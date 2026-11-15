import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { OPENCODE_FILES_MAX_BYTES, OPENCODE_FILES_MAX_COUNT } from '@opendots/shared';
import { getTask, TaskError } from '../tasks/service.ts';
import { OpencodeHttpError, OpencodeUnreachable, type PromptFile } from './client.ts';
import {
  checkInstance, deleteInstance, getInstance, instanceProjects, instanceSessions, instructOpencode, listExchanges, listFiles, listInstances, OpencodeError, readFile,
  pairInstance, replyPermission, replyQuestion, saveInstance, setTaskModel, syncTask, taskModels, toInstanceDTO, workspace,
} from './service.ts';

const instanceSchema = z.object({
  name: z.string().min(1).max(60), baseUrl: z.string().min(1).max(500), username: z.string().max(100).optional(),
  // Absent : inchangé. null : retiré. Le mot de passe n'est jamais renvoyé par l'API.
  password: z.string().max(500).nullable().optional(), defaultDirectory: z.string().max(1000).nullable().optional(),
}).strict();

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', json: 'application/json', md: 'text/markdown', csv: 'text/csv', html: 'text/html', svg: 'image/svg+xml' };
/** Browsers leave the type empty for many source files: guess from the name, plain text otherwise (code, logs). */
const mimeOf = (name: string) => MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'text/plain';

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
  // Lien d'appairage de `opencode pair --remote` (ou son QR code) : le code est échangé ici, une seule fois.
  app.post('/instances/pair', async (c) => {
    const body = z.object({ link: z.string().min(10).max(2000), name: z.string().max(60).nullable().optional(), defaultDirectory: z.string().max(1000).nullable().optional() }).strict().parse(await c.req.json());
    return c.json(await toInstanceDTO(await pairInstance(body)));
  });
  app.put('/instances/:id', async (c) => c.json(await toInstanceDTO(await saveInstance({ id: c.req.param('id'), ...instanceSchema.parse(await c.req.json()) }))));
  app.post('/instances/:id/check', async (c) => c.json(await toInstanceDTO(await checkInstance(await instance(c.req.param('id'))))));
  app.delete('/instances/:id', async (c) => { await deleteInstance(c.req.param('id')); return c.json({ ok: true }); });
  app.get('/instances/:id/projects', async (c) => c.json(await instanceProjects(await instance(c.req.param('id')))));
  app.get('/instances/:id/sessions', async (c) => c.json(await instanceSessions(await instance(c.req.param('id')), c.req.query('directory') || null)));

  app.get('/exchanges', async (c) => c.json(await listExchanges({ limit: 300 })));
  app.get('/tasks/:id', async (c) => { const row = await task(c.req.param('id')); await syncTask(row).catch(() => {}); return c.json(await workspace((await getTask(row.id))!)); });
  // Consigne saisie par l'utilisateur dans l'espace de code : attribuée à l'utilisateur, pas à un compagnon.
  // JSON, or multipart when files are attached: they go straight to OpenCode and are not kept here.
  app.post('/tasks/:id/prompt', bodyLimit({ maxSize: OPENCODE_FILES_MAX_BYTES + 256 * 1024, onError: (c) => c.json({ error: 'Les fichiers joints ne peuvent pas dépasser 20 Mo au total.' }, 413) }), async (c) => {
    const schema = z.object({ text: z.string().max(8000), delivery: z.enum(['steer', 'queue']).optional() }).strict();
    let body: z.infer<typeof schema>, files: PromptFile[] = [];
    if ((c.req.header('content-type') ?? '').startsWith('multipart/form-data')) {
      const form = await c.req.parseBody({ all: true });
      const raw = ([] as unknown[]).concat(form.file ?? []).filter((f): f is File => f instanceof File);
      if (raw.length > OPENCODE_FILES_MAX_COUNT) throw new OpencodeError(`${OPENCODE_FILES_MAX_COUNT} fichiers au plus par message.`);
      files = await Promise.all(raw.map(async (f) => ({ name: (f.name || 'fichier').replace(/[\\/\r\n\u0000-\u001f]/g, '_').slice(0, 200), mime: f.type || mimeOf(f.name), data: Buffer.from(await f.arrayBuffer()) })));
      body = schema.parse({ text: typeof form.text === 'string' ? form.text : '', ...(typeof form.delivery === 'string' && form.delivery ? { delivery: form.delivery } : {}) });
    } else body = schema.parse(await c.req.json());
    const text = body.text.trim();
    if (!text && !files.length) throw new OpencodeError('Écris un message ou joins un fichier.');
    return c.json(await instructOpencode(await task(c.req.param('id')), text || 'Voici des fichiers joints.', 'user', null, body.delivery, files));
  });
  app.get('/tasks/:id/models', async (c) => c.json(await taskModels(await task(c.req.param('id')))));
  app.post('/tasks/:id/model', async (c) => {
    const ref = z.object({ providerID: z.string().min(1).max(200), id: z.string().min(1).max(300), variant: z.string().max(60).nullable().optional() }).strict().parse(await c.req.json());
    return c.json(await setTaskModel(await task(c.req.param('id')), ref));
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
