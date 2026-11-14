import { closeCodexClients } from '../src/models/codex.ts';
/** Navigateur + HTTP réel : fichiers, cartes de tâche et chats généraux. Aucun appel de modèle payant. */
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
  if (url === 'https://openrouter.ai/api/v1/models') return Response.json({ data: [{ id: 'fixture/model', name: 'Modèle de test', supported_parameters: ['tools'], architecture: { input_modalities: ['text'], output_modalities: ['text'] } }] });
  // Le modèle n'est jamais joint : les tours échouent proprement, ce que les cartes doivent montrer tel quel.
  if (url.includes('openrouter.ai/')) return Response.json({ error: { message: 'Fixture : aucun modèle.' } }, { status: 401 });
  return nativeFetch(input, init);
};

const shots = process.env.OPENDOTS_SHOTS_DIR;
const dir = await mkdtemp(join(tmpdir(), 'opendots-ui-work-'));
process.env.OPENDOTS_DATA_DIR = dir;
const { createApplication } = await import('../src/app.ts');
const { authStore, closeAuthStore, accountById } = await import('../src/auth/store.ts');
const { withAccount } = await import('../src/auth/context.ts');
const { openDatabase, closeAllDatabases } = await import('../src/db/client.ts');
const { createAgent, mainConversationId } = await import('../src/agents/repo.ts');
const { setSetting, setOpenRouterKey } = await import('../src/settings.ts');
const { createTask } = await import('../src/tasks/service.ts');
const { registerLifeHandlers } = await import('../src/life/engine.ts');
const { startQueue, stopQueue } = await import('../src/jobs/queue.ts');
registerLifeHandlers();
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
  page.on('dialog', (dialog) => void dialog.accept());
  const shot = async (name: string) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };
  await page.goto(origin);
  await page.getByRole('button', { name: 'Pas encore de compte ? S’inscrire' }).click();
  await page.getByLabel('Adresse e-mail', { exact: true }).fill('work@example.com');
  await page.getByLabel('Mot de passe', { exact: true }).fill('browser password for test');
  await page.getByLabel('Confirmer le mot de passe').fill('browser password for test');
  await page.getByRole('button', { name: 'Créer mon compte', exact: true }).click();
  await page.getByText('1. Connexion au fournisseur', { exact: true }).waitFor();
  const profile = await (await context.request.get(`${origin}/api/auth/me`)).json();
  const account = (await accountById(profile.account.id))!;
  let ariId = '', devId = '';
  await withAccount(account, async () => {
    await setOpenRouterKey('ui-fixture-personal-key');
    await setSetting('onboarding.done', true);
    await setSetting('models.default', { provider: 'openrouter', model: 'fixture/model' });
    await startQueue(); // la file de jobs exécute les tâches, comme en production
    ariId = (await createAgent({ name: 'Ari' })).id; devId = (await createAgent({ name: 'Dev' })).id;
  });
  await page.goto(`${origin}/#/agent/${ariId}`); await page.reload();

  // --- Fichiers (#30) : tout type de fichier, carte dans le fil, accès et historique.
  const composer = page.getByRole('textbox', { name: 'Écrire à Ari…' });
  await composer.waitFor();
  await page.getByLabel('Choisir des fichiers').setInputFiles({ name: 'notes de réunion.md', mimeType: 'text/markdown', buffer: Buffer.from('# Réunion\n\nDécision : livrer vendredi.\n') });
  const draft = page.getByLabel('Fichiers joints');
  await draft.getByText('notes de réunion.md', { exact: true }).waitFor();
  await draft.getByText('41 o', { exact: true }).waitFor();
  await composer.fill('Voici les notes.');
  await page.getByRole('button', { name: 'Envoyer' }).click();
  const fileCard = page.locator('[data-file-card]').first();
  await fileCard.getByText('notes de réunion.md', { exact: true }).waitFor();
  await fileCard.getByText(/41 o/).waitFor();
  const href = await fileCard.getByRole('link', { name: 'Télécharger' }).getAttribute('href');
  const download = await context.request.get(`${origin}${href}`);
  assert.equal(await download.text(), '# Réunion\n\nDécision : livrer vendredi.\n');
  assert.match(download.headers()['content-disposition'], /^attachment/);
  await shot('1-file-card');
  await fileCard.getByRole('button', { name: 'Accès' }).click();
  const access = page.getByRole('dialog');
  await access.locator('[data-grant]').filter({ hasText: 'Ari' }).waitFor();
  await access.locator('[data-artifact-history]').getByText(/Créé/).waitFor();
  await shot('2-file-access');
  await access.getByRole('button', { name: 'Retirer' }).click();
  await access.getByText('Aucun compagnon ne peut lire ce fichier.').waitFor();
  await access.getByRole('button', { name: 'Donner à Dev' }).click();
  await access.locator('[data-grant]').filter({ hasText: 'Dev' }).waitFor();
  await access.locator('[data-artifact-history]').getByText(/Accès retiré.*Ari/).waitFor();
  await access.locator('[data-artifact-history]').getByText(/Partagé → Dev/).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Fichiers' }).click();
  await page.getByText('Aucun fichier', { exact: true }).waitFor(); // Ari n'y a plus accès

  // --- Tâches (#24) : une carte, mise à jour sur place, sans recharger.
  await page.getByRole('tab', { name: /Tâches/ }).click();
  await page.getByText('Aucune tâche', { exact: true }).waitFor();
  let taskId = '';
  await withAccount(account, async () => { taskId = (await createTask({ agentId: ariId, conversationId: await mainConversationId(ariId), title: 'Préparer le rapport', instruction: 'Rassemble les chiffres et rédige le rapport.', requestedBy: 'user' })).id; });
  const taskCard = page.locator('[data-tasks-list] [data-task-card]');
  await taskCard.getByText('Préparer le rapport', { exact: true }).waitFor();
  assert.equal(await taskCard.count(), 1);
  // Sans modèle joignable, la tâche échoue : la même carte passe à « Échouée », avec la raison réelle.
  await page.locator('[data-tasks-list] [data-task-card="failed"]').waitFor({ timeout: 30_000 });
  assert.equal(await taskCard.count(), 1);
  await shot('3-task-card');
  await taskCard.getByRole('button', { name: 'Détails' }).click();
  const details = page.getByRole('dialog');
  await details.getByText('Rassemble les chiffres et rédige le rapport.', { exact: true }).waitFor();
  await details.locator('[data-task-events] li').first().waitFor();
  await shot('4-task-details');
  await page.keyboard.press('Escape');

  // --- Chats (#29) : destination distincte, @mention, intervention signée, renommage, suppression.
  await page.getByRole('button', { name: 'Nouveau chat' }).click();
  await page.waitForURL(/#\/chat\//);
  const chatBox = page.getByRole('textbox', { name: 'Écrire un message, @ pour un compagnon…' });
  await chatBox.fill('@D');
  await page.getByRole('option', { name: '@Dev' }).waitFor();
  assert.equal(await page.getByRole('option').count(), 1);
  await chatBox.press('Enter');
  assert.equal(await chatBox.inputValue(), '@Dev ');
  await chatBox.pressSequentially('résume la réunion de vendredi');
  await shot('5-chat-mention');
  await chatBox.press('Enter');
  const intervention = page.locator('[data-general-chat] [data-task-card]');
  await intervention.getByText('Dev', { exact: true }).waitFor();
  await intervention.getByText('intervention').waitFor();
  assert.equal(await intervention.count(), 1);
  const chatUrl = page.url();
  await page.getByRole('navigation', { name: 'Chats' }).getByText(/résume la réunion/).first().waitFor();
  await page.reload();
  await page.locator('[data-general-chat] [data-task-card]').getByText('intervention').waitFor(); // état relu après rechargement
  assert.equal(page.url(), chatUrl);
  await shot('6-chat-intervention');
  await page.getByRole('tab', { name: 'Interventions' }).click();
  await page.locator('[data-tasks-list] [data-task-card]').first().waitFor();
  await page.getByRole('tab', { name: 'Réglages' }).click();
  await page.getByLabel('Titre').fill('Réunion de vendredi');
  await page.getByRole('button', { name: 'Renommer' }).click();
  await page.getByRole('navigation', { name: 'Chats' }).getByText('Réunion de vendredi', { exact: true }).waitFor();
  await page.locator('header').getByText('Réunion de vendredi', { exact: true }).waitFor();
  await shot('7-chat-settings');
  await page.getByRole('button', { name: 'Supprimer ce chat' }).click();
  await page.waitForURL(/#\/agent\//);
  assert.equal(await page.getByRole('navigation', { name: 'Chats' }).getByText('Réunion de vendredi', { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log('Chromium : fichier joint, carte, accès et historique ; carte de tâche en direct et détails ; chat, @mention, intervention, renommage et suppression vérifiés.');
} catch (error) {
  const page = browser.contexts()[0]?.pages().find((p) => p.url().startsWith(origin));
  if (page) { await page.screenshot({ path: join(process.env.OPENDOTS_SHOTS_DIR ?? tmpdir(), 'opendots-ui-work-failure.png'), fullPage: true }); console.error((await page.locator('body').innerText()).slice(-2500)); }
  throw error;
} finally {
  closeCodexClients();
  await stopQueue().catch(() => {});
  await browser.close(); await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeAllDatabases(); await closeAuthStore(); await rm(dir, { recursive: true, force: true });
}
process.exit(0);
