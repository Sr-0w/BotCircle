import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { ARTIFACT_MAX_BYTES } from '@opendots/shared';
import { getAgent, mainConversationId } from '../agents/repo.ts';
import { ArtifactError, artifactHistory, createArtifact, deleteArtifact, getArtifact, grantArtifact, listArtifacts, readArtifact, revokeGrant, toArtifactDTO } from './service.ts';

/** Fichiers du compte : envoi, téléchargement, historique et autorisations. Toutes les routes exigent la session. */
export function artifactRoutes() {
  const app = new Hono();
  app.onError((error, c) => {
    if (!(error instanceof ArtifactError)) return c.json({ error: 'Le fichier n’a pas pu être traité.', status: 'failed' }, 400);
    return c.json({ error: error.message, status: error.status }, error.status === 'not_found' ? 404 : error.status === 'too_large' ? 413 : 400);
  });

  app.get('/', async (c) => c.json((await listArtifacts({ conversationId: c.req.query('conversationId') || undefined, agentId: c.req.query('agentId') || undefined, taskId: c.req.query('taskId') || undefined })).map(toArtifactDTO)));

  app.post('/', bodyLimit({ maxSize: ARTIFACT_MAX_BYTES + 64 * 1024, onError: (c) => c.json({ error: `Un fichier ne peut pas dépasser ${Math.round(ARTIFACT_MAX_BYTES / 1024 / 1024)} Mo.`, status: 'too_large' }, 413) }), async (c) => {
    const body = await c.req.parseBody();
    if (!(body.file instanceof File)) return c.json({ error: 'Choisis un fichier.', status: 'rejected' }, 400);
    // Joint à la conversation d'un compagnon : ce compagnon, et lui seul, reçoit le droit de le lire.
    const agentId = typeof body.agentId === 'string' && body.agentId ? body.agentId : null;
    const agent = agentId ? await getAgent(agentId) : null;
    if (agentId && (!agent || agent.archived)) return c.json({ error: 'Compagnon introuvable.', status: 'not_found' }, 404);
    const conversationId = typeof body.conversationId === 'string' && body.conversationId ? body.conversationId : agent ? await mainConversationId(agent.id) : null;
    const row = await createArtifact({ bytes: new Uint8Array(await body.file.arrayBuffer()), name: body.file.name, authorKind: 'user', source: 'upload', conversationId });
    if (agent) await grantArtifact(row.id, agent.id, 'user', 'upload', { conversationId });
    return c.json(toArtifactDTO(row));
  });

  app.get('/:id', async (c) => {
    const row = await getArtifact(c.req.param('id'));
    return row ? c.json({ ...toArtifactDTO(row), ...(await artifactHistory(row.id)) }) : c.json({ error: 'Fichier introuvable.', status: 'not_found' }, 404);
  });

  app.get('/:id/content', async (c) => {
    const { artifact, bytes } = await readArtifact('user', c.req.param('id'), 'download');
    // Jamais interprété par le navigateur comme une page : téléchargement, sauf image, PDF ou texte brut en aperçu.
    const inline = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain)$/.test(artifact.mediaType) && c.req.query('download') !== '1';
    c.header('Content-Type', inline ? artifact.mediaType : 'application/octet-stream');
    c.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(artifact.name)}`);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Security-Policy', "default-src 'none'; sandbox");
    c.header('Cache-Control', 'private, no-store');
    return c.body(new Uint8Array(bytes));
  });

  app.post('/:id/grants', async (c) => {
    const { agentId } = z.object({ agentId: z.string() }).parse(await c.req.json());
    const [row, agent] = [await getArtifact(c.req.param('id')), await getAgent(agentId)];
    if (!row || !agent || agent.archived) return c.json({ error: 'Fichier ou compagnon introuvable.', status: 'not_found' }, 404);
    await grantArtifact(row.id, agent.id, 'user', 'user');
    return c.json(await artifactHistory(row.id));
  });

  app.delete('/:id/grants/:agentId', async (c) => {
    if (!await getArtifact(c.req.param('id'))) return c.json({ error: 'Fichier introuvable.', status: 'not_found' }, 404);
    await revokeGrant(c.req.param('id'), c.req.param('agentId'));
    return c.json(await artifactHistory(c.req.param('id')));
  });

  app.delete('/:id', async (c) => c.json({ ok: await deleteArtifact(c.req.param('id')) }));
  return app;
}
