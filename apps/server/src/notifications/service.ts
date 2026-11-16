import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, desc, eq, gte, inArray, isNull } from 'drizzle-orm';
import webpush from 'web-push';
import { ACTIVE_TASK_STATUSES, type ServerEvent } from '@opendots/shared';
import { db, schema } from '../db/client.ts';
import { subscribeAll } from '../bus.ts';
import { withAccount, type AccountContext } from '../auth/context.ts';
import { systemDataDir, config } from '../config.ts';
import { getSetting, setSetting } from '../settings.ts';
import { enqueue, registerJobHandler } from '../jobs/queue.ts';
import { getActiveStream } from '../agents/streams.ts';
import { newId, truncate } from '../util.ts';

/**
 * #64: notifications. They come from authoritative lifecycle transitions on the bus (a Circle's or a chat's finished
 * reply, a task that ends or needs the user, an approval or a question), never from streamed chunks; each one is
 * stored once (deduplicated) and delivered to the user's devices and browsers by Web Push (browsers) or UnifiedPush
 * (Android). Activity and the Inbox remain the source of truth: a missed push loses nothing, and a push never
 * approves anything by itself.
 */
export type Category = 'messages' | 'tasks' | 'approvals' | 'code' | 'scheduled';
export const CATEGORIES: Category[] = ['messages', 'tasks', 'approvals', 'code', 'scheduled'];
export interface NotificationPrefs {
  enabled: boolean;
  categories: Record<Category, boolean>;
  mutedAgents: string[];
  mutedChats: string[];
  /** "22:00"–"07:00" local to [timezone]; null = off. */
  quietHours: { start: string; end: string; timezone: string } | null;
  /** Show message text on the lock screen. Off by default: a generic line is shown instead. */
  preview: boolean;
}
export const DEFAULT_PREFS: NotificationPrefs = {
  enabled: true, categories: { messages: true, tasks: true, approvals: true, code: true, scheduled: true },
  mutedAgents: [], mutedChats: [], quietHours: null, preview: false,
};
export async function getPrefs(): Promise<NotificationPrefs> {
  const saved = (await getSetting('notifications.prefs')) as Partial<NotificationPrefs> | null;
  return { ...DEFAULT_PREFS, ...saved, categories: { ...DEFAULT_PREFS.categories, ...(saved?.categories ?? {}) } };
}
export async function setPrefs(patch: Partial<NotificationPrefs>) {
  const next = { ...(await getPrefs()), ...patch };
  await setSetting('notifications.prefs', next);
  return next;
}

// --- VAPID (one key pair for the server; the public key is shared with browsers and UnifiedPush) ---------

let vapid: { publicKey: string; privateKey: string } | null = null;
export function vapidKeys() {
  if (vapid) return vapid;
  const file = join(systemDataDir, 'vapid.json');
  if (existsSync(file)) vapid = JSON.parse(readFileSync(file, 'utf8'));
  else { vapid = webpush.generateVAPIDKeys(); writeFileSync(file, JSON.stringify(vapid), { mode: 0o600 }); }
  return vapid!;
}
const subject = () => process.env.OPENDOTS_VAPID_SUBJECT || (config.publicUrl?.startsWith('https://') ? config.publicUrl : 'mailto:botcircle@localhost');

// --- Rules ---------------------------------------------------------------------------------------------

function inQuietHours(q: NotificationPrefs['quietHours'], now = new Date()): boolean {
  if (!q) return false;
  const local = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: q.timezone || 'UTC' }).format(now);
  const [s, e, t] = [q.start, q.end, local];
  return s <= e ? t >= s && t < e : t >= s || t < e;
}

export interface NewNotification { dedupeKey: string; category: Category; title: string; body: string; target: typeof schema.notifications.$inferInsert['target']; sensitive?: boolean; agentId?: string | null; chatId?: string | null }

/** Stores the notification once and schedules its delivery, unless the user's preferences say otherwise. */
export async function notify(input: NewNotification): Promise<string | null> {
  const prefs = await getPrefs();
  if (!prefs.enabled || !prefs.categories[input.category]) return null;
  if (input.agentId && prefs.mutedAgents.includes(input.agentId)) return null;
  if (input.chatId && prefs.mutedChats.includes(input.chatId)) return null;
  const id = newId('ntf');
  const inserted = await db().insert(schema.notifications).values({
    id, dedupeKey: input.dedupeKey, category: input.category, title: truncate(input.title, 120), body: truncate(input.body, 300), target: input.target, sensitive: input.sensitive ?? true,
  }).onConflictDoNothing().returning({ id: schema.notifications.id });
  if (!inserted.length) return null; // already notified (retry, reconnect, replayed status)
  // Quiet hours: the event is kept in Activity / Inbox, nothing buzzes.
  if (inQuietHours(prefs.quietHours)) return id;
  await deliverAll(id);
  return id;
}

/** An approval decided or a question answered elsewhere: its notification disappears from every device. */
export async function closeNotification(dedupeKey: string) {
  const [row] = await db().select().from(schema.notifications).where(and(eq(schema.notifications.dedupeKey, dedupeKey), eq(schema.notifications.status, 'active')));
  if (!row) return;
  await db().update(schema.notifications).set({ status: 'closed' }).where(eq(schema.notifications.id, row.id));
  await deliverAll(row.id, true);
}

async function deliverAll(notificationId: string, close = false) {
  const subs = await db().select({ id: schema.pushSubscriptions.id }).from(schema.pushSubscriptions);
  for (const sub of subs) await enqueue('push.deliver', { notificationId, subscriptionId: sub.id, close }, { dedupeKey: `push:${notificationId}:${sub.id}:${close ? 'close' : 'show'}`, maxAttempts: 4 });
}

/** What leaves the server: a short title and line, a tag to group / replace, and where a tap goes. */
export async function payloadOf(row: typeof schema.notifications.$inferSelect, close = false) {
  const prefs = await getPrefs();
  const generic = row.sensitive && !prefs.preview;
  return {
    id: row.id, tag: row.dedupeKey.replace(/:[^:]*$/, ''), category: row.category, close,
    title: row.title, body: close ? '' : generic ? GENERIC[row.category] : row.body,
    url: urlOf(row.target), target: row.target,
  };
}
const GENERIC: Record<Category, string> = { messages: 'Nouveau message', tasks: 'Une tâche a changé d’état', approvals: 'Validation demandée', code: 'Session de code mise à jour', scheduled: 'Activité programmée' };
export function urlOf(t: typeof schema.notifications.$inferSelect['target']): string {
  switch (t.kind) {
    case 'chat': return `/#/chat/${t.id}${t.messageId ? `?m=${t.messageId}` : ''}`;
    case 'circle': return `/#/agent/${t.id}${t.messageId ? `?m=${t.messageId}` : ''}`;
    case 'approval': case 'request': return '/#/settings/approvals';
    case 'code': return `/#/code/${t.id}`;
    case 'task': return `/#/task/${t.id}`;
    default: return '/#/settings/tasks';
  }
}

registerJobHandler('push.deliver', async ({ notificationId, subscriptionId, close }: { notificationId: string; subscriptionId: string; close: boolean }) => {
  const [row] = await db().select().from(schema.notifications).where(eq(schema.notifications.id, notificationId));
  const [sub] = await db().select().from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.id, subscriptionId));
  if (!row || !sub) return;
  if (!close && row.status === 'closed') return; // decided meanwhile: nothing to show
  await sendPush(sub, await payloadOf(row, close), row.category === 'approvals' ? 'high' : 'normal');
});

export async function sendPush(sub: typeof schema.pushSubscriptions.$inferSelect, payload: unknown, urgency: 'high' | 'normal' = 'normal') {
  const keys = vapidKeys();
  try {
    if (!sub.p256dh || !sub.auth) throw Object.assign(new Error('Abonnement sans clés de chiffrement.'), { statusCode: 410 });
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), {
      TTL: 24 * 3600, urgency, vapidDetails: { subject: subject(), publicKey: keys.publicKey, privateKey: keys.privateKey },
    });
    await db().update(schema.pushSubscriptions).set({ failures: 0, lastOkAt: new Date() }).where(eq(schema.pushSubscriptions.id, sub.id));
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    // Gone or unknown: the browser / distributor dropped it. Remove it; the device re-registers when it can.
    if (status === 404 || status === 410) { await db().delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.id, sub.id)); return; }
    await db().update(schema.pushSubscriptions).set({ failures: sub.failures + 1 }).where(eq(schema.pushSubscriptions.id, sub.id));
    throw error; // retried by the job queue with backoff
  }
}

// --- From bus events to notifications --------------------------------------------------------------------

const turnStarts = new Map<string, { at: Date; autonomous: boolean }>();
const preview = (text: string) => text.replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();

export async function handleEvent(event: ServerEvent) {
  switch (event.type) {
    case 'turn.started': turnStarts.set(event.conversationId, { at: new Date(), autonomous: event.autonomous }); return;
    case 'turn.finished': return circleReply(event.agentId, event.conversationId);
    case 'chat.changed': if (!event.deleted) return chatReply(event.chatId); return;
    case 'task.changed': return taskChanged(event.task);
    case 'approval.changed':
      if (event.approval.status === 'pending') {
        const agent = await agentName(event.approval.agentId);
        return void (await notify({ dedupeKey: `approval:${event.approval.id}:pending`, category: 'approvals', title: `${agent} attend ta validation`, body: event.approval.summary, target: { kind: 'approval', id: event.approval.id, agentId: event.approval.agentId }, agentId: event.approval.agentId }));
      }
      return closeNotification(`approval:${event.approval.id}:pending`);
    case 'request.changed':
      if (event.request.status === 'pending') {
        const agent = await agentName(event.request.agentId);
        return void (await notify({ dedupeKey: `request:${event.request.id}:pending`, category: 'approvals', title: `${agent} a une question`, body: event.request.title, target: { kind: 'request', id: event.request.id, agentId: event.request.agentId }, agentId: event.request.agentId }));
      }
      return closeNotification(`request:${event.request.id}:pending`);
    default: return;
  }
}

async function agentName(id: string | null | undefined) {
  if (!id) return 'Un Circle';
  const [row] = await db().select({ name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.id, id));
  return row?.name ?? 'Un Circle';
}

/** A Circle finished a turn in its own thread: one notification for its last visible answer. */
async function circleReply(agentId: string, conversationId: string) {
  const started = turnStarts.get(conversationId); turnStarts.delete(conversationId);
  const [conv] = await db().select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
  if (!conv || conv.kind !== 'main' || conv.deletedAt) return;
  const since = started?.at ?? new Date(Date.now() - 10 * 60_000);
  const [last] = await db().select().from(schema.messages)
    .where(and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.hidden, false), eq(schema.messages.role, 'assistant'), gte(schema.messages.createdAt, since)))
    .orderBy(desc(schema.messages.seq)).limit(1);
  if (!last || !last.textContent.trim()) return;
  // It only handed work to tasks that still run: their outcome will bring the real answer (no double notification).
  const pending = await db().select({ id: schema.tasks.id }).from(schema.tasks).where(and(eq(schema.tasks.conversationId, conversationId), inArray(schema.tasks.status, ACTIVE_TASK_STATUSES), gte(schema.tasks.createdAt, since)));
  if (pending.length) return;
  await notify({
    dedupeKey: `reply:${last.id}`, category: started?.autonomous ? 'scheduled' : 'messages', title: await agentName(agentId), body: preview(last.textContent),
    target: { kind: 'circle', id: agentId, messageId: last.id }, agentId,
  });
}

/** A general chat's answer is ready (also after a mentioned Circle answered and the chat resumed, #62). */
async function chatReply(chatId: string) {
  if (getActiveStream(chatId)) return;
  const [conv] = await db().select().from(schema.conversations).where(and(eq(schema.conversations.id, chatId), isNull(schema.conversations.deletedAt)));
  if (!conv || conv.kind !== 'chat') return;
  const [last] = await db().select().from(schema.messages).where(and(eq(schema.messages.conversationId, chatId), eq(schema.messages.hidden, false))).orderBy(desc(schema.messages.seq)).limit(1);
  if (!last || last.role !== 'assistant' || !last.textContent.trim() || Date.now() - last.createdAt.getTime() > 2 * 60_000) return;
  // A Circle called in with @ still works: the chat resumes with its answer, and that synthesis is what we notify.
  const pending = await db().select({ id: schema.tasks.id }).from(schema.tasks).where(and(eq(schema.tasks.conversationId, chatId), inArray(schema.tasks.status, ACTIVE_TASK_STATUSES)));
  if (pending.length) return;
  await notify({ dedupeKey: `reply:${last.id}`, category: 'messages', title: conv.title?.trim() || 'Chat', body: preview(last.textContent), target: { kind: 'chat', id: chatId, messageId: last.id }, chatId });
}

type TaskEvent = Extract<ServerEvent, { type: 'task.changed' }>['task'];
async function taskChanged(task: TaskEvent) {
  const code = task.provider === 'opencode';
  const direct = task.agentId === 'user';
  // A general chat's @mention: the chat's resumed answer is the one notification (#62).
  const [conv] = await db().select({ kind: schema.conversations.kind }).from(schema.conversations).where(eq(schema.conversations.id, task.conversationId));
  if (conv?.kind === 'chat' && task.status === 'completed') return;
  const attention = task.status === 'failed' || task.status === 'waiting_for_user' || task.status === 'paused';
  // A Circle's own task that completes wakes the Circle, whose answer is notified: only attention states here.
  if (task.status === 'completed' && !direct) return;
  if (!attention && task.status !== 'completed') return;
  const owner = direct ? null : await agentName(task.agentId);
  const label = task.status === 'completed' ? 'Terminé' : task.status === 'failed' ? 'Échec — à regarder' : task.status === 'paused' ? 'En pause' : 'Action requise';
  await notify({
    dedupeKey: `task:${task.id}:${task.status}:${task.finishedAt ?? task.startedAt ?? task.createdAt}`,
    category: code ? 'code' : 'tasks', title: `${label} · ${task.title}`.slice(0, 120),
    body: preview(task.status === 'failed' ? task.error ?? '' : task.blocker ?? task.result ?? '') || (owner ? `Tâche de ${owner}` : 'Session de code'),
    target: code ? { kind: 'code', id: task.id } : { kind: 'task', id: task.id, agentId: direct ? null : task.agentId }, agentId: direct ? null : task.agentId, sensitive: true,
  });
}

/** Listens to every account's bus, inside that account. */
export function startNotifications() {
  return subscribeAll((event, account) => {
    if (!account) return;
    void withAccount(account as AccountContext, () => handleEvent(event)).catch(() => {});
  });
}

