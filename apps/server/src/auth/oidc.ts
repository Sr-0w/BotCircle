/**
 * #77 — Single Sign-On with OpenID Connect (Authentik is the reference provider, nothing Authentik-specific here).
 *
 * The BotCircle server is the only OIDC client (confidential: it holds the client secret). Web and Android never
 * see IdP tokens: the server runs Authorization Code + PKCE (S256) with state and nonce, verifies the ID token
 * (signature against the discovered JWKS with key rollover, exact issuer, audience, expiry, nonce), maps the stable
 * `(issuer, sub)` identity to a BotCircle account and opens an ordinary BotCircle session.
 * Android starts the flow in the system browser (Custom Tabs) and gets its session through a one-time handoff code
 * bound to its own PKCE verifier, so a code intercepted on the custom scheme is useless.
 * An OIDC login never grants anything beyond the account's own BotCircle role; group claims only matter through
 * explicit allowlists configured by an administrator.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createLocalJWKSet, jwtVerify, errors as joseErrors, type JSONWebKeySet, type JWTPayload } from 'jose';
import { withAccount, type AccountContext } from './context.ts';
import { authStore, AuthError, emailAddress } from './store.ts';
import { decryptSecret, encryptSecret } from '../secrets.ts';

export type OidcSettings = {
  enabled: boolean;
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  /** Text of the sign-in button, e.g. "Authentik". */
  label: string;
  /** Create a BotCircle account at first SSO login (just-in-time). */
  jit: boolean;
  /** Optional: only these email domains (verified email) may sign in. */
  allowedDomains: string[];
  /** Optional: only members of one of these groups (claim `groupsClaim`) may sign in. */
  allowedGroups: string[];
  /** Optional: members of one of these groups are administrators of this BotCircle (synced at each SSO login). */
  adminGroups: string[];
  groupsClaim: string;
  /** false = SSO only: password login is kept for administrators only (break-glass recovery). */
  localLogin: boolean;
  /** Lifetime of a session opened through SSO; a removed or suspended identity loses access within this bound. */
  sessionHours: number;
};
export type OidcPublic = { enabled: boolean; label: string; localLogin: boolean };
type Discovery = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; end_session_endpoint?: string; userinfo_endpoint?: string; token_endpoint_auth_methods_supported?: string[]; code_challenge_methods_supported?: string[]; id_token_signing_alg_values_supported?: string[] };
type Pending = { client: 'web' | 'android'; mode: 'login' | 'link'; linkUserId?: string; state: string; nonce: string; verifier: string; browser?: string; appChallenge?: string; returnTo: string; expires: number };
type Handoff = { userId: string; appChallenge: string; expires: number; identity: string };

const DEFAULTS: OidcSettings = { enabled: false, issuer: '', clientId: '', clientSecret: '', scopes: 'openid profile email', label: 'SSO', jit: false, allowedDomains: [], allowedGroups: [], adminGroups: [], groupsClaim: 'groups', localLogin: true, sessionHours: 12 };
const sha = (value: string) => createHash('sha256').update(value).digest('base64url');
const token = () => randomBytes(32).toString('base64url');
const list = (raw: string | undefined) => (raw ?? '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export class OidcError extends AuthError {
  constructor(message: string, readonly code: string = 'sso_failed') { super(message); }
}

/** Environment configuration (headless deployments) always wins over the UI configuration. */
export function envSettings(): Partial<OidcSettings> | null {
  const e = process.env;
  if (!e.OPENDOTS_OIDC_ISSUER) return null;
  return {
    enabled: e.OPENDOTS_OIDC_ENABLED !== 'false', issuer: e.OPENDOTS_OIDC_ISSUER, clientId: e.OPENDOTS_OIDC_CLIENT_ID ?? '', clientSecret: e.OPENDOTS_OIDC_CLIENT_SECRET ?? '',
    ...(e.OPENDOTS_OIDC_SCOPES ? { scopes: e.OPENDOTS_OIDC_SCOPES } : {}), ...(e.OPENDOTS_OIDC_LABEL ? { label: e.OPENDOTS_OIDC_LABEL } : {}),
    jit: e.OPENDOTS_OIDC_JIT === 'true', allowedDomains: list(e.OPENDOTS_OIDC_ALLOWED_DOMAINS), allowedGroups: list(e.OPENDOTS_OIDC_ALLOWED_GROUPS), adminGroups: list(e.OPENDOTS_OIDC_ADMIN_GROUPS),
    ...(e.OPENDOTS_OIDC_GROUPS_CLAIM ? { groupsClaim: e.OPENDOTS_OIDC_GROUPS_CLAIM } : {}), localLogin: e.OPENDOTS_OIDC_LOCAL_LOGIN !== 'false',
    ...(e.OPENDOTS_OIDC_SESSION_HOURS ? { sessionHours: Number(e.OPENDOTS_OIDC_SESSION_HOURS) } : {}),
  };
}

export async function oidcSettings(): Promise<OidcSettings & { source: 'environment' | 'local' }> {
  // Emergency switch for a misconfigured or unreachable IdP: OPENDOTS_OIDC=off restores password login for everyone.
  const off = process.env.OPENDOTS_OIDC === 'off';
  const env = envSettings();
  if (env) return { ...DEFAULTS, ...env, ...(off ? { enabled: false, localLogin: true } : {}), source: 'environment' };
  const { rows } = await (await authStore()).query<{ value: string }>('SELECT value FROM instance_settings WHERE key=$1', ['oidc']);
  const stored = rows[0] ? withAccount(undefined, () => JSON.parse(decryptSecret(rows[0].value))) as Partial<OidcSettings> : {};
  return { ...DEFAULTS, ...stored, ...(off ? { enabled: false, localLogin: true } : {}), source: 'local' };
}

export async function publicOidc(): Promise<OidcPublic> {
  const s = await oidcSettings();
  const ready = s.enabled && !!s.issuer && !!s.clientId;
  return { enabled: ready, label: s.label || 'SSO', localLogin: !ready || s.localLogin };
}

/** Admin view: never returns the secret, only whether one is set. */
export async function adminOidcView(origin: string) {
  const s = await oidcSettings();
  const { clientSecret, ...rest } = s;
  return { ...rest, hasSecret: !!clientSecret, callbackUrl: `${origin}/api/auth/oidc/callback`, androidRedirect: ANDROID_REDIRECT, postLogoutUrl: `${origin}/` };
}

export async function saveOidcSettings(input: Partial<OidcSettings>, actor: AccountContext) {
  if (actor.role !== 'admin') throw new OidcError('Configuration réservée à l’administrateur.');
  if (envSettings()) throw new OidcError('Le SSO est configuré par les variables du déploiement (OPENDOTS_OIDC_*).');
  const previous = await oidcSettings();
  const next: OidcSettings = { ...DEFAULTS, ...previous, ...input, clientSecret: input.clientSecret ? input.clientSecret : (input.clientId === undefined || input.clientId === previous.clientId) ? previous.clientSecret : '' };
  next.issuer = next.issuer.trim().replace(/\/+$/, ''); next.clientId = next.clientId.trim(); next.label = next.label.trim().slice(0, 40) || 'SSO';
  next.scopes = next.scopes.split(/\s+/).filter(Boolean).join(' ');
  if (!next.scopes.split(' ').includes('openid')) next.scopes = `openid ${next.scopes}`.trim();
  next.sessionHours = Math.min(24 * 30, Math.max(1, Math.round(Number(next.sessionHours) || 12)));
  for (const key of ['allowedDomains', 'allowedGroups', 'adminGroups'] as const) next[key] = [...new Set((next[key] ?? []).map((s) => String(s).trim().toLowerCase()).filter(Boolean))].slice(0, 50);
  if (next.enabled) {
    if (!next.issuer || !next.clientId || !next.clientSecret) throw new OidcError('Issuer, Client ID et secret sont requis pour activer le SSO.');
    const url = new URL(next.issuer);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new OidcError('L’issuer doit être en HTTPS.');
  }
  // SSO-only never applies to the acting administrator's own recovery path (admins keep password login).
  const { source: _source, ...stored } = next as OidcSettings & { source?: string };
  const encrypted = withAccount(undefined, () => encryptSecret(JSON.stringify(stored)));
  await (await authStore()).query('INSERT INTO instance_settings(key,value) VALUES ($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', ['oidc', encrypted]);
  await audit(actor.id, 'oidc.config', { enabled: next.enabled, issuer: next.issuer, clientId: next.clientId, secretChanged: !!input.clientSecret, jit: next.jit, localLogin: next.localLogin, allowedGroups: next.allowedGroups, adminGroups: next.adminGroups, allowedDomains: next.allowedDomains });
}

export const ANDROID_REDIRECT = 'botcircle://auth/callback';

export async function audit(actor: string | null, action: string, detail: Record<string, unknown>) {
  await (await authStore()).query('INSERT INTO auth_audit(actor,action,detail) VALUES ($1,$2,$3)', [actor, action, JSON.stringify(detail)]);
}

export class OidcService {
  private discoveryCache = new Map<string, { value: Discovery; until: number }>();
  private jwksCache = new Map<string, { keys: JSONWebKeySet; until: number }>();
  private pending = new Map<string, Pending>();
  private handoffs = new Map<string, Handoff>();
  constructor(private transport: typeof fetch = (...args) => fetch(...args), private now = () => Date.now()) {}

  async discover(issuer: string, fresh = false): Promise<Discovery> {
    const cached = this.discoveryCache.get(issuer);
    if (!fresh && cached && cached.until > this.now()) return cached.value;
    let response: Response;
    try { response = await this.transport(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000), redirect: 'error' }); }
    catch { throw new OidcError('Fournisseur d’identité injoignable. Réessaie plus tard ou connecte-toi avec ton mot de passe.', 'sso_unavailable'); }
    if (!response.ok) throw new OidcError(`Découverte OIDC impossible (${response.status}).`, 'sso_unavailable');
    const value = await response.json() as Discovery;
    // Exact issuer match (OIDC Discovery §4.3): a lookalike or mis-typed issuer is refused.
    if (value.issuer !== issuer && value.issuer !== `${issuer}/`) throw new OidcError(`Issuer différent de celui configuré (${value.issuer}).`, 'sso_misconfigured');
    for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) if (typeof value[key] !== 'string' || !/^https?:\/\//.test(value[key])) throw new OidcError(`Découverte OIDC incomplète (${key}).`, 'sso_misconfigured');
    if (value.code_challenge_methods_supported && !value.code_challenge_methods_supported.includes('S256')) throw new OidcError('Le fournisseur ne prend pas en charge PKCE S256.', 'sso_misconfigured');
    this.discoveryCache.set(issuer, { value, until: this.now() + 10 * 60_000 });
    return value;
  }

  private async jwks(uri: string, fresh = false) {
    const cached = this.jwksCache.get(uri);
    if (!fresh && cached && cached.until > this.now()) return cached.keys;
    const response = await this.transport(uri, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000), redirect: 'error' });
    if (!response.ok) throw new OidcError('Clés de signature du fournisseur indisponibles.', 'sso_unavailable');
    const keys = await response.json() as JSONWebKeySet;
    this.jwksCache.set(uri, { keys, until: this.now() + 10 * 60_000 });
    return keys;
  }

  private sweep() {
    for (const [k, v] of this.pending) if (v.expires <= this.now()) this.pending.delete(k);
    for (const [k, v] of this.handoffs) if (v.expires <= this.now()) this.handoffs.delete(k);
  }

  /** Starts a login (or an account link) and returns the IdP authorization URL. */
  async begin(input: { client: 'web' | 'android'; origin: string; returnTo?: string; appChallenge?: string; linkUserId?: string }) {
    const s = await oidcSettings();
    if (!s.enabled || !s.issuer || !s.clientId) throw new OidcError('Le SSO n’est pas activé sur ce serveur.', 'sso_disabled');
    if (input.client === 'android' && !/^[A-Za-z0-9_-]{43}$/.test(input.appChallenge ?? '')) throw new OidcError('Requête de connexion invalide.', 'sso_invalid');
    this.sweep();
    if (this.pending.size >= 500) throw new OidcError('Trop de connexions en cours. Réessaie dans quelques minutes.', 'sso_busy');
    const d = await this.discover(s.issuer);
    const state = token(), nonce = token(), verifier = token(), browser = input.client === 'web' ? token() : undefined;
    // Only same-app relative destinations: no open redirect through returnTo.
    const returnTo = typeof input.returnTo === 'string' && /^\/(?!\/)[^\s\\]*$/.test(input.returnTo) ? input.returnTo : '/';
    this.pending.set(sha(state), { client: input.client, mode: input.linkUserId ? 'link' : 'login', linkUserId: input.linkUserId, state, nonce, verifier, browser: browser && sha(browser), appChallenge: input.appChallenge, returnTo, expires: this.now() + 10 * 60_000 });
    const url = new URL(d.authorization_endpoint);
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: s.clientId, redirect_uri: `${input.origin}/api/auth/oidc/callback`, scope: s.scopes, state, nonce, code_challenge: sha(verifier), code_challenge_method: 'S256' })) url.searchParams.set(k, v);
    return { url: url.href, browser, state };
  }

  /** Which client started a flow (to send an error back to the right place). */
  clientOf(state: string | undefined): 'web' | 'android' | null {
    return this.pending.get(sha(state ?? ''))?.client ?? null;
  }

  /** Callback: one-time state, browser binding (web), code exchange, ID-token verification, identity mapping. */
  async complete(input: { origin: string; state?: string; code?: string; error?: string; browser?: string }) {
    const key = sha(input.state ?? ''), entry = this.pending.get(key);
    if (!entry || entry.expires <= this.now()) throw new OidcError('Connexion expirée. Recommence.', 'sso_expired');
    if (entry.client === 'web' && (!input.browser || !entry.browser || !same(sha(input.browser), entry.browser))) throw new OidcError('Cette connexion doit se terminer dans le navigateur qui l’a commencée.', 'sso_invalid');
    this.pending.delete(key); // one-time, including denied consent
    if (input.error || !input.code) throw new OidcError(input.error === 'access_denied' ? 'Connexion refusée ou annulée.' : 'Connexion annulée.', 'sso_denied');
    const s = await oidcSettings();
    if (!s.enabled) throw new OidcError('Le SSO n’est pas activé sur ce serveur.', 'sso_disabled');
    const d = await this.discover(s.issuer);
    const body = new URLSearchParams({ grant_type: 'authorization_code', code: input.code, redirect_uri: `${input.origin}/api/auth/oidc/callback`, code_verifier: entry.verifier });
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    const methods = d.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
    if (methods.includes('client_secret_basic')) headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(s.clientId)}:${encodeURIComponent(s.clientSecret)}`).toString('base64')}`;
    else { body.set('client_id', s.clientId); body.set('client_secret', s.clientSecret); }
    let response: Response;
    try { response = await this.transport(d.token_endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(15_000), redirect: 'error' }); }
    catch { throw new OidcError('Fournisseur d’identité injoignable.', 'sso_unavailable'); }
    if (!response.ok) throw new OidcError(`Le fournisseur a refusé l’échange (${response.status}).`, 'sso_failed');
    const tokens = await response.json() as { id_token?: string };
    if (typeof tokens.id_token !== 'string') throw new OidcError('Le fournisseur n’a pas renvoyé d’ID token.', 'sso_failed');
    const claims = await this.verify(tokens.id_token, d, s, entry.nonce);
    const user = await this.resolve(claims, s, entry);
    return { user, entry, settings: s, discovery: d, idToken: tokens.id_token };
  }

  async verify(idToken: string, d: Discovery, s: OidcSettings, nonce: string): Promise<JWTPayload & Record<string, unknown>> {
    const check = async (fresh: boolean) => jwtVerify(idToken, createLocalJWKSet(await this.jwks(d.jwks_uri, fresh)), {
      issuer: d.issuer, audience: s.clientId, clockTolerance: 120, currentDate: new Date(this.now()),
      algorithms: (d.id_token_signing_alg_values_supported ?? ['RS256']).filter((a) => a !== 'none' && !a.startsWith('HS')),
    });
    let result;
    try { result = await check(false); }
    catch (error) {
      // Key rollover: an unknown `kid` refreshes the JWKS once.
      if (error instanceof joseErrors.JWKSNoMatchingKey) {
        try { result = await check(true); } catch { throw new OidcError('Signature de l’identité invalide.', 'sso_invalid'); }
      } else throw new OidcError(error instanceof joseErrors.JWTExpired ? 'Identité expirée : recommence la connexion.' : 'Identité du fournisseur invalide.', 'sso_invalid');
    }
    const p = result.payload as JWTPayload & Record<string, unknown>;
    if (typeof p.nonce !== 'string' || !same(p.nonce, nonce)) throw new OidcError('Identité rejouée ou invalide.', 'sso_invalid');
    if (Array.isArray(p.aud) && p.aud.length > 1 && p.azp !== s.clientId) throw new OidcError('Identité destinée à une autre application.', 'sso_invalid');
    if (typeof p.sub !== 'string' || !p.sub) throw new OidcError('Identité sans sujet.', 'sso_invalid');
    return p;
  }

  private groups(claims: Record<string, unknown>, s: OidcSettings) {
    const raw = claims[s.groupsClaim];
    return (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []).map((g) => String(g).toLowerCase());
  }

  /** Maps `(issuer, sub)` to an account. Email is never enough to take over an existing account. */
  private async resolve(claims: JWTPayload & Record<string, unknown>, s: OidcSettings, entry: Pending) {
    const db = await authStore();
    const issuer = String(claims.iss), subject = String(claims.sub);
    const verifiedEmail = claims.email_verified === true && typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : null;
    const groups = this.groups(claims, s);
    if (s.allowedGroups.length && !groups.some((g) => s.allowedGroups.includes(g))) { await audit(null, 'oidc.denied', { issuer, subject, reason: 'group' }); throw new OidcError('Ton compte n’est pas autorisé sur ce BotCircle.', 'sso_forbidden'); }
    if (s.allowedDomains.length && !(verifiedEmail && s.allowedDomains.includes(verifiedEmail.split('@')[1]))) { await audit(null, 'oidc.denied', { issuer, subject, reason: 'domain' }); throw new OidcError('Ton compte n’est pas autorisé sur ce BotCircle.', 'sso_forbidden'); }
    const linked = await db.query<{ user_id: string }>('SELECT user_id FROM identities WHERE issuer=$1 AND subject=$2', [issuer, subject]);
    let userId = linked.rows[0]?.user_id;
    if (entry.mode === 'link') {
      if (userId && userId !== entry.linkUserId) throw new OidcError('Ce compte du fournisseur est déjà lié à un autre compte BotCircle.', 'sso_conflict');
      const other = await db.query('SELECT 1 FROM identities WHERE user_id=$1 AND issuer=$2', [entry.linkUserId, issuer]);
      if (!userId && other.rows.length) throw new OidcError('Un autre compte de ce fournisseur est déjà lié. Délie-le d’abord.', 'sso_conflict');
      userId = entry.linkUserId!;
      await db.query('INSERT INTO identities(issuer,subject,user_id,email) VALUES ($1,$2,$3,$4) ON CONFLICT (issuer,subject) DO NOTHING', [issuer, subject, userId, verifiedEmail]);
      await audit(userId, 'oidc.link', { issuer, subject });
    } else if (!userId) {
      if (!s.jit) throw new OidcError('Aucun compte BotCircle n’est lié à cette identité. Connecte-toi avec ton mot de passe, puis lie ton compte dans ton profil.', 'sso_unlinked');
      if (process.env.OPENDOTS_REGISTRATION === 'closed') throw new OidcError('Les inscriptions sont fermées sur ce serveur.', 'sso_unlinked');
      if (!verifiedEmail) throw new OidcError('Le fournisseur ne fournit pas d’adresse e-mail vérifiée.', 'sso_unlinked');
      const email = emailAddress(verifiedEmail);
      // Never merge on email: an existing local account must link explicitly while signed in.
      const taken = await db.query('SELECT 1 FROM users WHERE email=$1', [email]);
      if (taken.rows.length) throw new OidcError('Un compte BotCircle utilise déjà cette adresse. Connecte-toi avec ton mot de passe, puis lie ton compte dans ton profil.', 'sso_conflict');
      userId = `usr_${randomBytes(16).toString('hex')}`;
      // No password: '!' never matches a scrypt hash, so this account signs in through SSO only.
      await db.query('INSERT INTO users (id,email,password) VALUES ($1,$2,$3)', [userId, email, '!']);
      await db.query('INSERT INTO identities(issuer,subject,user_id,email) VALUES ($1,$2,$3,$4)', [issuer, subject, userId, verifiedEmail]);
      await audit(userId, 'oidc.jit', { issuer, subject });
    }
    // Profile claims are kept with the identity; they only fill a name the user never set (see profile.ts).
    const claim = (key: string) => typeof claims[key] === 'string' ? (claims[key] as string).trim().slice(0, 60) || null : null;
    await db.query('UPDATE identities SET last_login_at=now(), email=COALESCE($3,email), given_name=$4, family_name=$5 WHERE issuer=$1 AND subject=$2', [issuer, subject, verifiedEmail, claim('given_name'), claim('family_name')]);
    // Role mapping only when an administrator configured admin groups; re-evaluated at every SSO login.
    if (s.adminGroups.length && entry.mode === 'login') {
      const role = groups.some((g) => s.adminGroups.includes(g)) ? 'admin' : 'user';
      const { rows } = await db.query<{ role: string; password: string }>('SELECT role,password FROM users WHERE id=$1', [userId]);
      // A local password admin is the break-glass account: never demoted by a group claim.
      if (rows[0] && rows[0].role !== role && !(rows[0].role === 'admin' && rows[0].password.includes(':'))) {
        await db.query('UPDATE users SET role=$2 WHERE id=$1', [userId, role]);
        await audit(userId, 'oidc.role', { role });
      }
    }
    return { id: userId, identity: `${issuer}#${subject}` };
  }

  /** Android: a one-time code, usable only with the app's PKCE verifier, within 2 minutes. */
  issueHandoff(userId: string, appChallenge: string, identity: string) {
    this.sweep();
    const code = token();
    this.handoffs.set(sha(code), { userId, appChallenge, identity, expires: this.now() + 120_000 });
    return code;
  }
  redeemHandoff(code: string, verifier: string) {
    const key = sha(code), entry = this.handoffs.get(key);
    this.handoffs.delete(key);
    if (!entry || entry.expires <= this.now() || !/^[A-Za-z0-9_-]{43,128}$/.test(verifier) || !same(sha(verifier), entry.appChallenge)) throw new OidcError('Code de connexion invalide ou expiré.', 'sso_invalid');
    return entry;
  }
}
export const oidc = new OidcService();

export async function linkedIdentities(userId: string) {
  const { rows } = await (await authStore()).query<{ issuer: string; subject: string; email: string | null; created_at: Date; last_login_at: Date | null }>('SELECT issuer,subject,email,created_at,last_login_at FROM identities WHERE user_id=$1 ORDER BY created_at', [userId]);
  return rows.map((r) => ({ issuer: r.issuer, subject: r.subject, email: r.email, linkedAt: new Date(r.created_at).toISOString(), lastLoginAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : null }));
}

export async function unlinkIdentity(userId: string, issuer: string, subject: string) {
  const db = await authStore();
  const { rows } = await db.query<{ password: string }>('SELECT password FROM users WHERE id=$1', [userId]);
  const count = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM identities WHERE user_id=$1', [userId]);
  // An SSO-only account cannot drop its last way in.
  if (!rows[0]?.password.includes(':') && (count.rows[0]?.n ?? 0) <= 1) throw new OidcError('Ce compte n’a pas de mot de passe : il ne peut pas délier sa seule identité.', 'sso_lockout');
  const result = await db.query('DELETE FROM identities WHERE user_id=$1 AND issuer=$2 AND subject=$3 RETURNING 1', [userId, issuer, subject]);
  if (!result.rows.length) throw new OidcError('Identité introuvable.', 'sso_invalid');
  await audit(userId, 'oidc.unlink', { issuer, subject });
}
