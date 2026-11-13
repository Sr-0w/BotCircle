import { sendInstruction, taskByWorkConversation } from '../tasks/service.ts';
import { and, desc, eq, exists } from 'drizzle-orm';
import type { ApprovalDTO, ApprovalStatus } from '@opendots/shared';
import { db, schema } from '../db/client.ts';
import { publish } from '../bus.ts';
import { log } from '../journal.ts';
import { enqueue } from '../jobs/queue.ts';
import { cancelApprovalHandoff, openHandoff, resumeReferencedHandoff, withDelegationSummary, type TeamDelegation } from '../team/handoff.ts';
import { errorMessage, newId } from '../util.ts';
import { getConnector } from '../connectors/repo.ts';

/**
 * Moteur d'approbation : une opération sensible est enregistrée « préparée »,
 * puis exécutée par le backend uniquement après validation humaine. Le
 * résultat réel (exécutée / échouée) est conservé et renvoyé au compagnon.
 */
type Row = typeof schema.approvals.$inferSelect;
type Executor = (input: any, approval: Row) => Promise<unknown>;

const executors = new Map<string, Executor>();
const rejectHooks = new Map<string, Executor>();

export function registerApprovalAction(action: string, executor: Executor, onReject?: Executor) {
  executors.set(action, executor);
  if (onReject) rejectHooks.set(action, onReject);
}

export function toApprovalDTO(r: Row): ApprovalDTO {
  return {
    service: r.service ?? null,
    id: r.id,
    agentId: r.agentId,
    conversationId: r.conversationId,
    action: r.action,
    summary: r.summary,
    input: r.input,
    status: r.status,
    result: r.result,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
  };
}

export async function createApproval(input: {
  agentId: string;
  conversationId: string;
  toolCallId?: string;
  action: string;
  summary: string;
  input: unknown;
  delegation?: TeamDelegation | null;
}): Promise<Row> {
  const { delegation } = input;
  const service = await serviceOf(input.action, input.input);
  const row = {
    service,
    id: newId('ap'),
    agentId: input.agentId,
    conversationId: input.conversationId,
    toolCallId: input.toolCallId ?? null,
    action: input.action,
    summary: withDelegationSummary(delegation, input.summary),
    input: input.input as object,
  };
  const created = await db().transaction(async (tx) => {
    const [approval] = await tx.insert(schema.approvals).values(row).returning();
    if (delegation) await openHandoff({ agentId: input.agentId, kind: 'approval', refId: row.id, delegation }, tx);
    return approval;
  });
  publish({ type: 'approval.changed', approval: toApprovalDTO(created) });
  await log(input.agentId, 'approval.requested', `Validation demandée : ${row.summary}`, { approvalId: row.id });
  return created;
}

/** Where an operation acts, for the card's logo: the connected service, or the kind of capability. */
async function serviceOf(action: string, input: unknown): Promise<string | null> {
  if (action === 'integration.call') {
    const id = (input as { connectorId?: string } | null)?.connectorId;
    const connector = id ? await getConnector(id).catch(() => null) : null;
    return (connector?.config as { provider?: string } | undefined)?.provider ?? null;
  }
  if (action.startsWith('mail.')) return 'mail';
  if (action.startsWith('computer.')) return 'computer';
  if (action.startsWith('shell.')) return 'terminal';
  if (action.startsWith('mcp.')) return 'mcp';
  return null;
}

export async function getApproval(id: string): Promise<Row | null> {
  const [row] = await db().select().from(schema.approvals).where(eq(schema.approvals.id, id));
  return row ?? null;
}

export async function listApprovals(filter: { agentId?: string; status?: ApprovalStatus } = {}): Promise<ApprovalDTO[]> {
  const conds = [];
  if (filter.agentId) conds.push(eq(schema.approvals.agentId, filter.agentId));
  if (filter.status) conds.push(eq(schema.approvals.status, filter.status));
  const rows = await db()
    .select()
    .from(schema.approvals)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(schema.approvals.createdAt))
    .limit(200);
  return rows.map(toApprovalDTO);
}

async function setStatus(id: string, patch: Partial<Row>): Promise<Row> {
  await db().update(schema.approvals).set(patch).where(eq(schema.approvals.id, id));
  const row = (await getApproval(id))!;
  publish({ type: 'approval.changed', approval: toApprovalDTO(row) });
  return row;
}

export class ApprovalError extends Error {}

/**
 * Applique une décision. `notifyAgent` réveille le compagnon pour qu'il
 * rapporte le résultat (inutile si la décision vient de sa propre conversation).
 */
export async function resolveApproval(
  id: string,
  decision: 'approve' | 'reject',
  opts: { by: 'ui' | 'conversation'; notifyAgent: boolean } | { by: 'agent'; teamMessageId: string },
): Promise<Row> {
  if (opts.by === 'agent' && decision !== 'reject') throw new ApprovalError('Seul l’utilisateur peut valider cette action.');
  const editableDraft = opts.by === 'agent' ? and(eq(schema.approvals.action, 'mail.send'), exists(
    db().select({ id: schema.teamHandoffs.id }).from(schema.teamHandoffs).where(and(
      eq(schema.teamHandoffs.kind, 'approval'), eq(schema.teamHandoffs.refId, id),
      eq(schema.teamHandoffs.teamMessageId, opts.teamMessageId), eq(schema.teamHandoffs.status, 'pending'),
    )),
  )) : undefined;
  // Transition atomique pending → approved/rejected : une seule exécution possible.
  const claimed = await db()
    .update(schema.approvals)
    .set({ status: decision === 'approve' ? 'approved' : 'rejected', resolvedAt: new Date(), resolvedBy: opts.by })
    .where(and(eq(schema.approvals.id, id), eq(schema.approvals.status, 'pending'), editableDraft))
    .returning();
  if (!claimed.length) {
    if (opts.by === 'agent') throw new ApprovalError('Ce brouillon ne peut pas être remplacé dans cet échange.');
    const existing = await getApproval(id);
    if (!existing) throw new ApprovalError('Demande de validation introuvable.');
    throw new ApprovalError(`Cette demande a déjà été traitée (statut : ${existing.status}).`);
  }
  let row = claimed[0];
  publish({ type: 'approval.changed', approval: toApprovalDTO(row) });

  if (decision === 'reject') {
    await rejectHooks.get(row.action)?.(row.input, row).catch(() => {});
    await log(row.agentId, 'approval.rejected', `Refusé : ${row.summary}`, { approvalId: id });
  } else {
    const executor = executors.get(row.action);
    try {
      if (!executor) throw new Error(`Action inconnue : ${row.action}`);
      const result = await executor(row.input, row);
      row = await setStatus(id, { status: 'executed', result: (result ?? null) as any });
      await log(row.agentId, 'approval.executed', `Exécuté : ${row.summary}`, { approvalId: id, result });
    } catch (err) {
      row = await setStatus(id, { status: 'failed', error: errorMessage(err) });
      await log(row.agentId, 'approval.failed', `Échec : ${row.summary}`, { approvalId: id, error: errorMessage(err) });
    }
  }

  if (opts.by === 'agent') {
    await cancelApprovalHandoff(id, opts.teamMessageId);
    return row;
  }

  const task = await taskByWorkConversation(row.conversationId);
  if (task) {
    // Demandée par un worker : la décision est versée à sa tâche, qui reprend d'elle-même.
    const verdict = row.status === 'executed' ? `L'utilisateur a approuvé « ${row.summary} » et l'action a été exécutée. Résultat : ${JSON.stringify(row.result)}`
      : row.status === 'failed' ? `L'utilisateur a approuvé « ${row.summary} » mais l'exécution a échoué : ${row.error}`
        : `L'utilisateur a refusé « ${row.summary} ». Ne la réessaie pas ; continue autrement ou conclus.`;
    if (task.status === 'waiting_for_user' || task.status === 'paused' || task.status === 'running' || task.status === 'queued') await sendInstruction(task.id, verdict).catch(() => {});
    return row;
  }
  const outcome =
    row.status === 'executed'
      ? `L'utilisateur a approuvé et l'action a été exécutée avec succès. Résultat : ${JSON.stringify(row.result)}`
      : row.status === 'failed'
        ? `L'utilisateur a approuvé mais l'exécution a échoué : ${row.error}`
        : `L'utilisateur a refusé cette action. Ne la réessaie pas sans nouvelle demande.`;
  // Une validation née d'un échange entre compagnons reprend ce fil, à la profondeur d'origine.
  // Personne d'autre que l'utilisateur ne peut l'avoir décidée.
  const [handoff] = await resumeReferencedHandoff(row.agentId, 'approval', row.id, outcome);
  if (!handoff && opts.notifyAgent) {
    await enqueue(
      'agent.wake',
      {
        agentId: row.agentId,
        conversationId: row.conversationId,
        event: { type: 'approval', title: `Validation : ${row.summary}`, approvalId: row.id },
        text: `${outcome}\nInforme brièvement l'utilisateur du résultat réel.`,
        depth: 0,
      },
      { agentId: row.agentId, dedupeKey: `approval:${row.id}` },
    );
  }
  return row;
}
