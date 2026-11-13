import { and, eq, inArray, type SQL } from 'drizzle-orm';
import type { UIMessageChunk } from 'ai';
import { db, schema, type DB } from '../db/client.ts';
import { enqueue, kick } from '../jobs/queue.ts';
import { saveMessage } from '../conversations/repo.ts';
import { postTeamNote, updateTeamMessage, type TeamMessageRow } from './service.ts';
import { getAgent, mainConversationId } from '../agents/repo.ts';
import { publish } from '../bus.ts';
import { ActiveStream } from '../agents/streams.ts';
import { newId } from '../util.ts';

/** Contexte d'une délégation en cours, transmis aux outils du tour d'équipe. */
export interface TeamDelegation {
  teamMessageId: string;
  fromAgentId: string;
  fromName: string;
  task: string;
  depth: number;
  expectsReply: boolean;
  pairConversationId: string;
  mainConversationId: string;
}

export type HandoffKind = 'approval' | 'question' | 'desktop' | 'connection' | 'secure_login';

/** Réveil qui reprend le fil d'équipe sans remettre la profondeur à zéro. */
export interface TeamResumeWake {
  handoffId: string;
  teamMessageId: string;
  fromAgentId: string;
  expectsReply: boolean;
  depth: number;
}

export type HandoffRow = typeof schema.teamHandoffs.$inferSelect;

export function withDelegationSummary(delegation: TeamDelegation | null | undefined, summary: string): string {
  if (!delegation) return summary;
  const task = delegation.task.replace(/\s+/g, ' ').trim().slice(0, 90);
  return task ? `${delegation.fromName} · « ${task} » — ${summary}` : `${delegation.fromName} — ${summary}`;
}

function contextLine(agentName: string, delegation: TeamDelegation, detail: string): string {
  const task = delegation.task.replace(/\s+/g, ' ').trim().slice(0, 280);
  return `${delegation.fromName} a demandé à ${agentName} : « ${task} ». ${detail}`;
}

/** Carte visible dans le fil principal du compagnon qui agit, là où Robin lit. */
async function mirrorUserCard(input: {
  agentId: string;
  mainConversationId: string;
  text: string;
  tool: string;
  toolInput?: unknown;
  output: Record<string, unknown>;
}) {
  await saveMessage(
    input.mainConversationId,
    {
      id: newId('msg'),
      role: 'assistant',
      parts: [
        { type: 'text', text: input.text },
        {
          type: `tool-${input.tool}`,
          toolCallId: newId('call'),
          state: 'output-available',
          input: input.toolInput ?? {},
          output: input.output,
        },
      ] as never,
      metadata: { kind: 'chat', agentId: input.agentId, createdAt: new Date().toISOString() },
    },
    { author: 'agent', agentId: input.agentId },
  );
}

export async function openHandoff(input: {
  agentId: string;
  kind: HandoffKind;
  refId?: string | null;
  delegation: TeamDelegation;
}, database: Pick<DB, 'insert'> = db()): Promise<HandoffRow> {
  const [row] = await database.insert(schema.teamHandoffs).values({
    id: newId('th'),
    agentId: input.agentId,
    kind: input.kind,
    refId: input.refId ?? null,
    pairConversationId: input.delegation.pairConversationId,
    mainConversationId: input.delegation.mainConversationId,
    teamMessageId: input.delegation.teamMessageId,
    fromAgentId: input.delegation.fromAgentId,
    task: input.delegation.task.slice(0, 500),
    depth: input.delegation.depth,
    expectsReply: input.delegation.expectsReply,
  }).returning();
  return row;
}

/** Copie la carte de validation dans le fil principal. */
export async function mirrorApproval(
  ctx: { agent: { id: string; name: string }; delegation?: TeamDelegation | null },
  approval: { id: string; summary: string },
  card: { tool: string; output?: Record<string, unknown> },
) {
  if (!ctx.delegation) return;
  await mirrorUserCard({
    agentId: ctx.agent.id,
    mainConversationId: await mainConversationId(ctx.agent.id),
    text: contextLine(ctx.agent.name, ctx.delegation, `Cette action attend ta validation : ${approval.summary}`),
    tool: card.tool,
    output: { ok: true, status: 'pending_approval', approvalId: approval.id, summary: approval.summary, ...(card.output ?? {}) },
  });
}

/** Affiche un formulaire ou une carte de configuration dans le fil principal. */
export async function trackUserCard(
  ctx: { agent: { id: string; name: string }; delegation?: TeamDelegation | null },
  card: { kind: 'question' | 'desktop' | 'connection' | 'secure_login'; detail: string; tool: string; input?: unknown; output: Record<string, unknown> },
) {
  if (!ctx.delegation) return card.output;
  const handoff = card.kind === 'desktop' || card.kind === 'connection' ? await openHandoff({ agentId: ctx.agent.id, kind: card.kind, delegation: ctx.delegation }) : null;
  const output = handoff ? { ...card.output, handoffId: handoff.id } : card.output;
  await mirrorUserCard({
    agentId: ctx.agent.id,
    mainConversationId: await mainConversationId(ctx.agent.id),
    text: contextLine(ctx.agent.name, ctx.delegation, card.detail),
    tool: card.tool,
    toolInput: card.input,
    output,
  });
  return output;
}

async function scheduleHandoff(where: SQL | undefined, text: string): Promise<HandoffRow[]> {
  const handoffs = await db().transaction(async (tx) => {
    const rows = await tx.update(schema.teamHandoffs)
      .set({ status: 'queued' })
      .where(and(where, eq(schema.teamHandoffs.status, 'pending')))
      .returning();
    for (const row of rows) await enqueue(
      'agent.wake',
      {
        agentId: row.agentId,
        conversationId: row.pairConversationId,
        event: {
          type: row.kind === 'approval' ? 'approval' : 'system',
          title: 'Suite de la délégation',
          approvalId: row.kind === 'approval' ? row.refId ?? undefined : undefined,
          fromAgentId: row.fromAgentId,
        },
        text:
          `${text}\n\nTu reprends la tâche que ton coéquipier t'a déléguée : « ${row.task} ».\n` +
          `Termine le travail, puis réponds à ton coéquipier. Ta réponse finale lui est transmise, ainsi qu'une note dans ton fil principal. ` +
          `Cette collaboration reste à la profondeur ${row.depth} : n'ouvre pas une nouvelle chaîne.`,
        depth: row.depth,
        teamResume: {
          handoffId: row.id,
          teamMessageId: row.teamMessageId,
          fromAgentId: row.fromAgentId,
          expectsReply: row.expectsReply,
          depth: row.depth,
        } satisfies TeamResumeWake,
      },
      { agentId: row.agentId, dedupeKey: `handoff:${row.id}` },
      tx,
    );
    return rows;
  });
  if (handoffs.length) kick();
  return handoffs;
}

export function resumeReferencedHandoff(agentId: string, kind: 'question' | 'approval' | 'secure_login', refId: string, text: string) {
  return scheduleHandoff(and(eq(schema.teamHandoffs.agentId, agentId), eq(schema.teamHandoffs.kind, kind), eq(schema.teamHandoffs.refId, refId)), text);
}

export function resumeSetupHandoff(agentId: string, kind: 'desktop' | 'connection', handoffId: string, text: string) {
  return scheduleHandoff(and(eq(schema.teamHandoffs.agentId, agentId), eq(schema.teamHandoffs.kind, kind), eq(schema.teamHandoffs.id, handoffId)), text);
}

export async function cancelApprovalHandoff(approvalId: string, teamMessageId: string) {
  await db().update(schema.teamHandoffs).set({ status: 'cancelled' })
    .where(and(
      eq(schema.teamHandoffs.kind, 'approval'), eq(schema.teamHandoffs.refId, approvalId),
      eq(schema.teamHandoffs.teamMessageId, teamMessageId), eq(schema.teamHandoffs.status, 'pending'),
    ));
}

export async function completeHandoff(id: string) {
  await db().update(schema.teamHandoffs).set({ status: 'completed' }).where(eq(schema.teamHandoffs.id, id));
}

/**
 * Tant qu'une carte attend l'utilisateur, on ne réveille pas le compagnon qui a délégué.
 * Le résultat réel part après la décision, à la profondeur d'origine.
 */
export async function holdForUser(tm: TeamMessageRow, interim: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: schema.teamHandoffs.id })
    .from(schema.teamHandoffs)
    .where(and(eq(schema.teamHandoffs.teamMessageId, tm.id), inArray(schema.teamHandoffs.status, ['pending', 'queued'])))
    .limit(1);
  if (!row) return false;
  const actor = await getAgent(tm.toAgentId);
  await updateTeamMessage(tm.id, { status: 'waiting_for_user', reply: interim || null });
  publish({ type: 'team.changed', conversationId: tm.conversationId });
  await postTeamNote(tm.toAgentId, tm.fromAgentId, 'agent_message', 'En attente de validation avant de répondre à', interim || 'Une carte attend l’utilisateur dans ce fil.', `msg_wait_${tm.id}`);
  await postTeamNote(
    tm.fromAgentId,
    tm.toAgentId,
    'agent_reply',
    'Attend une validation de',
    `${actor?.name ?? 'Un compagnon'} a préparé une action qui attend l’utilisateur. Le résultat arrivera ensuite.${interim ? `\n\n${interim}` : ''}`,
    `msg_wait_from_${tm.id}`,
  );
  return true;
}

/** Flux court pour que le chat affiche la note pendant que le fil d'équipe reprend le travail. */
export function finishedTextStream(conversationId: string, messageId: string, text: string): ReadableStream<UIMessageChunk> {
  const stream = new ActiveStream(conversationId);
  const id = 'note';
  stream.push({ type: 'start', messageId });
  stream.push({ type: 'text-start', id });
  stream.push({ type: 'text-delta', id, delta: text });
  stream.push({ type: 'text-end', id });
  stream.push({ type: 'finish', finishReason: 'stop' });
  stream.end();
  return stream.readable();
}
