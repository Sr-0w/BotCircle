import { Hono } from 'hono';
import { z } from 'zod';
import { accountKey } from '../auth/context.ts';
import { closeMcpClient } from '../connectors/mcp.ts';
import { deleteConnector, listConnectors } from '../connectors/repo.ts';
import { connectWithToken, finishOAuth, HaError, isHomeAssistant, setPolicy, startOAuth, type HaConfig } from './service.ts';
import { defaultPolicy } from './policy.ts';
import type { ConnectorRow } from '../connectors/repo.ts';

const toDTO = (row: ConnectorRow) => {
  const cfg = row.config as unknown as HaConfig;
  return { id: row.id, name: row.name, base: cfg.base, mode: cfg.mode, auth: cfg.auth, status: row.status, lastError: row.lastError, tools: (row.tools ?? []).map((t) => t.name), policy: { ...defaultPolicy(), ...cfg.ha } };
};

/** #39: Settings → Connections → Home Assistant. Tokens go in, never come out. */
export function homeAssistantRoutes() {
  const app = new Hono();
  app.onError((error, c) => (error instanceof HaError || error instanceof z.ZodError ? c.json({ error: error instanceof z.ZodError ? 'Formulaire invalide.' : error.message }, 400) : Promise.reject(error)));
  const target = { id: z.string().optional(), name: z.string().max(80).optional(), url: z.string().min(1).max(500), mode: z.enum(['assist', 'full']).optional() };
  app.get('/instances', async (c) => c.json((await listConnectors('mcp')).filter(isHomeAssistant).map(toDTO)));
  app.post('/token', async (c) => c.json(toDTO(await connectWithToken(z.object({ ...target, token: z.string().min(1).max(4000) }).strict().parse(await c.req.json())))));
  app.post('/oauth/start', async (c) => c.json(startOAuth(accountKey(), z.object(target).strict().parse(await c.req.json()))));
  // Home Assistant sends the browser back here; the code is exchanged on the server.
  app.get('/callback', async (c) => {
    const code = c.req.query('code'), state = c.req.query('state');
    try {
      if (!code || !state) throw new HaError('Autorisation annulée.');
      await finishOAuth(accountKey(), state, code);
      return c.redirect('/#/settings/homeassistant?connected=1');
    } catch (error) {
      return c.redirect(`/#/settings/homeassistant?error=${encodeURIComponent(error instanceof Error ? error.message : 'Échec')}`);
    }
  });
  app.put('/instances/:id/policy', async (c) => {
    const access = z.enum(['none', 'read', 'control']);
    const body = z.object({ agents: z.record(z.string(), access).optional(), chats: access.optional(), sensitive: z.array(z.string().max(60)).max(40).optional(), areas: z.array(z.string().max(80)).max(100).optional(), domains: z.array(z.string().max(60)).max(60).optional() }).strict().parse(await c.req.json());
    return c.json(toDTO(await setPolicy(c.req.param('id'), body)));
  });
  app.delete('/instances/:id', async (c) => {
    const row = (await listConnectors('mcp')).find((r) => r.id === c.req.param('id') && isHomeAssistant(r));
    if (!row) return c.json({ error: 'Introuvable' }, 404);
    await closeMcpClient(row.id); await deleteConnector(row.id);
    return c.json({ ok: true });
  });
  return app;
}
