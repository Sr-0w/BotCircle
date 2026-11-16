import { createMCPClient } from '@ai-sdk/mcp';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { publicBaseUrl } from '../config.ts';
import { db, schema } from '../db/client.ts';
import { closeMcpClient } from '../connectors/mcp.ts';
import { getConnector, readSecrets, type ConnectorRow } from '../connectors/repo.ts';
import { encryptSecret } from '../secrets.ts';
import { errorMessage, newId } from '../util.ts';
import { defaultPolicy, type HaPolicy } from './policy.ts';

/**
 * #39: Home Assistant through its official MCP server (/api/mcp or /api/mcp/assist). A trusted, HTTP-only path that a
 * standard account may use (unlike arbitrary MCP servers). The token lives encrypted on the server; the model never
 * sees it. Connection: Home Assistant's own OAuth (preferred) or a long-lived access token.
 */
export class HaError extends Error {}
export type HaMode = 'assist' | 'full';
export interface HaConfig { transport: 'http'; url: string; provider: 'homeassistant'; trusted: 'homeassistant'; base: string; mode: HaMode; auth: 'oauth' | 'token'; ha: HaPolicy }

export function normalizeBase(raw: string): string {
  let url: URL;
  try { url = new URL(raw.trim().replace(/\/+$/, '')); } catch { throw new HaError('Adresse invalide : par exemple http://homeassistant.local:8123'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HaError('L’adresse doit commencer par http:// ou https://');
  if (url.username || url.password) throw new HaError('Ne mets pas d’identifiants dans l’adresse.');
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '').replace(/\/api\/mcp(\/assist)?$/, '')}`;
}
export const endpointOf = (base: string, mode: HaMode) => `${base}/api/mcp${mode === 'assist' ? '/assist' : ''}`;

/** Connects once with this token and lists the tools: the only proof the instance really serves MCP to us. */
async function probe(endpoint: string, token: string): Promise<{ name: string; description: string }[]> {
  let client: Awaited<ReturnType<typeof createMCPClient>> | null = null;
  try {
    client = await createMCPClient({ transport: { type: 'http', url: endpoint, headers: { Authorization: `Bearer ${token}` } } });
    const listed = await client.listTools();
    return listed.tools.map((t) => ({ name: t.name, description: (t.description ?? '').slice(0, 300) }));
  } catch (error) {
    const message = errorMessage(error);
    if (/401|403|unauthori[sz]ed|forbidden/i.test(message)) throw new HaError('Home Assistant refuse ce jeton (expiré, révoqué ou sans droits).');
    if (/404|not found/i.test(message)) throw new HaError('Pas de serveur MCP à cette adresse : ajoute l’intégration « Model Context Protocol Server » dans Home Assistant (Paramètres → Appareils et services).');
    if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|fetch failed|timed out/i.test(message)) throw new HaError('Home Assistant est injoignable depuis le serveur BotCircle : vérifie l’adresse, et que les deux sont sur le même réseau (ou via un VPN / une adresse externe).');
    if (/certificate|self.signed|CERT_/i.test(message)) throw new HaError('Le certificat HTTPS de Home Assistant n’est pas valide : utilise une adresse avec un certificat valide, ou l’adresse locale en http sur ton réseau.');
    throw new HaError(`Connexion à Home Assistant impossible : ${message}`);
  } finally { await client?.close().catch(() => {}); }
}

async function save(input: { id?: string; name: string; base: string; mode: HaMode; auth: 'oauth' | 'token'; secret: Record<string, string>; tools: { name: string; description: string }[] }): Promise<ConnectorRow> {
  const existing = input.id ? await getConnector(input.id) : null;
  const config: HaConfig = { transport: 'http', url: endpointOf(input.base, input.mode), provider: 'homeassistant', trusted: 'homeassistant', base: input.base, mode: input.mode, auth: input.auth, ha: (existing?.config as HaConfig | undefined)?.ha ?? defaultPolicy() };
  const values = { name: input.name.trim().slice(0, 80) || 'Home Assistant', kind: 'mcp' as const, config: config as unknown as Record<string, any>, secret: encryptSecret(JSON.stringify(input.secret)), approval: 'auto' as const, enabled: true, status: 'ok' as const, lastError: null, tools: input.tools, updatedAt: new Date() };
  if (existing) { await db().update(schema.connectors).set(values).where(eq(schema.connectors.id, existing.id)); await closeMcpClient(existing.id); return (await getConnector(existing.id))!; }
  const id = newId('mcp');
  await db().insert(schema.connectors).values({ id, ...values });
  return (await getConnector(id))!;
}

/** Long-lived access token (Home Assistant → profile → security). Entered in a secure form, never in a chat. */
export async function connectWithToken(input: { id?: string; name?: string; url: string; mode?: HaMode; token: string }) {
  const base = normalizeBase(input.url), mode = input.mode ?? 'assist';
  const token = input.token.trim();
  if (token.length < 20) throw new HaError('Jeton trop court : copie le jeton d’accès longue durée complet.');
  const tools = await probe(endpointOf(base, mode), token);
  return save({ id: input.id, name: input.name ?? 'Home Assistant', base, mode, auth: 'token', secret: { Authorization: `Bearer ${token}` }, tools });
}

// --- OAuth (Home Assistant's own: the client id is BotCircle's address) ---------------------------------------

const pending = new Map<string, { account: string; name: string; base: string; mode: HaMode; id?: string; at: number }>();
const clientId = () => `${publicBaseUrl().replace(/\/+$/, '')}/`;
const redirectUri = () => `${publicBaseUrl().replace(/\/+$/, '')}/api/homeassistant/callback`;

export function startOAuth(account: string, input: { id?: string; name?: string; url: string; mode?: HaMode }) {
  const base = normalizeBase(input.url);
  const state = randomBytes(24).toString('base64url');
  for (const [key, value] of pending) if (Date.now() - value.at > 15 * 60_000) pending.delete(key);
  pending.set(state, { account, name: input.name ?? 'Home Assistant', base, mode: input.mode ?? 'assist', id: input.id, at: Date.now() });
  const url = new URL(`${base}/auth/authorize`);
  url.searchParams.set('response_type', 'code'); url.searchParams.set('client_id', clientId()); url.searchParams.set('redirect_uri', redirectUri()); url.searchParams.set('state', state);
  return { authorizeUrl: url.toString() };
}

async function tokenRequest(base: string, form: Record<string, string>) {
  const response = await fetch(`${base}/auth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
  const data = await response.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!response.ok || !data.access_token) throw new HaError(`Home Assistant a refusé l’autorisation : ${data.error_description ?? data.error ?? response.status}`);
  return data;
}

/** The redirect back from Home Assistant: the code is exchanged here, on the server, for tokens kept encrypted. */
export async function finishOAuth(account: string, state: string, code: string) {
  const flow = pending.get(state);
  pending.delete(state);
  if (!flow || flow.account !== account) throw new HaError('Autorisation expirée ou d’une autre session : recommence la connexion.');
  const tokens = await tokenRequest(flow.base, { grant_type: 'authorization_code', code, client_id: clientId() });
  const tools = await probe(endpointOf(flow.base, flow.mode), tokens.access_token!);
  return save({ id: flow.id, name: flow.name, base: flow.base, mode: flow.mode, auth: 'oauth', tools, secret: { Authorization: `Bearer ${tokens.access_token}`, refresh_token: tokens.refresh_token ?? '', expires_at: String(Date.now() + (tokens.expires_in ?? 1800) * 1000) } });
}

/** OAuth access tokens last 30 minutes: refreshed just before use; the cached MCP client is rebuilt. */
export async function freshHomeAssistant(row: ConnectorRow): Promise<ConnectorRow> {
  const cfg = row.config as unknown as HaConfig;
  if (cfg.provider !== 'homeassistant' || cfg.auth !== 'oauth') return row;
  const secret = readSecrets(row);
  if (Number(secret.expires_at ?? 0) > Date.now() + 120_000) return row;
  if (!secret.refresh_token) throw new HaError('Autorisation Home Assistant expirée : reconnecte-le dans Paramètres → Connexions.');
  try {
    const tokens = await tokenRequest(cfg.base, { grant_type: 'refresh_token', refresh_token: secret.refresh_token, client_id: clientId() });
    const next = { ...secret, Authorization: `Bearer ${tokens.access_token}`, expires_at: String(Date.now() + (tokens.expires_in ?? 1800) * 1000) };
    await db().update(schema.connectors).set({ secret: encryptSecret(JSON.stringify(next)), updatedAt: new Date(), status: 'ok', lastError: null }).where(eq(schema.connectors.id, row.id));
    await closeMcpClient(row.id);
    return (await getConnector(row.id))!;
  } catch (error) {
    await db().update(schema.connectors).set({ status: 'error', lastError: errorMessage(error) }).where(eq(schema.connectors.id, row.id));
    throw error;
  }
}

export async function setPolicy(id: string, policy: Partial<HaPolicy>): Promise<ConnectorRow> {
  const row = await getConnector(id);
  const cfg = row?.config as unknown as HaConfig | undefined;
  if (!row || cfg?.provider !== 'homeassistant') throw new HaError('Instance Home Assistant introuvable.');
  const next: HaPolicy = { ...defaultPolicy(), ...cfg.ha, ...policy };
  await db().update(schema.connectors).set({ config: { ...cfg, ha: next } as unknown as Record<string, any>, updatedAt: new Date() }).where(eq(schema.connectors.id, id));
  await closeMcpClient(id);
  return (await getConnector(id))!;
}

export const isHomeAssistant = (row: Pick<ConnectorRow, 'config'>) => (row.config as { provider?: string } | null)?.provider === 'homeassistant' && (row.config as { trusted?: string }).trusted === 'homeassistant';
