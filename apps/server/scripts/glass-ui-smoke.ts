/** #68 : le matériau « frosted glass » du Web — flou réel derrière les boutons du header et le composeur, Light / Dark / OLED. */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.includes('gravatar.com/')) return new Response(null, { status: 404 });
  if (url === 'https://openrouter.ai/api/v1/models') return Response.json({ data: [] });
  if (url.includes('openrouter.ai/')) return Response.json({ error: { message: 'Fixture : aucun modèle.' } }, { status: 401 });
  return nativeFetch(input, init);
};

const shots = process.env.OPENDOTS_SHOTS_DIR;
const dir = await mkdtemp(join(tmpdir(), 'opendots-glass-'));
process.env.OPENDOTS_DATA_DIR = dir;
const { createApplication } = await import('../src/app.ts');
const { authStore, closeAuthStore, accountById } = await import('../src/auth/store.ts');
const { withAccount } = await import('../src/auth/context.ts');
const { openDatabase, closeAllDatabases } = await import('../src/db/client.ts');
const { createAgent, mainConversationId } = await import('../src/agents/repo.ts');
const { setSetting, setOpenRouterKey } = await import('../src/settings.ts');
const { saveMessage } = await import('../src/conversations/repo.ts');
await authStore(true);
const app = createApplication(async () => { await openDatabase({ memory: true }); });
const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
await new Promise<void>((resolve) => server.listening ? resolve() : server.once('listening', resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.OPENDOTS_CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ locale: 'fr-BE', viewport: { width: 1365, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(origin);
  await page.getByRole('button', { name: 'Pas encore de compte ? S’inscrire' }).click();
  await page.getByLabel('Adresse e-mail', { exact: true }).fill('glass@example.com');
  await page.getByLabel('Mot de passe', { exact: true }).fill('browser password for test');
  await page.getByLabel('Confirmer le mot de passe').fill('browser password for test');
  await page.getByRole('button', { name: 'Créer mon compte', exact: true }).click();
  await page.getByText('1. Connexion au fournisseur', { exact: true }).waitFor();
  const profile = await (await context.request.get(`${origin}/api/auth/me`)).json();
  const account = (await accountById(profile.account.id))!;
  let ariId = '';
  await withAccount(account, async () => {
    await setOpenRouterKey('ui-fixture-personal-key');
    await setSetting('onboarding.done', true);
    await setSetting('models.default', { provider: 'openrouter', model: 'fixture/model' });
    ariId = (await createAgent({ name: 'Ari' })).id;
    const conv = await mainConversationId(ariId);
    for (let i = 0; i < 24; i++) {
      await saveMessage(conv, { id: `glass-u${i}`, role: 'user', parts: [{ type: 'text', text: `Question ${i} : un texte bien contrasté qui doit passer sous le header et sous le composeur.` }] } as any, { author: 'user' });
      await saveMessage(conv, { id: `glass-a${i}`, role: 'assistant', parts: [{ type: 'text', text: `Réponse ${i} : ${'des mots nets et lisibles, '.repeat(8)}` }] } as any, { author: 'agent', agentId: ariId });
    }
  });
  await page.goto(`${origin}/#/agent/${ariId}`); await page.reload();
  const composer = page.getByRole('textbox', { name: 'Écrire à Ari…' });
  await composer.waitFor();
  await page.locator('[role="log"]').first().evaluate((el) => { el.scrollTop = el.scrollHeight / 2; });

  const filterOf = (selector: string) => page.locator(selector).first().evaluate((el) => {
    const s = getComputedStyle(el); return { filter: s.backdropFilter || (s as any).webkitBackdropFilter, bg: s.backgroundColor, border: s.borderTopWidth };
  });
  for (const theme of ['light', 'dark', 'oled'] as const) {
    await page.evaluate((mode) => { const c = document.documentElement.classList; c.toggle('dark', mode !== 'light'); c.toggle('oled', mode === 'oled'); }, theme);
    await page.waitForTimeout(150);
    // Header: floating over the thread, controls frosted, no opaque bar.
    const header = await page.locator('header').first().evaluate((el) => { const s = getComputedStyle(el); return { position: s.position, bg: s.backgroundColor, borderBottom: s.borderBottomWidth }; });
    assert.equal(header.position, 'absolute', `${theme}: the header floats over the thread`);
    assert.equal(header.borderBottom, '0px', `${theme}: no opaque header bar border`);
    assert.match(header.bg, /rgba\(0, 0, 0, 0\)|transparent/, `${theme}: the header itself has no fill`);
    const button = await filterOf('header button[aria-label="Rechercher dans ce fil"]');
    assert.match(button.filter, /blur\(1[0-9]px\)/, `${theme}: header buttons really blur what is behind them`);
    assert.doesNotMatch(button.bg, /rgb\(\d+, \d+, \d+\)$/, `${theme}: header buttons are translucent, not opaque`);
    // Composer: same material, messages visible below it (the thread scrolls under, no opaque band).
    const box = await filterOf('form.quiet-glass, .quiet-glass');
    assert.match(box.filter, /blur\(2[0-9]px\)/, `${theme}: the composer blurs what scrolls under it`);
    const scroller = page.locator('[role="log"]').first();
    const [logBox, composerBox, headerBox] = await Promise.all([scroller.boundingBox(), page.locator('.quiet-glass').first().boundingBox(), page.locator('header').first().boundingBox()]);
    assert(logBox!.y <= headerBox!.y + 1 && logBox!.y + logBox!.height >= composerBox!.y + composerBox!.height - 1, `${theme}: the thread extends under the header and the composer`);
    // The text stays crisp: the blur is on the surface, never on its children.
    assert.equal(await composer.evaluate((el) => getComputedStyle(el).backdropFilter + getComputedStyle(el).filter), 'nonenone', `${theme}: the composer text is not blurred`);
    if (shots) await page.screenshot({ path: join(shots, `glass-${theme}.png`) });
  }
  // The header buttons stay clickable (search opens) and the first message is not hidden under the header at the top.
  await page.locator('[role="log"]').first().evaluate((el) => { el.scrollTop = 0; });
  const first = await page.locator('[id^="message-"]').first().boundingBox(); const hb = await page.locator('header').first().boundingBox();
  assert(first!.y >= hb!.y + hb!.height - 1, 'the first message starts below the header when scrolled to the top');
  await page.getByRole('button', { name: 'Rechercher dans ce fil' }).click();
  await page.getByRole('textbox', { name: 'Rechercher dans ce fil…' }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS Chromium : header flottant (boutons verre dépoli, flou réel), composeur même matériau, fil sous les deux, Light/Dark/OLED, premier message sous le header, recherche cliquable.');
} finally {
  await browser.close(); server.close(); await closeAllDatabases(); await closeAuthStore(); await rm(dir, { recursive: true, force: true }).catch(() => {});
}
process.exit(0);
