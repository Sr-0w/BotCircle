import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
let model: any;
vi.mock('../src/models/gateway.ts', () => ({ resolveModel: async (cfg: any) => ({ model, providerOptions: {}, label: cfg.model }), requireDesktopVision: async () => {}, checkModel: async () => ({ ok: true }) }));
import { openDatabase, closeDatabase } from '../src/db/client.ts';
import { loadMessages, messageText } from '../src/conversations/repo.ts';
import { setSetting } from '../src/settings.ts';
import { createChat, listChats, toChatDTO, updateChat } from '../src/chats/repo.ts';
import { editChatMessage, regenerateChatTurn, runChatTurn } from '../src/chats/turn.ts';

beforeAll(async () => {
  await openDatabase({ memory: true });
  await setSetting('models.default', { provider: 'openrouter', model: 'default-model' });
});
afterAll(async () => { await closeDatabase(); });
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const reply = (value: string) => ({ warnings: [], stream: new ReadableStream({ start(c) { for (const p of [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: value }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }]) c.enqueue(p); c.close(); } }) }) as any;
const user = (id: string, value: string) => ({ id, role: 'user' as const, parts: [{ type: 'text' as const, text: value }], metadata: {} });

describe('contrôles d’un chat (#38)', () => {
  it('coupe vraiment la recherche web : les outils ne sont pas donnés au modèle', async () => {
    const chat = await createChat();
    expect((await toChatDTO(chat)).webSearch).toBe(true);
    let offered: string[] = [], system = '';
    model = new MockLanguageModelV4({ doStream: async (options: any) => { offered = (options.tools ?? []).map((t: any) => t.name); system = JSON.stringify(options.prompt[0]); return reply('ok'); } });
    await runChatTurn(chat.id, user('w1', 'Quoi de neuf ?')).done;
    expect(offered).toEqual(expect.arrayContaining(['web_search', 'web_fetch']));
    await updateChat(chat.id, { webSearch: false });
    expect((await toChatDTO((await listChats()).find((c) => c.id === chat.id)!)).webSearch).toBe(false);
    await runChatTurn(chat.id, user('w2', 'Et maintenant ?')).done;
    expect(offered).not.toContain('web_search');
    expect(offered).not.toContain('web_fetch');
    expect(system).toContain('Web search is turned OFF');
    const last = (await loadMessages(chat.id, { limit: 10 })).messages.at(-1)!;
    expect(last.metadata?.webSearch).toBe(false);
  });

  it('régénère la dernière réponse en gardant les précédentes dans ses versions', async () => {
    const chat = await createChat();
    model = new MockLanguageModelV4({ doStream: async () => reply('Première réponse') });
    await runChatTurn(chat.id, user('r1', 'Donne une idée')).done;
    model = new MockLanguageModelV4({ doStream: async () => reply('Deuxième réponse') });
    await (await regenerateChatTurn(chat.id)).done;
    model = new MockLanguageModelV4({ doStream: async () => reply('Troisième réponse') });
    await (await regenerateChatTurn(chat.id)).done;
    const visible = (await loadMessages(chat.id, { limit: 10 })).messages;
    expect(visible.map((m) => [m.role, messageText(m)])).toEqual([['user', 'Donne une idée'], ['assistant', 'Troisième réponse']]);
    expect(visible[1].metadata?.previous?.map((p) => p.text)).toEqual(['Première réponse', 'Deuxième réponse']);
    // Rien n'est effacé : les réponses remplacées restent en base, masquées.
    expect((await loadMessages(chat.id, { limit: 10, includeHidden: true })).messages).toHaveLength(4);
  });

  it('modifie un message : la suite est mise de côté (conservée), une réponse repart', async () => {
    const chat = await createChat();
    model = new MockLanguageModelV4({ doStream: async () => reply('Réponse A') });
    await runChatTurn(chat.id, user('e1', 'Question un')).done;
    await runChatTurn(chat.id, user('e2', 'Question deux')).done;
    let seen = '';
    model = new MockLanguageModelV4({ doStream: async (options: any) => { seen = JSON.stringify(options.prompt); return reply('Réponse B'); } });
    await (await editChatMessage(chat.id, 'e1', 'Question un, reformulée')).done;
    const visible = (await loadMessages(chat.id, { limit: 10 })).messages;
    expect(visible.map(messageText)).toEqual(['Question un, reformulée', 'Réponse B']);
    expect(visible[0].metadata?.edited).toMatchObject({ previousText: 'Question un', setAside: 3 });
    // Le modèle ne voit que la nouvelle branche.
    expect(seen).not.toContain('Question deux');
    expect((await loadMessages(chat.id, { limit: 20, includeHidden: true })).messages).toHaveLength(6);
    await expect(editChatMessage(chat.id, visible[1].id, 'x')).rejects.toThrow(/tes propres messages/);
  });

  it('épingle un chat en tête de liste', async () => {
    const a = await createChat({ title: 'Ancien' });
    await createChat({ title: 'Récent' });
    await updateChat(a.id, { pinned: true });
    const list = await listChats();
    expect(list[0].id).toBe(a.id);
    expect((await toChatDTO(list[0])).pinned).toBe(true);
  });
});
