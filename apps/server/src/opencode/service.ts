import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  ACTIVE_TASK_STATUSES, type OpencodeDiffDTO, type OpencodeExchangeDTO, type OpencodeFileNodeDTO, type OpencodeInstanceDTO, type OpencodeMessageDTO, type OpencodePartDTO,
  type OpencodeProjectDTO, type OpencodeSessionDTO, type OpencodeWorkspaceDTO, type TaskExternalRef, type OpencodeCurrentModelDTO, type OpencodeModelRef, type OpencodeModelsDTO,
  OPENCODE_FILE_MAX_BYTES, OPENCODE_FILES_MAX_BYTES, OPENCODE_FILES_MAX_COUNT,
} from '@opendots/shared';
import { publish } from '../bus.ts';
import { accountKey } from '../auth/context.ts';
import { db, schema } from '../db/client.ts';
import { enqueue } from '../jobs/queue.ts';
import { log } from '../journal.ts';
import { decryptSecret, encryptSecret } from '../secrets.ts';
import { addTaskEvent, getTask, registerTaskProvider, toTaskDTO, updateTask, type TaskRow } from '../tasks/service.ts';
import { errorMessage, newId, truncate } from '../util.ts';
import { detectApi, OpencodeHttpError, OpencodeUnreachable, OpencodeV1Client, OpencodeV2Client, parsePairingLink, redeemPairingCode, V1Api, type Delivery, type OpencodeApi, type OpencodeTarget, type PromptFile, type RawMessage, type RawModel, type RawPart, type RawSession } from './client.ts';

/*
 * OpenCode dans BotCircle. OpenCode fait le code sur sa machine ; BotCircle tient l'accès, la propriété de la
 * tâche, la communication et l'affichage. Une délégation est une tâche du registre commun (#24) dont le
 * fournisseur est `opencode` : même carte, même liste, mêmes règles (« une carte, pas de bulles »), mais l'état
 * vient de la session distante, relu à chaque battement. Rien n'est affirmé qui n'ait été observé :
 * une instance injoignable donne un état « inconnu », jamais un succès ni un échec.
 */

export class OpencodeError extends Error {}
export type InstanceRow = typeof schema.opencodeInstances.$inferSelect;

let fetcher: typeof fetch = (...args) => fetch(...args);
/** Pour les tests : remplace l'accès réseau. */
export function setOpencodeFetch(next: typeof fetch | null) { fetcher = next ?? ((...args) => fetch(...args)); }

const targetOf = (row: InstanceRow): OpencodeTarget => ({ baseUrl: row.baseUrl, username: row.username, password: row.password ? decryptSecret(row.password) : null });
/** The API an instance speaks, as last detected; an instance never checked is detected now. */
async function clientFor(row: InstanceRow): Promise<OpencodeApi> {
  if (row.apiVersion === 'v2') return new OpencodeV2Client(targetOf(row), fetcher);
  if (row.apiVersion === 'v1') return new V1Api(new OpencodeV1Client(targetOf(row), fetcher));
  const api = await detectApi(targetOf(row), fetcher);
  await db().update(schema.opencodeInstances).set({ apiVersion: api.version }).where(eq(schema.opencodeInstances.id, row.id));
  return api;
}

// --- Instances -----------------------------------------------------------------------

export function checkBaseUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new OpencodeError('Adresse invalide. Exemple : https://code.exemple.fr ou http://100.64.0.2:4096'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new OpencodeError('L’adresse doit commencer par https:// ou http://.');
  if (url.username || url.password) throw new OpencodeError('Ne mets pas les identifiants dans l’adresse : utilise les champs prévus.');
  url.hash = ''; url.search = '';
  return url.toString().replace(/\/$/, '');
}

async function activeCount(instanceId: string) {
  const rows = await db().select({ external: schema.tasks.external }).from(schema.tasks).where(and(eq(schema.tasks.provider, 'opencode'), inArray(schema.tasks.status, ACTIVE_TASK_STATUSES)));
  return rows.filter((r) => r.external?.instanceId === instanceId).length;
}

export async function toInstanceDTO(row: InstanceRow): Promise<OpencodeInstanceDTO> {
  return {
    id: row.id, name: row.name, baseUrl: row.baseUrl, username: row.username, hasPassword: Boolean(row.password), defaultDirectory: row.defaultDirectory,
    version: row.version, state: row.lastError ? 'offline' : row.lastSeenAt ? 'online' : 'unknown',
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null, lastError: row.lastError, activeTasks: await activeCount(row.id),
    apiVersion: row.apiVersion ?? null, authKind: row.authKind, tokenExpiresAt: row.tokenExpiresAt?.toISOString() ?? null,
  };
}

export const listInstances = () => db().select().from(schema.opencodeInstances).orderBy(schema.opencodeInstances.createdAt);
export async function getInstance(id: string): Promise<InstanceRow | null> {
  const [row] = await db().select().from(schema.opencodeInstances).where(eq(schema.opencodeInstances.id, id));
  return row ?? null;
}
/** Par id ou par nom (insensible à la casse) : c'est ainsi qu'un compagnon désigne une machine. */
export async function findInstance(ref: string): Promise<InstanceRow | null> {
  const all = await listInstances();
  return all.find((i) => i.id === ref) ?? all.find((i) => i.name.toLowerCase() === ref.trim().toLowerCase()) ?? null;
}

/** Contrôle réel : l'instance répond-elle, et est-ce bien OpenCode ? Le résultat est enregistré tel quel. */
export async function checkInstance(row: InstanceRow): Promise<InstanceRow> {
  let patch: Partial<InstanceRow>;
  try {
    const api = await detectApi(targetOf(row), fetcher);
    const health = await api.health();
    if (!health?.healthy) throw new OpencodeUnreachable('L’instance ne se déclare pas en bonne santé.');
    patch = { version: health.version ?? null, apiVersion: api.version, lastSeenAt: new Date(), lastError: null };
  } catch (error) {
    const expired = row.authKind === 'pairing' && error instanceof OpencodeHttpError && (error.status === 401 || error.status === 403);
    patch = { lastError: expired ? 'Le jumelage a expiré ou a été révoqué : relance `opencode pair --remote` et colle le nouveau lien.' : errorMessage(error).slice(0, 300) };
  }
  const [updated] = await db().update(schema.opencodeInstances).set(patch).where(eq(schema.opencodeInstances.id, row.id)).returning();
  if ((row.lastError ?? null) !== (updated.lastError ?? null) || row.version !== updated.version) publish({ type: 'opencode.changed' });
  return updated;
}

export async function saveInstance(input: { id?: string; name: string; baseUrl: string; username?: string; password?: string | null; defaultDirectory?: string | null }): Promise<InstanceRow> {
  const name = input.name.trim().slice(0, 60);
  if (!name) throw new OpencodeError('Donne un nom à cette instance (par exemple « PC de dev »).');
  const baseUrl = checkBaseUrl(input.baseUrl);
  const others = (await listInstances()).filter((i) => i.id !== input.id);
  if (others.some((i) => i.name.toLowerCase() === name.toLowerCase())) throw new OpencodeError('Une autre instance porte déjà ce nom.');
  const values = { name, baseUrl, username: input.username?.trim() || 'opencode', defaultDirectory: input.defaultDirectory?.trim() || null };
  let row: InstanceRow;
  if (input.id) {
    const existing = await getInstance(input.id);
    if (!existing) throw new OpencodeError('Instance introuvable.');
    // Mot de passe : absent = inchangé, null ou vide = retiré, texte = remplacé.
    const password = input.password === undefined ? existing.password : input.password ? encryptSecret(input.password) : null;
    // A password typed by hand replaces a paired token.
    const auth = input.password === undefined ? {} : { authKind: 'password' as const, tokenExpiresAt: null };
    [row] = await db().update(schema.opencodeInstances).set({ ...values, password, ...auth }).where(eq(schema.opencodeInstances.id, input.id)).returning();
  } else {
    [row] = await db().insert(schema.opencodeInstances).values({ id: newId('oc'), ...values, password: input.password ? encryptSecret(input.password) : null }).returning();
  }
  row = await checkInstance(row);
  publish({ type: 'opencode.changed' });
  return row;
}

/**
 * Connects a machine from the one-time link of `opencode pair` (or `opencode pair --remote`, through OpenTunnel): the
 * code is redeemed for a session token, kept encrypted like a password. Pairing the same address again renews it.
 */
export async function pairInstance(input: { link: string; name?: string | null; defaultDirectory?: string | null }): Promise<InstanceRow> {
  const { baseUrl, code } = parsePairingLink(input.link);
  const { token, expiresAt } = await redeemPairingCode(baseUrl, code, fetcher);
  const target = { baseUrl, username: 'opencode', password: token };
  const api = await detectApi(target, fetcher);
  const health = await api.health();
  const existing = (await listInstances()).find((i) => i.baseUrl === baseUrl);
  const taken = new Set((await listInstances()).filter((i) => i.id !== existing?.id).map((i) => i.name.toLowerCase()));
  let name = (input.name?.trim() || existing?.name || (health as { hostname?: string | null }).hostname || 'OpenCode').slice(0, 60);
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${name.replace(/ \d+$/, '')} ${n}`;
  const values = { name, baseUrl, username: 'opencode', password: encryptSecret(token), authKind: 'pairing' as const, tokenExpiresAt: expiresAt, apiVersion: api.version, version: health.version ?? null, lastSeenAt: new Date(), lastError: null, defaultDirectory: input.defaultDirectory?.trim() || existing?.defaultDirectory || null };
  const [row] = existing
    ? await db().update(schema.opencodeInstances).set(values).where(eq(schema.opencodeInstances.id, existing.id)).returning()
    : await db().insert(schema.opencodeInstances).values({ id: newId('oc'), ...values }).returning();
  publish({ type: 'opencode.changed' });
  return row;
}

/** Retirer une instance coupe l'accès ; les tâches et échanges passés restent consultables. */
export async function deleteInstance(id: string) {
  if (await activeCount(id)) throw new OpencodeError('Des tâches sont en cours sur cette instance : arrête-les d’abord.');
  await db().delete(schema.opencodeInstances).where(eq(schema.opencodeInstances.id, id));
  publish({ type: 'opencode.changed' });
}

const toSession = (s: RawSession, busy: boolean): OpencodeSessionDTO => ({ id: s.id, title: s.title, directory: s.directory, updatedAt: s.time.updated, busy, additions: s.summary?.additions ?? 0, deletions: s.summary?.deletions ?? 0, files: s.summary?.files ?? 0 });

export async function instanceProjects(row: InstanceRow): Promise<OpencodeProjectDTO[]> {
  return (await (await clientFor(row)).projects()).map((p) => ({ id: p.id, worktree: p.worktree, name: p.name ?? null }));
}
export async function instanceSessions(row: InstanceRow, directory?: string | null): Promise<OpencodeSessionDTO[]> {
  const client = await clientFor(row), dir = directory ?? row.defaultDirectory;
  const [sessions, statuses] = await Promise.all([client.sessions(dir), client.statuses(dir).catch(() => ({} as Record<string, { type: string }>))]);
  return sessions.map((s) => toSession(s, Boolean(statuses[s.id]) && statuses[s.id].type !== 'idle'));
}

// --- Échanges ---------------------------------------------------------------------------

async function exchange(task: TaskRow, entry: { author: 'user' | 'companion' | 'opencode'; kind: typeof schema.opencodeExchanges.$inferInsert['kind']; text: string; original?: string | null }) {
  const ext = task.external!;
  await db().insert(schema.opencodeExchanges).values({ taskId: task.id, instanceId: ext.instanceId, sessionId: ext.sessionId, author: entry.author, agentId: entry.author === 'companion' ? task.agentId : null, kind: entry.kind, text: truncate(entry.text, 8000), original: entry.original ? truncate(entry.original, 4000) : null });
}
export async function listExchanges(filter: { taskId?: string; limit?: number } = {}): Promise<OpencodeExchangeDTO[]> {
  const rows = await db().select().from(schema.opencodeExchanges).where(filter.taskId ? eq(schema.opencodeExchanges.taskId, filter.taskId) : undefined).orderBy(desc(schema.opencodeExchanges.seq)).limit(filter.limit ?? 200);
  return rows.reverse().map((r) => ({ seq: r.seq, taskId: r.taskId, author: r.author, agentId: r.agentId, kind: r.kind, text: r.text, original: r.original, createdAt: r.createdAt.toISOString() }));
}

// --- Délégation -------------------------------------------------------------------------

async function patchExternal(task: TaskRow, patch: Partial<TaskExternalRef>, more: Partial<TaskRow> = {}) {
  return updateTask(task.id, { ...more, external: { ...task.external!, ...patch } });
}

/**
 * Lance une tâche de code : une session OpenCode réelle (créée, ou réutilisée si `sessionId` est donné) reçoit la
 * consigne. La tâche n'existe dans le registre qu'une fois la consigne acceptée par l'instance.
 */
export async function startOpencodeTask(input: { agentId: string; conversationId: string; instance: InstanceRow; directory?: string | null; sessionId?: string | null; title: string; instruction: string; original?: string | null; requestedBy: 'agent' | 'user' }): Promise<TaskRow> {
  const client = await clientFor(input.instance);
  const directory = input.directory?.trim() || input.instance.defaultDirectory || null;
  const session = input.sessionId ? await client.session(input.sessionId, directory) : await client.createSession(input.title.slice(0, 120), directory);
  if (input.sessionId) {
    const clash = (await db().select().from(schema.tasks).where(and(eq(schema.tasks.provider, 'opencode'), inArray(schema.tasks.status, ACTIVE_TASK_STATUSES)))).find((t) => t.external?.sessionId === session.id && t.external.instanceId === input.instance.id);
    if (clash) throw new OpencodeError(`Cette session a déjà une tâche en cours (« ${clash.title} ») : envoie-lui une consigne plutôt que d’en lancer une seconde.`);
  }
  const promptedAt = Date.now();
  await client.prompt(session.id, input.instruction, session.directory ?? directory);
  const id = newId('task'), workConversationId = newId('cv');
  await db().insert(schema.conversations).values({ id: workConversationId, kind: 'task', agentId: input.agentId, title: input.title.slice(0, 200) });
  const external: TaskExternalRef = { instanceId: input.instance.id, sessionId: session.id, directory: session.directory ?? directory, promptedAt, seenMessageId: null, unreachable: false };
  await db().insert(schema.tasks).values({
    id, agentId: input.agentId, conversationId: input.conversationId, workConversationId, title: input.title.trim().slice(0, 200), instruction: input.instruction.trim(),
    requestedBy: input.requestedBy, provider: 'opencode', external, status: 'running', startedAt: new Date(), lastHeartbeat: new Date(), phase: 'Démarrage', currentAction: 'Consigne transmise à OpenCode',
  });
  const row = (await getTask(id))!;
  await addTaskEvent(id, 'status', `Consigne transmise à OpenCode (${input.instance.name}${external.directory ? ` · ${external.directory}` : ''})`);
  await exchange(row, { author: input.requestedBy === 'user' ? 'user' : 'companion', kind: 'delegation', text: input.instruction, original: input.original });
  await log(input.agentId, 'opencode.started', `Tâche de code confiée à OpenCode : ${row.title}`, { taskId: id });
  publish({ type: 'task.changed', task: await toTaskDTO(row) });
  publish({ type: 'opencode.changed' });
  return row;
}

async function context(task: TaskRow) {
  const ext = task.external;
  if (task.provider !== 'opencode' || !ext) throw new OpencodeError('Cette tâche n’est pas une session OpenCode.');
  const instance = await getInstance(ext.instanceId);
  if (!instance) throw new OpencodeError('L’instance OpenCode de cette tâche a été retirée.');
  return { ext, instance, client: await clientFor(instance) };
}

// --- Modèles -----------------------------------------------------------------------------

/** The models of an instance change rarely; they are read at most every five minutes, per account and instance. */
const modelCache = new Map<string, { at: number; models: RawModel[] }>();
async function instanceModels(instance: InstanceRow, client: OpencodeApi, directory: string | null, fresh = false): Promise<RawModel[]> {
  const key = `${accountKey()}:${instance.id}`;
  const hit = modelCache.get(key);
  if (hit && !fresh && Date.now() - hit.at < 5 * 60_000) return hit.models;
  const models = await client.models(directory);
  modelCache.set(key, { at: Date.now(), models });
  return models;
}
const sameModel = (a: OpencodeModelRef, b: { providerID: string; id: string }) => a.providerID === b.providerID && a.id === b.id;

/** The model the session will use next: the one OpenCode keeps (2.x), else the one chosen here, else the last one used. */
async function currentModel(task: TaskRow, client: OpencodeApi, instance: InstanceRow, session: RawSession | null, messages: RawMessage[] | null): Promise<OpencodeCurrentModelDTO | null> {
  const ext = task.external!;
  const lastUsed = messages ? [...messages].reverse().find((m) => m.info.role === 'assistant' && m.info.modelID) : undefined;
  const ref: OpencodeModelRef | null = session?.model ?? ext.model ?? (lastUsed ? { providerID: lastUsed.info.providerID ?? '', id: lastUsed.info.modelID! } : null);
  if (!ref) return null;
  const info = (await instanceModels(instance, client, ext.directory).catch(() => [] as RawModel[])).find((m) => sameModel(ref, m));
  return { providerID: ref.providerID, id: ref.id, variant: ref.variant && ref.variant !== 'default' ? ref.variant : null, name: info?.name ?? null, input: info?.input ?? null };
}

export async function taskModels(task: TaskRow): Promise<OpencodeModelsDTO> {
  const { ext, client, instance } = await context(task);
  const [models, session] = await Promise.all([instanceModels(instance, client, ext.directory, true), client.session(ext.sessionId, ext.directory).catch(() => null)]);
  return { current: await currentModel(task, client, instance, session, session?.model ? null : await client.messages(ext.sessionId, ext.directory, 20).catch(() => null)), models: models.map((m) => ({ ...m })) };
}

/** The user picks the session's model; OpenCode uses it from the next instruction on. */
export async function setTaskModel(task: TaskRow, ref: OpencodeModelRef): Promise<OpencodeCurrentModelDTO> {
  const { ext, client, instance } = await context(task);
  const info = (await instanceModels(instance, client, ext.directory)).find((m) => sameModel(ref, m));
  if (!info) throw new OpencodeError('Ce modèle n’est pas proposé par cette instance OpenCode.');
  const variant = ref.variant && info.variants.includes(ref.variant) ? ref.variant : null;
  await client.setModel(ext.sessionId, { providerID: info.providerID, id: info.id, variant }, ext.directory);
  await patchExternal(task, { model: { providerID: info.providerID, id: info.id, variant } }, {});
  await exchange(task, { author: 'user', kind: 'model', text: `Modèle : ${info.name}${variant ? ` (${variant})` : ''}` });
  return { providerID: info.providerID, id: info.id, variant, name: info.name, input: info.input };
}

/** Files are checked before they leave: size, count, and whether the model can read them at all. */
function checkFiles(files: PromptFile[], model: OpencodeCurrentModelDTO | null) {
  if (files.length > OPENCODE_FILES_MAX_COUNT) throw new OpencodeError(`${OPENCODE_FILES_MAX_COUNT} fichiers au plus par message.`);
  if (files.some((f) => f.data.length > OPENCODE_FILE_MAX_BYTES)) throw new OpencodeError('Un fichier ne peut pas dépasser 10 Mo.');
  if (files.reduce((n, f) => n + f.data.length, 0) > OPENCODE_FILES_MAX_BYTES) throw new OpencodeError('Les fichiers joints ne peuvent pas dépasser 20 Mo au total.');
  const input = model?.input;
  if (!input) return;
  const name = model.name ?? model.id;
  if (files.some((f) => f.mime.startsWith('image/')) && !input.includes('image')) throw new OpencodeError(`${name} ne lit pas les images : choisis un modèle qui les accepte, ou retire l’image.`);
  if (files.some((f) => f.mime === 'application/pdf') && !input.includes('pdf')) throw new OpencodeError(`${name} ne lit pas les PDF : choisis un modèle qui les accepte, ou retire le PDF.`);
}

/** Une consigne dans LA session de la tâche. Si elle travaille, OpenCode la traite à la suite ; sinon elle relance la session. */
export async function instructOpencode(task: TaskRow, instruction: string, author: 'user' | 'companion', original?: string | null, delivery?: Delivery, files: PromptFile[] = []): Promise<{ queued: boolean; delivery: Delivery | null }> {
  const { ext, client, instance } = await context(task);
  if (files.length) checkFiles(files, await currentModel(task, client, instance, await client.session(ext.sessionId, ext.directory).catch(() => null), null));
  const busy = Boolean((await client.statuses(ext.directory))[ext.sessionId]);
  const delivered = await client.prompt(ext.sessionId, instruction, ext.directory, busy ? delivery : undefined, { files, model: client.version === 'v1' ? ext.model ?? null : null });
  await exchange(task, { author, kind: 'instruction', text: files.length ? `${instruction}\n\nFichiers joints : ${files.map((f) => f.name).join(', ')}` : instruction, original });
  // Une session terminée repart : la carte redevient « en cours », le prochain résultat sera un nouveau résultat.
  await patchExternal(task, { promptedAt: Date.now(), unreachable: false }, { status: 'running', finishedAt: null, result: null, error: null, blocker: null, requiresUserInput: false, currentAction: busy ? (delivered === 'steer' ? 'Consigne intégrée au travail en cours' : 'Consigne placée à la suite du travail en cours') : 'Consigne transmise à OpenCode', lastHeartbeat: new Date() });
  return { queued: busy, delivery: busy ? (delivered ?? 'queue') : null };
}

registerTaskProvider('opencode', {
  cancel: async (row) => {
    const { ext, client } = await context(row);
    await client.abort(ext.sessionId, ext.directory); // lève une erreur si l'arrêt n'a pas pu être transmis
    await exchange(row, { author: 'user', kind: 'stop', text: 'Arrêt demandé' });
  },
  instruct: async (row, instruction, author) => { await instructOpencode(row, instruction, author); },
}, async (instanceId) => (await getInstance(instanceId))?.name ?? null);

// --- Lecture de la session ---------------------------------------------------------------

const stringify = (value: unknown, max: number) => truncate(typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 1), max);
function toPart(part: RawPart): OpencodePartDTO | null {
  if (part.type === 'text' && part.text?.trim()) return { type: 'text', text: truncate(part.text, 20_000) };
  if (part.type === 'reasoning' && part.text?.trim()) return { type: 'reasoning', text: truncate(part.text, 6000) };
  if (part.type === 'tool' && part.state) return { type: 'tool', tool: part.tool ?? 'tool', status: part.state.status, title: part.state.title ?? null, input: stringify(part.state.input, 2000), output: part.state.status === 'completed' ? truncate(part.state.output ?? '', 8000) : part.state.status === 'error' ? truncate(part.state.error ?? '', 2000) : null };
  if (part.type === 'patch') return { type: 'patch', files: (part.files ?? []).slice(0, 50) };
  if (part.type === 'file') return { type: 'file', filename: part.filename ?? null, mime: part.mime ?? 'application/octet-stream' };
  return null;
}
const errorOf = (m: RawMessage) => (m.info.error ? m.info.error.data?.message ?? m.info.error.name ?? 'Erreur' : null);
const toMessage = (m: RawMessage): OpencodeMessageDTO => ({ id: m.info.id, role: m.info.role, createdAt: m.info.time.created, completedAt: m.info.time.completed ?? null, model: m.info.modelID ? `${m.info.providerID ?? ''}/${m.info.modelID}`.replace(/^\//, '') : null, error: errorOf(m), parts: m.parts.map(toPart).filter((p): p is OpencodePartDTO => p !== null) });
const textOf = (m: RawMessage) => m.parts.filter((p) => p.type === 'text' && p.text).map((p) => p.text!.trim()).filter(Boolean).join('\n\n');
const toDiff = (d: { path?: string; file?: string; status?: 'added' | 'modified' | 'deleted'; additions: number; deletions: number; patch?: string }): OpencodeDiffDTO => ({ path: d.path ?? d.file ?? '?', status: d.status ?? 'modified', additions: d.additions, deletions: d.deletions, patch: truncate(d.patch ?? '', 60_000) });

export async function sessionDiffs(task: TaskRow): Promise<OpencodeDiffDTO[]> {
  const { ext, client } = await context(task);
  return (await client.diff(ext.sessionId, ext.directory)).map(toDiff);
}

/** L'espace de code d'une tâche. Injoignable : on le dit, avec le dernier état connu de la tâche. */
export async function workspace(task: TaskRow): Promise<OpencodeWorkspaceDTO> {
  const exchanges = await listExchanges({ taskId: task.id });
  const base = { task: await toTaskDTO(task), exchanges, session: null, messages: [], permissions: [], questions: [], diffs: [], model: null };
  let ctx;
  try { ctx = await context(task); } catch (error) { return { ...base, reachable: false, error: errorMessage(error), sessionStatus: 'unknown' }; }
  const { ext, client, instance } = ctx;
  try {
    const [session, statuses, messages, permissions, questions, diffs] = await Promise.all([
      client.session(ext.sessionId, ext.directory), client.statuses(ext.directory), client.messages(ext.sessionId, ext.directory, 80),
      client.permissions(ext.sessionId, ext.directory).catch(() => []), client.questions(ext.sessionId, ext.directory).catch(() => []), client.diff(ext.sessionId, ext.directory).then((d) => d.map(toDiff)).catch(() => null),
    ]);
    // What the session changed, kept on the task so the card in the conversation shows it without asking the machine.
    if (diffs) {
      const changes = changesOf(diffs);
      const known = ext.changes;
      if (!known || known.files !== changes.files || known.additions !== changes.additions || known.deletions !== changes.deletions) {
        await patchExternal(task, { changes });
      }
    }
    const status = statuses[ext.sessionId]?.type ?? 'idle';
    return {
      ...base, reachable: true, error: null, session: toSession(session, status !== 'idle'), sessionStatus: status,
      messages: messages.map(toMessage),
      permissions: permissions.filter((p) => p.sessionID === ext.sessionId).map((p) => ({ id: p.id, permission: p.permission, patterns: p.patterns ?? [] })),
      questions: questions.filter((q) => q.sessionID === ext.sessionId).map((q) => ({ id: q.id, questions: q.questions.map((x) => ({ question: x.question, header: x.header, options: x.options.map((o) => o.label), multiple: Boolean(x.multiple) })) })),
      diffs: diffs ?? [],
      model: await currentModel(task, client, instance, session, messages).catch(() => null),
    };
  } catch (error) {
    if (error instanceof OpencodeUnreachable || error instanceof OpencodeHttpError) return { ...base, reachable: false, error: error.message, sessionStatus: 'unknown' };
    throw error;
  }
}

/** La décision de l'utilisateur va à la bonne session ; elle ne donne au compagnon aucun droit sur la machine. */
export async function replyPermission(task: TaskRow, requestId: string, reply: 'once' | 'always' | 'reject') {
  const { ext, client } = await context(task);
  if (!(await client.permissions(ext.sessionId, ext.directory)).some((p) => p.id === requestId)) throw new OpencodeError('Cette demande n’attend plus de réponse.');
  await client.replyPermission(ext.sessionId, requestId, reply, ext.directory);
  await exchange(task, { author: 'user', kind: 'permission', text: reply === 'reject' ? 'Autorisation refusée' : reply === 'always' ? 'Autorisation accordée (toujours)' : 'Autorisation accordée (cette fois)' });
  await syncTask((await getTask(task.id))!);
}
export async function replyQuestion(task: TaskRow, requestId: string, answers: string[][]) {
  const { ext, client } = await context(task);
  if (!(await client.questions(ext.sessionId, ext.directory)).some((q) => q.id === requestId)) throw new OpencodeError('Cette question n’attend plus de réponse.');
  await client.replyQuestion(ext.sessionId, requestId, answers, ext.directory);
  await exchange(task, { author: 'user', kind: 'question', text: `Réponse : ${answers.map((a) => a.join(', ')).join(' · ')}` });
  await syncTask((await getTask(task.id))!);
}
export async function listFiles(task: TaskRow, path: string): Promise<OpencodeFileNodeDTO[]> {
  const { ext, client } = await context(task);
  return (await client.files(path || '.', ext.directory)).filter((n) => !n.ignored).map((n) => ({ name: n.name, path: n.path, type: n.type })).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
}
export async function readFile(task: TaskRow, path: string): Promise<{ path: string; binary: boolean; content: string }> {
  const { ext, client } = await context(task);
  const file = await client.file(path, ext.directory);
  const binary = file.type !== 'text' || file.encoding === 'base64';
  return { path, binary, content: binary ? '' : truncate(file.content, 200_000) };
}

// --- Suivi : l'état réel, relu à chaque battement -------------------------------------------

/** Compte rendu remis au compagnon à la fin : ce qu'OpenCode a dit et ce qui a réellement changé, sans rien présumer. */
function report(task: TaskRow, instanceName: string, outcome: 'completed' | 'failed', text: string, diffs: OpencodeDiffDTO[] | null) {
  const changes = diffs === null ? 'Changed files: could not be read from the instance.'
    : diffs.length ? `Changed files (${diffs.length}): ${diffs.slice(0, 30).map((d) => `${d.path} (+${d.additions}/-${d.deletions})`).join(', ')}` : 'Changed files: none reported by OpenCode.';
  return `OpenCode ${outcome === 'completed' ? 'finished' : 'stopped with an error on'} the coding task "${task.title}" (task ${task.id}, instance ${instanceName}).\n\n` +
    `${outcome === 'completed' ? "OpenCode's own report" : 'Error'}:\n${truncate(text || '(no text)', 6000)}\n\n${changes}\n\n` +
    `"Finished" means the session stopped working, not that the result is correct. Tests passed only if the report above shows their real output. ` +
    `Review it; if something is missing or wrong, send a follow-up to the SAME session with opencode_send (task ${task.id}). ` +
    `The user already sees this task's card in the conversation (state and changed files) and can open the full OpenCode session from it: do NOT paste or restate OpenCode's report, tables, task ids or paths. ` +
    `Then tell the user in two to four sentences only what matters: the outcome, what was actually verified, and what is left or needs their decision.`;
}

const changesOf = (diffs: OpencodeDiffDTO[]) => ({ files: diffs.length, additions: diffs.reduce((n, d) => n + d.additions, 0), deletions: diffs.reduce((n, d) => n + d.deletions, 0) });

async function conclude(task: TaskRow, instanceName: string, outcome: 'completed' | 'failed', text: string, seenMessageId: string, diffs: OpencodeDiffDTO[] | null, steps: number) {
  // Une seule conclusion par réponse : un événement tardif ou répété ne réveille personne une seconde fois.
  const [claimed] = await db().update(schema.tasks).set({ status: outcome, finishedAt: new Date(), completedSteps: Math.max(task.completedSteps, steps), currentAction: null, requiresUserInput: false, blocker: null, result: outcome === 'completed' ? truncate(text, 4000) : null, error: outcome === 'failed' ? truncate(text, 1000) : null, external: { ...task.external!, seenMessageId, unreachable: false, ...(diffs ? { changes: changesOf(diffs) } : {}) } })
    .where(and(eq(schema.tasks.id, task.id), inArray(schema.tasks.status, ACTIVE_TASK_STATUSES))).returning();
  if (!claimed) return;
  await addTaskEvent(task.id, outcome === 'completed' ? 'status' : 'error', outcome === 'completed' ? 'OpenCode a terminé' : `OpenCode s'est arrêté sur une erreur : ${truncate(text, 300)}`);
  await exchange(claimed, { author: 'opencode', kind: outcome === 'completed' ? 'result' : 'failure', text: text || '(sans texte)' });
  await log(task.agentId, `opencode.${outcome}`, `OpenCode ${outcome === 'completed' ? 'a terminé' : 'a échoué'} : ${task.title}`, { taskId: task.id });
  publish({ type: 'task.changed', task: await toTaskDTO(claimed) });
  // Le résultat est REMIS au compagnon, même si sa conversation est fermée : c'est lui qui relit, corrige ou informe.
  await enqueue('agent.wake', { agentId: task.agentId, conversationId: task.conversationId, event: { type: 'task', title: `OpenCode : ${task.title}`, taskId: task.id }, text: report(task, instanceName, outcome, text, diffs), depth: 0 }, { agentId: task.agentId, dedupeKey: `opencode:${task.id}:${seenMessageId}` });
}

/** Réconcilie une tâche avec sa session. N'affirme que ce qui est observé. */
export async function syncTask(task: TaskRow): Promise<void> {
  if (task.provider !== 'opencode' || !task.external || !ACTIVE_TASK_STATUSES.includes(task.status)) return;
  const ext = task.external;
  const instance = await getInstance(ext.instanceId);
  if (!instance) { await updateTask(task.id, { status: 'failed', finishedAt: new Date(), error: 'L’instance OpenCode a été retirée.', currentAction: null }); return; }
  let client: OpencodeApi;
  try {
    client = await clientFor(instance);
    const [statuses, messages, permissions, questions] = await Promise.all([client.statuses(ext.directory), client.messages(ext.sessionId, ext.directory, 60), client.permissions(ext.sessionId, ext.directory).catch(() => []), client.questions(ext.sessionId, ext.directory).catch(() => [])]);
    const status = statuses[ext.sessionId] ?? { type: 'idle' as const };
    // The current turn is what follows the latest request in the session. Using the transcript rather than clocks
    // keeps this right when the development machine's clock differs from the server's.
    const lastRequest = messages.map((m) => m.info.role).lastIndexOf('user');
    const recent = lastRequest >= 0 ? messages.slice(lastRequest + 1) : messages;
    const tools = recent.flatMap((m) => m.parts.filter((p) => p.type === 'tool' && p.state));
    const done = tools.filter((p) => p.state!.status === 'completed' || p.state!.status === 'error').length;
    const running = [...tools].reverse().find((p) => p.state!.status === 'running' || p.state!.status === 'pending');
    const lastTool = tools.at(-1);
    const activity = running ? running.state!.title || running.tool || 'Outil en cours' : status.type === 'retry' ? `Nouvelle tentative (${status.attempt}) : ${truncate(status.message, 120)}` : status.type === 'busy' ? (lastTool ? `Après : ${lastTool.state!.title || lastTool.tool}` : 'Réfléchit') : null;
    const waiting = [...permissions.filter((p) => p.sessionID === ext.sessionId).map((p) => `OpenCode demande une autorisation : ${p.permission}${p.patterns?.length ? ` (${truncate(p.patterns.join(', '), 120)})` : ''}`), ...questions.filter((q) => q.sessionID === ext.sessionId).map((q) => `OpenCode pose une question : ${truncate(q.questions[0]?.question ?? '', 160)}`)];
    const lastAssistant = [...recent].reverse().find((m) => m.info.role === 'assistant');

    if (waiting.length) {
      if (task.status !== 'waiting_for_user' || task.blocker !== waiting[0]) {
        await patchExternal(task, { unreachable: false }, { status: 'waiting_for_user', blocker: waiting[0], requiresUserInput: true, currentAction: null, completedSteps: Math.max(task.completedSteps, done), lastHeartbeat: new Date() });
        await addTaskEvent(task.id, 'status', waiting[0]);
        await exchange(task, { author: 'opencode', kind: waiting[0].includes('autorisation') ? 'permission' : 'question', text: waiting[0] });
      }
      return;
    }
    if (status.type === 'idle' && lastAssistant && lastAssistant.info.id !== ext.seenMessageId && (lastAssistant.info.time.completed || lastAssistant.info.error)) {
      const failure = errorOf(lastAssistant);
      const diffs = await client.diff(ext.sessionId, ext.directory).then((d) => d.map(toDiff)).catch(() => null);
      // 2.x splits a turn into one message per step: the answer is the latest step that has text.
      const answer = [...recent].reverse().find((m) => m.info.role === 'assistant' && textOf(m));
      await conclude(task, instance.name, failure ? 'failed' : 'completed', failure ?? (answer ? textOf(answer) : ''), lastAssistant.info.id, diffs, done);
      return;
    }
    const next = { status: 'running' as const, blocker: null, requiresUserInput: false, phase: status.type === 'idle' ? 'En attente de la réponse d’OpenCode' : 'Travail en cours', currentAction: activity, completedSteps: Math.max(task.completedSteps, done) };
    const changed = task.status !== next.status || task.phase !== next.phase || task.currentAction !== next.currentAction || task.completedSteps !== next.completedSteps || ext.unreachable;
    if (changed) {
      if (running && task.currentAction !== activity) await addTaskEvent(task.id, 'step', activity!);
      await patchExternal(task, { unreachable: false }, { ...next, lastHeartbeat: new Date() });
    }
    if (instance.lastError) await checkInstance(instance);
  } catch (error) {
    if (error instanceof OpencodeHttpError && error.status === 404) {
      await updateTask(task.id, { status: 'failed', finishedAt: new Date(), error: 'La session a été supprimée dans OpenCode.', currentAction: null, requiresUserInput: false });
      await addTaskEvent(task.id, 'error', 'La session a été supprimée dans OpenCode.');
      return;
    }
    if (!(error instanceof OpencodeUnreachable) && !(error instanceof OpencodeHttpError)) throw error;
    // Injoignable ou refusée : l'état distant est inconnu. La tâche garde son dernier état connu.
    if (!ext.unreachable) {
      await patchExternal(task, { unreachable: true }, { currentAction: `${error.message} Dernier état connu affiché.` });
      await addTaskEvent(task.id, 'note', `Instance injoignable : ${error.message}`);
      await checkInstance(instance);
    }
  }
}

const syncing = new Set<string>();
/** Appelé à chaque battement du moteur : chaque tâche OpenCode active est relue sur son instance. */
export async function syncOpencodeTasks(): Promise<void> {
  const account = accountKey();
  if (syncing.has(account)) return;
  syncing.add(account);
  try {
    const rows = await db().select().from(schema.tasks).where(and(eq(schema.tasks.provider, 'opencode'), inArray(schema.tasks.status, ACTIVE_TASK_STATUSES)));
    for (const row of rows) await syncTask(row).catch((error) => console.error('[opencode]', errorMessage(error)));
  } finally { syncing.delete(account); }
}
