import type { AgentAvatar } from '@opendots/shared';
import { eq } from 'drizzle-orm';
import { registerApprovalAction } from '../approvals/service.ts';
import { publish } from '../bus.ts';
import { db, schema } from '../db/client.ts';
import { getAgent, toAgentDTO } from './repo.ts';

/** #50: applies a silhouette, keeping the previous one so it can be restored. */
export async function applyAvatar(agentId: string, avatar: AgentAvatar | null, color?: string) {
  const agent = await getAgent(agentId);
  if (!agent || agent.archived) throw new Error('Circle introuvable.');
  await db().update(schema.agents).set({ avatar, avatarPrevious: agent.avatar ?? null, ...(color ? { color } : {}), updatedAt: new Date() }).where(eq(schema.agents.id, agentId));
  const row = (await getAgent(agentId))!;
  publish({ type: 'agent.updated', agent: await toAgentDTO(row) });
  return row;
}

export async function restoreAvatar(agentId: string) {
  const agent = await getAgent(agentId);
  if (!agent) throw new Error('Circle introuvable.');
  if (!agent.avatarPrevious && !agent.avatar) return agent;
  return applyAvatar(agentId, agent.avatarPrevious ?? null);
}

// A silhouette proposed by a Circle is only applied once the user approved the preview.
registerApprovalAction('avatar.set', async (input: { agentId: string; avatar: AgentAvatar; color?: string }) => {
  const row = await applyAvatar(input.agentId, input.avatar, input.color);
  return { ok: true, agent: row.name, shape: input.avatar.preset ?? 'custom' };
});
