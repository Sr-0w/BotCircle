import { createHash } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import ssh2, { type ConnectConfig, type Client as SshClient, type ClientChannel } from 'ssh2';
// ssh2 is CommonJS: its classes come from the default export under Node's ESM loader.
const { Client } = ssh2;
import { db, schema } from '../db/client.ts';
import { decryptSecret, encryptSecret } from '../secrets.ts';
import { errorMessage, newId, truncate } from '../util.ts';

/**
 * #52: SSH connections. Everything happens here, on the server: the clients and the models never see a key, a
 * password or a passphrase. A host is trusted by the fingerprint of its key, recorded when the user confirms it;
 * a different key afterwards is refused (possible interception), never silently accepted.
 */
export type SshRow = typeof schema.sshConnections.$inferSelect;
export class SshError extends Error {}

export interface SshConnectionDTO {
  id: string; name: string; description: string; host: string; port: number; username: string; auth: 'key' | 'password';
  hasSecret: boolean; hostKey: string | null; agents: string[]; approval: 'ask' | 'auto'; enabled: boolean;
  status: 'unknown' | 'ok' | 'error'; lastError: string | null; lastOkAt: string | null;
  /** The public half of its key (never the private one), and the command that authorises it on the remote machine. */
  publicKey: string | null; installCommand: string | null; generatedKey: boolean;
}

/** OpenSSH public line of a private key (generated or pasted); null when it cannot be read (e.g. wrong passphrase). */
function publicKeyOf(secret: Record<string, string>): string | null {
  if (secret.publicKey) return secret.publicKey;
  if (!secret.privateKey) return null;
  try {
    const parsed = ssh2.utils.parseKey(secret.privateKey, secret.passphrase);
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!key || key instanceof Error) return null;
    return `${key.type} ${key.getPublicSSH().toString('base64')} botcircle`;
  } catch { return null; }
}

/** Idempotent: run once on the remote machine, as the user BotCircle connects as. */
export function installCommand(publicKey: string): string {
  const quoted = `'${publicKey.replace(/'/g, `'\\''`)}'`;
  return `mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && (grep -qxF ${quoted} ~/.ssh/authorized_keys || echo ${quoted} >> ~/.ssh/authorized_keys)`;
}

export function toSshDTO(row: SshRow): SshConnectionDTO {
  const secret = row.secret && row.auth === 'key' ? JSON.parse(decryptSecret(row.secret)) as Record<string, string> : {};
  const publicKey = publicKeyOf(secret);
  return { publicKey, installCommand: publicKey ? installCommand(publicKey) : null, generatedKey: Boolean(secret.generated), id: row.id, name: row.name, description: row.description, host: row.host, port: row.port, username: row.username, auth: row.auth, hasSecret: Boolean(row.secret), hostKey: row.hostKey, agents: row.agents, approval: row.approval, enabled: row.enabled, status: row.status, lastError: row.lastError, lastOkAt: row.lastOkAt?.toISOString() ?? null };
}

const HOST = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*|\d{1,3}(?:\.\d{1,3}){3}|\[?[0-9a-fA-F:]+\]?)$/;

export interface SshInput { name?: string; description?: string; host?: string; port?: number; username?: string; auth?: 'key' | 'password'; privateKey?: string | null; generateKey?: boolean; passphrase?: string | null; password?: string | null; agents?: string[]; approval?: 'ask' | 'auto'; enabled?: boolean }

export async function listSsh(): Promise<SshRow[]> { return db().select().from(schema.sshConnections).orderBy(desc(schema.sshConnections.createdAt)); }
export async function getSsh(id: string): Promise<SshRow | null> { const [row] = await db().select().from(schema.sshConnections).where(eq(schema.sshConnections.id, id)); return row ?? null; }

export async function saveSsh(input: SshInput & { id?: string }): Promise<SshRow> {
  const existing = input.id ? await getSsh(input.id) : null;
  if (input.id && !existing) throw new SshError('Connexion introuvable.');
  const host = (input.host ?? existing?.host ?? '').trim().replace(/^\[|\]$/g, '');
  if (!host || !HOST.test(host)) throw new SshError('Adresse invalide : un nom d’hôte ou une adresse IP.');
  const port = input.port ?? existing?.port ?? 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SshError('Port invalide.');
  const username = (input.username ?? existing?.username ?? '').trim();
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(username)) throw new SshError('Nom d’utilisateur invalide.');
  const auth = input.generateKey ? 'key' : input.auth ?? existing?.auth ?? 'key';
  const previous = existing?.secret ? JSON.parse(decryptSecret(existing.secret)) as Record<string, string> : {};
  const secret: Record<string, string> = { ...previous };
  if (input.privateKey !== undefined) { delete secret.publicKey; delete secret.generated; if (input.privateKey) secret.privateKey = input.privateKey.trim() + '\n'; else delete secret.privateKey; }
  // A key made here: ed25519, kept only encrypted on the server; the user gets its public half and the command to add it.
  if (input.generateKey) {
    const pair = ssh2.utils.generateKeyPairSync('ed25519', { comment: 'botcircle' });
    secret.privateKey = pair.private.trim() + '\n'; secret.publicKey = pair.public.trim(); secret.generated = '1'; delete secret.passphrase;
  }
  if (input.passphrase !== undefined) { if (input.passphrase) secret.passphrase = input.passphrase; else delete secret.passphrase; }
  if (input.password !== undefined) { if (input.password) secret.password = input.password; else delete secret.password; }
  if (auth === 'key' && secret.privateKey && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(secret.privateKey)) throw new SshError('Clé privée illisible : colle la clé complète (BEGIN … PRIVATE KEY).');
  if (auth === 'key' && !secret.privateKey) throw new SshError('Ajoute la clé privée, ou laisse BotCircle en créer une.');
  if (auth === 'password' && !secret.password) throw new SshError('Ajoute le mot de passe.');
  // Changing where it points invalidates the trusted host key.
  const moved = existing && (existing.host !== host || existing.port !== port);
  const values = {
    name: (input.name ?? existing?.name ?? host).trim().slice(0, 80) || host,
    description: (input.description ?? existing?.description ?? '').trim().slice(0, 300),
    host, port, username, auth,
    secret: encryptSecret(JSON.stringify(secret)),
    hostKey: moved ? null : existing?.hostKey ?? null,
    agents: [...new Set(input.agents ?? existing?.agents ?? [])],
    approval: input.approval ?? existing?.approval ?? 'ask',
    enabled: input.enabled ?? existing?.enabled ?? true,
    updatedAt: new Date(),
  };
  if (existing) { await db().update(schema.sshConnections).set(values).where(eq(schema.sshConnections.id, existing.id)); return (await getSsh(existing.id))!; }
  const id = newId('ssh');
  await db().insert(schema.sshConnections).values({ id, ...values });
  return (await getSsh(id))!;
}

export async function deleteSsh(id: string) { await db().delete(schema.sshConnections).where(eq(schema.sshConnections.id, id)); }

const fingerprint = (key: Buffer) => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

/** Secrets must never appear in what a model or a log sees, even if a remote command echoes them. */
export function redact(text: string, row: SshRow): string {
  let out = text;
  if (row.secret) {
    const secret = JSON.parse(decryptSecret(row.secret)) as Record<string, string>;
    for (const value of Object.values(secret)) for (const piece of value.split('\n').map((l) => l.trim()).filter((l) => l.length >= 8 && !/^-----/.test(l))) out = out.split(piece).join('[secret]');
  }
  return out.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[clé privée masquée]');
}

interface Session { client: SshClient; hostKey: string }

/** Opens a session. With `trustNew`, an unknown host key is recorded (the user confirmed it); otherwise it must match. */
async function open(row: SshRow, opts: { trustNew?: boolean; timeoutMs?: number } = {}): Promise<Session> {
  if (!row.secret) throw new SshError('Aucun secret enregistré pour cette connexion.');
  const secret = JSON.parse(decryptSecret(row.secret)) as Record<string, string>;
  let seen = '';
  const client = new Client();
  // A late socket error (after ready, or a second one) must never become an unhandled 'error' event.
  client.on('error', () => {});
  const config: ConnectConfig = {
    host: row.host, port: row.port, username: row.username, readyTimeout: opts.timeoutMs ?? 12_000,
    ...(row.auth === 'key' ? { privateKey: secret.privateKey, passphrase: secret.passphrase } : { password: secret.password }),
    hostVerifier: (key: Buffer) => {
      seen = fingerprint(key);
      if (row.hostKey) return seen === row.hostKey;
      return Boolean(opts.trustNew);
    },
  };
  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve());
    client.once('error', (error: Error & { level?: string; code?: string }) => {
      const message = error.level === 'client-authentication' ? 'Authentification refusée (clé ou mot de passe incorrect).'
        : seen && row.hostKey && seen !== row.hostKey ? `La clé de l’hôte a changé (${seen}, attendue ${row.hostKey}) : connexion refusée. Si c’est normal (réinstallation), fais à nouveau confiance à l’hôte dans Paramètres → Connexions.`
        : seen && !row.hostKey && !opts.trustNew ? `Hôte inconnu (${seen}) : vérifie l’empreinte et fais-lui confiance dans Paramètres → Connexions avant toute commande.`
        : error.code === 'ECONNREFUSED' ? `Connexion refusée par ${row.host}:${row.port} (aucun serveur SSH à cette adresse ?).`
        : error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN' ? `Nom d’hôte introuvable : ${row.host}.`
        : /timed out|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/i.test(`${error.code} ${error.message}`) ? `${row.host} est injoignable depuis le serveur BotCircle : vérifie qu’il est sur le même réseau, un VPN ou un accès public.`
        : `Connexion SSH impossible : ${error.message}`;
      reject(new SshError(message));
    });
    client.connect(config);
  });
  return { client, hostKey: seen };
}

async function mark(row: SshRow, ok: boolean, error?: string) {
  await db().update(schema.sshConnections).set(ok ? { status: 'ok', lastError: null, lastOkAt: new Date() } : { status: 'error', lastError: truncate(error ?? '', 300) }).where(eq(schema.sshConnections.id, row.id));
}

/** Test: connects, reports the host key; with `trust`, records it as the trusted key. */
export async function testSsh(id: string, trust = false): Promise<{ ok: boolean; hostKey: string | null; trusted: boolean; error: string | null }> {
  const row = await getSsh(id);
  if (!row) throw new SshError('Connexion introuvable.');
  const candidate = trust ? { ...row, hostKey: null } : row;
  try {
    const session = await open(candidate, { trustNew: trust });
    session.client.end();
    if (trust) await db().update(schema.sshConnections).set({ hostKey: session.hostKey }).where(eq(schema.sshConnections.id, id));
    await mark(row, true);
    return { ok: true, hostKey: session.hostKey, trusted: true, error: null };
  } catch (error) {
    await mark(row, false, errorMessage(error));
    const unknown = /Hôte inconnu \((SHA256:[^)]+)\)/.exec(errorMessage(error));
    return { ok: false, hostKey: unknown?.[1] ?? row.hostKey, trusted: Boolean(row.hostKey), error: errorMessage(error) };
  }
}

export interface SshResult { status: 'succeeded' | 'failed' | 'timeout' | 'cancelled'; exitCode: number | null; stdout: string; stderr: string; durationMs: number; truncated: boolean }

/** Runs one command. Output is capped, secrets redacted; timeout and cancellation close the channel. */
export async function executeSsh(row: SshRow, command: string, opts: { timeoutMs?: number; maxOutput?: number; signal?: AbortSignal } = {}): Promise<SshResult> {
  if (!row.enabled) throw new SshError('Cette connexion est désactivée.');
  if (!row.hostKey) throw new SshError('Hôte pas encore vérifié : fais-lui confiance dans Paramètres → Connexions avant toute commande.');
  const started = Date.now(), max = opts.maxOutput ?? 60_000, timeoutMs = Math.min(opts.timeoutMs ?? 120_000, 30 * 60_000);
  const session = await open(row).catch(async (error) => { await mark(row, false, errorMessage(error)); throw error; });
  try {
    return await new Promise<SshResult>((resolve, reject) => {
      let stdout = '', stderr = '', truncated = false, done = false;
      const finish = (status: SshResult['status'], exitCode: number | null) => {
        if (done) return; done = true; clearTimeout(timer); opts.signal?.removeEventListener('abort', abort);
        resolve({ status, exitCode, stdout: redact(stdout, row), stderr: redact(stderr, row), durationMs: Date.now() - started, truncated });
      };
      const take = (chunk: Buffer, into: 'out' | 'err') => {
        const text = chunk.toString('utf8');
        if (into === 'out') { if (stdout.length < max) stdout += text.slice(0, max - stdout.length); else truncated = true; }
        else { if (stderr.length < max) stderr += text.slice(0, max - stderr.length); else truncated = true; }
      };
      let channel: import('ssh2').ClientChannel | null = null;
      const timer = setTimeout(() => { channel?.close(); finish('timeout', null); }, timeoutMs);
      const abort = () => { channel?.close(); finish('cancelled', null); };
      if (opts.signal?.aborted) { abort(); return; }
      opts.signal?.addEventListener('abort', abort, { once: true });
      session.client.exec(command, (error: Error | undefined, stream: ClientChannel) => {
        if (error) { done = true; clearTimeout(timer); reject(new SshError(`Commande refusée par l’hôte : ${error.message}`)); return; }
        channel = stream;
        stream.on('data', (chunk: Buffer) => take(chunk, 'out'));
        stream.stderr.on('data', (chunk: Buffer) => take(chunk, 'err'));
        stream.on('close', (code: number | null) => finish(code === 0 ? 'succeeded' : 'failed', code ?? null));
      });
    });
  } finally {
    session.client.end();
    await mark(row, true);
  }
}
