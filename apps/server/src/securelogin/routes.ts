import { Hono } from 'hono';
import { z } from 'zod';
import { getSecureLogin, listSecureLogins, resolveSecureLogin, SecureLoginError, toSecureLoginDTO } from './service.ts';

/** Demandes de connexion du compte. Aucune de ces routes ne reçoit ni ne renvoie d'identifiant. */
export function secureLoginRoutes() {
  const app = new Hono();
  app.onError((error, c) => c.json({ error: error instanceof SecureLoginError ? error.message : 'Requête invalide' }, 400));
  app.get('/', async (c) => c.json((await listSecureLogins({ pending: c.req.query('pending') === '1' })).map(toSecureLoginDTO)));
  app.get('/:id', async (c) => {
    const row = await getSecureLogin(c.req.param('id'));
    return row ? c.json(toSecureLoginDTO(row)) : c.json({ error: 'Demande de connexion introuvable.' }, 404);
  });
  app.post('/:id/resolve', async (c) => {
    const { outcome } = z.object({ outcome: z.enum(['authenticated', 'cancelled', 'failed']) }).strict().parse(await c.req.json());
    return c.json(toSecureLoginDTO(await resolveSecureLogin(c.req.param('id'), outcome)));
  });
  return app;
}
