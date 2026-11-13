import { afterAll, beforeAll, expect, it } from 'vitest';
import { openDatabase, closeDatabase } from '../src/db/client.ts';
import { createAgent, getAgent, mainConversationId } from '../src/agents/repo.ts';
import { buildTools } from '../src/agents/tools.ts';
import { resolveApproval } from '../src/approvals/service.ts';
let ctx: any;
const options = { toolCallId: 'profile', messages: [] } as any;
beforeAll(async () => { await openDatabase({ memory: true }); const agent = await createAgent({ name: 'Ari' }); ctx = { agent, conversationId: await mainConversationId(agent.id), isMain: true, userTurn: true, depth: 0, tz: 'UTC' }; });
afterAll(closeDatabase);
it('propose la modification des cibles demandées et retourne leur état persisté après validation', async () => {
  const tools = buildTools(ctx);
  for (const [name, color] of [['Venty', '#F59E0B'], ['Homey', '#8B5CF6']]) {
    const target = await createAgent({ name });
    const out = await tools.agent_update_profile.execute!({ target: name, color }, options) as { approvalId: string };
    expect(out).toMatchObject({ ok: true, status: 'pending_approval' });
    expect((await getAgent(target.id))?.color).toBe(target.color);
    expect(await resolveApproval(out.approvalId, 'approve', { by: 'ui', notifyAgent: false }))
      .toMatchObject({ status: 'executed', result: { profile: { color } } });
    expect((await getAgent(target.id))?.color).toBe(color);
  }
  expect(await tools.agent_update_profile.execute!({ target: 'absent', color: '#FFFFFF' }, options)).toMatchObject({ ok: false });
});
it('ne donne aucun outil de mutation de profil aux tours non autorisés', () => {
  for (const flags of [{ userTurn: false, isMain: true }, { userTurn: true, isMain: false }]) expect(buildTools({ ...ctx, ...flags }).agent_update_profile).toBeUndefined();
});

it('déduplique les mises à jour identiques dans un tour', async () => {
  const seen: string[] = [];
  const tools = buildTools({ ...ctx, onStatus: async (text: string) => { seen.push(text); } });
  await tools.text_user.execute!({ text: 'Un fichier modifié.' }, options);
  await tools.text_user.execute!({ text: 'Un fichier modifié.' }, options);
  expect(seen).toEqual(['Un fichier modifié.']);
});
