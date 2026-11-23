/**
 * New chat created on first message. Real HTTP + desktop/mobile Chromium; local mocked Ollama, no paid inference.
 * "New chat" opens a local draft: no POST /api/chats, nothing listed, nothing left behind when it is left. The first
 * message creates exactly one chat (with the model chosen in the draft), its answer streams on, the URL follows.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { serve } from '@hono/node-server';

const dir = await mkdtemp(join(tmpdir(), 'new-chat-draft-smoke-'));
process.env.OPENDOTS_DATA_DIR = dir;
const nativeFetch = globalThis.fetch;
let inferenceCalls = 0;
const models: string[] = [];
// The first answer pauses after its first words until the test has checked the page mid-stream.
let release: () => void = () => {};
let gate = Promise.resolve();
const chunk = (content: string) => `data: ${JSON.stringify({ id: 'draft', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`;
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url === 'http://127.0.0.1:11434/api/tags') return Response.json({ models: [{ name: 'draft-fixture' }, { name: 'draft-other' }] });
  if (url === 'https://openrouter.ai/api/v1/models') return Response.json({ data: [] });
  if (url === 'http://127.0.0.1:11434/v1/chat/completions') {
    inferenceCalls++;
    const body = JSON.parse(String(init?.body));
    models.push(body.model);
    const wait = gate;
    return new Response(new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(chunk('Première partie')));
        await wait;
        controller.enqueue(enc.encode(chunk(' de la réponse')));
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'draft', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`));
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  }
  if (url.includes('gravatar.com')) return new Response('', { status: 404 });
  if (!url.startsWith('http://127.0.0.1:')) throw new Error(`Unexpected external request in smoke fixture: ${url}`);
  return nativeFetch(input, init);
};
const { createApplication } = await import('../src/app.ts');
const { authStore, registerUser, createSession, closeAuthStore } = await import('../src/auth/store.ts');
const { withAccount } = await import('../src/auth/context.ts');
const { openDatabase, closeAllDatabases } = await import('../src/db/client.ts');
const { createAgent } = await import('../src/agents/repo.ts');
const { setSetting } = await import('../src/settings.ts');
await authStore(true);

const app = createApplication(async () => {});
const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
await new Promise<void>(resolve => server.listening ? resolve() : server.once('listening', resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const watchdog = setTimeout(() => { console.error('FAIL: smoke timed out'); process.exit(1); }, 300_000);
watchdog.unref();
const step = (label: string) => console.log(`  · ${label}`);
const browser = await chromium.launch({ executablePath: process.env.OPENDOTS_CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
try {
  for (const viewport of [{ width: 1365, height: 1000 }, { width: 390, height: 844 }]) {
    // One account per viewport: each run starts with no chat at all.
    const account = await registerUser(`draft-${viewport.width}@example.com`, 'new chat draft test password');
    const token = await createSession(account.id);
    let agentId = '';
    await withAccount(account, async () => {
      await openDatabase({ memory: true });
      await setSetting('onboarding.done', true);
      await setSetting('models.default', { provider: 'ollama', model: 'draft-fixture' });
      await setSetting('ollama.url', 'http://127.0.0.1:11434');
      agentId = (await createAgent({ name: 'Circle témoin' })).id;
    });
    const context = await browser.newContext({ viewport, locale: 'fr-FR' });
    await context.addCookies([{ name: 'opendots_session', value: token, url: origin }]);
    context.setDefaultTimeout(20_000);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => void dialog.accept());
    let creations = 0;
    page.on('request', request => { if (request.method() === 'POST' && /\/api\/chats\/?$/.test(new URL(request.url()).pathname)) creations++; });
    const api = async (path: string) => context.request.get(`${origin}/api${path}`, { headers: { 'x-opendots-client': '1' } });
    const chatsList = async () => (await (await api('/chats')).json()) as { id: string; title: string; model: { model: string } | null }[];
    const nothingSaved = async (why: string) => {
      assert.equal(creations, 0, `${why}: no POST /api/chats`);
      assert.deepEqual(await chatsList(), [], `${why}: no chat on the server`);
      assert.deepEqual(await (await api('/chats?archived=1')).json(), [], `${why}: nothing archived`);
      assert.equal(await page.locator('[data-chat-row]').count(), 0, `${why}: nothing in the list`);
    };
    const openMenu = async () => { if (viewport.width < 768) await page.getByRole('button', { name: 'Menu', exact: true }).click(); };
    const newChat = async () => {
      await openMenu();
      await page.getByRole('button', { name: 'Nouveau chat', exact: true }).first().click();
      await page.waitForFunction(() => location.hash === '#/chat/new');
    };
    const input = page.getByRole('textbox', { name: 'Écrire un message, @ pour un Circle…' });
    const send = page.getByRole('button', { name: 'Envoyer', exact: true });

    await page.goto(`${origin}/#/agent/${agentId}`);
    await page.locator('header').getByText('Circle témoin').waitFor();
    assert.deepEqual(await chatsList(), []);

    step('1'); // 1. New chat = a draft: the same view (orb, composer, model, ghost toggle), nothing on the server or in the list.
    await newChat();
    await page.locator('[data-general-chat] canvas[data-orb="breathing"]').waitFor();
    await page.locator('[data-chat-model]').waitFor();
    await page.locator('[data-ephemeral-toggle]').waitFor();
    await input.waitFor();
    await nothingSaved('draft opened');

    step('2'); // 2. Leaving it (a Circle, settings, a reload on the draft with text typed) leaves nothing behind.
    await page.evaluate((id) => { location.hash = `/agent/${id}`; }, agentId);
    await page.locator('header').getByText('Circle témoin').waitFor();
    await nothingSaved('draft left for a Circle');
    await newChat();
    await input.fill('Un brouillon jamais envoyé');
    await page.evaluate(() => { location.hash = '/settings'; });
    await page.waitForFunction(() => location.hash === '#/settings');
    await nothingSaved('draft left for settings');
    await newChat();
    await input.fill('Un brouillon jamais envoyé');
    await page.reload();
    await input.waitFor();
    assert.equal(await input.inputValue(), '');
    await nothingSaved('draft reloaded');

    step('3'); // 3. Draft settings are local: the model chosen here is the one the chat is created with.
    await page.locator('[data-chat-model]').click();
    await page.locator('[data-model-option="ollama/draft-other"] button').first().click();
    await page.locator('[data-chat-model]').getByText('draft-other').waitFor();
    await nothingSaved('model picked in the draft');

    step('4'); // 4. First message (text + a file): exactly one chat is created, the URL follows, the answer streams on.
    gate = new Promise<void>((resolve) => { release = resolve; });
    const firstChunk = page.getByText('Première partie', { exact: false }).first().waitFor({ timeout: 30_000 });
    await page.locator('input[type=file]').setInputFiles([{ name: 'brouillon.txt', mimeType: 'text/plain', buffer: Buffer.from('contenu-du-brouillon') }]);
    await input.fill('Bonjour, premier message du brouillon');
    await send.click();
    await firstChunk;
    await page.waitForFunction(() => /^#\/chat\/(?!new$|ephemeral$)[^/?]+$/.test(location.hash));
    const chatId = (await page.evaluate(() => location.hash)).replace('#/chat/', '');
    // Mid-stream: the answer is still coming (Stop shown), the chat already exists and is listed.
    await page.getByRole('button', { name: 'Arrêter', exact: true }).waitFor();
    assert.equal(await page.getByText('de la réponse', { exact: false }).count(), 0);
    let list = await chatsList();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, chatId);
    assert.equal(list[0].model?.model, 'draft-other');
    await openMenu();
    await page.locator(`[data-chat-row="${chatId}"]:visible`).waitFor();
    if (viewport.width < 768) await page.keyboard.press('Escape');
    release();
    await page.getByText('Première partie de la réponse', { exact: false }).first().waitFor();
    // The file was uploaded to the chat once it existed: it belongs to its conversation.
    const files = (await (await api(`/artifacts?conversationId=${chatId}`)).json()) as { name: string }[];
    assert.deepEqual(files.map((f) => f.name), ['brouillon.txt']);
    await send.waitFor();
    assert.equal(await page.locator('[data-ephemeral-toggle]').count(), 0);
    await page.locator('[data-general-chat]').getByText('Bonjour, premier message du brouillon', { exact: true }).waitFor();
    await page.locator('[data-general-chat]').getByText('brouillon.txt').first().waitFor();
    assert.equal(creations, 1, 'exactly one POST /api/chats');
    list = await chatsList();
    assert.equal(list.length, 1);
    assert.equal(models.at(-1), 'draft-other');

    step('5'); // 5. A second message goes to the same chat; Back does not return to an empty draft; reload keeps the chat.
    await input.fill('Deuxième message');
    await send.click();
    await page.getByText('Première partie de la réponse', { exact: true }).nth(1).waitFor();
    assert.equal(creations, 1);
    assert.equal((await chatsList()).length, 1);
    // The draft's history entry became the chat's: Back leaves it for the page before, never an empty draft.
    await page.evaluate(() => history.back());
    await page.waitForFunction((id) => location.hash !== `#/chat/${id}`, chatId);
    assert.notEqual(await page.evaluate(() => location.hash), '#/chat/new');
    await page.evaluate(() => history.forward());
    await page.waitForFunction((id) => location.hash === `#/chat/${id}`, chatId);
    await page.locator('[data-general-chat]').getByText('Deuxième message', { exact: true }).waitFor();
    await page.reload();
    await page.waitForFunction((id) => location.hash === `#/chat/${id}`, chatId);
    await page.locator('[data-general-chat]').getByText('Bonjour, premier message du brouillon', { exact: true }).waitFor();
    await page.locator('[data-general-chat]').getByText('Deuxième message', { exact: true }).waitFor();
    await page.getByText('Première partie de la réponse', { exact: true }).nth(1).waitFor();
    await openMenu();
    await page.locator(`[data-chat-row="${chatId}"]:visible`).getByText('Bonjour, premier message du brouillon').waitFor();
    if (viewport.width < 768) await page.keyboard.press('Escape');

    step('6'); // 6. Another new chat from there is again only a draft; going back to the chat loads it like any chat.
    await newChat();
    assert.equal(await page.getByText('Deuxième message').count(), 0);
    assert.equal(creations, 1);
    assert.equal((await chatsList()).length, 1);
    await openMenu();
    await page.locator(`[data-chat-row="${chatId}"]:visible`).click();
    await page.locator('[data-general-chat]').getByText('Deuxième message', { exact: true }).waitFor();
    assert.equal(creations, 1);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS Chromium ${viewport.width}x${viewport.height}: draft new chat (no POST, not listed, nothing left after Circle/settings/reload), first message creates exactly one chat with the draft's model, URL #/chat/<id>, answer streamed, file kept, listed, reload keeps it`);
  }
  assert.equal(inferenceCalls, 4);
} catch (error) {
  console.error('FAIL', error);
  process.exitCode = 1;
} finally {
  // Cleanup must not hide the result: give it a bounded time.
  setTimeout(() => process.exit(process.exitCode ?? 0), 15_000).unref();
  release();
  await browser.close();
  (server as import('node:http').Server).closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await closeAllDatabases(); await closeAuthStore();
  globalThis.fetch = nativeFetch;
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch((e) => console.warn(`cleanup: ${(e as Error).message}`));
}
