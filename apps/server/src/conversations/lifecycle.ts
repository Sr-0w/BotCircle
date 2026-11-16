import { and, eq, inArray, isNull, like, sql } from 'drizzle-orm';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ACTIVE_TASK_STATUSES } from '@opendots/shared';
import { db, schema } from '../db/client.ts';
import { publish } from '../bus.ts';
import { config } from '../config.ts';
import { getActiveStream } from '../agents/streams.ts';
import { mainConversationId } from '../agents/repo.ts';

/**
 * #56: a conversation's lifecycle — Archive (hidden from the lists, intact, restorable), Restore, Delete (final).
 * None of them touches a Circle's identity, settings, memories or other threads, and none is `/clear`
 * (which is "archive the current thread and start a blank one", kept as it is).
 */
export class LifecycleError extends Error {
  constructor(message: string, readonly status: 'not_found' | 'busy' | 'active_tasks' | 'invalid', readonly tasks: { id: string; title: string; status: string }[] = []) { super(message); }
}

type Conversation = typeof schema.conversations.$inferSelect;

async function conversation(id: string): Promise<Conversation | null> {
  const [row] = await db().select().from(schema.conversations).where(eq(schema.conversations.id, id));
  return row && !row.deletedAt ? row : null;
}

/** A chat, or one of this Circle's threads (current or archived): anything else is refused server-side. */
async function owned(id: string, scope: { chat: true } | { agentId: string }): Promise<Conversation> {
  const row = await conversation(id);
  const ok = row && ('chat' in scope ? row.kind === 'chat' : row.agentId === scope.agentId && (row.kind === 'main' || row.kind === 'archive'));
  if (!ok) throw new LifecycleError('Conversation introuvable.', 'not_found');
  return row!;
}

async function activeTasks(conversationId: string) {
  return (await db().select({ id: schema.tasks.id, title: schema.tasks.title, status: schema.tasks.status }).from(schema.tasks)
    .where(and(eq(schema.tasks.conversationId, conversationId), inArray(schema.tasks.status, ACTIVE_TASK_STATUSES))));
}

function changed(row: Conversation, extra: { deleted?: boolean } = {}) {
  if (row.kind === 'chat') publish({ type: 'chat.changed', chatId: row.id, ...extra });
  else if (row.agentId) publish({ type: 'conversation.changed', agentId: row.agentId, conversationId: row.id, ...extra });
}

// --- Archive / restore -------------------------------------------------------------------------

export async function archiveChat(id: string) {
  const row = await owned(id, { chat: true });
  await db().update(schema.conversations).set({ archived: true, archivedAt: new Date(), pinned: false }).where(eq(schema.conversations.id, id));
  changed(row);
}

export async function restoreChat(id: string) {
  const row = await owned(id, { chat: true });
  await db().update(schema.conversations).set({ archived: false, archivedAt: null, updatedAt: new Date() }).where(eq(schema.conversations.id, id));
  changed(row);
}

/** A Circle's current thread goes to its archives and a blank one takes its place; an archived thread stays as it is. */
export async function archiveCircleThread(agentId: string, id: string): Promise<{ conversationId: string }> {
  const row = await owned(id, { agentId });
  if (row.kind === 'main') {
    if (getActiveStream(id)) throw new LifecycleError('Une réponse est en cours : arrête-la ou attends la fin avant d’archiver ce fil.', 'busy');
    await db().update(schema.conversations).set({ kind: 'archive', archivedAt: new Date(), updatedAt: new Date() }).where(eq(schema.conversations.id, id));
    const conversationId = await mainConversationId(agentId);
    publish({ type: 'conversation.reset', agentId, conversationId, archivedId: id });
    return { conversationId };
  }
  return { conversationId: await mainConversationId(agentId) };
}

/**
 * An archived thread becomes the Circle's current thread again. The thread it replaces is archived in turn (or simply
 * dropped when it never had a message), so nothing is lost.
 */
export async function restoreCircleThread(agentId: string, id: string): Promise<{ conversationId: string; archivedId: string | null }> {
  const row = await owned(id, { agentId });
  if (row.kind === 'main') return { conversationId: id, archivedId: null };
  const current = await mainConversationId(agentId);
  if (getActiveStream(current)) throw new LifecycleError('Une réponse est en cours dans le fil actuel : arrête-la ou attends la fin avant de restaurer.', 'busy');
  const [{ n }] = await db().select({ n: sql<number>`count(*)::int` }).from(schema.messages).where(eq(schema.messages.conversationId, current));
  let archivedId: string | null = null;
  if (n > 0) { await db().update(schema.conversations).set({ kind: 'archive', archivedAt: new Date(), updatedAt: new Date() }).where(eq(schema.conversations.id, current)); archivedId = current; }
  else await db().update(schema.conversations).set({ kind: 'archive', deletedAt: new Date() }).where(eq(schema.conversations.id, current));
  await db().update(schema.conversations).set({ kind: 'main', archivedAt: null, updatedAt: new Date() }).where(eq(schema.conversations.id, id));
  publish({ type: 'conversation.reset', agentId, conversationId: id, archivedId: archivedId ?? id });
  return { conversationId: id, archivedId };
}

// --- Delete -------------------------------------------------------------------------------------

export interface DeleteOptions {
  /** Stop a reply being generated in it, then delete (otherwise refused while it runs). */
  stopActive?: boolean;
  /** The user saw the tasks still running from it and confirmed: they keep running; their results go to Activity. */
  confirmTasks?: boolean;
  /** Stops a running reply (chat turn or Circle turn). */
  stop?: () => void;
}

async function purge(row: Conversation, opts: DeleteOptions) {
  if (getActiveStream(row.id)) {
    if (!opts.stopActive) throw new LifecycleError('Une réponse est en cours dans cette conversation : arrête-la d’abord, ou confirme l’arrêt.', 'busy');
    opts.stop?.();
  }
  const tasks = await activeTasks(row.id);
  if (tasks.length && !opts.confirmTasks) throw new LifecycleError(`${tasks.length} tâche(s) lancée(s) depuis cette conversation sont encore en cours. Elles continueront et leurs résultats resteront dans Activité.`, 'active_tasks', tasks);
  // Images uploaded into these messages and kept nowhere else.
  const messages = await db().select({ parts: schema.messages.parts }).from(schema.messages).where(eq(schema.messages.conversationId, row.id));
  const images = new Set<string>();
  for (const m of messages) for (const part of m.parts as { type?: string; url?: string }[]) {
    const id = part?.type === 'file' ? /^\/api\/attachments\/([a-f0-9]{32})$/.exec(part.url ?? '')?.[1] : null;
    if (id) images.add(id);
  }
  await db().delete(schema.messageReactions).where(eq(schema.messageReactions.conversationId, row.id));
  await db().delete(schema.messages).where(eq(schema.messages.conversationId, row.id));
  for (const id of images) {
    const [elsewhere] = await db().select({ id: schema.messages.id }).from(schema.messages).where(like(sql`${schema.messages.parts}::text`, `%/api/attachments/${id}%`)).limit(1);
    if (!elsewhere) { const dir = join(config.dataDir, 'attachments'); await rm(join(dir, `${id}.jpg`), { force: true }); await rm(join(dir, `${id}.json`), { force: true }); }
  }
  // Files the user uploaded into it go with it; files a Circle made stay in its Files.
  await db().update(schema.artifacts).set({ deletedAt: new Date() }).where(and(eq(schema.artifacts.conversationId, row.id), eq(schema.artifacts.source, 'upload'), isNull(schema.artifacts.deletedAt)));
  // Questions still waiting in it are dropped.
  await db().update(schema.userRequests).set({ status: 'cancelled' }).where(and(eq(schema.userRequests.conversationId, row.id), eq(schema.userRequests.status, 'pending')));
  await db().update(schema.conversations).set({ deletedAt: new Date(), archived: true, title: null, pinned: false }).where(eq(schema.conversations.id, row.id));
}

export async function deleteChatConversation(id: string, opts: DeleteOptions = {}) {
  const row = await owned(id, { chat: true });
  await purge(row, opts);
  changed(row, { deleted: true });
}

/** Deleting the current thread leaves the Circle with a blank one; its memories and settings are untouched. */
export async function deleteCircleThread(agentId: string, id: string, opts: DeleteOptions = {}): Promise<{ conversationId: string }> {
  const row = await owned(id, { agentId });
  await purge(row, opts);
  if (row.kind === 'main') {
    await db().update(schema.conversations).set({ kind: 'archive' }).where(eq(schema.conversations.id, id));
    const conversationId = await mainConversationId(agentId);
    publish({ type: 'conversation.reset', agentId, conversationId, archivedId: id });
    return { conversationId };
  }
  changed(row, { deleted: true });
  return { conversationId: await mainConversationId(agentId) };
}

