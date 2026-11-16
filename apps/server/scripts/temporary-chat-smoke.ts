/** Real HTTP + desktop/mobile Chromium; local mocked Ollama, no paid inference. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { serve } from '@hono/node-server';

const dir = await mkdtemp('/tmp/opencode/temporary-chat-smoke-');
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
    const answer = userMessages.length === 1 ? 'Réponse temporaire de test' : 'Contexte temporaire retrouvé';
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
try {
  for (const viewport of [{ width: 1365, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, locale: 'fr-FR' });
    await context.addCookies([{ name: 'opendots_session', value: token, url: origin }]);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/#/chats/temporary`);
    const section = page.getByRole('region', { name: 'Chat temporaire', exact: true });
    await section.getByRole('button', { name: 'Démarrer un chat temporaire', exact: true }).click();
    await section.getByRole('button', { name: 'Choisir un modèle', exact: true }).click();
    await section.getByLabel('Fournisseur').selectOption('ollama');
    await section.getByRole('button', { name: /temporary-fixture/ }).click();
    await section.getByLabel('Message temporaire', { exact: true }).fill('Prompt sensible de test');
    await section.getByRole('button', { name: 'Envoyer', exact: true }).click();
    await section.getByText('Réponse temporaire de test', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }).includes('Prompt sensible')), false);
    // SPA navigation keeps the same temporary context, including on mobile Web.
    await page.evaluate(() => { location.hash = '/settings/general'; });
    await page.getByRole('heading', { name: 'Chat temporaire · sans historique' }).waitFor({ state: 'hidden' });
    await page.evaluate(() => { location.hash = '/chats/temporary'; });
    await section.getByText('Réponse temporaire de test', { exact: true }).waitFor();
    await section.getByLabel('Message temporaire', { exact: true }).fill('Et ensuite ?');
    await section.getByRole('button', { name: 'Envoyer', exact: true }).click();
    await section.getByText('Contexte temporaire retrouvé', { exact: true }).waitFor();
    // Real HTTP cancellation reaches the provider abort signal; no partial turn.
    await section.getByLabel('Message temporaire', { exact: true }).fill('slow fixture');
    await section.getByRole('button', { name: 'Envoyer', exact: true }).click();
    await section.getByText('Début interrompu', { exact: true }).waitFor();
    await section.getByRole('button', { name: 'Arrêter', exact: true }).click();
    await section.getByRole('button', { name: 'Arrêter', exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await section.locator('article').count(), 4);
    const snapshots = await withAccount(account, () => db().select().from(schema.messages));
    assert.equal(snapshots.length, 1);
    // Production now has real general chats. The explicit action creates a new,
    // empty durable chat, never a copy/conversion of this temporary transcript.
    assert.deepEqual(await (await context.request.get(`${origin}/api/chats?q=Prompt%20sensible`)).json(), []);
    const archives = await (await context.request.get(`${origin}/api/chats?archived=1`)).json();
    assert.deepEqual(archives, []);
    await section.getByRole('button', { name: 'Démarrer un chat normal', exact: true }).click();
    await page.waitForFunction(() => /^#\/chat\/[^/]+$/.test(location.hash));
    const normalId = new URL(page.url()).hash.split('/').at(-1)!;
    const normal = await (await context.request.get(`${origin}/api/chats/${normalId}/messages`)).json();
    assert.deepEqual(normal.messages, []);
    assert.deepEqual(normal.tasks, []);
    await page.evaluate(() => { location.hash = '/chats/temporary'; });
    await section.getByText('Contexte temporaire retrouvé', { exact: true }).waitFor();
    // Cancelling close must preserve the temporary chat.
    page.once('dialog', dialog => void dialog.dismiss());
    await section.getByRole('button', { name: 'Fermer et oublier' }).click();
    await section.getByText('Contexte temporaire retrouvé', { exact: true }).waitFor();
    page.once('dialog', dialog => void dialog.accept());
    await section.getByRole('button', { name: 'Fermer et oublier' }).click();
    await section.getByRole('button', { name: 'Démarrer un chat temporaire', exact: true }).waitFor();
    assert.equal(await section.getByText('Contexte temporaire retrouvé', { exact: true }).count(), 0);
    // A new temporary chat starts clean. Reload also cannot resurrect it.
    await section.getByRole('button', { name: 'Démarrer un chat temporaire', exact: true }).click();
    await section.getByLabel('Message temporaire', { exact: true }).waitFor();
    assert.equal(await section.locator('article').count(), 0);
    page.once('dialog', dialog => void dialog.accept());
    await page.reload();
    await section.getByRole('button', { name: 'Démarrer un chat temporaire', exact: true }).waitFor();
    await page.goto(`${origin}/#/agent/${agentId}`);
    await page.locator('#message-normal-smoke').getByText('Historique normal conservé', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS Chromium ${viewport.width}x${viewport.height}: start, model, streaming, context, SPA navigation, HTTP stop, search/archive exclusion, new normal chat isolation, close cancel/confirm, reload, clean restart`);
  }
  assert.equal(inferenceCalls, 6);
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
