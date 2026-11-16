import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { tool } from 'ai';
import { z } from 'zod';
let model: any;
const resolved: string[] = [];
vi.mock('../src/models/gateway.ts', () => ({ resolveModel: async (cfg: any) => { resolved.push(cfg.model); return { model, providerOptions: {}, label: cfg.model }; }, requireDesktopVision: async () => {}, checkModel: async () => ({ ok: true }) }));
vi.mock('../src/agents/capability-tools.ts', () => ({ buildCapabilityTools: async () => ({ info: { connectors: [], skills: [] }, lazy: { loaded: new Set(), names: new Set(), groups: [] }, tools: { fixture_read: tool({ inputSchema: z.object({}), execute: async () => ({ ok: true }) }) } }) }));
import { openDatabase, closeDatabase } from '../src/db/client.ts';
import { createAgent, listAgentRows, updateAgent } from '../src/agents/repo.ts';
import { loadMessages, messageText } from '../src/conversations/repo.ts';
import { setSetting } from '../src/settings.ts';
import { createChat, getChat, listChats, toChatDTO, updateChat } from '../src/chats/repo.ts';
import { runChatTurn } from '../src/chats/turn.ts';
import { deleteChatConversation } from '../src/conversations/lifecycle.ts';
import { getTask, listTasks } from '../src/tasks/service.ts';
import { runTask } from '../src/tasks/runner.ts';
import { createArtifact, hasGrant } from '../src/artifacts/service.ts';
import { artifactUrl, findMentions, presentAssistantTurn } from '@opendots/shared';

beforeAll(async () => {
  await openDatabase({ memory: true });
  await setSetting('engine.turnStepLimit', null);
  await setSetting('models.default', { provider: 'openrouter', model: 'default-model' });
});
afterAll(async () => { await closeDatabase(); });
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const reply = (parts: any[], more: boolean) => ({ warnings: [], stream: new ReadableStream({ start(c) { for (const p of [{ type: 'stream-start', warnings: [] }, ...parts, { type: 'finish', finishReason: { unified: more ? 'tool-calls' : 'stop', raw: more ? 'tool_calls' : 'stop' }, usage }]) c.enqueue(p); c.close(); } }) }) as any;
const text = (value: string) => [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: value }, { type: 'text-end', id: 't' }];
const user = (id: string, value: string, files: any[] = []) => ({ id, role: 'user' as const, parts: [{ type: 'text' as const, text: value }, ...files], metadata: {} });

describe('chats généraux', () => {
  it('fonctionne sans aucun compagnon et n’en crée pas', async () => {
    const chat = await createChat();
    expect((await toChatDTO(chat)).title).toBe('Nouveau chat');
    model = new MockLanguageModelV4({ doStream: async () => reply(text('Bonjour ! Comment puis-je aider ?'), false) });
    const result = await runChatTurn(chat.id, user('m1', 'Explique-moi les fuseaux horaires')).done;
    expect(result.text).toBe('Bonjour ! Comment puis-je aider ?');
    expect(await listAgentRows()).toHaveLength(0);
    const messages = (await loadMessages(chat.id, { limit: 10 })).messages;
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1].metadata?.agentId).toBeUndefined();
    // Titre tiré du premier message, renommage, recherche, suppression.
    expect((await toChatDTO((await getChat(chat.id))!)).title).toBe('Explique-moi les fuseaux horaires');
    await updateChat(chat.id, { title: 'Fuseaux' });
    expect((await listChats('fuseaux')).map((c) => c.id)).toContain(chat.id);
    expect((await listChats('horaires')).map((c) => c.id)).toContain(chat.id);
    expect(await listChats('introuvable-xyz')).toHaveLength(0);
    await deleteChatConversation(chat.id);
    expect(await getChat(chat.id)).toBeNull();
    expect((await loadMessages(chat.id, { limit: 10 })).messages).toHaveLength(0);
  });

  it('utilise le modèle du chat sans toucher à celui des compagnons', async () => {
    const ari = await createAgent({ name: 'Ari' });
    await updateAgent(ari.id, { model: { provider: 'openrouter', model: 'ari-model' } });
    const chat = await createChat({ model: { provider: 'openrouter', model: 'chat-model' } });
    resolved.length = 0;
    model = new MockLanguageModelV4({ doStream: async () => reply(text('ok'), false) });
    await runChatTurn(chat.id, user('m2', 'Bonjour')).done;
    expect(resolved).toEqual(['chat-model']);
    expect((await listAgentRows()).find((a) => a.id === ari.id)!.model).toEqual({ provider: 'openrouter', model: 'ari-model' });
    expect((await toChatDTO((await createChat())!)).effectiveModel.model).toBe('default-model');
  });

  it('une @mention crée une intervention attribuée, dont la réponse revient dans le même chat', async () => {
    const [ari] = await listAgentRows();
    const other = await createAgent({ name: 'Homey' });
    const chat = await createChat();
    const file = await createArtifact({ bytes: Buffer.from('a,b\n1,2'), name: 'pages.csv', authorKind: 'user', source: 'upload', conversationId: chat.id });
    let assistantCalled = false;
    model = new MockLanguageModelV4({ doStream: async () => { assistantCalled = true; return reply(text('?'), false); } });
    const result = await runChatTurn(chat.id, user('m3', '@Ari, compare ces deux pages.', [{ type: 'file', url: artifactUrl(file.id), filename: 'pages.csv', mediaType: 'text/csv' }])).done;
    // Le message s'adresse à Ari : pas de réponse de l'assistant général, une carte d'intervention.
    expect(assistantCalled).toBe(false);
    expect(result.interventions).toHaveLength(1);
    const task = (await getTask(result.interventions[0]))!;
    expect(task).toMatchObject({ agentId: ari.id, conversationId: chat.id, requestedBy: 'user', status: 'running' });
    // Périmètre : la demande et le fichier joint, pas le reste du chat ; aucun autre compagnon n'y accède.
    expect(task.instruction).toContain('compare ces deux pages');
    expect(await hasGrant(file.id, ari.id)).toBe(true);
    expect(await hasGrant(file.id, other.id)).toBe(false);
    const card = (await loadMessages(chat.id, { limit: 10 })).messages.at(-1)!;
    expect(presentAssistantTurn(card.parts as any).actions[0]).toMatchObject({ type: 'tool-invoke_agent', output: { taskId: task.id, agentName: 'Ari' } });

    // Ari travaille avec SON modèle, puis sa synthèse arrive dans le chat sous son nom.
    resolved.length = 0;
    let workerPrompt = '';
    model = new MockLanguageModelV4({ doStream: async (o: any) => { workerPrompt = JSON.stringify(o.prompt); return reply(text('Les deux pages diffèrent sur le prix.'), false); } });
    await runTask(task.id);
    expect(resolved).toEqual(['ari-model']);
    expect(workerPrompt).not.toContain('Explique-moi les fuseaux');
    const answer = (await loadMessages(chat.id, { limit: 10 })).messages.at(-1)!;
    expect(answer.role).toBe('assistant');
    expect(answer.metadata).toMatchObject({ agentId: ari.id, taskId: task.id });
    expect(messageText(answer)).toBe('Les deux pages diffèrent sur le prix.');

    // L'assistant général voit ensuite cette contribution comme celle d'Ari, pas comme la sienne.
    let history = '';
    model = new MockLanguageModelV4({ doStream: async (o: any) => { history = JSON.stringify(o.prompt); return reply(text('Ari a trouvé une différence de prix.'), false); } });
    await runChatTurn(chat.id, user('m4', 'Résume')).done;
    expect(history).toContain('[Réponse de Ari]');
  });

  it("l'assistant peut solliciter un compagnon et consulter l'état réel de l'intervention", async () => {
    const chat = await createChat();
    let step = 0;
    model = new MockLanguageModelV4({ doStream: async () => (++step === 1
      ? reply([{ type: 'tool-call', toolCallId: 'c1', toolName: 'invoke_agent', input: JSON.stringify({ agent: 'Homey', instruction: 'Vérifie les chiffres.' }) }], true)
      : step === 2 ? reply([{ type: 'tool-call', toolCallId: 'c2', toolName: 'task_status', input: '{}' }], true)
        : reply(text('Homey s’en occupe.'), false)) });
    const result = await runChatTurn(chat.id, user('m5', 'Fais vérifier les chiffres par Homey')).done;
    expect(result.interventions).toHaveLength(1);
    expect((await listTasks({ conversationId: chat.id }))[0]).toMatchObject({ requestedBy: 'assistant', status: 'running' });
    const saved = (await loadMessages(chat.id, { limit: 10 })).messages.at(-1)!;
    const status = (saved.parts as any[]).find((p) => p.type === 'tool-task_status');
    expect(status.output).toMatchObject({ ok: true, agent: 'Homey', status: 'running', completedSteps: 0 });
  });

  it('repère les mentions sans faux positifs et sans doublon', () => {
    const agents = [{ id: 'a', name: 'Ari' }, { id: 'b', name: 'Ariane' }, { id: 'c', name: 'Dev' }];
    expect(findMentions('@Ari et @dev, comparez.', agents)).toEqual(['a', 'c']);
    expect(findMentions('@Ariane seulement', agents)).toEqual(['b']);
    expect(findMentions('mail à ari@example.com, @Arial', agents)).toEqual([]);
    expect(findMentions('@Ari @Ari', agents)).toEqual(['a']);
  });
});
