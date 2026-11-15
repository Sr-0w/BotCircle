import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, closeDatabase } from '../src/db/client.ts';
import { archivedConversations, createAgent, mainConversationId, resetMainConversation } from '../src/agents/repo.ts';
import { getConversation, loadMessages, saveMessage } from '../src/conversations/repo.ts';

beforeAll(async () => { await openDatabase({ memory: true }); });
afterAll(async () => { await closeDatabase(); });

describe('/clear (#46)', () => {
  it('met le fil de côté (conservé), en ouvre un vierge, une seule fois même si la demande est répétée', async () => {
    const agent = await createAgent({ name: 'Ari' });
    const old = await mainConversationId(agent.id);
    await saveMessage(old, { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Ancien contexte' }], metadata: {} } as any, { author: 'user' });
    const first = await resetMainConversation(agent.id, old);
    expect(first.archivedId).toBe(old);
    expect(first.conversationId).not.toBe(old);
    expect(await mainConversationId(agent.id)).toBe(first.conversationId);
    expect((await loadMessages(first.conversationId)).messages).toHaveLength(0);
    // L'ancien fil existe toujours, lisible, marqué archivé.
    expect((await getConversation(old))?.kind).toBe('archive');
    expect((await loadMessages(old)).messages.map((m) => m.id)).toEqual(['m1']);
    expect((await archivedConversations(agent.id)).map((a) => a.id)).toEqual([old]);
    // Double tap / nouvel essai réseau : rien de plus.
    const again = await resetMainConversation(agent.id, old);
    expect(again).toEqual({ conversationId: first.conversationId, archivedId: null });
    expect(await archivedConversations(agent.id)).toHaveLength(1);
  });
});
