import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { createApplication } from '../src/app.ts';
import { authStore, closeAuthStore, registerUser, createSession } from '../src/auth/store.ts';
import { withAccount, type AccountContext } from '../src/auth/context.ts';
import { closeAllDatabases, db, openDatabase, schema } from '../src/db/client.ts';
import { readAttachment, storeImage } from '../src/attachments/service.ts';
import { archivedConversations, createAgent, mainConversationId } from '../src/agents/repo.ts';
import { loadMessages, saveMessage } from '../src/conversations/repo.ts';
import { createChat, getChat, listChats } from '../src/chats/repo.ts';
import { createTask } from '../src/tasks/service.ts';
import { createArtifact, getArtifact } from '../src/artifacts/service.ts';
import { listMemories, remember } from '../src/memory/repo.ts';

/** #56: archive (reversible), restore, delete (final, confirmed) for general chats and a Circle's threads. */
let alice: AccountContext, bob: AccountContext, cookie: string, bobCookie: string;
const app = createApplication(async () => { await openDatabase({ memory: true }); });
const call = (path: string, method = 'POST', body?: unknown, as = cookie) => app.request(`https://app.example/api${path}`, { method, headers: { cookie: as, 'x-opendots-client': '1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const say = (conversationId: string, id: string, text: string, files: any[] = []) => saveMessage(conversationId, { id, role: 'user', parts: [{ type: 'text', text }, ...files], metadata: {} }, { author: 'user' });

beforeAll(async () => {
  await authStore(true);
  alice = await registerUser('lifecycle-alice@example.com', 'lifecycle test password'); bob = await registerUser('lifecycle-bob@example.com', 'lifecycle test password');
  cookie = `opendots_session=${await createSession(alice.id)}`; bobCookie = `opendots_session=${await createSession(bob.id)}`;
  for (const account of [alice, bob]) await withAccount(account, () => openDatabase({ memory: true }));
});
afterAll(async () => { await closeAllDatabases(); await closeAuthStore(); });

describe('chats généraux', () => {
  it('archiver cache le chat sans rien perdre ; on le retrouve, on l’ouvre, on le restaure', async () => {
    const chat = await withAccount(alice, async () => { const c = await createChat({ title: 'Voyage' }); await say(c.id, 'v1', 'Prépare l’itinéraire'); return c; });
    expect((await call(`/chats/${chat.id}/archive`)).status).toBe(200);
    await withAccount(alice, async () => {
      expect((await listChats()).map((c) => c.id)).not.toContain(chat.id);
      expect((await listChats(undefined, { archived: true })).map((c) => c.id)).toContain(chat.id);
      expect((await listChats('itinéraire', { archived: true })).map((c) => c.id)).toContain(chat.id);
      expect((await getChat(chat.id))?.archived).toBe(true);
      expect((await loadMessages(chat.id, { limit: 10 })).messages).toHaveLength(1);
    });
    const listed = await (await call('/chats?archived=1', 'GET')).json();
    expect(listed.find((c: any) => c.id === chat.id)).toMatchObject({ archived: true, title: 'Voyage' });
    // Another account cannot touch it.
    expect((await call(`/chats/${chat.id}/restore`, 'POST', undefined, bobCookie)).status).toBe(404);
    expect((await call(`/chats/${chat.id}/restore`)).status).toBe(200);
    await withAccount(alice, async () => expect((await listChats()).map((c) => c.id)).toContain(chat.id));
  });

  it('supprimer demande confirmation pour les tâches actives, nettoie messages, images et fichiers envoyés, garde le reste', async () => {
    const { chat, ari, image, upload, made } = await withAccount(alice, async () => {
      const ari = await createAgent({ name: 'Ari' });
      const chat = await createChat({ title: 'À supprimer' });
      const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff0000' } }).png().toBuffer();
      const image = await storeImage(png, 'photo.png');
      await say(chat.id, 'd1', 'Regarde', [{ type: 'file', url: image.url, mediaType: 'image/jpeg', filename: 'photo.jpg' }]);
      const upload = await createArtifact({ bytes: Buffer.from('a'), name: 'notes.txt', authorKind: 'user', source: 'upload', conversationId: chat.id });
      const made = await createArtifact({ bytes: Buffer.from('b'), name: 'rapport.md', authorKind: 'agent', authorId: ari.id, source: 'agent', conversationId: chat.id });
      await createTask({ agentId: ari.id, conversationId: chat.id, title: 'Analyse longue', instruction: 'x', requestedBy: 'user' });
      await remember(ari.id, 'Robin aime le thé');
      return { chat, ari, image, upload, made };
    });
    const refused = await call(`/chats/${chat.id}`, 'DELETE', {});
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ status: 'active_tasks', tasks: [{ title: 'Analyse longue' }] });
    await withAccount(alice, async () => expect((await loadMessages(chat.id, { limit: 10 })).messages).toHaveLength(1));
    expect((await call(`/chats/${chat.id}`, 'DELETE', { confirmTasks: true })).status).toBe(200);
    await withAccount(alice, async () => {
      expect(await getChat(chat.id)).toBeNull();
      expect((await listChats(undefined, { archived: true })).map((c) => c.id)).not.toContain(chat.id);
      expect((await loadMessages(chat.id, { limit: 10 })).messages).toHaveLength(0);
      expect(await readAttachment(image.id)).toBeNull();
      expect((await db().select().from(schema.artifacts).where(eq(schema.artifacts.id, upload.id)))[0].deletedAt).not.toBeNull();
      expect(await getArtifact(made.id)).not.toBeNull();
      // The task keeps running; a late result is not written into the deleted chat.
      const [task] = await db().select().from(schema.tasks).where(eq(schema.tasks.agentId, ari.id));
      expect(task.status).not.toBe('cancelled');
      await say(chat.id, 'late', 'résultat tardif');
      expect((await loadMessages(chat.id, { limit: 10 })).messages).toHaveLength(0);
      expect((await listMemories(ari.id)).map((m) => m.content)).toContain('Robin aime le thé');
    });
    expect((await call(`/chats/${chat.id}/restore`)).status).toBe(404);
  });
});

describe('fils d’un Circle', () => {
  it('archiver le fil courant en ouvre un vierge ; restaurer échange les fils sans rien perdre ; supprimer un fil archivé', async () => {
    const { agent, first } = await withAccount(alice, async () => {
      const agent = await createAgent({ name: 'Homey' });
      const first = await mainConversationId(agent.id);
      await say(first, 'h1', 'Allume le salon');
      return { agent, first };
    });
    const archived = await (await call(`/agents/${agent.id}/conversations/${first}/archive`)).json();
    expect(archived.conversationId).not.toBe(first);
    await withAccount(alice, async () => {
      expect(await mainConversationId(agent.id)).toBe(archived.conversationId);
      expect((await archivedConversations(agent.id)).map((r) => r.id)).toEqual([first]);
      await say(archived.conversationId, 'h2', 'Nouveau sujet');
    });
    const restored = await (await call(`/agents/${agent.id}/conversations/${first}/restore`)).json();
    expect(restored).toEqual({ conversationId: first, archivedId: archived.conversationId });
    await withAccount(alice, async () => {
      expect(await mainConversationId(agent.id)).toBe(first);
      expect((await loadMessages(first, { limit: 10 })).messages.map((m) => m.id)).toEqual(['h1']);
      expect((await archivedConversations(agent.id)).map((r) => r.id)).toEqual([archived.conversationId]);
    });
    // Another Circle's id, or another account, is refused.
    const other = await withAccount(alice, () => createAgent({ name: 'Autre' }));
    expect((await call(`/agents/${other.id}/conversations/${first}`, 'DELETE', {})).status).toBe(404);
    expect((await call(`/agents/${agent.id}/conversations/${archived.conversationId}`, 'DELETE', {}, bobCookie)).status).toBe(404);
    expect((await call(`/agents/${agent.id}/conversations/${archived.conversationId}`, 'DELETE', {})).status).toBe(200);
    await withAccount(alice, async () => {
      expect(await archivedConversations(agent.id)).toHaveLength(0);
      expect((await loadMessages(archived.conversationId, { limit: 10 })).messages).toHaveLength(0);
    });
  });

  it('supprimer le fil courant laisse un fil vierge ; un résultat tardif arrive dans le fil courant', async () => {
    const { agent, current } = await withAccount(alice, async () => {
      const agent = await createAgent({ name: 'Dev' });
      const current = await mainConversationId(agent.id);
      await say(current, 'x1', 'Corrige le bug');
      return { agent, current };
    });
    const res = await (await call(`/agents/${agent.id}/conversations/${current}`, 'DELETE', {})).json();
    expect(res.conversationId).not.toBe(current);
    await withAccount(alice, async () => {
      expect(await mainConversationId(agent.id)).toBe(res.conversationId);
      expect(await archivedConversations(agent.id)).toHaveLength(0);
      await saveMessage(current, { id: 'late2', role: 'assistant', parts: [{ type: 'text', text: 'Bug corrigé' }], metadata: {} }, { author: 'agent', agentId: agent.id });
      expect((await loadMessages(res.conversationId, { limit: 10 })).messages.map((m) => m.id)).toEqual(['late2']);
    });
  });
});
