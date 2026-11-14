import { Hono } from 'hono';
import { z } from 'zod';
import { cancelTask, getTask, listTasks, pauseTask, resumeTask, sendInstruction, taskEvents, TaskError, toTaskDTO } from './service.ts';

/** Tâches du compte : état persisté (relu après rechargement), journal « Détails » et actions de l'utilisateur. */
export function taskRoutes() {
  const app = new Hono();
  app.onError((error, c) => c.json({ error: error instanceof TaskError || error instanceof z.ZodError ? error.message : 'Action impossible sur cette tâche.' }, 400));
  app.get('/', async (c) => c.json(await Promise.all((await listTasks({
    agentId: c.req.query('agentId') || undefined, conversationId: c.req.query('conversationId') || undefined, active: c.req.query('active') === '1',
  })).map(toTaskDTO))));
  app.get('/:id', async (c) => {
    const row = await getTask(c.req.param('id'));
    return row ? c.json({ ...(await toTaskDTO(row)), events: await taskEvents(row.id) }) : c.json({ error: 'Tâche introuvable.' }, 404);
  });
  app.post('/:id/cancel', async (c) => c.json(await toTaskDTO(await cancelTask(c.req.param('id')))));
  app.post('/:id/pause', async (c) => c.json(await toTaskDTO(await pauseTask(c.req.param('id')))));
  app.post('/:id/resume', async (c) => c.json(await toTaskDTO(await resumeTask(c.req.param('id')))));
  app.post('/:id/instruction', async (c) => {
    const { instruction } = z.object({ instruction: z.string().min(1).max(2000) }).parse(await c.req.json());
    return c.json(await toTaskDTO(await sendInstruction(c.req.param('id'), instruction)));
  });
  return app;
}
