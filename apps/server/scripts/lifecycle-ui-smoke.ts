/** #56: archive, restore and delete chats and Circle threads in the real web app (real server, real browser). */
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
const { createChat } = await import('../src/chats/repo.ts');
const { saveMessage } = await import('../src/conversations/repo.ts');
const { createTask } = await import('../src/tasks/service.ts');
const { mainConversationId } = await import('../src/agents/repo.ts');
await authStore(true);
const account = await registerUser('photos@example.com', 'photos browser test password'), other = await registerUser('other@example.com', 'photos browser test password');
const token = await createSession(account.id), otherToken = await createSession(other.id);
const agent = await withAccount(account, async () => {
  await openDatabase({ memory: true }); await setSetting('onboarding.done', true); await setSetting('models.default', { provider: 'openrouter', model: 'qwen/qwen3.8-27b' }); await setOpenRouterKey('fixture-not-a-real-key');
  const agent = await createAgent({ name: 'Photos' });
  const say = (cv: string, id: string, text: string) => saveMessage(cv, { id, role: 'user', parts: [{ type: 'text', text }], metadata: {} }, { author: 'user' });
  const voyage = await createChat({ title: 'Voyage à Rome' }); await say(voyage.id, 'm1', 'Prépare l’itinéraire');
  const budget = await createChat({ title: 'Budget 2027' }); await say(budget.id, 'm2', 'Fais le budget');
  await createTask({ agentId: agent.id, conversationId: budget.id, title: 'Tableur des dépenses', instruction: 'x', requestedBy: 'user' });
  await say(await mainConversationId(agent.id), 'm3', 'Ancien sujet du Circle');
  return Object.assign(agent, { voyage: voyage.id, budget: budget.id });
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
  const row = (id: string) => page.locator(`[data-chat-row="${id}"]`);
  await row(agent.voyage).waitFor();
  // Archive from the list's "…" menu: it leaves the list, appears under Archived, still opens, and is restored.
  await row(agent.voyage).hover();
  await page.locator(`[data-chat-row="${agent.voyage}"] ~ [data-conversation-menu]`).click();
  await page.getByRole('menuitem', { name: 'Archiver' }).click();
  await row(agent.voyage).waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Archivés (1)' }).click();
  await page.locator(`[data-archived-chat-row="${agent.voyage}"]`).click();
  await page.locator('[data-archived-banner]').waitFor();
  await page.getByText('Prépare l’itinéraire').waitFor();
  await page.locator('[data-archived-banner]').getByRole('button', { name: 'Restaurer' }).click();
  await row(agent.voyage).waitFor();
  await page.locator('[data-archived-banner]').waitFor({ state: 'detached' });
  // Delete from the open chat's header: explained confirmation, then the active-task confirmation, then gone.
  await row(agent.budget).click();
  await page.getByText('Fais le budget').waitFor();
  await page.getByRole('button', { name: 'Actions du chat' }).click();
  await page.getByRole('menuitem', { name: 'Supprimer…' }).click();
  const dialog = page.locator('[data-confirm-dialog]');
  await dialog.getByText('Ce n’est pas réversible').waitFor();
  await dialog.locator('[data-confirm-ok]').click();
  await dialog.getByText('Tableur des dépenses').waitFor();
  await dialog.getByText('Elles ne sont pas arrêtées').waitFor();
  await page.screenshot({ path: '/tmp/opendots-delete-confirm.png' });
  await dialog.locator('[data-confirm-ok]').click();
  await row(agent.budget).waitFor({ state: 'detached' });
  assert.equal((await context.request.get(`${origin}/api/chats/${agent.budget}`)).status(), 404);
  // A Circle's thread: archive the current one from the header, find it in Journal › Previous threads, restore it.
  await page.goto(`${origin}/#agent/${agent.id}`);
  await page.getByText('Ancien sujet du Circle').waitFor();
  await page.getByRole('button', { name: 'Actions du fil' }).click();
  await page.getByRole('menuitem', { name: 'Archiver ce fil' }).click();
  await page.getByText('Ancien sujet du Circle').waitFor({ state: 'detached' });
  const journal = page.getByRole('tab', { name: 'Journal' });
  for (let i = 0; i < 2 && !await journal.isVisible().catch(() => false); i++) { await page.getByRole('button', { name: 'Panneau du Circle' }).click(); await page.waitForTimeout(400); }
  await journal.click();
  const thread = page.locator('[data-archived-thread]').first(); await thread.waitFor();
  await thread.hover(); await thread.locator('[data-conversation-menu]').click();
  await page.getByRole('menuitem', { name: 'Restaurer comme fil courant' }).click();
  await page.getByText('Ancien sujet du Circle').first().waitFor();
  await page.screenshot({ path: '/tmp/opendots-lifecycle.png' });
  assert.deepEqual(errors, []);
  console.log('PASS Chromium : archiver/restaurer un chat (liste, « Archivés », bandeau), supprimer avec confirmation + tâches actives, archiver/restaurer le fil d’un Circle.');
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0]; if (page) { await page.screenshot({ path: '/tmp/opendots-lifecycle-failure.png', fullPage: true }); console.error((await page.locator('body').innerText()).slice(-1500)); }
  throw error;
} finally {
  await browser.close(); await new Promise<void>((resolve) => server.close(() => resolve())); await closeAllDatabases(); await closeAuthStore(); globalThis.fetch = nativeFetch; await rm(directory, { recursive: true, force: true });
}
