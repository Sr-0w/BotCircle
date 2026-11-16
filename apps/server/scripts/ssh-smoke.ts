/** #52 in a real browser against a real SSH server: add a machine with a key, verify the host, see it connected. */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import ssh2 from 'ssh2';
const { Server, utils } = ssh2;

const hostKey = utils.generateKeyPairSync('ed25519'), userKey = utils.generateKeyPairSync('ed25519');
const allowed = utils.parseKey(userKey.public) as any;
const ssh = new Server({ hostKeys: [hostKey.private] }, (client) => {
  client.on('error', () => {});
  client.on('authentication', (ctx) => (ctx.method === 'publickey' && ctx.key.algo === allowed.type && Buffer.compare(ctx.key.data, allowed.getPublicSSH()) === 0 ? ctx.accept() : ctx.reject(['publickey'])));
});
await new Promise<void>((resolve) => ssh.listen(0, '127.0.0.1', () => resolve()));
const sshPort = (ssh.address() as any).port;
const dir = await mkdtemp(join(tmpdir(), 'opendots-ssh-'));
process.env.OPENDOTS_DATA_DIR = dir;
const { createApplication } = await import('../src/app.ts');
const { authStore, closeAuthStore, accountById } = await import('../src/auth/store.ts');
const { withAccount } = await import('../src/auth/context.ts');
const { openDatabase, closeAllDatabases } = await import('../src/db/client.ts');
const { createAgent } = await import('../src/agents/repo.ts');
const { setSetting, setOpenRouterKey } = await import('../src/settings.ts');
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
  await page.getByLabel('Adresse e-mail', { exact: true }).fill('ssh@example.com');
  await page.getByLabel('Mot de passe', { exact: true }).fill('browser password for test');
  await page.getByLabel('Confirmer le mot de passe').fill('browser password for test');
  await page.getByRole('button', { name: 'Créer mon compte', exact: true }).click();
  await page.getByText('1. Connexion au fournisseur', { exact: true }).waitFor();
  const account = (await accountById((await (await context.request.get(`${origin}/api/auth/me`)).json()).account.id))!;
  await withAccount(account, async () => { await setOpenRouterKey('k'); await setSetting('onboarding.done', true); await createAgent({ name: 'Ari' }); });
  await page.goto(`${origin}/#/settings/ssh`); await page.reload();
  await page.getByRole('button', { name: 'Ajouter une machine' }).click();
  const form = page.locator('[data-ssh-form]');
  await form.getByLabel('Nom').fill('Serveur maison');
  await form.getByLabel('Adresse').fill('127.0.0.1');
  await form.getByLabel('Utilisateur').fill('robin');
  await form.getByLabel('Port').fill(String(sshPort));
  await form.getByLabel('Clé privée').fill(userKey.private);
  await form.getByLabel('Ari').check();
  await form.getByRole('button', { name: 'Enregistrer' }).click();
  // First connection: the fingerprint must be confirmed before anything else.
  await page.getByRole('alert').getByText(/SHA256:/).waitFor();
  await page.getByRole('button', { name: 'Faire confiance à cet hôte' }).click();
  await page.locator('[data-ssh-row] .bg-emerald-500').waitFor();
  await page.getByText('Circles autorisés : Ari').waitFor();
  const body = await page.content();
  assert.ok(!body.includes('PRIVATE KEY') || body.includes('BEGIN OPENSSH PRIVATE KEY-----</'), 'la clé ne doit jamais être réaffichée');
  assert.ok(!(await (await context.request.get(`${origin}/api/ssh/connections`)).text()).includes('PRIVATE KEY'));
  assert.deepEqual(errors, []);
  console.log('Chromium : machine SSH ajoutée par clé, empreinte confirmée, connexion vérifiée, secret jamais renvoyé.');
} finally {
  await browser.close(); await new Promise<void>((resolve) => server.close(() => resolve())); ssh.close();
  await closeAllDatabases(); await closeAuthStore(); await rm(dir, { recursive: true, force: true });
}
process.exit(0);
