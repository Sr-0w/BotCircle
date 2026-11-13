import { openHandoff, resumeReferencedHandoff, type TeamDelegation } from '../team/handoff.ts';
import { and, desc, eq, lt } from 'drizzle-orm';
import type { SecureLoginDTO, SecureLoginStatus } from '@opendots/shared';
import { publish } from '../bus.ts';
import { db, schema } from '../db/client.ts';
import { enqueue } from '../jobs/queue.ts';
import { log } from '../journal.ts';
import { newId } from '../util.ts';
import { desktopExecQuiet, setHumanControl } from '../computer/desktop.ts';
import { withDesktopAgent } from '../computer/session.ts';
import { getTask, sendInstruction } from '../tasks/service.ts';

/*
 * Connexion sécurisée, parcours « prise de main » : quand un compagnon rencontre une page de connexion, il le
 * signale ; l'utilisateur s'authentifie lui-même dans le navigateur du compagnon ; le compagnon ne reçoit qu'un
 * statut. La frontière est tenue par le serveur, pas par une consigne au modèle :
 *  - le bureau passe sous contrôle humain (captures, clics, clavier, inspection du DOM refusés) ;
 *  - les autres outils qui touchent l'ordinateur (shell, fichiers de l'espace de travail) sont retirés du tour ;
 *  - aucune valeur saisie ne transite par BotCircle : rien à journaliser, rien à stocker.
 */

export type SecureLoginRow = typeof schema.secureLogins.$inferSelect;
export class SecureLoginError extends Error {}

/** Une demande sans réponse n'immobilise pas le compagnon indéfiniment. */
export const SECURE_LOGIN_TTL_MS = Number(process.env.OPENDOTS_SECURE_LOGIN_TTL_MIN ?? 30) * 60_000;

/** Outils retirés pendant qu'une connexion est en cours : tout ce qui peut lire l'écran, le DOM, le presse-papiers ou le disque du bureau. */
export const SENSITIVE_TOOL = /^(computer_|browser_|shell_|share_screenshot$|artifact_to_workspace$|artifact_from_workspace$|git_)/;

export const toSecureLoginDTO = (r: SecureLoginRow): SecureLoginDTO => ({
  id: r.id, agentId: r.agentId, conversationId: r.conversationId, taskId: r.taskId, origin: r.origin, url: r.url, reason: r.reason,
  status: r.status, createdAt: r.createdAt.toISOString(), resolvedAt: r.resolvedAt?.toISOString() ?? null,
});

/**
 * L'origine affichée à l'utilisateur est celle que le serveur a analysée, jamais un libellé fourni par le modèle.
 * HTTPS uniquement (HTTP toléré pour une machine locale), sans identifiants dans l'URL.
 */
export function checkLoginUrl(raw: string): { origin: string; url: string } {
  let parsed: URL;
  try { parsed = new URL(raw.trim()); } catch { throw new SecureLoginError('URL de connexion invalide.'); }
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) throw new SecureLoginError('Une connexion sécurisée exige une page HTTPS.');
  if (parsed.username || parsed.password) throw new SecureLoginError('L’URL ne doit contenir ni identifiant ni mot de passe.');
  parsed.hash = '';
  return { origin: parsed.origin, url: parsed.toString().slice(0, 2000) };
}

export async function getSecureLogin(id: string): Promise<SecureLoginRow | null> {
  const [row] = await db().select().from(schema.secureLogins).where(eq(schema.secureLogins.id, id));
  return row ?? null;
}

export async function pendingSecureLogin(agentId: string): Promise<SecureLoginRow | null> {
  const [row] = await db().select().from(schema.secureLogins).where(and(eq(schema.secureLogins.agentId, agentId), eq(schema.secureLogins.status, 'pending'))).orderBy(desc(schema.secureLogins.createdAt)).limit(1);
  return row ?? null;
}

export async function listSecureLogins(filter: { pending?: boolean } = {}): Promise<SecureLoginRow[]> {
  const rows = db().select().from(schema.secureLogins);
  return (filter.pending ? rows.where(eq(schema.secureLogins.status, 'pending')) : rows).orderBy(desc(schema.secureLogins.createdAt)).limit(50);
}

export async function requestSecureLogin(input: { agentId: string; conversationId: string; taskId?: string | null; url: string; reason: string }, delegation?: TeamDelegation | null): Promise<SecureLoginRow> {
  const { origin, url } = checkLoginUrl(input.url);
  const { created, fresh } = await db().transaction(async (tx) => {
    const [existing] = await tx.select().from(schema.secureLogins)
      .where(and(eq(schema.secureLogins.agentId, input.agentId), eq(schema.secureLogins.status, 'pending')))
      .orderBy(desc(schema.secureLogins.createdAt)).limit(1).for('update');
    if (existing) {
      if (delegation && existing.url !== url) throw new SecureLoginError('Une autre connexion sécurisée est déjà en cours.');
      if (delegation) {
        const [linked] = await tx.select({ id: schema.teamHandoffs.id }).from(schema.teamHandoffs)
          .where(and(eq(schema.teamHandoffs.kind, 'secure_login'), eq(schema.teamHandoffs.refId, existing.id), eq(schema.teamHandoffs.teamMessageId, delegation.teamMessageId)));
        if (!linked) await openHandoff({ agentId: input.agentId, kind: 'secure_login', refId: existing.id, delegation }, tx);
      }
      return { created: existing, fresh: false };
    }
    const row = { id: newId('sl'), agentId: input.agentId, conversationId: input.conversationId, taskId: input.taskId ?? null, origin, url, reason: input.reason.slice(0, 500) };
    const [created] = await tx.insert(schema.secureLogins).values(row).returning();
    if (delegation) await openHandoff({ agentId: input.agentId, kind: 'secure_login', refId: row.id, delegation }, tx);
    return { created, fresh: true };
  });
  if (!fresh) return created;
  // Le contrôle du modèle est coupé AVANT que la carte n'apparaisse : pas de fenêtre où il verrait la saisie.
  await withDesktopAgent(input.agentId, () => setHumanControl(true));
  await log(input.agentId, 'secure_login.requested', `Connexion requise sur ${origin}`, { loginId: created.id });
  publish({ type: 'secure_login.changed', login: toSecureLoginDTO(created) });
  return created;
}

const OUTCOME: Record<Exclude<SecureLoginStatus, 'pending'>, string> = {
  authenticated: 'The user says they are signed in. You have control of your browser again: check the page with a fresh inspection or screenshot before continuing, and never ask for or repeat any credential.',
  cancelled: 'The user cancelled the sign-in. Do not retry it and do not ask for credentials; continue without this site or say what you could not do.',
  failed: 'The user could not sign in. Do not retry it and do not ask for credentials; say what you could not do.',
  expired: 'Nobody completed the sign-in in time, so the request expired. Do not ask for credentials; say what is blocked.',
};

/** L'utilisateur (ou l'expiration) clôt la demande : le compagnon reprend la main et ne reçoit qu'un statut. */
export async function resolveSecureLogin(id: string, status: Exclude<SecureLoginStatus, 'pending'>): Promise<SecureLoginRow> {
  const [row] = await db().update(schema.secureLogins).set({ status, resolvedAt: new Date() }).where(and(eq(schema.secureLogins.id, id), eq(schema.secureLogins.status, 'pending'))).returning();
  if (!row) {
    const current = await getSecureLogin(id);
    if (!current) throw new SecureLoginError('Demande de connexion introuvable.');
    return current; // déjà close : une seconde réponse ne réveille pas le compagnon une seconde fois
  }
  // Rien de ce qui a été copié pendant la saisie ne reste lisible par le compagnon.
  await withDesktopAgent(row.agentId, async () => {
    await desktopExecQuiet(['sh', '-c', 'command -v xsel >/dev/null && { xsel -bc; xsel -pc; xsel -sc; } ; command -v xclip >/dev/null && { printf "" | xclip -selection clipboard; printf "" | xclip -selection primary; } ; true']);
    await setHumanControl(false);
  });
  await log(row.agentId, `secure_login.${status}`, `Connexion sur ${row.origin} : ${status}`, { loginId: row.id });
  publish({ type: 'secure_login.changed', login: toSecureLoginDTO(row) });
  const text = `Secure sign-in on ${row.origin}: status = ${status}. ${OUTCOME[status]}`;
  const task = row.taskId ? await getTask(row.taskId) : null;
  if (task && ['waiting_for_user', 'paused', 'running', 'queued'].includes(task.status)) await sendInstruction(task.id, text).catch(() => {});
  const resumed = await resumeReferencedHandoff(row.agentId, 'secure_login', row.id, text);
  if (!row.taskId && !resumed.some((handoff) => handoff.pairConversationId === row.conversationId)) await enqueue('agent.wake', { agentId: row.agentId, conversationId: row.conversationId, event: { type: 'system', title: `Connexion : ${new URL(row.origin).host}` }, text, depth: 0 }, { agentId: row.agentId });
  return row;
}

export async function expireSecureLogins(now = Date.now()): Promise<number> {
  const stale = await db().select().from(schema.secureLogins).where(and(eq(schema.secureLogins.status, 'pending'), lt(schema.secureLogins.createdAt, new Date(now - SECURE_LOGIN_TTL_MS))));
  for (const row of stale) await resolveSecureLogin(row.id, 'expired').catch(() => {});
  return stale.length;
}
