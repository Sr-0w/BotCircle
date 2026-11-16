/** #64: Settings → Notifications and the service worker's real push handling (Chromium, CDP push delivery). */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
const directory = await mkdtemp(join(tmpdir(), 'opendots-image-ui-'));
process.env.OPENDOTS_DATA_DIR = directory;
const nativeFetch = globalThis.fetch, payloads: any[] = [];
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.includes('openrouter.ai/api/v1/chat/completions')) {
    const payload = JSON.parse(String(init?.body)); payloads.push(payload);
    const chunk = (delta: unknown, finish_reason: string | null) => JSON.stringify({ id: 'fixture', created: 1, model: payload.model, choices: [{ index: 0, delta, finish_reason }] });
    return new Response(`data: ${chunk({ role: 'assistant', content: `Images reçues ${payloads.length}.` }, null)}\n\ndata: ${chunk({}, 'stop')}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  }
  if (url.startsWith('https://openrouter.ai/')) throw new Error(`Appel externe inattendu : ${url}`);
  return nativeFetch(input, init);
};
const { createApplication } = await import('../src/app.ts');
const { authStore, registerUser, createSession, closeAuthStore } = await import('../src/auth/store.ts');
const { withAccount } = await import('../src/auth/context.ts');
const { openDatabase, closeAllDatabases } = await import('../src/db/client.ts');
const { createAgent } = await import('../src/agents/repo.ts');
const { setSetting, setOpenRouterKey } = await import('../src/settings.ts');
await authStore(true);
const account = await registerUser('photos@example.com', 'photos browser test password'), other = await registerUser('other@example.com', 'photos browser test password');
const token = await createSession(account.id), otherToken = await createSession(other.id);
const agent = await withAccount(account, async () => {
  await openDatabase({ memory: true }); await setSetting('onboarding.done', true); await setSetting('models.default', { provider: 'openrouter', model: 'qwen/qwen3.8-27b' }); await setOpenRouterKey('fixture-not-a-real-key');
  return createAgent({ name: 'Photos' });
});
const app = createApplication(async () => { await openDatabase({ memory: true }); });
const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
await new Promise<void>((resolve) => server.listening ? resolve() : server.once('listening', resolve));
const origin = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
const browser = await chromium.launch({ executablePath: process.env.OPENDOTS_CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox'] });
const image = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#2380df' } }).png().toBuffer();
try {
  const context = await browser.newContext({ locale: 'fr-BE', viewport: { width: 1280, height: 900 } });
  await context.addCookies([{ name: 'opendots_session', value: token, url: origin }]);
  await context.grantPermissions(['notifications'], { origin });
  const page = await context.newPage(), errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/#/settings/notifications`);
  const settings = page.locator('[data-notifications-page]'); await settings.waitFor();
  // Preferences are saved on the server.
  await settings.getByRole('switch', { name: 'Aperçu sur l’écran verrouillé' }).click();
  const prefs = async () => (await context.request.get(`${origin}/api/notifications/prefs`)).json();
  const until = async (check: (p: any) => boolean) => { for (let i = 0; i < 50; i++) { if (check(await prefs())) return; await page.waitForTimeout(100); } assert.fail('préférence non enregistrée'); };
  await until((p) => p.preview === true);
  await settings.getByRole('switch', { name: 'Code' }).click();
  await until((p) => p.categories.code === false);
  // The service worker shows a pushed notification, and a "close" push removes it (approval decided elsewhere).
  const swId = await page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js', { scope: '/' }); const reg = await navigator.serviceWorker.ready; return reg.active?.scriptURL; });
  assert.match(String(swId), /\/sw\.js$/);
  context.on('serviceworker', (w) => w.on('console', (m) => console.log('SW', m.text())));
  const cdp = await context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  const registrationId = await new Promise<string>((resolve) => { cdp.on('ServiceWorker.workerRegistrationUpdated', (e: any) => { const r = e.registrations.find((x: any) => x.scopeURL === `${origin}/`); if (r) resolve(r.registrationId); }); });
  const push = (data: unknown) => cdp.send('ServiceWorker.deliverPushMessage', { origin, registrationId, data: JSON.stringify(data) });
  await push({ id: 'n1', tag: 'approval:ap1', category: 'approvals', title: 'Ari attend ta validation', body: 'Validation demandée', url: '/#/settings/approvals', close: false });
  let shown: unknown[] = [];
  for (let i = 0; i < 50 && !shown.length; i++) { await page.waitForTimeout(100); shown = await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({ title: n.title, tag: n.tag, url: n.data?.url }))); }
  assert.deepEqual(shown, [{ title: 'Ari attend ta validation', tag: 'approval:ap1', url: '/#/settings/approvals' }]);
  await push({ tag: 'approval:ap1', close: true });
  for (let i = 0; i < 50; i++) { await page.waitForTimeout(100); if (!(await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).length))) break; }
  assert.equal(await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).length), 0);
  // Turning push on for this browser: either it subscribes and the device is listed, or the browser says why (never a crash).
  await settings.getByRole('switch', { name: 'Notifications sur ce navigateur' }).click();
  await page.waitForFunction(() => document.querySelector('[data-push-device]') || document.querySelector('[data-sonner-toast]'), undefined, { timeout: 15_000 });
  await page.screenshot({ path: '/tmp/opendots-notifications.png' });
  assert.deepEqual(errors, []);
  console.log('PASS Chromium : réglages enregistrés, service worker : notification affichée puis retirée par un push de fermeture, activation du push gérée.');
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0]; if (page) { await page.screenshot({ path: '/tmp/opendots-notifications-failure.png', fullPage: true }); console.error((await page.locator('body').innerText()).slice(-1500)); }
  throw error;
} finally {
  await browser.close(); await new Promise<void>((resolve) => server.close(() => resolve())); await closeAllDatabases(); await closeAuthStore(); globalThis.fetch = nativeFetch; await rm(directory, { recursive: true, force: true });
}
