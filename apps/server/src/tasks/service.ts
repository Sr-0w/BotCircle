import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { TaskDTO, TaskEventDTO, TaskStatus } from '@opendots/shared';
import type { ModelConfig } from '@opendots/shared';
import { ACTIVE_TASK_STATUSES } from '@opendots/shared';
import { db, schema } from '../db/client.ts';
import { publish } from '../bus.ts';
import { accountKey } from '../auth/context.ts';
import { enqueue } from '../jobs/queue.ts';
import { log } from '../journal.ts';
import { newId } from '../util.ts';
import { artifactsByIds, toArtifactDTO } from '../artifacts/service.ts';
import type { ActiveStream } from '../agents/streams.ts';

/*
 * Registre des tâches : le travail long d'un compagnon, exécuté par un worker hors du tour de chat.
 *
 * Une tâche est durable (elle survit à la fermeture du client et au redémarrage du serveur), a un
 * état explicite et une progression *observée* : étapes réellement exécutées, action en cours,
 * dernier signe de vie. Le journal technique (outils, erreurs) vit dans `task_events` et dans la
 * conversation privée du worker, jamais dans le fil de l'utilisateur.
 */

export type TaskRow = typeof schema.tasks.$inferSelect;
export class TaskError extends Error {}

/** Garde-fous : budget d'étapes, répétition d'une même action, silence prolongé, tâches actives par compagnon. */
export const TASK_MAX_STEPS = Number(process.env.OPENDOTS_TASK_MAX_STEPS ?? 200);
export const TASK_LOOP_REPEATS = 6;
export const TASK_STALL_MS = Number(process.env.OPENDOTS_TASK_STALL_MINUTES ?? 20) * 60_000;
const MAX_ACTIVE_PER_AGENT = 5;

/** Flux des tours de worker en cours, pour pouvoir les interrompre (annulation, pause). */
const live = new Map<string, ActiveStream>();
const liveKey = (taskId: string) => `${accountKey()}:${taskId}`;
export const registerTaskStream = (taskId: string, stream: ActiveStream) => { live.set(liveKey(taskId), stream); };
export const releaseTaskStream = (taskId: string) => { live.delete(liveKey(taskId)); };

export async function toTaskDTO(row: TaskRow): Promise<TaskDTO> {
  return {
    id: row.id, agentId: row.agentId, conversationId: row.conversationId, title: row.title, instruction: row.instruction, status: row.status,
    phase: row.phase, currentActionSummary: row.currentAction, completedSteps: row.completedSteps, totalSteps: row.totalSteps,
    blocker: row.blocker, requiresUserInput: row.requiresUserInput, result: row.result, error: row.error,
    artifacts: (await artifactsByIds(row.artifacts)).map(toArtifactDTO), requestedBy: row.requestedBy,
    provider: row.provider, model: row.model ?? null, usedModel: row.usedModel ?? null, external: row.external ? { ...row.external, instanceName: (await externalName?.(row.external.instanceId)) ?? 'OpenCode' } : null,
    lastHeartbeat: row.lastHeartbeat?.toISOString() ?? null, createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null, finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/**
 * Une exécution externe (OpenCode) garde la même carte, le même registre et les mêmes actions qu'un worker, mais
 * l'arrêt et les consignes partent vers la session distante. Le fournisseur s'enregistre ici.
 */
export interface TaskProvider {
  /** Arrête réellement l'exécution distante ; lève une erreur si l'arrêt n'a pas pu être transmis. */
  cancel(row: TaskRow): Promise<void>;
  /** Transmet une consigne à la même session. */
  instruct(row: TaskRow, instruction: string, author: 'user' | 'companion'): Promise<void>;
  /** Reprend maintenant une exécution distante en pause (#49 : limite d'usage), dans la même session. */
  resume?(row: TaskRow): Promise<void>;
}
const providers = new Map<string, TaskProvider>();
let externalName: ((instanceId: string) => Promise<string | null>) | null = null;
export function registerTaskProvider(name: string, provider: TaskProvider, nameOf: (instanceId: string) => Promise<string | null>) { providers.set(name, provider); externalName = nameOf; }

export async function getTask(id: string): Promise<TaskRow | null> {
  const [row] = await db().select().from(schema.tasks).where(eq(schema.tasks.id, id));
  return row ?? null;
}

export async function listTasks(filter: { agentId?: string; conversationId?: string; active?: boolean; limit?: number } = {}): Promise<TaskRow[]> {
  const where = [];
  if (filter.agentId) where.push(eq(schema.tasks.agentId, filter.agentId));
  if (filter.conversationId) where.push(eq(schema.tasks.conversationId, filter.conversationId));
  if (filter.active) where.push(inArray(schema.tasks.status, ACTIVE_TASK_STATUSES));
  return db().select().from(schema.tasks).where(where.length ? and(...where) : undefined).orderBy(desc(schema.tasks.createdAt)).limit(filter.limit ?? 50);
}

export async function taskEvents(taskId: string, limit = 200): Promise<TaskEventDTO[]> {
  const rows = await db().select().from(schema.taskEvents).where(eq(schema.taskEvents.taskId, taskId)).orderBy(desc(schema.taskEvents.seq)).limit(limit);
  return rows.reverse().map((r) => ({ seq: r.seq, kind: r.kind, summary: r.summary, createdAt: r.createdAt.toISOString() }));
}

/** Les clés et jetons ne doivent jamais apparaître dans le journal consultable. */
export function redact(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, '$1 [secret]')
    .replace(/\b(sk|pk|ghp|gho|github_pat|xox[abp]|AKIA)[-_A-Za-z0-9]{12,}\b/g, '[secret]')
    .replace(/((?:password|passwd|token|secret|api[_-]?key|authorization)["'\s:=]+)[^\s"',}]{4,}/gi, '$1[secret]');
}

export async function addTaskEvent(taskId: string, kind: typeof schema.taskEvents.$inferInsert['kind'], summary: string, data?: unknown) {
  await db().insert(schema.taskEvents).values({ taskId, kind, summary: redact(summary).slice(0, 500), data: data === undefined ? null : (data as object) });
}

export async function updateTask(id: string, patch: Partial<Omit<TaskRow, 'id' | 'createdAt'>>): Promise<TaskRow> {
  const [row] = await db().update(schema.tasks).set(patch).where(eq(schema.tasks.id, id)).returning();
  if (!row) throw new TaskError('Tâche introuvable.');
  publish({ type: 'task.changed', task: await toTaskDTO(row) });
  return row;
}

/** Crée une tâche en file et lance le worker si le compagnon n'en exécute pas déjà une. */
export async function createTask(input: { agentId: string; conversationId: string; title: string; instruction: string; requestedBy: 'agent' | 'user' | 'assistant'; artifacts?: string[]; model?: ModelConfig | null }): Promise<TaskRow> {
  const active = await db().select({ id: schema.tasks.id }).from(schema.tasks).where(and(eq(schema.tasks.agentId, input.agentId), inArray(schema.tasks.status, ACTIVE_TASK_STATUSES)));
  if (active.length >= MAX_ACTIVE_PER_AGENT) throw new TaskError(`Ce compagnon a déjà ${MAX_ACTIVE_PER_AGENT} tâches en cours ou en attente : termines-en ou annules-en une d'abord.`);
  const id = newId('task');
  const workConversationId = newId('cv');
  await db().insert(schema.conversations).values({ id: workConversationId, kind: 'task', agentId: input.agentId, title: input.title.slice(0, 200) });
  await db().insert(schema.tasks).values({
    id, agentId: input.agentId, conversationId: input.conversationId, workConversationId,
    title: input.title.trim().slice(0, 200), instruction: input.instruction.trim(), requestedBy: input.requestedBy, artifacts: input.artifacts ?? [], model: input.model ?? null,
  });
  await addTaskEvent(id, 'status', 'Tâche créée, en file');
  await log(input.agentId, 'task.created', `Tâche créée : ${input.title.slice(0, 120)}`, { taskId: id });
  const row = (await getTask(id))!;
  publish({ type: 'task.changed', task: await toTaskDTO(row) });
  await startNextTask(input.agentId);
  return (await getTask(id))!;
}

/**
 * Un seul worker à la fois par compagnon : deux tâches ne se disputent jamais le même bureau ni le
 * même navigateur. La suivante démarre quand la précédente rend la main.
 */
export async function startNextTask(agentId: string) {
  const [running] = await db().select({ id: schema.tasks.id }).from(schema.tasks).where(and(eq(schema.tasks.agentId, agentId), eq(schema.tasks.status, 'running'), eq(schema.tasks.provider, 'worker'))).limit(1);
  if (running) return;
  const [next] = await db().select().from(schema.tasks).where(and(eq(schema.tasks.agentId, agentId), eq(schema.tasks.status, 'queued'), eq(schema.tasks.provider, 'worker'))).orderBy(schema.tasks.createdAt).limit(1);
  if (!next) return;
  await updateTask(next.id, { status: 'running', startedAt: next.startedAt ?? new Date(), lastHeartbeat: new Date(), blocker: null, error: null, requiresUserInput: false });
  // Sans agentId : le worker ne doit pas bloquer les réveils et messages du compagnon dans la file.
  await enqueue('task.run', { taskId: next.id }, { dedupeKey: `task:${next.id}:${Date.now()}`, maxAttempts: 1 });
}

export async function hasRunningTask(agentId: string): Promise<TaskRow | null> {
  const [row] = await db().select().from(schema.tasks).where(and(eq(schema.tasks.agentId, agentId), eq(schema.tasks.status, 'running'), eq(schema.tasks.provider, 'worker'))).limit(1);
  return row ?? null;
}

/** Une étape réellement exécutée par le worker : progression observée, signe de vie, détection de boucle. */
export async function recordStep(taskId: string, summary: string, signature: string): Promise<{ loop: boolean; overBudget: boolean }> {
  const [row] = await db().update(schema.tasks)
    .set({ completedSteps: sql`${schema.tasks.completedSteps} + 1`, currentAction: redact(summary).slice(0, 200), lastHeartbeat: new Date() })
    .where(eq(schema.tasks.id, taskId)).returning();
  if (!row) return { loop: false, overBudget: false };
  await addTaskEvent(taskId, 'step', summary, { signature: signature.slice(0, 300) });
  publish({ type: 'task.changed', task: await toTaskDTO(row) });
  const recent = await db().select({ data: schema.taskEvents.data }).from(schema.taskEvents).where(and(eq(schema.taskEvents.taskId, taskId), eq(schema.taskEvents.kind, 'step'))).orderBy(desc(schema.taskEvents.seq)).limit(TASK_LOOP_REPEATS);
  const loop = recent.length === TASK_LOOP_REPEATS && recent.every((r) => (r.data as { signature?: string } | null)?.signature === signature.slice(0, 300));
  return { loop, overBudget: row.completedSteps >= TASK_MAX_STEPS };
}

/** Consignes ajoutées en cours de route : remises au worker une seule fois, à sa prochaine étape. */
export async function takeInstructions(taskId: string): Promise<string[]> {
  const row = await getTask(taskId);
  if (!row?.pendingInstructions.length) return [];
  await db().update(schema.tasks).set({ pendingInstructions: [] }).where(eq(schema.tasks.id, taskId));
  return row.pendingInstructions;
}

export async function sendInstruction(taskId: string, instruction: string, author: 'user' | 'companion' = 'user') {
  const row = await getTask(taskId);
  if (!row) throw new TaskError('Tâche introuvable.');
  const external = providers.get(row.provider);
  if (external) {
    // Session distante : la consigne part dans LA session de cette tâche ; une session terminée peut être poursuivie.
    await external.instruct(row, instruction.trim().slice(0, 8000), author);
    await addTaskEvent(taskId, 'instruction', `Consigne envoyée : ${instruction.trim().slice(0, 300)}`);
    return (await getTask(taskId))!;
  }
  if (!ACTIVE_TASK_STATUSES.includes(row.status)) throw new TaskError('Cette tâche est terminée : démarre-en une nouvelle.');
  await db().update(schema.tasks).set({ pendingInstructions: [...row.pendingInstructions, instruction.trim().slice(0, 2000)] }).where(eq(schema.tasks.id, taskId));
  await addTaskEvent(taskId, 'instruction', `Consigne ajoutée : ${instruction.trim().slice(0, 300)}`);
  // Une tâche qui attendait l'utilisateur ou était en pause reprend avec cette consigne.
  if (row.status === 'waiting_for_user' || row.status === 'paused') return resumeTask(taskId);
  return (await getTask(taskId))!;
}

export async function cancelTask(taskId: string): Promise<TaskRow> {
  const row = await getTask(taskId);
  if (!row) throw new TaskError('Tâche introuvable.');
  if (!ACTIVE_TASK_STATUSES.includes(row.status)) return row;
  // Une exécution distante n'est dite « annulée » que si l'arrêt a réellement été transmis.
  await providers.get(row.provider)?.cancel(row);
  const updated = await updateTask(taskId, { status: 'cancelled', finishedAt: new Date(), currentAction: null, requiresUserInput: false });
  await addTaskEvent(taskId, 'status', 'Annulée');
  live.get(liveKey(taskId))?.abort.abort();
  await startNextTask(row.agentId);
  return updated;
}

export async function pauseTask(taskId: string): Promise<TaskRow> {
  const row = await getTask(taskId);
  if (!row) throw new TaskError('Tâche introuvable.');
  if (providers.has(row.provider)) throw new TaskError('Une session OpenCode ne se met pas en pause : arrête-la, ou envoie-lui une consigne.');
  if (row.status !== 'running' && row.status !== 'queued') throw new TaskError('Seule une tâche en cours peut être mise en pause.');
  const updated = await updateTask(taskId, { status: 'paused', currentAction: null });
  await addTaskEvent(taskId, 'status', 'Mise en pause');
  live.get(liveKey(taskId))?.abort.abort();
  await startNextTask(row.agentId);
  return updated;
}

export async function resumeTask(taskId: string): Promise<TaskRow> {
  const row = await getTask(taskId);
  if (!row) throw new TaskError('Tâche introuvable.');
  const external = providers.get(row.provider);
  if (external?.resume && row.status === 'paused') { await external.resume(row); return (await getTask(taskId))!; }
  if (external) throw new TaskError('Réponds à la demande d’OpenCode depuis l’espace de code, ou envoie-lui une consigne.');
  if (row.status !== 'paused' && row.status !== 'waiting_for_user') throw new TaskError('Cette tâche n’est ni en pause ni en attente.');
  const updated = await updateTask(taskId, { status: 'queued', blocker: null, requiresUserInput: false });
  await addTaskEvent(taskId, 'status', 'Reprise demandée');
  await startNextTask(row.agentId);
  return (await getTask(taskId)) ?? updated;
}

/** Le worker signale qu'il ne peut pas continuer sans l'utilisateur (choix, approbation, connexion). */
export async function waitForUser(taskId: string, blocker: string) {
  await updateTask(taskId, { status: 'waiting_for_user', blocker: blocker.slice(0, 500), requiresUserInput: true, currentAction: null });
  await addTaskEvent(taskId, 'status', `En attente de l'utilisateur : ${blocker.slice(0, 300)}`);
}

/** Tâche dont une conversation est le journal de travail. */
export async function taskByWorkConversation(conversationId: string): Promise<TaskRow | null> {
  const [row] = await db().select().from(schema.tasks).where(eq(schema.tasks.workConversationId, conversationId));
  return row ?? null;
}

/** Tâches « en cours » sans signe de vie depuis trop longtemps : échec explicite plutôt qu'un état figé. */
export async function failStalledTasks(now = Date.now()): Promise<number> {
  const stalled = await db().select().from(schema.tasks).where(and(eq(schema.tasks.status, 'running'), eq(schema.tasks.provider, 'worker'), lt(schema.tasks.lastHeartbeat, new Date(now - TASK_STALL_MS))));
  for (const row of stalled) {
    if (live.has(liveKey(row.id))) { live.get(liveKey(row.id))!.abort.abort(); }
    await updateTask(row.id, { status: 'failed', error: 'Aucun signe de vie du worker : tâche arrêtée.', finishedAt: new Date(), currentAction: null });
    await addTaskEvent(row.id, 'error', 'Arrêtée : aucun signe de vie');
    await startNextTask(row.agentId);
  }
  return stalled.length;
}
