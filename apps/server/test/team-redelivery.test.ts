import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

// #65: a team.deliver job replayed a day later (retry, restart recovery) must not re-insert/re-announce the
// "Message reçu de …" card in the recipient's current chat.
const calls: any[] = [];
vi.mock('../src/agents/turn.ts', () => ({
  isAgentBusy: () => false,
  runTurn: (_a: string, _c: string, trigger: any) => {
    calls.push(trigger);
    return { stream: null, done: Promise.resolve({ messageId: null, text: 'Ok.', silent: false, error: null, noReply: false }) };
  },
}));

const { closeDatabase, db, openDatabase, schema } = await import('../src/db/client.ts');
const { createAgent, mainConversationId } = await import('../src/agents/repo.ts');
const { loadMessages } = await import('../src/conversations/repo.ts');
const { postTeamNote } = await import('../src/team/service.ts');
const { subscribe } = await import('../src/bus.ts');

beforeAll(async () => { await openDatabase({ memory: true }); });
afterAll(async () => { await closeDatabase(); });

describe('#65 rejeu d’un événement d’équipe', () => {
  it('ne réinsère ni ne ré-annonce une carte déjà enregistrée', async () => {
    const hugues = await createAgent({ name: 'Hugues' });
    const ari = await createAgent({ name: 'Ari' });
    const conv = await mainConversationId(ari.id);
    await postTeamNote(ari.id, hugues.id, 'agent_message', 'Message reçu de', 'Couleur mise à jour', 'msg_rcv_tm_1');
    const [first] = await db().select().from(schema.messages).where(eq(schema.messages.id, 'msg_rcv_tm_1'));
    // The user's current conversation moves on…
    await db().insert(schema.messages).values({ id: 'msg_user_now', conversationId: conv, role: 'user', author: 'user', parts: [{ type: 'text', text: 'Lance OpenCode' }], metadata: {}, textContent: 'Lance OpenCode', createdAt: new Date(Date.now() + 86_400_000) });
    const seen: string[] = [];
    const off = subscribe((e) => { if (e.type === 'message.created') seen.push(e.messageId); });
    // …then the job is replayed.
    await postTeamNote(ari.id, hugues.id, 'agent_message', 'Message reçu de', 'Couleur mise à jour', 'msg_rcv_tm_1');
    off();
    expect(seen).toEqual([]);
    const [again] = await db().select().from(schema.messages).where(eq(schema.messages.id, 'msg_rcv_tm_1'));
    expect(again.createdAt).toEqual(first.createdAt);
    expect(again.seq).toBe(first.seq);
    expect((await loadMessages(conv)).messages.filter((m) => m.id === 'msg_rcv_tm_1')).toHaveLength(1);
  });
});
