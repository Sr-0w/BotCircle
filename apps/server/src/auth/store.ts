import { EventEmitter } from 'node:events';
import { PGlite } from '@electric-sql/pglite';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { systemDataDir } from '../config.ts';
import type { AccountContext } from './context.ts';

type User = { id: string; email: string; password: string; role: 'admin' | 'user' };
let opening: Promise<PGlite> | undefined;
export function authStore(memory = false) {
  opening ??= (async () => {
    const dir = join(systemDataDir, 'auth');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const db = memory ? new PGlite() : new PGlite(join(dir, 'pg'));
    await db.exec(`CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY, email text UNIQUE NOT NULL, password text NOT NULL, role text NOT NULL DEFAULT 'user', created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS sessions (hash text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
      CREATE TABLE IF NOT EXISTS instance_settings (key text PRIMARY KEY, value text NOT NULL);
      CREATE TABLE IF NOT EXISTS identities (issuer text NOT NULL, subject text NOT NULL, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, email text, created_at timestamptz NOT NULL DEFAULT now(), last_login_at timestamptz, PRIMARY KEY (issuer, subject));
      CREATE INDEX IF NOT EXISTS identities_user ON identities(user_id);
      CREATE TABLE IF NOT EXISTS auth_audit (id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), actor text, action text NOT NULL, detail text NOT NULL);
      ALTER TABLE identities ADD COLUMN IF NOT EXISTS given_name text;
      ALTER TABLE identities ADD COLUMN IF NOT EXISTS family_name text;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS via text NOT NULL DEFAULT 'password';
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS id_token_hint text;`);
    await db.query('DELETE FROM sessions WHERE expires_at < now()');
    return db;
  })();
  return opening;
}
const derive = (password: string, salt: Buffer) => new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, result) => error ? reject(error) : resolve(result)));
export class AuthError extends Error {}
export function emailAddress(raw: string) {
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthError('Adresse e-mail invalide.');
  return email;
}
export async function registerUser(rawEmail: string, password: string) {
  const email = emailAddress(rawEmail);
  if (password.length < 12 || password.length > 256) throw new AuthError('Choisis un mot de passe de 12 à 256 caractères.');
  const salt = randomBytes(16);
  const encoded = `${salt.toString('hex')}:${(await derive(password, salt)).toString('hex')}`;
  const id = `usr_${randomBytes(16).toString('hex')}`;
  const db = await authStore();
  const result = await db.query<User>('INSERT INTO users (id,email,password) VALUES ($1,$2,$3) ON CONFLICT (email) DO NOTHING RETURNING *', [id, email, encoded]);
  if (!result.rows.length) throw new AuthError('Cette adresse est déjà utilisée. Connecte-toi à ton compte.');
  return toAccount(result.rows[0]);
}
export async function authenticate(rawEmail: string, password: string) {
  const email = emailAddress(rawEmail);
  if (password.length > 256) throw new AuthError('Identifiants incorrects.');
  const { rows } = await (await authStore()).query<User>('SELECT * FROM users WHERE email=$1', [email]);
  // SSO-only accounts store '!' (no password): same work as a wrong password, never a match.
  const local = rows[0]?.password.includes(':') ? rows[0].password : `${'00'.repeat(16)}:${'00'.repeat(64)}`;
  const [salt, hash] = local.split(':');
  const candidate = await derive(password, Buffer.from(salt, 'hex'));
  if (!rows[0] || local !== rows[0].password || !timingSafeEqual(candidate, Buffer.from(hash, 'hex'))) throw new AuthError('Identifiants incorrects.');
  return toAccount(rows[0]);
}
function toAccount(row: Pick<User, 'id' | 'email' | 'role'>): AccountContext {
  return { id: row.id, email: row.email, role: row.role, dataDir: join(systemDataDir, 'users', row.id) };
}
export const publicAccount = (account: AccountContext) => ({ id: account.id, email: account.email, role: account.role });
export async function listAccounts() {
  return (await (await authStore()).query<User>('SELECT id,email,role FROM users ORDER BY created_at')).rows.map(toAccount);
}
export async function accountById(id: string) {
  const { rows } = await (await authStore()).query<User>('SELECT id,email,role FROM users WHERE id=$1', [id]);
  return rows[0] ? toAccount(rows[0]) : null;
}
const revokedSessions = new EventEmitter();
revokedSessions.setMaxListeners(0);
export function onSessionRevoked(token: string, listener: () => void) {
  const key = sessionHash(token);
  revokedSessions.on(key, listener);
  return () => { revokedSessions.off(key, listener); };
}
const sessionHash = (raw: string) => createHash('sha256').update(raw).digest('hex');
export async function createSession(accountId: string, options: { via?: 'password' | 'oidc'; hours?: number; idTokenHint?: string } = {}) {
  const token = randomBytes(32).toString('base64url');
  const hours = options.hours ?? 7 * 24;
  await (await authStore()).query('INSERT INTO sessions(hash,user_id,expires_at,via,id_token_hint) VALUES ($1,$2,$3,$4,$5)', [sessionHash(token), accountId, new Date(Date.now() + hours * 3600_000), options.via ?? 'password', options.idTokenHint ?? null]);
  return token;
}
/** How a session was opened, and its RP-initiated logout hint (encrypted ID token) for SSO sessions. */
export async function sessionInfo(token: string | undefined) {
  if (!token) return null;
  const { rows } = await (await authStore()).query<{ via: string; id_token_hint: string | null }>('SELECT via,id_token_hint FROM sessions WHERE hash=$1', [sessionHash(token)]);
  return rows[0] ?? null;
}
/** Whether the account has a local password (SSO-only JIT accounts have none). */
export async function hasPassword(accountId: string) {
  const { rows } = await (await authStore()).query<{ password: string }>('SELECT password FROM users WHERE id=$1', [accountId]);
  return !!rows[0]?.password.includes(':');
}
/** Ends every session of an account (unlink, role change, suspension). */
export async function revokeAccountSessions(accountId: string) {
  const { rows } = await (await authStore()).query<{ hash: string }>('DELETE FROM sessions WHERE user_id=$1 RETURNING hash', [accountId]);
  for (const row of rows) revokedSessions.emit(row.hash);
}
export async function sessionAccount(token: string | undefined) {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const { rows } = await (await authStore()).query<User>('SELECT u.id,u.email,u.role FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.hash=$1 AND s.expires_at > now()', [sessionHash(token)]);
  return rows[0] ? toAccount(rows[0]) : null;
}
export async function sessionExpiresAt(token: string) {
  const { rows } = await (await authStore()).query<{ expires_at: Date }>('SELECT expires_at FROM sessions WHERE hash=$1', [sessionHash(token)]);
  return rows[0] ? new Date(rows[0].expires_at).getTime() : 0;
}
export async function revokeSession(token: string) {
  await (await authStore()).query('DELETE FROM sessions WHERE hash=$1', [sessionHash(token)]);
  revokedSessions.emit(sessionHash(token));
}
export async function promoteAdmin(rawEmail: string) {
  const { rows } = await (await authStore()).query('UPDATE users SET role=$1 WHERE email=$2 RETURNING id', ['admin', emailAddress(rawEmail)]);
  if (!rows.length) throw new AuthError('Inscris d’abord ce compte dans BotCircle.');
}
export async function closeAuthStore() {
  if (opening) await (await opening).close();
  opening = undefined;
}
