import { Hono } from 'hono';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { newId } from '../util.ts';
import { CATEGORIES, getPrefs, payloadOf, sendPush, setPrefs, vapidKeys } from './service.ts';

/** #64: Settings → Notifications — preferences, this account's devices and browsers, a test. */
export function notificationRoutes() {
  const app = new Hono();
  app.onError((error, c) => c.json({ error: error instanceof z.ZodError ? 'Requête invalide.' : (error as Error).message }, error instanceof z.ZodError ? 400 : 502));
  app.get('/vapid', (c) => c.json({ publicKey: vapidKeys().publicKey }));
  app.get('/prefs', async (c) => c.json(await getPrefs()));
  const time = z.string().regex(/^\d{2}:\d{2}$/);
  app.put('/prefs', async (c) => {
    const body = z.object({
      enabled: z.boolean().optional(),
      categories: z.object(Object.fromEntries(CATEGORIES.map((k) => [k, z.boolean().optional()]))).partial().optional(),
      mutedAgents: z.array(z.string().max(80)).max(200).optional(), mutedChats: z.array(z.string().max(80)).max(500).optional(),
      quietHours: z.object({ start: time, end: time, timezone: z.string().max(64) }).nullable().optional(),
      preview: z.boolean().optional(),
    }).strict().parse(await c.req.json());
    const current = await getPrefs();
    return c.json(await setPrefs({ ...body, categories: { ...current.categories, ...(body.categories ?? {}) } as typeof current.categories }));
  });
  app.get('/subscriptions', async (c) => c.json((await db().select().from(schema.pushSubscriptions).orderBy(desc(schema.pushSubscriptions.createdAt)))
    .map((s) => ({ id: s.id, kind: s.kind, label: s.label, createdAt: s.createdAt.toISOString(), lastOkAt: s.lastOkAt?.toISOString() ?? null, failures: s.failures, endpointHost: safeHost(s.endpoint) }))));
  app.post('/subscriptions', async (c) => {
    const body = z.object({ kind: z.enum(['webpush', 'unifiedpush']), endpoint: z.string().url().max(2000).refine((u) => u.startsWith('https://'), 'HTTPS requis'), p256dh: z.string().max(200), auth: z.string().max(100), label: z.string().max(80).optional() }).strict().parse(await c.req.json());
    const [existing] = await db().select().from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.endpoint, body.endpoint));
    if (existing) { await db().update(schema.pushSubscriptions).set({ p256dh: body.p256dh, auth: body.auth, label: body.label ?? existing.label, failures: 0 }).where(eq(schema.pushSubscriptions.id, existing.id)); return c.json({ id: existing.id }); }
    const id = newId('push');
    await db().insert(schema.pushSubscriptions).values({ id, kind: body.kind, endpoint: body.endpoint, p256dh: body.p256dh, auth: body.auth, label: body.label ?? '' });
    return c.json({ id });
  });
  app.delete('/subscriptions/:id', async (c) => { await db().delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.id, c.req.param('id'))); return c.json({ ok: true }); });
  /** Sends a test to one device (or all), now: reports what really happened. */
  app.post('/test', async (c) => {
    const { subscriptionId } = z.object({ subscriptionId: z.string().optional() }).strict().parse(await c.req.json().catch(() => ({})));
    const subs = (await db().select().from(schema.pushSubscriptions)).filter((s) => !subscriptionId || s.id === subscriptionId);
    if (!subs.length) return c.json({ error: 'Aucun appareil abonné.' }, 400);
    const row = { id: newId('ntf'), dedupeKey: `test:${Date.now()}:x`, category: 'messages' as const, title: 'BotCircle', body: 'Notification de test : tout fonctionne.', target: { kind: 'activity' as const, id: 'test' }, sensitive: false, status: 'active' as const, createdAt: new Date() };
    const results = await Promise.all(subs.map(async (s) => { try { await sendPush(s, await payloadOf(row)); return { id: s.id, ok: true }; } catch (e) { return { id: s.id, ok: false, error: (e as Error).message }; } }));
    return c.json({ results });
  });
  app.get('/recent', async (c) => c.json((await db().select().from(schema.notifications).orderBy(desc(schema.notifications.createdAt)).limit(50)).map((n) => ({ ...n, createdAt: n.createdAt.toISOString() }))));
  return app;
}
function safeHost(url: string) { try { return new URL(url).host; } catch { return ''; } }
