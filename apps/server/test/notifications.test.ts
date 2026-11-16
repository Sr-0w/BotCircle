import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createECDH, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import webpush from 'web-push';
import { eq } from 'drizzle-orm';
import { openDatabase, closeDatabase, db, schema } from '../src/db/client.ts';
import { createAgent, mainConversationId } from '../src/agents/repo.ts';
import { saveMessage } from '../src/conversations/repo.ts';
import { createChat } from '../src/chats/repo.ts';
import { startQueue, stopQueue } from '../src/jobs/queue.ts';
import { handleEvent, payloadOf, setPrefs, DEFAULT_PREFS, vapidKeys } from '../src/notifications/service.ts';

/** #64: lifecycle events → one deduplicated notification each → delivered to every subscribed device. */
const sent: { endpoint: string; payload: any; urgency?: string }[] = [];
let fail410 = false;
const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
const auth = randomBytes(16);
const b64 = (b: Buffer) => b.toString('base64url');
const settle = async () => { for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 50)); const q = await db().select().from(schema.jobs).where(eq(schema.jobs.type, 'push.deliver')); if (q.every((j) => j.status !== 'queued' && j.status !== 'running')) return; } };
const approval = (id: string, status: string, agentId: string) => ({ type: 'approval.changed', approval: { id, status, agentId, summary: 'Supprimer le dossier /tmp/x', action: 'shell.exec', conversationId: 'cv', input: {}, createdAt: new Date().toISOString(), service: null, error: null } }) as any;
let agentId = '';

beforeAll(async () => {
  await openDatabase({ memory: true });
  vi.spyOn(webpush, 'sendNotification').mockImplementation((async (sub: any, payload: any, opts: any) => {
    if (fail410) throw Object.assign(new Error('gone'), { statusCode: 410 });
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), urgency: opts?.urgency });
    return { statusCode: 201, body: '', headers: {} };
  }) as any);
  agentId = (await createAgent({ name: 'Ari' })).id;
  await db().insert(schema.pushSubscriptions).values({ id: 'push_phone', kind: 'unifiedpush', endpoint: 'https://ntfy.example/up123', p256dh: b64(ecdh.getPublicKey()), auth: b64(auth), label: 'Pixel' });
  startQueue();
});
afterAll(async () => { await stopQueue(); await closeDatabase(); vi.restoreAllMocks(); });
beforeEach(async () => { sent.length = 0; fail410 = false; await setPrefs(DEFAULT_PREFS); });

describe('notifications', () => {
  it('une validation : une notification prioritaire, jamais deux, retirée quand elle est décidée', async () => {
    await handleEvent(approval('ap1', 'pending', agentId));
    await handleEvent(approval('ap1', 'pending', agentId)); // reconnect / replay
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ urgency: 'high', payload: { category: 'approvals', title: 'Ari attend ta validation', tag: 'approval:ap1', url: '/#/settings/approvals', close: false } });
    // Lock-screen privacy by default: no action text.
    expect(sent[0].payload.body).toBe('Validation demandée');
    await handleEvent(approval('ap1', 'approved', agentId));
    await settle();
    expect(sent[1].payload).toMatchObject({ close: true, tag: 'approval:ap1' });
  });

  it('préférences : catégories, Circle en sourdine, heures calmes, aperçu', async () => {
    await setPrefs({ categories: { ...DEFAULT_PREFS.categories, approvals: false } });
    await handleEvent(approval('ap2', 'pending', agentId)); await settle();
    expect(sent).toHaveLength(0);
    await setPrefs({ ...DEFAULT_PREFS, mutedAgents: [agentId] });
    await handleEvent(approval('ap3', 'pending', agentId)); await settle();
    expect(sent).toHaveLength(0);
    await setPrefs({ ...DEFAULT_PREFS, quietHours: { start: '00:00', end: '23:59', timezone: 'UTC' } });
    await handleEvent(approval('ap4', 'pending', agentId)); await settle();
    expect(sent).toHaveLength(0);
    expect((await db().select().from(schema.notifications).where(eq(schema.notifications.dedupeKey, 'approval:ap4:pending')))).toHaveLength(1); // kept, silent
    await setPrefs({ ...DEFAULT_PREFS, preview: true });
    await handleEvent(approval('ap5', 'pending', agentId)); await settle();
    expect(sent[0].payload.body).toBe('Supprimer le dossier /tmp/x');
  });

  it('la réponse finie d’un Circle, une fois, avec le lien vers le message ; rien tant que ses tâches tournent', async () => {
    const cv = await mainConversationId(agentId);
    await handleEvent({ type: 'turn.started', agentId, conversationId: cv, autonomous: false });
    await saveMessage(cv, { id: 'r1', role: 'assistant', parts: [{ type: 'text', text: 'XFCE est configuré.' }], metadata: {} }, { author: 'agent', agentId });
    await handleEvent({ type: 'turn.finished', agentId, conversationId: cv });
    await handleEvent({ type: 'turn.finished', agentId, conversationId: cv });
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toMatchObject({ category: 'messages', title: 'Ari', url: `/#/agent/${agentId}?m=r1`, target: { kind: 'circle', id: agentId, messageId: 'r1' } });
    // Delegated work still running: the reply that only hands it over is not notified.
    await handleEvent({ type: 'turn.started', agentId, conversationId: cv, autonomous: false });
    await saveMessage(cv, { id: 'r2', role: 'assistant', parts: [{ type: 'text', text: 'Je lance l’analyse.' }], metadata: {} }, { author: 'agent', agentId });
    await db().insert(schema.tasks).values({ id: 'tk_a', agentId, conversationId: cv, workConversationId: 'w', title: 'Analyse', instruction: 'x', requestedBy: 'agent', status: 'running' });
    await handleEvent({ type: 'turn.finished', agentId, conversationId: cv });
    await settle();
    expect(sent).toHaveLength(1);
  });

  it('chat avec @Circle : seulement la synthèse finale (#62) ; tâches : échec oui, réussite d’un Circle non, session de code oui', async () => {
    const chat = await createChat({ title: 'Voyage' });
    await saveMessage(chat.id, { id: 'c1', role: 'assistant', parts: [{ type: 'text', text: 'J’ai demandé à Ari.' }], metadata: {} }, { author: 'agent' });
    await db().insert(schema.tasks).values({ id: 'tk_m', agentId, conversationId: chat.id, workConversationId: 'w2', title: 'Mention', instruction: 'x', requestedBy: 'assistant', status: 'running' });
    await handleEvent({ type: 'chat.changed', chatId: chat.id }); await settle();
    expect(sent).toHaveLength(0);
    await db().update(schema.tasks).set({ status: 'completed' }).where(eq(schema.tasks.id, 'tk_m'));
    await handleEvent({ type: 'task.changed', task: { id: 'tk_m', agentId, conversationId: chat.id, status: 'completed', title: 'Mention', provider: 'agent', createdAt: '2026-11-16T00:00:00Z', startedAt: null, finishedAt: '2026-11-16T00:01:00Z', result: 'ok', error: null, blocker: null } as any });
    await saveMessage(chat.id, { id: 'c2', role: 'assistant', parts: [{ type: 'text', text: 'Synthèse : Rome en mai.' }], metadata: {} }, { author: 'agent' });
    await handleEvent({ type: 'chat.changed', chatId: chat.id }); await settle();
    expect(sent.map((s) => s.payload.target)).toEqual([{ kind: 'chat', id: chat.id, messageId: 'c2' }]);
    sent.length = 0;
    const base = { conversationId: 'cvx', provider: 'agent', createdAt: '2026-11-16T00:00:00Z', startedAt: null, result: null, blocker: null, error: 'Timeout' };
    await handleEvent({ type: 'task.changed', task: { ...base, id: 't1', agentId, status: 'completed', title: 'Rapport', finishedAt: 'a' } as any });
    await handleEvent({ type: 'task.changed', task: { ...base, id: 't2', agentId, status: 'failed', title: 'Rapport', finishedAt: 'b' } as any });
    await handleEvent({ type: 'task.changed', task: { ...base, id: 't3', agentId: 'user', provider: 'opencode', status: 'completed', title: 'Refactor', finishedAt: 'c' } as any });
    await settle();
    expect(sent.map((s) => [s.payload.category, s.payload.title])).toEqual([['tasks', 'Échec — à regarder · Rapport'], ['code', 'Terminé · Refactor']]);
    expect(sent[1].payload.url).toBe('/#/code/t3');
  });

  it('un abonnement expiré (410) est retiré ; le chiffrement Web Push se déchiffre avec les clés de l’appareil', async () => {
    fail410 = true;
    await handleEvent(approval('ap9', 'pending', agentId)); await settle();
    expect(await db().select().from(schema.pushSubscriptions)).toHaveLength(0);
    // Real encryption round trip (RFC 8291) for what a phone / browser receives.
    const [row] = await db().select().from(schema.notifications).where(eq(schema.notifications.dedupeKey, 'approval:ap9:pending'));
    const payload = JSON.stringify(await payloadOf(row));
    const keys = vapidKeys();
    const details = webpush.generateRequestDetails({ endpoint: 'https://push.example/x', keys: { p256dh: b64(ecdh.getPublicKey()), auth: b64(auth) } }, payload, { vapidDetails: { subject: 'mailto:t@example.com', publicKey: keys.publicKey, privateKey: keys.privateKey } });
    const ece = createRequire(import.meta.url)('http_ece');
    const plain = ece.decrypt(details.body, { version: 'aes128gcm', privateKey: ecdh, authSecret: b64(auth) });
    expect(JSON.parse(plain.toString())).toMatchObject({ tag: 'approval:ap9', category: 'approvals' });
  });
});
