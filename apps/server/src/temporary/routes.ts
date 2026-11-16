import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { streamText } from 'ai';
import { z } from 'zod';
import { currentAccount } from '../auth/context.ts';
import { onSessionRevoked } from '../auth/store.ts';
import { resolveModel } from '../models/gateway.ts';
import { TemporaryError, TemporaryStore, MAX_TEXT } from './store.ts';

const turnSchema = z.object({
  text: z.string().trim().min(1).max(16_000),
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
  app.use('*', bodyLimit({ maxSize: 70_000 }));
  app.use('*', async (c, next) => {
    const token = getCookie(c, 'opendots_session');
    if (!currentAccount() || !token) return c.json({ error: 'Connexion requise.' }, 401);
    await next();
    // Hono's SSE helper defaults to no-cache; overwrite it after the handler.
    c.header('Cache-Control', 'no-store');
    c.header('X-Accel-Buffering', 'no');
  });
  const owner = (token: string) => `${currentAccount()!.id}:${createHash('sha256').update(token).digest('hex')}`;
  const view = (s: ReturnType<TemporaryStore['create']>) => ({
    id: s.id, expiresAt: Math.min(s.expiresAt, s.idleUntil), messages: s.messages, busy: !!s.active,
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
    const controller = store.begin(session, body.text);
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
            messages: [...session.messages.map(({ role, content }) => ({ role, content })), { role: 'user', content: body.text }],
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
            session.messages.push({ role: 'user', content: body.text }, { role: 'assistant', content: text, model: body.model });
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
