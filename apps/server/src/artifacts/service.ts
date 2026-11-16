import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { ARTIFACT_MAX_BYTES, artifactUrl, type ArtifactAccessDTO, type ArtifactDTO, type ArtifactGrantDTO } from '@opendots/shared';
import { config } from '../config.ts';
import { db, schema } from '../db/client.ts';
import { publish } from '../bus.ts';
import { accountKey } from '../auth/context.ts';
import { KeyedMutex, newId } from '../util.ts';

/*
 * Artefacts : les fichiers d'un compte, qu'ils viennent de l'utilisateur, d'un compagnon ou d'un worker.
 *
 * - Les octets restent inchangés et sont stockés une fois par empreinte (plusieurs artefacts peuvent
 *   pointer sur le même contenu : partager à trois compagnons ne copie rien).
 * - L'utilisateur du compte voit tous ses artefacts. Un compagnon ne lit que ceux pour lesquels il
 *   a une autorisation active (`artifact_grants`) : connaître un identifiant ne suffit jamais.
 * - Chaque création, lecture, partage, publication ou refus est journalisé, sans le contenu.
 */

export class ArtifactError extends Error {
  constructor(message: string, readonly status: 'failed' | 'not_found' | 'denied' | 'too_large' | 'quota' | 'rejected' = 'failed') {
    super(message);
  }
}

export type ArtifactRow = typeof schema.artifacts.$inferSelect;
type Actor = 'user' | string;

const lock = new KeyedMutex();
const blobsDir = () => join(config.dataDir, 'artifacts', 'blobs');
const blobPath = (sha256: string) => join(blobsDir(), sha256);
const quotaBytes = () => Number(process.env.OPENDOTS_ARTIFACTS_QUOTA_MB ?? 2048) * 1024 * 1024;

/** Exécutables natifs : jamais stockés, quel que soit le nom annoncé. */
function hostileMagic(data: Buffer): string | null {
  if (data.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return 'exécutable ELF';
  if (data.subarray(0, 2).toString('latin1') === 'MZ') return 'exécutable Windows';
  if (data.length < 4) return null;
  const head = data.readUInt32BE(0);
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(head) && data.length > 8 && data.readUInt32BE(4) < 64) return 'exécutable macOS';
  return null;
}

const BLOCKED_EXTENSIONS = /\.(exe|dll|msi|scr|com|bat|cmd|pif|lnk|apk|app|dmg|pkg|deb|rpm|jar)$/i;

/** Nom affichable et sûr : pas de chemin, pas de caractère de contrôle, longueur bornée. */
export function sanitizeName(raw: string): string {
  const base = raw.replace(/\\/g, '/').split('/').pop() ?? '';
  const clean = base.normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^\.+/, '').trim().slice(0, 180);
  return clean || 'fichier';
}

const EXTENSION_TYPES: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json', xml: 'application/xml', yaml: 'application/yaml', yml: 'application/yaml',
  html: 'text/html', css: 'text/css', js: 'text/javascript', ts: 'text/typescript', py: 'text/x-python', sh: 'text/x-shellscript', sql: 'application/sql', log: 'text/plain', patch: 'text/x-diff', diff: 'text/x-diff',
  pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', mp3: 'audio/mpeg', mp4: 'video/mp4',
};

/** Type détecté à partir du contenu d'abord, de l'extension ensuite ; jamais du type annoncé par le client. */
export function detectMediaType(name: string, data: Buffer): string {
  if (data.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (data.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'image/jpeg';
  if (/^GIF8[79]a/.test(data.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return EXTENSION_TYPES[ext]?.includes('openxmlformats') ? EXTENSION_TYPES[ext] : 'application/zip';
  if (EXTENSION_TYPES[ext]) return EXTENSION_TYPES[ext];
  return isProbablyText(data) ? 'text/plain' : 'application/octet-stream';
}

export function isProbablyText(data: Buffer): boolean {
  const sample = data.subarray(0, 4096);
  if (!sample.length) return true;
  let odd = 0;
  for (const byte of sample) if (byte === 0) return false; else if (byte < 9 || (byte > 13 && byte < 32)) odd++;
  return odd / sample.length < 0.02;
}

export const isTextual = (mediaType: string) => mediaType.startsWith('text/') || /(json|xml|yaml|sql|javascript|typescript|x-sh|x-python|x-diff)/.test(mediaType);

export function toArtifactDTO(row: ArtifactRow): ArtifactDTO {
  return {
    id: row.id, name: row.name, mediaType: row.mediaType, size: row.size, sha256: row.sha256,
    authorKind: row.authorKind, authorId: row.authorId, source: row.source,
    conversationId: row.conversationId, taskId: row.taskId, parentId: row.parentId,
    createdAt: row.createdAt.toISOString(), url: artifactUrl(row.id),
  };
}

async function logAccess(artifactId: string, actor: Actor, action: typeof schema.artifactAccess.$inferInsert['action'], detail?: string) {
  await db().insert(schema.artifactAccess).values({ id: newId('aa'), artifactId, actor, action, detail: detail?.slice(0, 300) ?? null });
}

/** Enregistre un fichier. L'auteur compagnon reçoit d'office le droit de le relire. */
export async function createArtifact(input: {
  bytes: Uint8Array;
  name: string;
  authorKind: 'user' | 'agent' | 'worker';
  authorId?: string | null;
  source: ArtifactRow['source'];
  conversationId?: string | null;
  taskId?: string | null;
  parentId?: string | null;
}): Promise<ArtifactRow> {
  const data = Buffer.from(input.bytes);
  if (!data.length) throw new ArtifactError('Fichier vide.', 'rejected');
  if (data.length > ARTIFACT_MAX_BYTES) throw new ArtifactError(`Fichier trop volumineux : ${Math.round(ARTIFACT_MAX_BYTES / 1024 / 1024)} Mo au maximum.`, 'too_large');
  const name = sanitizeName(input.name);
  const hostile = hostileMagic(data) ?? (BLOCKED_EXTENSIONS.test(name) ? 'type de fichier exécutable' : null);
  if (hostile) throw new ArtifactError(`Fichier refusé (${hostile}).`, 'rejected');
  const sha256 = createHash('sha256').update(data).digest('hex');
  return lock.run(accountKey(), async () => {
    const path = blobPath(sha256);
    const known = await stat(path).then(() => true, () => false);
    if (!known) {
      const [{ used }] = await db().select({ used: sql<number>`coalesce(sum(size), 0)::bigint` }).from(
        db().selectDistinctOn([schema.artifacts.sha256], { sha256: schema.artifacts.sha256, size: schema.artifacts.size }).from(schema.artifacts).where(isNull(schema.artifacts.deletedAt)).as('blobs'),
      );
      if (Number(used) + data.length > quotaBytes()) throw new ArtifactError('L’espace de fichiers de ce compte est épuisé.', 'quota');
      await mkdir(blobsDir(), { recursive: true, mode: 0o700 });
      await writeFile(path, data, { mode: 0o600, flag: 'wx' }).catch(async (error) => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    }
    const row = {
      id: newId('art'), name, mediaType: detectMediaType(name, data), size: data.length, sha256,
      authorKind: input.authorKind, authorId: input.authorId ?? null, source: input.source,
      conversationId: input.conversationId ?? null, taskId: input.taskId ?? null, parentId: input.parentId ?? null,
    };
    await db().insert(schema.artifacts).values(row);
    const actor = input.authorKind === 'user' ? 'user' : input.authorId ?? 'worker';
    await logAccess(row.id, actor, 'create', row.name);
    if (input.authorKind !== 'user' && input.authorId) await grantArtifact(row.id, input.authorId, input.authorId, 'create', { conversationId: row.conversationId, taskId: row.taskId });
    publish({ type: 'artifact.changed', artifactId: row.id });
    return (await getArtifact(row.id))!;
  });
}

export async function getArtifact(id: string): Promise<ArtifactRow | null> {
  if (!/^art_[a-z0-9]+$/.test(id)) return null;
  const [row] = await db().select().from(schema.artifacts).where(and(eq(schema.artifacts.id, id), isNull(schema.artifacts.deletedAt)));
  return row ?? null;
}

export async function hasGrant(artifactId: string, agentId: string): Promise<boolean> {
  const [row] = await db().select({ id: schema.artifactGrants.id }).from(schema.artifactGrants)
    .where(and(eq(schema.artifactGrants.artifactId, artifactId), eq(schema.artifactGrants.agentId, agentId), isNull(schema.artifactGrants.revokedAt)));
  return Boolean(row);
}

/** Donne à un compagnon le droit de lire un artefact. Idempotent. */
export async function grantArtifact(artifactId: string, agentId: string, grantedBy: Actor, via: typeof schema.artifactGrants.$inferInsert['via'], scope: { conversationId?: string | null; taskId?: string | null } = {}) {
  if (await hasGrant(artifactId, agentId)) return false;
  await db().insert(schema.artifactGrants).values({ id: newId('ag'), artifactId, agentId, grantedBy, via, conversationId: scope.conversationId ?? null, taskId: scope.taskId ?? null });
  if (via !== 'create') await logAccess(artifactId, grantedBy, 'share', `→ ${agentId}`);
  publish({ type: 'artifact.changed', artifactId });
  return true;
}

export async function revokeGrant(artifactId: string, agentId: string) {
  const res = await db().update(schema.artifactGrants).set({ revokedAt: new Date() })
    .where(and(eq(schema.artifactGrants.artifactId, artifactId), eq(schema.artifactGrants.agentId, agentId), isNull(schema.artifactGrants.revokedAt))).returning({ id: schema.artifactGrants.id });
  if (res.length) { await logAccess(artifactId, 'user', 'revoke', `✕ ${agentId}`); publish({ type: 'artifact.changed', artifactId }); }
  return res.length > 0;
}

/** L'artefact, si cet acteur a le droit de le lire. Un refus est journalisé et indistinct d'une absence. */
export async function artifactFor(actor: Actor, id: string): Promise<ArtifactRow> {
  const row = await getArtifact(id);
  if (!row) throw new ArtifactError('Fichier introuvable ou non partagé avec toi.', 'not_found');
  if (actor !== 'user' && !(await hasGrant(id, actor))) {
    await logAccess(id, actor, 'denied');
    throw new ArtifactError('Fichier introuvable ou non partagé avec toi.', 'not_found');
  }
  return row;
}

/** Lit les octets pour un acteur autorisé et journalise l'accès. */
export async function readArtifact(actor: Actor, id: string, action: 'read' | 'download' = 'read'): Promise<{ artifact: ArtifactRow; bytes: Buffer }> {
  const artifact = await artifactFor(actor, id);
  let bytes: Buffer;
  try { bytes = await readFile(blobPath(artifact.sha256)); } catch { throw new ArtifactError('Le contenu de ce fichier n’est plus disponible.', 'not_found'); }
  await logAccess(id, actor, action);
  return { artifact, bytes };
}

/** Marque une publication dans une conversation (le fichier devient une pièce jointe visible). */
export async function recordPublication(artifactId: string, actor: Actor, conversationId: string) {
  await logAccess(artifactId, actor, 'publish', conversationId);
}

export async function listArtifacts(filter: { conversationId?: string; agentId?: string; taskId?: string; limit?: number } = {}): Promise<ArtifactRow[]> {
  const where = [isNull(schema.artifacts.deletedAt)];
  if (filter.conversationId) where.push(eq(schema.artifacts.conversationId, filter.conversationId));
  if (filter.taskId) where.push(eq(schema.artifacts.taskId, filter.taskId));
  if (filter.agentId) {
    const granted = await db().select({ id: schema.artifactGrants.artifactId }).from(schema.artifactGrants)
      .where(and(eq(schema.artifactGrants.agentId, filter.agentId), isNull(schema.artifactGrants.revokedAt)));
    if (!granted.length) return [];
    where.push(inArray(schema.artifacts.id, granted.map((g) => g.id)));
  }
  return db().select().from(schema.artifacts).where(and(...where)).orderBy(desc(schema.artifacts.createdAt)).limit(filter.limit ?? 100);
}

export async function artifactsByIds(ids: string[]): Promise<ArtifactRow[]> {
  if (!ids.length) return [];
  const rows = await db().select().from(schema.artifacts).where(and(inArray(schema.artifacts.id, ids), isNull(schema.artifacts.deletedAt)));
  return ids.flatMap((id) => rows.filter((row) => row.id === id));
}

/** Qui a accès, et tout ce qui s'est passé sur ce fichier. */
export async function artifactHistory(id: string): Promise<{ grants: ArtifactGrantDTO[]; access: ArtifactAccessDTO[] }> {
  const grants = await db().select().from(schema.artifactGrants).where(eq(schema.artifactGrants.artifactId, id)).orderBy(schema.artifactGrants.createdAt);
  const access = await db().select().from(schema.artifactAccess).where(eq(schema.artifactAccess.artifactId, id)).orderBy(desc(schema.artifactAccess.createdAt)).limit(200);
  return {
    grants: grants.map((g) => ({ agentId: g.agentId, grantedBy: g.grantedBy, via: g.via, createdAt: g.createdAt.toISOString(), revokedAt: g.revokedAt?.toISOString() ?? null })),
    access: access.map((a) => ({ actor: a.actor, action: a.action, detail: a.detail, createdAt: a.createdAt.toISOString() })),
  };
}

/** Supprime l'artefact ; le contenu est effacé quand plus aucun artefact ne le référence. */
export async function deleteArtifact(id: string) {
  const row = await getArtifact(id);
  if (!row) return false;
  await db().update(schema.artifacts).set({ deletedAt: new Date() }).where(eq(schema.artifacts.id, id));
  await db().update(schema.artifactGrants).set({ revokedAt: new Date() }).where(and(eq(schema.artifactGrants.artifactId, id), isNull(schema.artifactGrants.revokedAt)));
  await logAccess(id, 'user', 'delete');
  const [other] = await db().select({ id: schema.artifacts.id }).from(schema.artifacts).where(and(eq(schema.artifacts.sha256, row.sha256), isNull(schema.artifacts.deletedAt))).limit(1);
  if (!other) await rm(blobPath(row.sha256), { force: true });
  publish({ type: 'artifact.changed', artifactId: id });
  return true;
}

/** Extrait lisible d'un artefact textuel, borné : le contenu d'un fichier n'entre dans le contexte du modèle que sur demande. */
export function textExcerpt(bytes: Buffer, offset = 0, maxChars = 20_000): { text: string; totalChars: number; truncated: boolean } {
  const all = bytes.toString('utf8');
  const start = Math.max(0, Math.min(offset, all.length));
  const text = all.slice(start, start + maxChars);
  return { text, totalChars: all.length, truncated: start + text.length < all.length };
}
