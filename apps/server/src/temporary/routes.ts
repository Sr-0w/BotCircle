import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { streamText, type ModelMessage } from 'ai';
import { z } from 'zod';
import { currentAccount } from '../auth/context.ts';
import { onSessionRevoked } from '../auth/store.ts';
import { resolveModel } from '../models/gateway.ts';
import { TemporaryError, TemporaryStore, MAX_TEXT, type TemporarySession } from './store.ts';
import { attachmentSchema, prepareAttachments, userContent, TURN_BODY_LIMIT } from './attachments.ts';

const turnSchema = z.object({
  // May be empty when attachments are present (checked in the handler).
  text: z.string().trim().max(16_000),
  attachments: z.array(attachmentSchema).optional(),
  // Codex's local app-server diagnostics have not been audited for this mode.
  model: z.object({
    provider: z.enum(['openrouter', 'ollama']),
    model: z.string().min(1).max(200),
    reasoning: z.enum(['low', 'medium', 'high']).nullable().optional(),
  }).strict(),
}).strict();

const defaultStore = new TemporaryStore();
const sweepTimer = setInterval(() => defaultStore.sweep(), 15_000);
sweepTimer.unref();
export const closeTemporaryChats = () => defaultStore.close();

export function temporaryRoutes(store = defaultStore, resolve = resolveModel) {
  const app = new Hono();
  // Do not let validation, provider diagnostics or stream errors reach the
  // parent API logger: upstream errors can contain complete request bodies.
  app.onError((error, c) => c.json({
    error: error instanceof TemporaryError ? error.message : 'Requête temporaire impossible. Aucun diagnostic de contenu conservé.',
  }, error instanceof TemporaryError ? error.status : 400));
  // Only the turn route may carry attachments (base64); everything else stays tiny.
  const onError = (c: Context) => c.json({ error: 'Requête trop volumineuse : 5 pièces jointes, 10 Mo chacune, 20 Mo par message.' }, 413);
  const small = bodyLimit({ maxSize: 70_000, onError }), large = bodyLimit({ maxSize: TURN_BODY_LIMIT, onError });
  app.use('*', (c, next) => (c.req.method === 'POST' && c.req.path.endsWith('/turn') ? large(c, next) : small(c, next)));
  app.use('*', async (c, next) => {
    const token = getCookie(c, 'opendots_session');
    if (!currentAccount() || !token) return c.json({ error: 'Connexion requise.' }, 401);
    await next();
    // Hono's SSE helper defaults to no-cache; overwrite it after the handler.
    c.header('Cache-Control', 'no-store');
    c.header('X-Accel-Buffering', 'no');
  });
  const owner = (token: string) => `${currentAccount()!.id}:${createHash('sha256').update(token).digest('hex')}`;
  // Snapshots carry attachment metadata only, never bytes.
  const view = (s: TemporarySession) => ({
    id: s.id, expiresAt: Math.min(s.expiresAt, s.idleUntil), busy: !!s.active,
    messages: s.messages.map(({ files: _bytes, ...message }) => message),
  });
  app.post('/', c => {
    const token = getCookie(c, 'opendots_session')!;
    const session = store.create(owner(token));
    session.cleanup = onSessionRevoked(token, () => store.discard(session));
    return c.json(view(session), 201);
  });
  app.get('/:id', c => c.json(view(store.get(c.req.param('id'), owner(getCookie(c, 'opendots_session')!)))));
  app.delete('/:id', c => {
    store.discard(store.get(c.req.param('id'), owner(getCookie(c, 'opendots_session')!)));
    return c.json({ ok: true });
  });
  app.post('/:id/stop', c => {
    store.get(c.req.param('id'), owner(getCookie(c, 'opendots_session')!)).active?.abort();
    return c.json({ ok: true });
  });
  app.post('/:id/turn', async c => {
    const session = store.get(c.req.param('id'), owner(getCookie(c, 'opendots_session')!));
    const body = turnSchema.parse(await c.req.json());
    if (!body.text && !body.attachments?.length) throw new TemporaryError(400, 'Message vide.');
    const files = await prepareAttachments(body.attachments);
    const controller = store.begin(session, body.text, files.reduce((n, f) => n + f.size, 0));
    const disconnect = () => controller.abort();
    c.req.raw.signal.addEventListener('abort', disconnect, { once: true });
    const timeout = setTimeout(disconnect, 120_000);
    const cleanup = () => {
      clearTimeout(timeout);
      c.req.raw.signal.removeEventListener('abort', disconnect);
      if (session.active === controller) session.active = undefined;
    };
    try {
      const resolved = await resolve(body.model);
      if (c.req.raw.signal.aborted || controller.signal.aborted) { cleanup(); return c.json({ error: 'Réponse arrêtée.' }, 409); }
      return streamSSE(c, async stream => {
        stream.onAbort(disconnect);
        try {
          const result = streamText({
            model: resolved.model, providerOptions: resolved.providerOptions,
            system: 'You are a general-purpose assistant in a temporary chat. No persistent memory or tools are available. Do not claim to schedule tasks, use tools or remember information beyond this session.',
            messages: [...session.messages.map(({ role, content, files: kept }): ModelMessage => (role === 'user' ? { role, content: userContent(content, kept) } : { role, content })), { role: 'user', content: userContent(body.text, files) } satisfies ModelMessage],
            // No tools, delegation, uploads, telemetry, durable callbacks or retries.
            tools: {}, toolChoice: 'none', maxRetries: 0, maxOutputTokens: 8192,
            abortSignal: controller.signal, onError: () => {},
          });
          let text = '';
          for await (const part of result.fullStream) {
            if (controller.signal.aborted) break;
            if (part.type === 'error' || part.type === 'tool-call') throw new Error('provider');
            if (part.type === 'text-delta') {
              text += part.text;
              if (text.length + body.text.length + session.messages.reduce((n, m) => n + m.content.length, 0) > MAX_TEXT) {
                controller.abort(); break;
              }
              await stream.writeSSE({ event: 'delta', data: JSON.stringify(part.text) });
            }
          }
          if (controller.signal.aborted) {
            await stream.writeSSE({ event: 'stopped', data: '{}' });
          } else {
            // Commit complete turns only; interrupted turns can be safely retried.
            session.messages.push({ role: 'user', content: body.text, ...(files.length ? { attachments: files.map(({ name, mediaType, size }) => ({ name, mediaType, size })), files } : {}) },{ role: 'assistant', content: text, model: body.model });
            await stream.writeSSE({ event: 'done', data: '{}' });
          }
        } catch {
          controller.abort();
          await stream.writeSSE({ event: 'failure', data: '"Réponse interrompue. Réessaie ; ce tour n’a pas été conservé."' }).catch(() => {});
        } finally { cleanup(); }
      }, async () => { controller.abort(); cleanup(); });
    } catch {
      controller.abort(); cleanup();
      return c.json({ error: 'Modèle indisponible pour ce chat temporaire.' }, 400);
    }
  });
  return app;
}
