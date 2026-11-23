/** Real HTTP + desktop/mobile Chromium; local mocked Ollama, no paid inference. */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { serve } from '@hono/node-server';

const dir = await mkdtemp(join(tmpdir(), 'temporary-chat-smoke-'));
process.env.OPENDOTS_DATA_DIR = dir;
const nativeFetch = globalThis.fetch;
let inferenceCalls = 0;
let abortedCalls = 0;
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url === 'http://127.0.0.1:11434/api/tags') return Response.json({ models: [{ name: 'temporary-fixture' }] });
  if (url === 'https://openrouter.ai/api/v1/models') return Response.json({ data: [] });
  if (url === 'http://127.0.0.1:11434/v1/chat/completions') {
    inferenceCalls++;
    const body = JSON.parse(String(init?.body));
    assert(!body.tools?.length);
    const userMessages = body.messages.filter((m: any) => m.role === 'user');
    if (JSON.stringify(userMessages.at(-1)).includes('slow fixture')) {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: 'slow', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'Début interrompu' }, finish_reason: null }] })}\n\n`));
          init?.signal?.addEventListener('abort', () => { abortedCalls++; controller.error(new Error('fixture abort')); }, { once: true });
        },
      }), { headers: { 'content-type': 'text/event-stream' } });
    }
    const everything = JSON.stringify(userMessages);
    const hasImage = /image_url|data:image\/jpeg;base64/.test(everything), hasText = everything.includes('contenu-secret-du-fichier');
    let answer = userMessages.length === 1 ? 'Réponse temporaire de test' : 'Contexte temporaire retrouvé';
    if (JSON.stringify(userMessages.at(-1)).includes('rappel-fichier')) answer = hasImage && hasText ? 'Fichiers toujours présents' : 'Fichiers perdus';
    else if (JSON.stringify(userMessages.at(-1)).includes('contenu-secret-du-fichier')) answer = hasImage ? 'Fichiers bien reçus' : 'Image absente';
    return new Response([
      `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
      'data: [DONE]\n\n',
    ].join(''), { headers: { 'content-type': 'text/event-stream' } });
  }
  if (url.includes('gravatar.com')) return new Response('', { status: 404 });
  if (!url.startsWith('http://127.0.0.1:')) throw new Error('Unexpected external request in smoke fixture');
  return nativeFetch(input, init);
};
const { createApplication } = await import('../src/app.ts');
const { authStore, registerUser, createSession, closeAuthStore } = await import('../src/auth/store.ts');
const { withAccount } = await import('../src/auth/context.ts');
const { openDatabase, closeAllDatabases, db, schema } = await import('../src/db/client.ts');
const { createAgent, mainConversationId } = await import('../src/agents/repo.ts');
const { saveMessage, loadMessages } = await import('../src/conversations/repo.ts');
const { setSetting } = await import('../src/settings.ts');
const { closeTemporaryChats } = await import('../src/temporary/routes.ts');
await authStore(true);
const account = await registerUser('temporary-browser@example.com', 'temporary browser test password');
const token = await createSession(account.id);
let conversation = '';
let agentId = '';
await withAccount(account, async () => {
  await openDatabase({ memory: true });
  await setSetting('onboarding.done', true);
  await setSetting('models.default', { provider: 'ollama', model: 'temporary-fixture' });
  const agent = await createAgent({ name: 'Normal control' });
  agentId = agent.id; conversation = await mainConversationId(agent.id);
  await saveMessage(conversation, { id: 'normal-smoke', role: 'user', parts: [{ type: 'text', text: 'Historique normal conservé' }] }, { author: 'user' });
});
const app = createApplication(async () => {});
const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
await new Promise<void>(resolve => server.listening ? resolve() : server.once('listening', resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.OPENDOTS_CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const EPHEMERAL = 'Chat éphémère';
try {
  for (const viewport of [{ width: 1365, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, locale: 'fr-FR' });
    await context.addCookies([{ name: 'opendots_session', value: token, url: origin }]);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => void dialog.accept()); // beforeunload on reload
    const sessionIds: string[] = [];
    page.on('request', request => {
      const match = /\/api\/temporary-chats\/(tmp_[0-9a-f]+)\/turn$/.exec(request.url());
      if (match && !sessionIds.includes(match[1])) sessionIds.push(match[1]);
    });
    const api = async (path: string) => context.request.get(`${origin}/api${path}`, { headers: { 'x-opendots-client': '1' } });
    const chatsList = async () => (await (await api('/chats')).json()) as { id: string }[];
    const newChat = async () => {
      if (viewport.width < 768) await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await page.getByRole('button', { name: 'Nouveau chat', exact: true }).first().click();
    };
    const toggle = page.locator('[data-ephemeral-toggle]');
    const expectGone = async (id: string) => {
      for (let i = 0; i < 40; i++) { if ((await api(`/temporary-chats/${id}`)).status() === 404) return; await page.waitForTimeout(100); }
      assert.fail(`ephemeral session ${id} still alive`);
    };
    await page.goto(`${origin}/#/agent/${agentId}`);
    await page.locator('#message-normal-smoke').getByText('Historique normal conservé', { exact: true }).waitFor();
    assert.deepEqual(await chatsList(), []);

    // 1. New (empty) chat: the icon is there; it turns the chat ephemeral and the empty normal chat disappears.
    await newChat();
    await page.waitForFunction(() => /^#\/chat\/(?!ephemeral$)[^/]+$/.test(location.hash));
    await toggle.waitFor();
    assert.equal((await chatsList()).length, 1);
    await toggle.click();
    await page.waitForFunction(() => location.hash === '#/chat/ephemeral');
    await page.locator('[data-ephemeral-badge]').waitFor();
    assert.deepEqual(await chatsList(), []);
    assert.equal(await page.locator('[data-chat-row]').count(), 0);

    // 2. Toggle back before sending: a fresh normal chat is created; and again to ephemeral (the empty one is deleted).
    await toggle.click();
    await page.waitForFunction(() => /^#\/chat\/(?!ephemeral$)[^/]+$/.test(location.hash));
    await toggle.waitFor();
    assert.equal((await chatsList()).length, 1);
    await toggle.click();
    await page.waitForFunction(() => location.hash === '#/chat/ephemeral');
    assert.deepEqual(await chatsList(), []);
    assert.equal(sessionIds.length, 0, 'toggling must not create a server session');

    // 3. Chat like a normal chat: streaming, context, no toggle once a message is sent, nothing in browser storage.
    const input = page.getByLabel('Écrire un message éphémère…', { exact: true });
    await input.fill('Prompt sensible de test');
    await page.getByRole('button', { name: 'Envoyer', exact: true }).click();
    await page.getByText('Réponse temporaire de test', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Envoyer', exact: true }).waitFor();
    assert.equal(await toggle.count(), 0);
    assert.equal(sessionIds.length, 1);
    assert.equal(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }).includes('Prompt sensible')), false);
    await input.fill('Et ensuite ?');
    await page.getByRole('button', { name: 'Envoyer', exact: true }).click();
    await page.getByText('Contexte temporaire retrouvé', { exact: true }).waitFor();
    // Attachments: an image and a text file, via the "+" button; previews in the bubble, nothing stored anywhere.
    const storageFiles = async () => (await readdir(dir, { recursive: true })).filter(name => /attachments|artifacts|uploads/i.test(String(name)));
    const filesBefore = await storageFiles();
    await page.locator('input[type=file]').setInputFiles([
      { name: 'rouge.png', mimeType: 'image/png', buffer: await sharp({ create: { width: 32, height: 32, channels: 3, background: '#cc2200' } }).png().toBuffer() },
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('contenu-secret-du-fichier') },
    ]);
    await input.fill('Que contiennent ces fichiers ?');
    await page.getByRole('button', { name: 'Envoyer', exact: true }).click();
    await page.getByText('Fichiers bien reçus', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-chat-image^="blob:"]').count(), 1);
    await page.getByText('notes.txt').first().waitFor();
    await input.fill('rappel-fichier ?');
    await page.getByRole('button', { name: 'Envoyer', exact: true }).click();
    await page.getByText('Fichiers toujours présents', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }).includes('contenu-secret')), false);
    assert.deepEqual(await storageFiles(), filesBefore);
    assert.equal(await toggle.count(), 0);
    // Stop reaches the provider abort signal; the interrupted turn is dropped on both sides.
    await input.fill('slow fixture');
    await page.getByRole('button', { name: 'Envoyer', exact: true }).click();
    await page.getByText('Début interrompu', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Arrêter', exact: true }).click();
    await page.getByRole('button', { name: 'Arrêter', exact: true }).waitFor({ state: 'hidden' });
    await page.getByText('Début interrompu', { exact: true }).waitFor({ state: 'detached' });
    // Never saved, never listed.
    assert.equal((await withAccount(account, () => db().select().from(schema.messages))).length, 1);
    assert.deepEqual(await chatsList(), []);
    assert.deepEqual(await (await api('/chats?q=Prompt%20sensible')).json(), []);
    assert.deepEqual(await (await api('/chats?archived=1')).json(), []);
    assert.equal((await api(`/temporary-chats/${sessionIds[0]}`)).status(), 200);

    // 4. Leaving = gone: another new chat deletes the session; a toast says so; nothing comes back.
    await newChat();
    await page.waitForFunction(() => /^#\/chat\/(?!ephemeral$)[^/]+$/.test(location.hash));
    await page.getByText('Chat éphémère effacé', { exact: true }).waitFor();
    await expectGone(sessionIds[0]);
    assert.equal((await chatsList()).length, 1);
    assert.equal(await page.getByText('Prompt sensible de test').count(), 0);
    assert.equal(await page.getByText('Chat temporaire', { exact: true }).count(), 0); // the old sidebar entry is gone

    // 5. Navigating to a Circle also deletes the session; the second session lists nowhere.
    await toggle.click();
    await page.waitForFunction(() => location.hash === '#/chat/ephemeral');
    await page.getByLabel('Écrire un message éphémère…', { exact: true }).fill('Deuxième');
    await page.getByRole('button', { name: 'Envoyer', exact: true }).click();
    await page.getByText('Réponse temporaire de test', { exact: true }).waitFor();
    await page.evaluate((id) => { location.hash = `/agent/${id}`; }, agentId);
    await expectGone(sessionIds[1]);
    await page.locator('#message-normal-smoke').getByText('Historique normal conservé', { exact: true }).waitFor();

    // 6. Reload also deletes it and does not resurrect it.
    await page.goto(`${origin}/#/chat/ephemeral`);
    await page.getByLabel('Écrire un message éphémère…', { exact: true }).fill('Troisième');
    await page.getByRole('button', { name: 'Envoyer', exact: true }).click();
    await page.getByText('Réponse temporaire de test', { exact: true }).waitFor();
    await page.reload();
    await expectGone(sessionIds[2]);
    await page.getByText('Réponse temporaire de test', { exact: true }).waitFor({ state: 'detached' });
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS Chromium ${viewport.width}x${viewport.height}: icon on new chat, toggle on/off, empty normal chat removed/recreated, streaming, context, image + text file attachments, stop, never listed/saved, leave/reload deletes session`);
  }
  assert.equal(inferenceCalls, 14);
  assert.equal(abortedCalls, 2);
  await withAccount(account, async () => assert.equal((await loadMessages(conversation)).messages.length, 1));
} finally {
  await browser.close();
  closeTemporaryChats();
  (server as import('node:http').Server).closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await closeAllDatabases(); await closeAuthStore();
  globalThis.fetch = nativeFetch;
  await rm(dir, { recursive: true, force: true });
}
