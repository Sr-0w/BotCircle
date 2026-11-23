import { assertTimelineScroll } from './assert-timeline-scroll.ts';
/** #58: search across conversations and inside a thread, in the real web app (real server, real browser). */
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
  const say = (cv: string, id: string, text: string, role: 'user' | 'assistant' = 'user') => saveMessage(cv, { id, role, parts: [{ type: 'text', text }], metadata: {} }, { author: role === 'user' ? 'user' : 'agent', agentId: role === 'user' ? null : agent.id });
  const voyage = await createChat({ title: 'Voyage à Rome' });
  await say(voyage.id, 'v0', 'Je veux voir le Colisée et manger une pizza à Évora');
  for (let i = 1; i < 140; i++) await say(voyage.id, `v${i}`, `Étape ordinaire ${i}`, i % 2 ? 'assistant' : 'user');
  const budget = await createChat({ title: 'Budget 2027' });
  const main = await mainConversationId(agent.id);
  await say(main, 'p1', 'Range les photos d’Évora dans un album', 'user');
  await say(main, 'p2', 'Album « Évora 2026 » créé avec 42 photos', 'assistant');
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
  await page.getByRole('log').getByText('Album « Évora 2026 » créé avec 42 photos').waitFor();
  await assertTimelineScroll(page.getByRole('log'));
  // Global search (button in the Chats header), accent-insensitive, both chats and Circles, snippet highlighted.
  await page.locator('[data-open-search]').click();
  const dialog = page.locator('[data-search-dialog]');
  await dialog.getByRole('textbox').fill('evora');
  await dialog.locator('[data-search-hit]').nth(2).waitFor();
  assert.equal(await dialog.locator('[data-search-hit]').count(), 3);
  assert.equal(await dialog.locator('[data-search-hit="v0"] mark').first().innerText(), 'Évora');
  await page.screenshot({ path: '/tmp/opendots-search.png' });
  // Chats only, then Circles only.
  await dialog.getByRole('button', { name: 'Chats', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-search-hit]').length === 1);
  await dialog.getByRole('button', { name: 'Circles', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-search-hit]').length === 2);
  // Open the chat result: the right chat, scrolled to the message (an old one, outside the first page).
  await dialog.getByRole('button', { name: 'Tout', exact: true }).click();
  await dialog.locator('[data-search-hit="v0"]').click();
  await page.waitForFunction(() => location.hash.includes('/chat/'));
  const target = page.locator('#message-v0');
  await target.waitFor();
  await page.waitForFunction(() => { const r = document.getElementById('message-v0')?.getBoundingClientRect(); return !!r && r.top >= 0 && r.bottom <= innerHeight; });
  assert.equal(await page.evaluate(() => (CSS as any).highlights.get('od-search')?.size ?? 0) > 0, true);
  // Find in this thread: Ctrl+F, previous / next with position.
  await page.keyboard.press('Control+f');
  const bar = page.locator('[data-thread-search]'); await bar.waitFor();
  await bar.getByRole('textbox').fill('ordinaire 1');
  await page.waitForFunction(() => /\/ \d+/.test(document.querySelector('[data-thread-search-position]')?.textContent ?? ''));
  const total = (await bar.locator('[data-thread-search-position]').innerText()).split('/ ')[1];
  assert(Number(total) >= 10, total);
  await bar.getByRole('button', { name: 'Résultat précédent' }).click();
  assert.equal(await bar.locator('[data-thread-search-position]').innerText(), `${Number(total) - 1} / ${total}`);
  // The previous match ("ordinaire 138") is brought into view.
  await page.waitForFunction(() => { const r = document.getElementById('message-v138')?.getBoundingClientRect(); return !!r && r.top >= 0 && r.bottom <= innerHeight; }, undefined, { timeout: 8000 });
  await page.screenshot({ path: '/tmp/opendots-thread-search.png' });
  await page.keyboard.press('Escape');
  await bar.waitFor({ state: 'detached' });
  await page.setViewportSize({ width: 390, height: 720 });
  await assertTimelineScroll(page.getByRole('log'));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route("**/api/team/threads", route => route.fulfill({ json: [{ conversationId: "test-team", agentIds: [agent.id, agent.id], lastMessageAt: Date.now(), lastMessagePreview: "Team scroll test" }] }));
  const teamRow = (id: string) => ({ id, role: 'assistant', parts: [{ type: 'text', text: id }] });
  const teamMessages = Array.from({ length: 50 }, (_, i) => teamRow('Team message ' + i));
  await page.route('**/api/conversations/test-team/messages', route => route.fulfill({ json: { messages: teamMessages } }));
  await page.goto(origin + '/#/settings/team');
  const log = page.getByRole('log');
  await log.getByText('Team message 49', { exact: true }).waitFor();
  await assertTimelineScroll(log);
  await log.evaluate(el => { el.style.zoom = '1.1'; });
  await log.focus();
  await page.keyboard.press('PageUp');
  await page.waitForFunction(() => {
    const el = document.querySelector('[role="log"]')!;
    return el.scrollHeight - el.scrollTop - el.clientHeight > 120;
  });
  await page.keyboard.press('End');
  await page.getByRole('button', { name: 'Aller au dernier message' }).waitFor({ state: 'hidden' });
  await log.evaluate(el => { el.style.zoom = ''; });
  await log.hover();
  await page.mouse.wheel(0, -900);
  await page.getByRole('button', { name: 'Aller au dernier message' }).waitFor();
  const anchor = await log.evaluate(el => {
    const top = el.getBoundingClientRect().top;
    const row = Array.from(el.querySelectorAll<HTMLElement>('[data-scroll-key]')).find(r => r.getBoundingClientRect().bottom > top)!;
    return { key: row.dataset.scrollKey!, offset: row.getBoundingClientRect().top - top };
  });
  await page.goto(origin + '/#/settings/opencode');
  await log.waitFor({ state: 'detached' });
  teamMessages.unshift(teamRow('Older history'));
  await page.goBack();
  const restored = log.getByText(anchor.key, { exact: true });
  await restored.waitFor();
  const offset = await restored.locator('xpath=ancestor::*[@data-scroll-key][1]').evaluate(el => el.getBoundingClientRect().top - el.closest('[role="log"]')!.getBoundingClientRect().top);
  assert.ok(Math.abs(offset - anchor.offset) <= 2, 'Restored the same row and offset after history replay');
  assert.deepEqual(errors, []);
  console.log('PASS Chromium : recherche globale (accents, chats/Circles, extrait surligné), ouverture au message exact dans un long fil, recherche dans le fil précédent/suivant.');
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0]; if (page) { await page.screenshot({ path: '/tmp/opendots-search-failure.png', fullPage: true }); console.error((await page.locator('body').innerText()).slice(-1500)); }
  throw error;
} finally {
  await browser.close(); await new Promise<void>((resolve) => server.close(() => resolve())); await closeAllDatabases(); await closeAuthStore(); globalThis.fetch = nativeFetch; await rm(directory, { recursive: true, force: true });
}
