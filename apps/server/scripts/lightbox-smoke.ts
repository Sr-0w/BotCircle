/** #60: chat photos open in the in-app lightbox (real upload API, real browser; model stream is a local fixture). */
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
  const page = await context.newPage(), errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/#agent/${agent.id}`);
  const prompt = page.locator('textarea').first(); await prompt.waitFor();
  const send = async (names: string[], n: number) => {
    await page.locator('input[type=file]').setInputFiles(names.map((name) => ({ name, mimeType: 'image/png', buffer: image })));
    await page.locator('[aria-label="Fichiers joints"] img').nth(names.length - 1).waitFor();
    await prompt.fill(`Photos ${n}`); await page.getByRole('button', { name: 'Envoyer', exact: true }).click();
    await page.getByRole('log').getByText(`Images reçues ${n}.`, { exact: true }).waitFor({ timeout: 30_000 });
  };
  await send(['a.png', 'b.png'], 1); await send(['c.png'], 2);
  await page.locator('img[data-chat-image]').nth(2).waitFor();
  // #60: a chat photo opens in the in-app lightbox (no navigation, no new tab), with the thread's other photos.
  const pagesBefore = context.pages().length, urlBefore = page.url();
  await page.locator('img[data-chat-image]').first().click();
  const lightbox = page.locator('[data-image-lightbox]'); await lightbox.waitFor();
  assert.equal(page.url(), urlBefore); assert.equal(context.pages().length, pagesBefore);
  await lightbox.locator('[data-lightbox-image]').waitFor();
  assert.equal(await lightbox.locator('[data-lightbox-position]').innerText(), '1 / 3');
  await page.keyboard.press('ArrowRight');
  assert.equal(await lightbox.locator('[data-lightbox-position]').innerText(), '2 / 3');
  assert.equal(await lightbox.locator('[data-lightbox-image]').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth), 320);
  await lightbox.locator('[data-lightbox-image]').dblclick();
  assert.match(await lightbox.locator('[data-lightbox-image]').getAttribute('style') ?? '', /scale\(2\.5\)/);
  await page.screenshot({ path: '/tmp/opendots-image-lightbox.png' });
  await page.keyboard.press('Escape'); await lightbox.waitFor({ state: 'detached' });
  // Ctrl/⌘-click still opens a new tab on purpose; a broken image shows an in-app error, not the browser.
  await page.route('**/api/attachments/**', (route) => route.fulfill({ status: 410, body: '' }));
  await page.reload(); await page.locator('img[data-chat-image]').first().waitFor({ state: 'attached' });
  await page.locator('img[data-chat-image]').first().click({ force: true });
  await lightbox.locator('[data-lightbox-error]').waitFor();
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  console.log('PASS Chromium : photos du chat dans la visionneuse intégrée — sans navigation, galerie 1/3 → 2/3, image réelle, zoom, Échap, erreur affichée dans l’app.');
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0]; if (page) { await page.screenshot({ path: '/tmp/opendots-lightbox-failure.png', fullPage: true }); console.error((await page.locator('body').innerText()).slice(-1500)); }
  throw error;
} finally {
  await browser.close(); await new Promise<void>((resolve) => server.close(() => resolve())); await closeAllDatabases(); await closeAuthStore(); globalThis.fetch = nativeFetch; await rm(directory, { recursive: true, force: true });
}
