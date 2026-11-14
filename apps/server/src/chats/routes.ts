import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createUIMessageStreamResponse } from 'ai';
import { z } from 'zod';
import { getActiveStream } from '../agents/streams.ts';
import { AttachmentError, validateMessageParts } from '../attachments/service.ts';
import { checkModel } from '../models/gateway.ts';
import { loadMessages, type OpenDotsUIMessage } from '../conversations/repo.ts';
import { listTasks, toTaskDTO } from '../tasks/service.ts';
import type { ModelConfig } from '@opendots/shared';
import { ChatError, createChat, deleteChat, getChat, listChats, toChatDTO, updateChat } from './repo.ts';
import { runChatTurn, stopChat } from './turn.ts';

const modelSchema = z.object({
  provider: z.enum(['openrouter', 'ollama', 'codex']),
  model: z.string().min(1),
  reasoning: z.enum(['low', 'medium', 'high']).nullable().optional(),
  providerOrder: z.array(z.string()).nullable().optional(),
});

/** Chats généraux : création, historique, renommage, suppression, et le fil lui-même. */
export function chatRoutes() {
  const app = new Hono();
  app.onError((error, c) => c.json({ error: error instanceof ChatError || error instanceof AttachmentError ? error.message : error instanceof z.ZodError ? 'Requête invalide' : 'Action impossible sur ce chat.' }, 400));

  app.get('/', async (c) => c.json(await Promise.all((await listChats(c.req.query('q') || undefined)).map(toChatDTO))));
  app.post('/', async (c) => {
    const body = z.object({ title: z.string().max(200).optional(), model: modelSchema.nullable().optional() }).parse(await c.req.json().catch(() => ({})));
    return c.json(await toChatDTO(await createChat({ title: body.title, model: (body.model ?? null) as ModelConfig | null })));
  });
  app.get('/:id', async (c) => {
    const row = await getChat(c.req.param('id'));
    return row ? c.json(await toChatDTO(row)) : c.json({ error: 'Chat introuvable.' }, 404);
  });
  app.patch('/:id', async (c) => {
    const body = z.object({ title: z.string().max(200).optional(), model: modelSchema.nullable().optional() }).parse(await c.req.json());
    if (body.model) {
      const check = await checkModel(body.model as ModelConfig);
      if (!check.ok) return c.json({ error: check.error }, 400);
    }
    return c.json(await toChatDTO(await updateChat(c.req.param('id'), { title: body.title, ...(body.model !== undefined ? { model: body.model as ModelConfig | null } : {}) })));
  });
  app.delete('/:id', async (c) => c.json({ ok: await deleteChat(c.req.param('id')) }));

  app.get('/:id/messages', async (c) => {
    const row = await getChat(c.req.param('id'));
    if (!row) return c.json({ error: 'Chat introuvable.' }, 404);
    const before = c.req.query('before');
    const { messages, rows } = await loadMessages(row.id, { limit: 80, beforeSeq: before ? Number(before) : undefined });
    return c.json({
      conversationId: row.id, messages, cursor: rows.length === 80 ? rows[0].seq : null, active: Boolean(getActiveStream(row.id)),
      tasks: await Promise.all((await listTasks({ conversationId: row.id })).map(toTaskDTO)),
    });
  });

  app.post('/:id/chat', bodyLimit({ maxSize: 1_000_000, onError: (c) => c.json({ error: 'Message trop volumineux.' }, 413) }), async (c) => {
    const row = await getChat(c.req.param('id'));
    if (!row) return c.json({ error: 'Chat introuvable.' }, 404);
    const message = ((await c.req.json()) as { message?: OpenDotsUIMessage }).message;
    if (!message || message.role !== 'user' || !Array.isArray(message.parts) || !message.id) return c.json({ error: 'Message invalide' }, 400);
    const parts = await validateMessageParts(message.parts);
    const { stream } = runChatTurn(row.id, { id: String(message.id).slice(0, 64), role: 'user', parts, metadata: {} });
    return createUIMessageStreamResponse({ stream: stream.readable() });
  });

  app.get('/:id/stream', async (c) => {
    if (!await getChat(c.req.param('id'))) return c.json({ error: 'Chat introuvable.' }, 404);
    const active = getActiveStream(c.req.param('id'));
    return active ? createUIMessageStreamResponse({ stream: active.readable() }) : c.body(null, 204);
  });

  app.post('/:id/stop', async (c) => c.json({ ok: true, stopped: stopChat(c.req.param('id')) }));
  return app;
}
