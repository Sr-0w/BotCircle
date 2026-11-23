import { checkDockedPanels } from './check-docked-panels.ts';
/**
 * #72: the Web Code destination, in the real app (real server, real browser, fake `opencode serve`). Code is fixed
 * above Settings even with a long chat list; one canonical list with All / Mine / Circles; OpenCode-only sessions;
 * a new session started from Code without a Circle; the exact session at a stable URL; the chat draft survives.
 */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';

const nativeFetch = globalThis.fetch;
const AUTH = `Basic ${Buffer.from('opencode:smoke-secret').toString('base64')}`;
const now = Date.now();
const sessions: Record<string, { id: string; title: string; directory: string; time: { created: number; updated: number } }> = {
  ses_ari: { id: 'ses_ari', title: 'Refactor par Ari', directory: '/home/dev/botcircle', time: { created: now, updated: now } },
  ses_outside: { id: 'ses_outside', title: 'Lancée dans OpenCode', directory: '/home/dev/botcircle', time: { created: now - 3_600_000, updated: now - 3_600_000 } },
};
let created = 0;
function fakeOpencode(url: URL, init?: RequestInit) {
  const json = (value: unknown) => Response.json(value);
  const path = url.pathname, method = init?.method ?? 'GET';
  if ((init?.headers as Record<string, string>)?.authorization !== AUTH) return Response.json({}, { status: 401 });
  if (path === '/global/health') return json({ healthy: true, version: '1.19.5' });
  if (path === '/project') return json([{ id: 'p1', worktree: '/home/dev/botcircle', time: { created: now } }]);
  if (path === '/session' && method === 'POST') { const id = `ses_new${++created}`; sessions[id] = { id, title: 'Nouvelle session', directory: '/home/dev/botcircle', time: { created: Date.now(), updated: Date.now() } }; return json(sessions[id]); }
  if (path === '/session' && method === 'GET') return json(Object.values(sessions));
  const one = /^\/session\/([^/]+)$/.exec(path);
  if (one && sessions[one[1]] && method === 'PATCH') { sessions[one[1]].title = JSON.parse(String(init?.body)).title; return json(sessions[one[1]]); }
  if (one && sessions[one[1]]) return json(sessions[one[1]]);
  if (path === '/session/status') return json({ ses_ari: { type: 'busy' } });
  if (/^\/session\/[^/]+\/message$/.test(path)) return json([]);
  if (/^\/session\/[^/]+\/(prompt_async|abort)$/.test(path)) return new Response(null, { status: 204 });
  if (path === '/file') return json([]);
  if (/^\/session\/[^/]+\/diff$/.test(path)) return json([]);
  if (path === '/config/providers') return json({ providers: [{ id: 'openai', name: 'OpenAI', models: { 'gpt-5': { id: 'gpt-5', name: 'GPT-5' } } }], default: { openai: 'gpt-5' } });
  if (path === '/permission' || path === '/question') return json([]);
  return Response.json({}, { status: 404 });
}
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith('https://code.example.test/')) return fakeOpencode(new URL(url), init);
  if (url.includes('gravatar.com/')) return new Response(null, { status: 404 });
  if (url === 'https://openrouter.ai/api/v1/models') return Response.json({ data: [] });
  if (url.includes('openrouter.ai/')) return Response.json({ error: { message: 'Fixture : aucun modèle.' } }, { status: 401 });
  return nativeFetch(input, init);
};

const dir = await mkdtemp(join(tmpdir(), 'opendots-code-ui-'));
process.env.OPENDOTS_DATA_DIR = dir;
const { createApplication } = await import('../src/app.ts');
const { authStore, registerUser, createSession, closeAuthStore } = await import('../src/auth/store.ts');
const { withAccount } = await import('../src/auth/context.ts');
const { openDatabase, closeAllDatabases } = await import('../src/db/client.ts');
const { createAgent, mainConversationId } = await import('../src/agents/repo.ts');
const { setSetting, setOpenRouterKey } = await import('../src/settings.ts');
const { createChat } = await import('../src/chats/repo.ts');
const { saveInstance, startOpencodeTask, getInstance } = await import('../src/opencode/service.ts');
await authStore(true);
const account = await registerUser('code@example.com', 'code browser test password'), other = await registerUser('other-code@example.com', 'code browser test password');
const token = await createSession(account.id), otherToken = await createSession(other.id);
const fixture = await withAccount(account, async () => {
  await openDatabase({ memory: true }); await setSetting('onboarding.done', true); await setSetting('models.default', { provider: 'openrouter', model: 'fixture/model' }); await setOpenRouterKey('fixture-not-a-real-key');
  const ari = await createAgent({ name: 'Ari' });
  // A long chat history: Code must stay reachable without scrolling the sidebar.
  let chat = '';
  for (let i = 0; i < 60; i++) chat = (await createChat({ title: `Chat ${String(i).padStart(2, '0')}` })).id;
  const instance = await saveInstance({ name: 'PC de dev', baseUrl: 'https://code.example.test', password: 'smoke-secret', defaultDirectory: '/home/dev/botcircle' });
  const task = await startOpencodeTask({ agentId: ari.id, conversationId: await mainConversationId(ari.id), instance: (await getInstance(instance.id))!, sessionId: 'ses_ari', title: 'Refactor par Ari', instruction: 'Regroupe les réglages.', requestedBy: 'agent' });
  return { ari: ari.id, chat, ariTask: task.id };
});
await withAccount(other, async () => { await openDatabase({ memory: true }); await setSetting('onboarding.done', true); });
const app = createApplication(async () => { await openDatabase({ memory: true }); });
const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
await new Promise<void>((resolve) => server.listening ? resolve() : server.once('listening', resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.OPENDOTS_CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox'] });
const errors: string[] = [];
try {
  // Mobile first: the desktop pass then attaches the OpenCode-only session, changing the list.
  for (const viewport of [{ width: 390, height: 844 }, { width: 1365, height: 820 }]) {
    const mobile = viewport.width < 768;
    const context = await browser.newContext({ locale: 'fr-BE', viewport });
    await context.addCookies([{ name: 'opendots_session', value: token, url: origin }]);
    const page = await context.newPage(); page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${origin}/#/chat/${fixture.chat}`);
    if (!mobile) await checkDockedPanels(page, fixture);
    // A draft in a general chat: it must survive a trip to Code and back.
    const composer = page.locator('[data-floating-composer] textarea');
    await composer.waitFor();
    await composer.fill('Brouillon à garder');

    if (mobile) {
      await page.getByRole('button', { name: 'Menu' }).click();
      assert.equal(await page.getByRole('separator', { name: /.+/ }).count(), 0);
    }
    const nav = page.locator('[data-nav-code]').last();
    await nav.waitFor();
    // Fixed above Settings, visible without scrolling the long chat list.
    const box = await nav.boundingBox(), settings = await page.getByRole('button', { name: 'Paramètres' }).last().boundingBox();
    assert(box && settings && box.y < settings.y && box.y + box.height <= viewport.height, 'Code above Settings, in view');
    assert.equal(await nav.locator('[data-nav-count]').innerText(), '1'); // Ari's session is really running
    await nav.click();
    await page.waitForFunction(() => location.hash === '#/code');
    const list = page.locator('[data-code-page]'); await list.waitFor();
    // One canonical list: Ari's session once (it is also an OpenCode session), the OpenCode-only one under "Depuis OpenCode".
    await list.locator(`[data-code-session="${fixture.ariTask}"]`).waitFor();
    await list.locator('[data-outside-session="ses_outside"]').waitFor();
    assert.equal(await list.locator('[data-outside-session="ses_ari"]').count(), 0);
    assert.match(await list.locator(`[data-code-session="${fixture.ariTask}"]`).innerText(), /Par Ari[\s\S]*En cours/);
    // Filters: Mine hides Ari's, Circles shows only Ari's.
    await list.locator('[data-code-filter="mine"]').click();
    await list.locator(`[data-code-session="${fixture.ariTask}"]`).waitFor({ state: 'detached' });
    assert.equal(await list.locator('[data-outside-session]').count(), 0);
    await list.locator('[data-code-filter="circles"]').click();
    await list.locator(`[data-code-session="${fixture.ariTask}"]`).waitFor();
    await list.locator('[data-code-filter="all"]').click();

    // Back to the chat: the conversation stayed mounted, the draft is still there.
    await page.goBack();
    await page.waitForFunction((id) => location.hash === `#/chat/${id}`, fixture.chat);
    assert.equal(await page.locator('[data-floating-composer] textarea').inputValue(), 'Brouillon à garder');

    if (!mobile) {
      await page.goForward(); await list.waitFor();
      // ＋ Nouvelle session: straight from Code, no Circle, no task screen; opens the exact session at its URL.
      await list.locator('[data-code-new]').click();
      await page.waitForFunction(() => /^#\/code\/.+/.test(location.hash));
      const newId = decodeURIComponent((await page.evaluate(() => location.hash)).replace('#/code/', ''));
      await page.locator(`[data-code-route-session="${newId}"]`).waitFor();
      // Reload keeps the exact session (stable, linkable URL).
      await page.reload();
      await page.locator(`[data-code-route-session="${newId}"]`).waitFor();
      await page.getByRole('button', { name: 'Fermer l’espace de code' }).click();
      await page.waitForFunction(() => location.hash === '#/code');
      await page.locator(`[data-code-session="${newId}"][data-code-origin="user"]`).waitFor();
      // #69: rename from the list row (menu), Escape cancels, an empty name is refused, Enter validates.
      const row = page.locator(`[data-code-row="${newId}"]`);
      await row.locator('[data-code-row-menu]').click();
      await page.getByRole('menuitem', { name: 'Renommer' }).click();
      const box = row.getByRole('textbox', { name: 'Nom de la session' });
      assert.equal(await box.inputValue(), 'Nouvelle session');
      await box.fill('Annulé'); await box.press('Escape');
      await row.locator(`[data-code-session="${newId}"]`).getByText('Nouvelle session', { exact: true }).waitFor();
      await row.locator('[data-code-row-menu]').click();
      await page.getByRole('menuitem', { name: 'Renommer' }).click();
      await box.fill('   '); await box.press('Enter');
      await row.getByRole('alert').waitFor({ state: 'attached' });
      await box.fill('Implémentation des chats éphémères'); await box.press('Enter');
      await row.locator(`[data-code-session="${newId}"]`).getByText('Implémentation des chats éphémères', { exact: true }).waitFor();
      // …and from the open session's header, without leaving it.
      await row.locator(`[data-code-session="${newId}"]`).click();
      await page.locator('[data-code-title]').getByText('Implémentation des chats éphémères').waitFor();
      await page.locator('[data-code-rename-open]').click();
      const headerBox = page.locator('[data-code-workspace] [data-code-rename] input');
      await headerBox.fill('Titre depuis l’en-tête'); await headerBox.press('Enter');
      await page.locator('[data-code-title]').getByText('Titre depuis l’en-tête').waitFor();
      assert(new RegExp(`#/code/${newId}$`).test(await page.evaluate(() => decodeURIComponent(location.hash))), 'rename keeps the same session URL');
      await page.getByRole('button', { name: 'Fermer l’espace de code' }).click();
      await page.waitForFunction(() => location.hash === '#/code');
      // Attaching the OpenCode-only session creates one canonical task, opened directly.
      await page.locator('[data-outside-session="ses_outside"]').click();
      await page.waitForFunction(() => /^#\/code\/.+/.test(location.hash));
      await page.getByRole('button', { name: 'Fermer l’espace de code' }).click();
      await page.locator('[data-code-session][data-code-origin="opencode"]').waitFor();
      assert.equal(await page.locator('[data-outside-session="ses_outside"]').count(), 0);
    }
    await context.close();
  }
  // Another account sees none of these sessions.
  const intruder = await (await nativeFetch(`${origin}/api/opencode/sessions`, { headers: { cookie: `opendots_session=${otherToken}` } })).json();
  assert.deepEqual(intruder, []);
  assert.deepEqual(errors, []);
  console.log('PASS Chromium 1365x820 + 390x844 : Code fixe au-dessus de Paramètres (longue liste), compteur réel, liste canonique Toutes/Les miennes/Circles, sessions OpenCode seules, nouvelle session sans Circle, URL stable + rechargement, rattachement sans doublon, brouillon conservé, isolation des comptes.');
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0]; if (page) { await page.screenshot({ path: join(tmpdir(), 'opendots-code-failure.png'), fullPage: true }); console.error((await page.locator('body').innerText()).slice(-1500)); }
  throw error;
} finally {
  await browser.close(); await new Promise<void>((resolve) => server.close(() => resolve())); await closeAllDatabases(); await closeAuthStore(); globalThis.fetch = nativeFetch; await rm(dir, { recursive: true, force: true });
}
