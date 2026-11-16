import { Hono } from 'hono';
import { z } from 'zod';
import { deleteSsh, getSsh, listSsh, saveSsh, SshError, testSsh, toSshDTO } from './service.ts';

/** #52: Settings → Connections → SSH. Secrets go in, never come out. */
export function sshRoutes() {
  const app = new Hono();
  app.onError((error, c) => (error instanceof SshError || error instanceof z.ZodError ? c.json({ error: error instanceof z.ZodError ? 'Formulaire invalide.' : error.message }, 400) : Promise.reject(error)));
  const body = z.object({
    name: z.string().max(80).optional(), description: z.string().max(300).optional(),
    host: z.string().max(255).optional(), port: z.number().int().min(1).max(65535).optional(), username: z.string().max(64).optional(),
    auth: z.enum(['key', 'password']).optional(),
    privateKey: z.string().max(20_000).nullable().optional(), passphrase: z.string().max(500).nullable().optional(), password: z.string().max(500).nullable().optional(),
    agents: z.array(z.string()).max(50).optional(), approval: z.enum(['ask', 'auto']).optional(), enabled: z.boolean().optional(),
  }).strict();
  app.get('/connections', async (c) => c.json((await listSsh()).map(toSshDTO)));
  app.post('/connections', async (c) => c.json(toSshDTO(await saveSsh(body.parse(await c.req.json())))));
  app.put('/connections/:id', async (c) => c.json(toSshDTO(await saveSsh({ id: c.req.param('id'), ...body.parse(await c.req.json()) }))));
  app.delete('/connections/:id', async (c) => { await deleteSsh(c.req.param('id')); return c.json({ ok: true }); });
  app.post('/connections/:id/test', async (c) => {
    const { trust } = z.object({ trust: z.boolean().optional() }).strict().parse(await c.req.json().catch(() => ({})));
    if (!await getSsh(c.req.param('id'))) return c.json({ error: 'Introuvable' }, 404);
    return c.json(await testSsh(c.req.param('id'), trust ?? false));
  });
  return app;
}
