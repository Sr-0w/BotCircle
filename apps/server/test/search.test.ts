import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApplication } from '../src/app.ts';
import { authStore, closeAuthStore, registerUser, createSession } from '../src/auth/store.ts';
import { withAccount, type AccountContext } from '../src/auth/context.ts';
import { closeAllDatabases, openDatabase } from '../src/db/client.ts';
import { createAgent, mainConversationId } from '../src/agents/repo.ts';
import { saveMessage } from '../src/conversations/repo.ts';
import { createChat } from '../src/chats/repo.ts';
import { archiveChat, archiveCircleThread, deleteChatConversation } from '../src/conversations/lifecycle.ts';
import { findMatches, parseQuery } from '../src/conversations/search.ts';

/** #58: full-text search across chats and Circle threads, and inside one thread. */
let alice: AccountContext, bob: AccountContext, cookie: string, bobCookie: string;
const app = createApplication(async () => { await openDatabase({ memory: true }); });
const get = async (path: string, as = cookie) => (await app.request(`https://app.example/api${path}`, { headers: { cookie: as, 'x-opendots-client': '1' } })).json();
const say = (cv: string, id: string, text: string, role: 'user' | 'assistant' = 'user', agentId?: string) => saveMessage(cv, { id, role, parts: [{ type: 'text', text }], metadata: {} }, { author: role === 'user' ? 'user' : 'agent', agentId });
let ids: Record<string, string> = {};

beforeAll(async () => {
  await authStore(true);
  alice = await registerUser('search-alice@example.com', 'search test password'); bob = await registerUser('search-bob@example.com', 'search test password');
  cookie = `opendots_session=${await createSession(alice.id)}`; bobCookie = `opendots_session=${await createSession(bob.id)}`;
  for (const account of [alice, bob]) await withAccount(account, () => openDatabase({ memory: true }));
  ids = await withAccount(alice, async () => {
    const ari = await createAgent({ name: 'Ari' }), dev = await createAgent({ name: 'Dev' });
    const chat = await createChat({ title: 'Vacances' });
    await say(chat.id, 'c1', 'On part à Évora en été');
    await say(chat.id, 'c2', 'Réserve un hôtel près de la cathédrale', 'assistant');
    const old = await createChat({ title: 'Ancien' }); await say(old.id, 'o1', 'Le café de Évora était bon'); await archiveChat(old.id);
    const gone = await createChat({ title: 'Supprimé' }); await say(gone.id, 'g1', 'Évora secret'); await deleteChatConversation(gone.id);
    const ariMain = await mainConversationId(ari.id);
    await say(ariMain, 'a1', 'Configure opencode.json dans ~/projets/bot', 'user');
    await say(ariMain, 'a2', 'J’ai modifié opencode.json et lancé anthropic/claude-sonnet-5.5', 'assistant', ari.id);
    const devMain = await mainConversationId(dev.id);
    await say(devMain, 'd1', 'Ancienne discussion sur opencode.json', 'user');
    await archiveCircleThread(dev.id, devMain);
    for (let i = 0; i < 150; i++) await say(ariMain, `f${i}`, i === 3 ? 'un mot rare : zéphyr' : `message ordinaire ${i}`);
    return { ari: ari.id, dev: dev.id, chat: chat.id, old: old.id, ariMain, devMain };
  });
  await withAccount(bob, async () => { const c = await createChat({ title: 'Bob' }); await say(c.id, 'b1', 'Évora chez Bob'); });
});
afterAll(async () => { await closeAllDatabases(); await closeAuthStore(); });

describe('recherche', () => {
  it('normalise accents et casse, garde la ponctuation et les phrases exactes', () => {
    expect(parseQuery('Évora "Claude-Sonnet 5.5" opencode.json')).toEqual(['evora', 'claude-sonnet 5.5', 'opencode.json']);
    expect(findMatches('À ÉVORA, évora!', ['evora'])).toEqual([[2, 7], [9, 14]]);
  });

  it('trouve le contenu des messages des chats et des Circles, avec extrait surligné, jamais un autre compte ni un fil supprimé', async () => {
    const res = await get('/search?q=evora');
    expect(res.hits.map((h: any) => h.messageId)).toEqual(['c1']);
    const hit = res.hits[0];
    expect(hit).toMatchObject({ kind: 'chat', title: 'Vacances', conversationId: ids.chat });
    const [a, b] = hit.highlights[0]; expect(hit.snippet.slice(a, b)).toBe('Évora');
    // Archived only on request; deleted never; other account never.
    expect((await get('/search?q=evora&archived=1')).hits.map((h: any) => h.messageId).sort()).toEqual(['c1', 'o1']);
    expect((await get('/search?q=evora&archived=1', bobCookie)).hits.map((h: any) => h.messageId)).toEqual(['b1']);
    // Assistant messages too; technical terms with punctuation.
    expect((await get('/search?q=cathedrale')).hits.map((h: any) => h.role)).toEqual(['assistant']);
    expect((await get('/search?q=anthropic/claude-sonnet-5.5')).hits.map((h: any) => h.messageId)).toEqual(['a2']);
  });

  it('portées : chats seulement, Circles seulement, un Circle (avec ses anciens fils)', async () => {
    expect((await get('/search?q=opencode.json&scope=chats')).hits).toHaveLength(0);
    expect((await get('/search?q=opencode.json&scope=circles')).hits.map((h: any) => h.messageId).sort()).toEqual(['a1', 'a2']);
    expect((await get('/search?q=opencode.json&scope=circles&archived=1')).hits.map((h: any) => h.messageId).sort()).toEqual(['a1', 'a2', 'd1']);
    const dev = await get(`/search?q=opencode.json&agentId=${ids.dev}`);
    expect(dev.hits.map((h: any) => h.messageId)).toEqual(['d1']);
    expect(dev.hits[0]).toMatchObject({ kind: 'circle', title: 'Dev', archived: true, current: false });
    // Recent first or best match first.
    expect((await get('/search?q=opencode.json&sort=recent&scope=circles')).hits[0].messageId).toBe('a2');
  });

  it('recherche dans un fil (précédent / suivant) et ouverture au bon message dans un long historique', async () => {
    const inThread = await get(`/conversations/${ids.ariMain}/search?q=opencode.json`);
    expect(inThread.map((r: any) => r.messageId)).toEqual(['a1', 'a2']);
    expect((await get(`/conversations/${ids.ariMain}/search?q=zephyr`)).map((r: any) => r.messageId)).toEqual(['f3']);
    expect((await app.request(`https://app.example/api/conversations/${ids.ariMain}/search?q=x`, { headers: { cookie: bobCookie, 'x-opendots-client': '1' } })).status).toBe(404);
    const page = await get(`/agents/${ids.ari}/messages`);
    expect(page.messages.map((m: any) => m.id)).not.toContain('a1');
    const around = await get(`/agents/${ids.ari}/messages?around=a1`);
    expect(around.messages.map((m: any) => m.id)).toContain('a1');
    // New content is searchable at once; deleted content disappears.
    await withAccount(alice, () => say(ids.chat, 'c3', 'Nouveau mot : quokka'));
    expect((await get('/search?q=quokka')).hits).toHaveLength(1);
    await withAccount(alice, () => deleteChatConversation(ids.chat));
    expect((await get('/search?q=quokka')).hits).toHaveLength(0);
  });
});
