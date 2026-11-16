import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { tool } from 'ai';
import { z } from 'zod';
let model: any;
vi.mock('../src/models/gateway.ts', () => ({ resolveModel: async (cfg: any) => ({ model, providerOptions: {}, label: cfg.model }), requireDesktopVision: async () => {}, checkModel: async () => ({ ok: true }) }));
vi.mock('../src/agents/capability-tools.ts', () => ({ buildCapabilityTools: async () => ({ info: { connectors: [], skills: [] }, lazy: { loaded: new Set(), names: new Set(), groups: [] }, tools: { fixture_read: tool({ inputSchema: z.object({}), execute: async () => ({ ok: true }) }) } }) }));
import { and, eq } from 'drizzle-orm';
import { openDatabase, closeDatabase, db, schema } from '../src/db/client.ts';
import { createAgent, mainConversationId } from '../src/agents/repo.ts';
import { loadMessages, messageText } from '../src/conversations/repo.ts';
import { setSetting } from '../src/settings.ts';
import { createChat } from '../src/chats/repo.ts';
import { resumeChat, runChatTurn } from '../src/chats/turn.ts';
import { getTask } from '../src/tasks/service.ts';
import { runTask } from '../src/tasks/runner.ts';
import { enqueue } from '../src/jobs/queue.ts';

beforeAll(async () => {
  await openDatabase({ memory: true });
  await setSetting('engine.turnStepLimit', null);
  await setSetting('models.default', { provider: 'openrouter', model: 'default-model' });
});
afterAll(async () => { await closeDatabase(); });
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const reply = (value: string) => ({ warnings: [], stream: new ReadableStream({ start(c) { for (const p of [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: value }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }]) c.enqueue(p); c.close(); } }) }) as any;
const user = (id: string, value: string) => ({ id, role: 'user' as const, parts: [{ type: 'text' as const, text: value }], metadata: {} });
const resumeJobs = async (taskId: string) => db().select().from(schema.jobs).where(and(eq(schema.jobs.type, 'chat.resume')));

describe('chat général ↔ compagnon (#62, #63)', () => {
  it('la demande apparaît dans le fil du compagnon, sa réponse aussi, et le chat reprend tout seul avec le vrai résultat', async () => {
    const ari = await createAgent({ name: 'Ari' });
    const chat = await createChat();
    model = new MockLanguageModelV4({ doStream: async () => reply('?') });
    const sent = await runChatTurn(chat.id, user('m1', '@Ari trouve le prix du train Genève–Lausanne demain matin.')).done;
    const task = (await getTask(sent.interventions[0]))!;

    // #63: Ari's own thread shows what it was asked, from which chat — a record, not a second run.
    const own = (await loadMessages(await mainConversationId(ari.id))).messages;
    const request = own.find((m) => m.metadata?.event?.type === 'chat_request')!;
    expect(request.metadata?.event).toMatchObject({ chatId: chat.id, taskId: task.id });
    expect(request.metadata?.event?.title).toContain('Demande depuis le chat');
    expect(messageText(request)).toContain('prix du train');

    model = new MockLanguageModelV4({ doStream: async () => reply('Le premier train part à 7 h 04, 25,60 CHF.') });
    await runTask(task.id);
    const replyRecord = (await loadMessages(await mainConversationId(ari.id))).messages.find((m) => m.metadata?.event?.type === 'chat_reply')!;
    expect(replyRecord.metadata?.event).toMatchObject({ chatId: chat.id, taskId: task.id });
    expect(messageText(replyRecord)).toContain('25,60 CHF');

    // #62: one resume per outcome, durable (a job), never twice.
    const jobs = (await resumeJobs(task.id)).filter((j) => (j.payload as any).taskId === task.id);
    expect(jobs).toHaveLength(1);
    expect(await enqueue('chat.resume', { chatId: chat.id, taskId: task.id }, { dedupeKey: `chat-resume:${task.id}:completed` })).toBe(false);

    let seen = '';
    model = new MockLanguageModelV4({ doStream: async (o: any) => { seen = JSON.stringify(o.prompt); return reply('Ari a trouvé : départ 7 h 04, 25,60 CHF. Je peux réserver si tu veux.'); } });
    await resumeChat(chat.id, task.id);
    expect(seen).toContain('[Réponse de Ari]');
    expect(seen).toContain('25,60 CHF');
    expect(seen).toContain('Resume the user');
    const thread = (await loadMessages(chat.id)).messages;
    const last = thread.at(-1)!;
    expect(last.role).toBe('assistant');
    expect(last.metadata?.agentId).toBeUndefined();
    expect(messageText(last)).toContain('7 h 04');
    // No extra user message was needed or invented.
    expect(thread.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('plusieurs compagnons : le chat reprend une seule fois, quand le dernier a répondu', async () => {
    await createAgent({ name: 'Homey' });
    const chat = await createChat();
    model = new MockLanguageModelV4({ doStream: async () => reply('?') });
    const sent = await runChatTurn(chat.id, user('m2', '@Ari et @Homey, vérifiez chacun la météo et le chauffage.')).done;
    expect(sent.interventions).toHaveLength(2);
    let calls = 0;
    model = new MockLanguageModelV4({ doStream: async () => { calls += 1; return reply('Fait.'); } });
    await runTask(sent.interventions[0]);
    calls = 0;
    await resumeChat(chat.id, sent.interventions[0]);
    expect(calls).toBe(0); // the other one still works
    await runTask(sent.interventions[1]);
    calls = 0;
    await resumeChat(chat.id, sent.interventions[1]);
    expect(calls).toBe(1);
  });

  it('la même demande au même compagnon n’est pas lancée deux fois', async () => {
    const chat = await createChat();
    model = new MockLanguageModelV4({ doStream: async () => reply('?') });
    const a = await runChatTurn(chat.id, user('m3', '@Ari range mes fichiers.')).done;
    const b = await runChatTurn(chat.id, user('m4', '@Ari range mes fichiers.')).done;
    expect(b.interventions[0]).toBe(a.interventions[0]);
  });
});
