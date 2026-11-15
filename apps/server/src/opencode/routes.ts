import { Hono } from 'hono';
import { z } from 'zod';
import { getTask, TaskError } from '../tasks/service.ts';
import { OpencodeHttpError, OpencodeUnreachable } from './client.ts';
import {
  checkInstance, deleteInstance, getInstance, instanceProjects, instanceSessions, instructOpencode, listExchanges, listFiles, listInstances, OpencodeError, readFile,
  replyPermission, replyQuestion, saveInstance, syncTask, toInstanceDTO, workspace,
} from './service.ts';

const instanceSchema = z.object({
  name: z.string().min(1).max(60), baseUrl: z.string().min(1).max(500), username: z.string().max(100).optional(),
  // Absent : inchangé. null : retiré. Le mot de passe n'est jamais renvoyé par l'API.
  password: z.string().max(500).nullable().optional(), defaultDirectory: z.string().max(1000).nullable().optional(),
}).strict();

/** Instances OpenCode du compte et espace de code d'une tâche. Tout est vérifié côté serveur, pour la session du compte. */
export function opencodeRoutes() {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof OpencodeUnreachable) return c.json({ error: error.message, status: 'unreachable' }, 502);
    if (error instanceof OpencodeHttpError) return c.json({ error: error.message, status: 'rejected' }, error.status === 404 ? 404 : 400);
    if (error instanceof OpencodeError || error instanceof TaskError) return c.json({ error: error.message, status: 'rejected' }, 400);
    if (error instanceof z.ZodError) return c.json({ error: 'Requête invalide' }, 400);
    throw error;
  });
  const instance = async (id: string) => { const row = await getInstance(id); if (!row) throw new OpencodeError('Instance introuvable.'); return row; };
  const task = async (id: string) => { const row = await getTask(id); if (!row || row.provider !== 'opencode') throw new OpencodeError('Tâche OpenCode introuvable.'); return row; };

  app.get('/instances', async (c) => c.json(await Promise.all((await listInstances()).map(toInstanceDTO))));
  app.post('/instances', async (c) => c.json(await toInstanceDTO(await saveInstance(instanceSchema.parse(await c.req.json())))));
  app.put('/instances/:id', async (c) => c.json(await toInstanceDTO(await saveInstance({ id: c.req.param('id'), ...instanceSchema.parse(await c.req.json()) }))));
  app.post('/instances/:id/check', async (c) => c.json(await toInstanceDTO(await checkInstance(await instance(c.req.param('id'))))));
  app.delete('/instances/:id', async (c) => { await deleteInstance(c.req.param('id')); return c.json({ ok: true }); });
  app.get('/instances/:id/projects', async (c) => c.json(await instanceProjects(await instance(c.req.param('id')))));
  app.get('/instances/:id/sessions', async (c) => c.json(await instanceSessions(await instance(c.req.param('id')), c.req.query('directory') || null)));

  app.get('/exchanges', async (c) => c.json(await listExchanges({ limit: 300 })));
  app.get('/tasks/:id', async (c) => { const row = await task(c.req.param('id')); await syncTask(row).catch(() => {}); return c.json(await workspace((await getTask(row.id))!)); });
  // Consigne saisie par l'utilisateur dans l'espace de code : attribuée à l'utilisateur, pas à un compagnon.
  app.post('/tasks/:id/prompt', async (c) => {
    const { text } = z.object({ text: z.string().min(1).max(8000) }).strict().parse(await c.req.json());
    return c.json(await instructOpencode(await task(c.req.param('id')), text.trim(), 'user'));
  });
  app.post('/tasks/:id/permissions/:requestId', async (c) => {
    const { reply } = z.object({ reply: z.enum(['once', 'always', 'reject']) }).strict().parse(await c.req.json());
    await replyPermission(await task(c.req.param('id')), c.req.param('requestId'), reply); return c.json({ ok: true });
  });
  app.post('/tasks/:id/questions/:requestId', async (c) => {
    const { answers } = z.object({ answers: z.array(z.array(z.string().max(500)).max(20)).max(20) }).strict().parse(await c.req.json());
    await replyQuestion(await task(c.req.param('id')), c.req.param('requestId'), answers); return c.json({ ok: true });
  });
  app.get('/tasks/:id/files', async (c) => c.json(await listFiles(await task(c.req.param('id')), c.req.query('path') ?? '')));
  app.get('/tasks/:id/file', async (c) => c.json(await readFile(await task(c.req.param('id')), z.string().min(1).max(2000).parse(c.req.query('path')))));
  return app;
}
