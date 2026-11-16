import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { openDatabase, closeDatabase } from '../src/db/client.ts';
import { createAgent } from '../src/agents/repo.ts';
import { closeAllMcpClients, mcpToolsForTurn } from '../src/connectors/mcp.ts';
import { getConnector } from '../src/connectors/repo.ts';
import { connectWithToken, finishOAuth, freshHomeAssistant, setPolicy, startOAuth } from '../src/homeassistant/service.ts';

/** A Home Assistant stand-in: the official MCP server shape (Assist tools) behind a bearer token, plus /auth/token. */
const TOKEN = 'ha-long-lived-token-0123456789';
let validTokens = new Set([TOKEN]);
const calls: { tool: string; args: any }[] = [];
let http: HttpServer; let base = '';
function mcp() {
  const server = new McpServer({ name: 'home-assistant', version: '2026.11' });
  server.registerTool('GetLiveContext', { description: 'Live states of the exposed entities' }, async () => ({ content: [{ type: 'text', text: 'Salon: lumière on; Solaire: 3.2 kW' }] }));
  server.registerTool('HassTurnOn', { description: 'Turns on a device', inputSchema: { name: z.string().optional(), area: z.string().optional(), domain: z.array(z.string()).optional() } }, async (args) => { calls.push({ tool: 'HassTurnOn', args }); return { content: [{ type: 'text', text: 'done' }] }; });
  return server;
}
beforeAll(async () => {
  await openDatabase({ memory: true });
  http = createServer(async (req, res) => {
    if (req.url === '/auth/token') {
      let body = ''; for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      const ok = (form.get('grant_type') === 'authorization_code' && form.get('code') === 'good-code') || (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === 'refresh-1');
      if (!ok) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid_grant' })); return; }
      const access = `oauth-access-${Date.now()}-abcdefghij`; validTokens.add(access);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ access_token: access, refresh_token: 'refresh-1', expires_in: 1800, token_type: 'Bearer' })); return;
    }
    if (!req.url?.startsWith('/api/mcp/assist')) { res.writeHead(404); res.end('Not Found'); return; }
    if (!validTokens.has((req.headers.authorization ?? '').replace(/^Bearer /, ''))) { res.writeHead(401); res.end('401: Unauthorized'); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = mcp();
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(http.address() as any).port}`;
});
afterAll(async () => { await closeAllMcpClients(); http.close(); await closeDatabase(); });

const approval = async () => ({ ok: true, status: 'pending_approval' });

describe('#39 : Home Assistant (MCP officiel)', () => {
  it('connexion par jeton : vérifiée, erreurs claires, jeton jamais exposé', async () => {
    await expect(connectWithToken({ url: base, token: 'wrong-token-wrong-token' })).rejects.toThrow(/refuse ce jeton/);
    await expect(connectWithToken({ url: base, mode: 'full', token: TOKEN })).rejects.toThrow(/Pas de serveur MCP/);
    await expect(connectWithToken({ url: 'http://127.0.0.1:1', token: TOKEN })).rejects.toThrow(/injoignable/);
    const row = await connectWithToken({ name: 'Maison', url: `${base}/`, token: TOKEN });
    expect(row.tools?.map((t) => t.name).sort()).toEqual(['GetLiveContext', 'HassTurnOn']);
    expect(JSON.stringify(row.config)).not.toContain(TOKEN);
  });

  it('droits par Circle et pour les chats, appliqués à chaque appel ; appareils sensibles validés ; pièces limitées', async () => {
    const homey = await createAgent({ name: 'Homey' }), reader = await createAgent({ name: 'Lecteur' }), stranger = await createAgent({ name: 'Autre' });
    const row = (await connectWithToken({ name: 'Maison 2', url: base, token: TOKEN }));
    await setPolicy(row.id, { agents: { [homey.id]: 'control', [reader.id]: 'read' }, chats: 'read', areas: ['salon'] });
    const toolsOf = async (principal: { agentId?: string; chat?: boolean }) => (await mcpToolsForTurn(approval, principal)).tools as any;
    expect(Object.keys(await toolsOf({ agentId: stranger.id })).filter((n) => n.includes('Maison_2'))).toEqual([]);
    const readTools = await toolsOf({ agentId: reader.id });
    const live = Object.keys(readTools).find((n) => n.endsWith('GetLiveContext') && n.includes('2'))!;
    expect(Object.keys(readTools).some((n) => n.endsWith('HassTurnOn') && n.includes('2'))).toBe(false);
    expect(JSON.stringify(await readTools[live].execute({}, { toolCallId: 'x' }))).toContain('3.2 kW');
    expect(Object.keys(await toolsOf({ chat: true })).some((n) => n.endsWith('GetLiveContext'))).toBe(true);

    const control = await toolsOf({ agentId: homey.id });
    const turnOn = Object.keys(control).find((n) => n.endsWith('HassTurnOn') && n.includes('2'))!;
    calls.length = 0;
    expect(await control[turnOn].execute({ name: 'lampe', area: 'Salon' }, { toolCallId: 'a' })).toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
    expect(await control[turnOn].execute({ name: 'lampe', area: 'Garage' }, { toolCallId: 'b' })).toMatchObject({ ok: false, status: 'denied' });
    expect(await control[turnOn].execute({ name: 'porte', area: 'salon', domain: ['lock'] }, { toolCallId: 'c' })).toMatchObject({ status: 'pending_approval' });
    expect(calls).toHaveLength(1);
    // Rights removed while the tools were already given: the next call is refused.
    await setPolicy(row.id, { agents: { [homey.id]: 'read' } });
    expect(await control[turnOn].execute({ name: 'lampe', area: 'salon' }, { toolCallId: 'd' })).toMatchObject({ ok: false, status: 'denied' });
    expect(calls).toHaveLength(1);
  });

  it('OAuth de Home Assistant : code échangé côté serveur, jeton rafraîchi avant expiration', async () => {
    const { authorizeUrl } = startOAuth('acc', { url: base, name: 'OAuth maison' });
    const url = new URL(authorizeUrl);
    expect(url.pathname).toBe('/auth/authorize');
    expect(url.searchParams.get('client_id')).toMatch(/\/$/);
    const state = url.searchParams.get('state')!;
    await expect(finishOAuth('other-account', state, 'good-code')).rejects.toThrow(/Autorisation expirée/);
    const again = new URL(startOAuth('acc', { url: base, name: 'OAuth maison' }).authorizeUrl).searchParams.get('state')!;
    const row = await finishOAuth('acc', again, 'good-code');
    expect((row.config as any).auth).toBe('oauth');
    // Force expiry: refreshed on next use.
    const { db, schema } = await import('../src/db/client.ts');
    const { encryptSecret } = await import('../src/secrets.ts');
    const { eq } = await import('drizzle-orm');
    await db().update(schema.connectors).set({ secret: encryptSecret(JSON.stringify({ Authorization: 'Bearer stale', refresh_token: 'refresh-1', expires_at: '1' })) }).where(eq(schema.connectors.id, row.id));
    const fresh = await freshHomeAssistant((await getConnector(row.id))!);
    expect(fresh.updatedAt.getTime()).toBeGreaterThan(row.updatedAt.getTime() - 1);
    expect(fresh.status).toBe('ok');
  });
});
