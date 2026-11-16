/**
 * #27: accessibility audit of the web app with axe-core (WCAG 2 A/AA, contrast included), on the main screens, in the
 * three Quiet themes, desktop and mobile widths. Fails on any serious or critical violation.
 *
 *   OPENDOTS_CHROMIUM_PATH=/opt/pw-browsers/chromium pnpm --filter @opendots/server exec tsx scripts/a11y-audit.ts
 */
import { chromium, type Page } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { serve } from '@hono/node-server';

const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const dir = await mkdtemp(join(tmpdir(), 'opendots-a11y-'));
process.env.OPENDOTS_DATA_DIR = dir;
const { createApplication } = await import('../src/app.ts');
const { authStore, closeAuthStore, accountById } = await import('../src/auth/store.ts');
const { withAccount } = await import('../src/auth/context.ts');
const { openDatabase, closeAllDatabases } = await import('../src/db/client.ts');
const { createAgent, mainConversationId } = await import('../src/agents/repo.ts');
const { setSetting, setOpenRouterKey } = await import('../src/settings.ts');
const { saveMessage } = await import('../src/conversations/repo.ts');
const { createChat } = await import('../src/chats/repo.ts');
await authStore(true);
const app = createApplication(async () => { await openDatabase({ memory: true }); });
const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
await new Promise<void>((resolve) => server.listening ? resolve() : server.once('listening', resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.OPENDOTS_CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox'] });
type Finding = { screen: string; theme: string; width: number; id: string; impact: string; help: string; nodes: string[] };
const findings: Finding[] = [];
try {
  const context = await browser.newContext({ locale: 'fr-BE', viewport: { width: 1365, height: 900 } });
  const page = await context.newPage();
  await page.goto(origin);
  await page.getByRole('button', { name: 'Pas encore de compte ? S’inscrire' }).click();
  await page.getByLabel('Adresse e-mail', { exact: true }).fill('a11y@example.com');
  await page.getByLabel('Mot de passe', { exact: true }).fill('browser password for test');
  await page.getByLabel('Confirmer le mot de passe').fill('browser password for test');
  await page.getByRole('button', { name: 'Créer mon compte', exact: true }).click();
  await page.getByText('1. Connexion au fournisseur', { exact: true }).waitFor();
  const profile = await (await context.request.get(`${origin}/api/auth/me`)).json();
  const account = (await accountById(profile.account.id))!;
  let ariId = '', chatId = '';
  await withAccount(account, async () => {
    await setOpenRouterKey('a11y-fixture-key');
    await setSetting('onboarding.done', true);
    await setSetting('models.default', { provider: 'openrouter', model: 'fixture/model' });
    const ari = await createAgent({ name: 'Ari', description: 'Range tes fichiers et suit tes projets.' });
    ariId = ari.id;
    const conv = await mainConversationId(ari.id);
    await saveMessage(conv, { id: 'msg_a1', role: 'user', parts: [{ type: 'text', text: 'Bonjour Ari, où en est le rapport ?' }], metadata: { kind: 'chat', createdAt: new Date().toISOString() } }, { author: 'user' });
    await saveMessage(conv, { id: 'msg_a2', role: 'assistant', parts: [{ type: 'text', text: 'Le rapport est prêt : **3 sections**, tableau des chiffres et [lien vers la source](https://example.com).\n\n```ts\nconst total = 42;\n```' }], metadata: { kind: 'chat', agentId: ari.id, createdAt: new Date().toISOString() } }, { author: 'agent', agentId: ari.id });
    chatId = (await createChat({ title: 'Idées de voyage' })).id;
  });
  const screens: [string, string, (p: Page) => Promise<void>][] = [
    ['Conversation d’un Circle', `#/agent/${ariId}`, async (p) => { await p.locator('[id^="message-"]').getByText('Le rapport est prêt').first().waitFor(); }],
    ['Fiche du Circle', `#/agent/${ariId}`, async (p) => { await p.getByRole('tab', { name: 'Profil' }).click(); await p.locator('[data-circle-section="home"]').waitFor(); }],
    ['Chat général', `#/chat/${chatId}`, async (p) => { await p.locator('[data-general-chat]').waitFor(); }],
    ['Paramètres', '#/settings/general', async (p) => { await p.locator('[data-profile-card]').waitFor(); }],
    ['Fournisseurs', '#/settings/providers', async (p) => { await p.getByRole('heading', { name: 'Fournisseurs de modèles' }).first().waitFor(); }],
    ['OpenCode', '#/settings/opencode', async (p) => { await p.getByRole('heading', { name: 'OpenCode' }).first().waitFor(); }],
    ['Connecteurs', '#/settings/connectors', async (p) => { await p.locator('main h1, h1').first().waitFor(); }],
    ['Ordinateur', '#/settings/computer', async (p) => { await p.locator('main h1, h1').first().waitFor(); }],
    ['Tâches planifiées', '#/settings/tasks', async (p) => { await p.locator('main h1, h1').first().waitFor(); }],
    ['Skills', '#/settings/skills', async (p) => { await p.locator('main h1, h1').first().waitFor(); }],
    ['Validations', '#/settings/approvals', async (p) => { await p.locator('main h1, h1').first().waitFor(); }],
    ['Palette /', `#/chat/${chatId}`, async (p) => { await p.locator('[data-general-chat]').waitFor(); await p.getByRole('textbox', { name: /Écrire un message/ }).fill('/'); await p.locator('[data-slash-palette]').waitFor(); }],
  ];
  for (const width of [1365, 390]) {
    await page.setViewportSize({ width, height: width > 600 ? 900 : 844 });
    for (const theme of ['light', 'dark', 'oled']) {
      await page.evaluate((value) => localStorage.setItem('od-theme', value), theme);
      for (const [screen, hash, ready] of screens) {
        if (width < 600 && screen === 'Fiche du Circle') continue; // the side panel is a sheet on phones
        await page.goto(`${origin}/${hash}`); await page.reload();
        try { await ready(page); } catch (error) { findings.push({ screen, theme, width, id: 'not-reached', impact: 'critical', help: (error as Error).message.slice(0, 200), nodes: [] }); continue; }
        await page.waitForTimeout(300);
        await page.addScriptTag({ path: axePath });
        const result = await page.evaluate(async () => (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] }));
        for (const v of result.violations as any[]) findings.push({ screen, theme, width, id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 4).map((n: any) => `${n.target.join(' ')}${n.any?.[0]?.message ? ` — ${n.any[0].message.slice(0, 160)}` : ''}`) });
      }
    }
  }
} finally {
  await browser.close(); await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeAllDatabases(); await closeAuthStore(); await rm(dir, { recursive: true, force: true });
}
const serious = findings.filter((f) => f.impact === 'serious' || f.impact === 'critical');
const byRule = new Map<string, Finding[]>();
for (const f of findings) byRule.set(`${f.id} (${f.impact})`, [...(byRule.get(`${f.id} (${f.impact})`) ?? []), f]);
for (const [rule, list] of byRule) {
  console.log(`\n${rule}: ${list[0].help}`);
  for (const f of list.slice(0, 8)) console.log(`  · ${f.screen} · ${f.theme} · ${f.width}px\n      ${f.nodes.join('\n      ')}`);
}
console.log(`\n${findings.length} violation(s), ${serious.length} sérieuse(s) ou critique(s).`);
process.exit(serious.length ? 1 : 0);
