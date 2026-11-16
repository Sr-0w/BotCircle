/** #39 in a real browser against an official-shaped Home Assistant MCP server: connect with a token, set rights. */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { serve } from '@hono/node-server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const TOKEN = 'ha-long-lived-token-0123456789';
const ha = createServer(async (req, res) => {
  if (!req.url?.startsWith('/api/mcp/assist')) { res.writeHead(404); res.end(); return; }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401); res.end(); return; }
  let body = ''; for await (const chunk of req) body += chunk;
  const server = new McpServer({ name: 'home-assistant', version: '2026.11' });
  server.registerTool('GetLiveContext', { description: 'Live states' }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
  server.registerTool('HassTurnOn', { description: 'Turn on' }, async () => ({ content: [{ type: 'text', text: 'done' }] }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { void transport.close(); void server.close(); });
  await server.connect(transport); await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
});
await new Promise<void>((resolve) => ha.listen(0, '127.0.0.1', () => resolve()));
const haUrl = `http://127.0.0.1:${(ha.address() as any).port}`;
const dir = await mkdtemp(join(tmpdir(), 'opendots-ha-'));
process.env.OPENDOTS_DATA_DIR = dir;
const { createApplication } = await import('../src/app.ts');
const { authStore, closeAuthStore, accountById } = await import('../src/auth/store.ts');
const { withAccount } = await import('../src/auth/context.ts');
const { openDatabase, closeAllDatabases } = await import('../src/db/client.ts');
const { createAgent } = await import('../src/agents/repo.ts');
const { setSetting, setOpenRouterKey } = await import('../src/settings.ts');
await authStore(true);
const app = createApplication(async () => { await openDatabase({ memory: true }); });
const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
await new Promise<void>((resolve) => server.listening ? resolve() : server.once('listening', resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.OPENDOTS_CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ locale: 'fr-BE', viewport: { width: 1365, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(origin);
  await page.getByRole('button', { name: 'Pas encore de compte ? S’inscrire' }).click();
  await page.getByLabel('Adresse e-mail', { exact: true }).fill('ha@example.com');
  await page.getByLabel('Mot de passe', { exact: true }).fill('browser password for test');
  await page.getByLabel('Confirmer le mot de passe').fill('browser password for test');
  await page.getByRole('button', { name: 'Créer mon compte', exact: true }).click();
  await page.getByText('1. Connexion au fournisseur', { exact: true }).waitFor();
  const account = (await accountById((await (await context.request.get(`${origin}/api/auth/me`)).json()).account.id))!;
  await withAccount(account, async () => { await setOpenRouterKey('k'); await setSetting('onboarding.done', true); await createAgent({ name: 'Ari' }); });
  await page.goto(`${origin}/#/settings/homeassistant`); await page.reload();
  const connect = page.locator('[data-ha-connect]');
  await connect.getByLabel('Adresse de Home Assistant').fill(haUrl);
  await connect.getByRole('button', { name: 'Utiliser un jeton d’accès à la place' }).click();
  await connect.getByLabel('Jeton d’accès longue durée').fill(TOKEN);
  await connect.getByRole('button', { name: 'Connecter', exact: true }).click();
  const row = page.locator('[data-ha-row]').first();
  await row.getByText('GetLiveContext').waitFor();
  await row.getByRole('radiogroup', { name: 'Ari' }).getByRole('radio', { name: 'Pilotage' }).click();
  await row.getByRole('radiogroup', { name: 'Ari' }).getByRole('radio', { name: 'Pilotage', checked: true }).waitFor();
  const listed = await (await context.request.get(`${origin}/api/homeassistant/instances`)).text();
  assert.ok(!listed.includes(TOKEN), 'le jeton ne doit jamais être renvoyé');
  assert.match(listed, /"control"/);
  assert.deepEqual(errors, []);
  console.log('Chromium : Home Assistant connecté par jeton (MCP officiel), outils découverts, droits de Ari réglés, jeton jamais renvoyé.');
} finally {
  await browser.close(); await new Promise<void>((resolve) => server.close(() => resolve())); ha.close();
  await closeAllDatabases(); await closeAuthStore(); await rm(dir, { recursive: true, force: true });
}
process.exit(0);
