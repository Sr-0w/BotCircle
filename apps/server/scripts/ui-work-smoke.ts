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
  if (url.startsWith('https://code.example.test/')) return fakeOpencode(new URL(url), init);
  if (url.includes('gravatar.com/')) return new Response(null, { status: 404 });
  if (url === 'https://openrouter.ai/api/v1/models') return Response.json({ data: [{ id: 'fixture/model', name: 'Modèle de test', supported_parameters: ['tools'], architecture: { input_modalities: ['text'], output_modalities: ['text'] } }] });
  // Le modèle n'est jamais joint : les tours échouent proprement, ce que les cartes doivent montrer tel quel.
  if (url.includes('openrouter.ai/')) return Response.json({ error: { message: 'Fixture : aucun modèle.' } }, { status: 401 });
  return nativeFetch(input, init);
};

/** Une fausse instance `opencode serve` : mêmes chemins et mêmes formes que l'API réelle. */
const oc = { prompts: [] as string[], busy: true, messages: [
  { info: { id: 'm_u1', role: 'user', time: { created: Date.now() + 3_600_000 } }, parts: [{ id: 'a', type: 'text', text: 'Regroupe OAuth avec les fournisseurs.' }] },
  { info: { id: 'm_a1', role: 'assistant', time: { created: Date.now() + 3_600_000 }, modelID: 'gpt-5', providerID: 'openai' }, parts: [
    { id: 'b', type: 'text', text: 'Je regroupe les réglages des fournisseurs.' },
    { id: 'c', type: 'tool', tool: 'edit', state: { status: 'completed', input: { file: 'settings-page.tsx' }, output: 'ok', title: 'settings-page.tsx' } },
    { id: 'd', type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'pnpm test' }, title: 'Lance les tests' } }] }] as any[] };
function fakeOpencode(url: URL, init?: RequestInit) {
  const json = (value: unknown) => Response.json(value);
  const path = url.pathname, method = init?.method ?? 'GET';
  if ((init?.headers as Record<string, string>)?.authorization !== `Basic ${Buffer.from('opencode:smoke-secret').toString('base64')}`) return Response.json({}, { status: 401 });
  if (path === '/global/health') return json({ healthy: true, version: '1.19.5' });
  if (path === '/session' && method === 'POST') return json({ id: 'ses_smoke', title: 'x', directory: '/home/dev/opendots', time: { created: Date.now(), updated: Date.now() } });
  if (path === '/session/ses_smoke') return json({ id: 'ses_smoke', title: 'Refactor des réglages', directory: '/home/dev/opendots', time: { created: Date.now(), updated: Date.now() }, summary: { additions: 12, deletions: 4, files: 1 } });
  if (path === '/session/status') return json(oc.busy ? { ses_smoke: { type: 'busy' } } : {});
  if (path === '/session/ses_smoke/message') return json(oc.messages);
  if (path === '/session/ses_smoke/diff') return json([{ path: 'apps/web/src/settings-page.tsx', status: 'modified', additions: 12, deletions: 4, patch: '@@ -1,2 +1,2 @@\n-ancien\n+nouveau' }]);
  if (path === '/session/ses_smoke/prompt_async') { const text = JSON.parse(String(init!.body)).parts[0].text; oc.prompts.push(text); if (!oc.messages.some((m) => m.info.role === 'user' && m.parts[0]?.text === text)) oc.messages.push({ info: { id: `m_u${oc.messages.length}`, role: 'user', time: { created: Date.now() + 3_600_000 } }, parts: [{ id: 'p', type: 'text', text }] }); return new Response(null, { status: 204 }); }
  if (path === '/session/ses_smoke/abort') { oc.busy = false; return json(true); }
  if (path === '/permission' || path === '/question') return json([]);
  if (path === '/file') return json([{ name: 'apps', path: 'apps', type: 'directory', ignored: false }, { name: 'README.md', path: 'README.md', type: 'file', ignored: false }]);
  if (path === '/file/content') return json({ type: 'text', content: '# BotCircle\n' });
  return Response.json({}, { status: 404 });
}
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
const { requestSecureLogin } = await import('../src/securelogin/service.ts');
const { listInstances, startOpencodeTask, syncTask } = await import('../src/opencode/service.ts');
const { saveMessage } = await import('../src/conversations/repo.ts');
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

  // --- Connexion sécurisée (#23) : carte de confiance, origine vérifiée, issue transmise sans secret.
  let loginId = '';
  await withAccount(account, async () => {
    const login = await requestSecureLogin({ agentId: devId, conversationId: await mainConversationId(devId), url: 'https://service.example/login?next=%2Finvoices', reason: 'Lire la dernière facture' });
    loginId = login.id;
    await saveMessage(await mainConversationId(devId), { id: 'login-fixture', role: 'assistant', parts: [
      { type: 'text', text: 'Une connexion est nécessaire sur service.example.' },
      { type: 'tool-request_secure_login', toolCallId: 'login-call', state: 'output-available', input: { url: login.url, reason: login.reason }, output: { ok: true, status: 'waiting_for_secure_login', loginId: login.id, origin: login.origin } },
    ] as any, metadata: { agentId: devId } }, { author: 'agent', agentId: devId });
  });
  await page.goto(`${origin}/#/agent/${devId}`);
  const loginCard = page.getByRole('region', { name: 'Connexion sécurisée' });
  await loginCard.getByText('Se connecter à service.example', { exact: true }).waitFor();
  await loginCard.getByText('En attente de ta connexion', { exact: true }).waitFor();
  assert.equal(await loginCard.locator('input').count(), 0); // aucun champ d'identifiant dans BotCircle
  await loginCard.getByText(/Connexion chiffrée \(HTTPS\)/).click();
  await loginCard.getByText('https://service.example/login?next=%2Finvoices', { exact: true }).waitFor();
  await shot('8-secure-login');
  // Tant qu'elle est en cours, la main ne se rend pas par un autre chemin.
  assert.equal((await context.request.post(`${origin}/api/computer/desktop/control?agentId=${devId}`, { data: { enabled: false }, headers: { 'x-opendots-client': '1' } })).status(), 409);
  await loginCard.getByRole('button', { name: 'Annuler', exact: true }).click();
  await loginCard.getByText('Connexion annulée', { exact: true }).waitFor();
  assert.equal(await loginCard.getByRole('button').count(), 0);
  assert.equal((await (await context.request.get(`${origin}/api/secure-logins/${loginId}`)).json()).status, 'cancelled');
  await page.goto(`${origin}/#/agent/${ariId}`);

  // --- OpenCode (#31) : instance contrôlée, carte unique, espace de code sur la session exacte.
  await page.goto(`${origin}/#/settings/opencode`);
  // Jumelage par lien contre un VRAI OpenCode 2, quand il y en a un (OPENCODE_URL / OPENCODE_PASSWORD).
  if (process.env.OPENCODE_URL && process.env.OPENCODE_PASSWORD) {
    const issued = await (await nativeFetch(`${process.env.OPENCODE_URL}/api/pair`, { method: 'POST', headers: { authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString('base64')}` } })).json() as { code: string };
    const link = `${process.env.OPENCODE_URL}/auth/connect/${issued.code}`;
    await page.getByRole('button', { name: 'Jumeler avec un lien' }).click();
    await page.getByLabel('Lien affiché par opencode pair').fill(link);
    await page.getByRole('button', { name: 'Jumeler', exact: true }).click();
    const paired = page.locator('[data-instance-state="online"]').filter({ hasText: /jumelée jusqu’au/ });
    await paired.waitFor({ timeout: 20_000 });
    await shot('11-opencode-paired');
    // Le même lien une seconde fois : refus explicite.
    await page.getByRole('button', { name: 'Jumeler avec un lien' }).click();
    await page.getByLabel('Lien affiché par opencode pair').fill(link);
    await page.getByRole('button', { name: 'Jumeler', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: /expiré ou a déjà servi/ }).waitFor();
    await page.getByRole('button', { name: 'Annuler' }).click();
    console.log('Chromium : jumelage par lien contre un vrai OpenCode ' + (await paired.textContent())?.match(/OpenCode [\d.]+/)?.[0]);
  }
  await page.getByRole('button', { name: 'Adresse et mot de passe' }).click();
  await page.getByLabel('Nom', { exact: true }).fill('PC de dev');
  await page.getByLabel('Adresse de l’API').fill('https://code.example.test');
  await page.getByLabel('Mot de passe', { exact: true }).fill('smoke-secret');
  await page.getByLabel('Dossier du projet par défaut').fill('/home/dev/opendots');
  await page.getByRole('button', { name: 'Enregistrer et contrôler' }).click();
  const instanceCard = page.getByRole('region', { name: 'PC de dev', exact: true });
  await instanceCard.getByText('En ligne', { exact: true }).waitFor();
  await instanceCard.getByText(/OpenCode 1\.19\.5/).waitFor();
  assert.equal(JSON.stringify(await (await context.request.get(`${origin}/api/opencode/instances`)).json()).includes('smoke-secret'), false);
  await shot('9-opencode-instances');
  let codeTaskId = '';
  await withAccount(account, async () => {
    const instance = (await listInstances()).find((i) => i.name === 'PC de dev')!;
    const task = await startOpencodeTask({ agentId: ariId, conversationId: await mainConversationId(ariId), instance, title: 'Refactor des réglages', instruction: 'Regroupe OAuth avec les fournisseurs.', original: 'range les réglages', requestedBy: 'agent' });
    codeTaskId = task.id;
    await saveMessage(await mainConversationId(ariId), { id: 'code-fixture', role: 'assistant', parts: [
      { type: 'tool-opencode_start', toolCallId: 'code-call', state: 'output-available', input: { title: task.title, instruction: task.instruction }, output: { ok: true, status: 'running', taskId: task.id, title: task.title, sessionId: 'ses_smoke' } },
      { type: 'text', text: 'J’ai confié le refactor à OpenCode ; je reste disponible.' },
    ] as any, metadata: { agentId: ariId } }, { author: 'agent', agentId: ariId });
    await syncTask(task);
  });
  await page.goto(`${origin}/#/agent/${ariId}`);
  const codeCard = page.locator(`[data-task-card]:has([data-task-provider="opencode"])`).first();
  await codeCard.getByText('Refactor des réglages', { exact: true }).waitFor();
  await codeCard.getByText(/PC de dev · opendots/).waitFor();
  await codeCard.getByText('Lance les tests', { exact: true }).waitFor(); // activité réelle lue sur la session
  assert.equal(await codeCard.getByRole('button', { name: 'Pause' }).count(), 0);
  await codeCard.getByRole('button', { name: 'Ouvrir l’espace de code' }).click();
  const space = page.locator(`[data-code-workspace="${codeTaskId}"]`);
  await space.getByText('Je regroupe les réglages des fournisseurs.').waitFor();
  await space.locator('[data-code-tool="running"]').getByText('Lance les tests').waitFor();
  // La conversation reste utilisable à côté de l'espace de code.
  await page.getByRole('textbox', { name: 'Écrire à Ari…' }).waitFor();
  await shot('10-code-workspace');
  await space.getByRole('tab', { name: /Changements/ }).click();
  await space.locator('[data-code-diff]').getByText('apps/web/src/settings-page.tsx').click();
  await space.getByText('+nouveau', { exact: true }).waitFor();
  await space.getByRole('tab', { name: 'Fichiers' }).click();
  await space.locator('[data-code-files]').getByText('README.md').click();
  await space.locator('[data-code-file]').getByText('# BotCircle').waitFor();
  await space.getByRole('textbox', { name: 'Écrire directement à OpenCode…' }).fill('Garde les animations.');
  await space.getByRole('button', { name: 'Envoyer' }).click();
  await page.waitForFunction(() => true); await space.getByRole('tab', { name: 'Session' }).click();
  await space.locator('[data-code-message="user"]').getByText('Garde les animations.').waitFor();
  assert.deepEqual(oc.prompts, ['Regroupe OAuth avec les fournisseurs.', 'Garde les animations.']);
  await space.getByRole('tab', { name: 'Échanges' }).click();
  await space.locator('[data-exchange="user"]').getByText('Garde les animations.').waitFor(); // attribuée à l'utilisateur
  await space.locator('[data-exchange="companion"]').getByText('Demande d’origine').waitFor();
  await space.getByRole('button', { name: 'Arrêter' }).click();
  await space.locator('[data-code-status="cancelled"]').waitFor();
  await space.getByRole('button', { name: 'Fermer l’espace de code' }).click();

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
  // Quiet UI : trois thèmes complets, valeurs exactes du design language.
  for (const [theme, background] of [['light', 'rgb(255, 255, 255)'], ['dark', 'rgb(13, 13, 14)'], ['oled', 'rgb(0, 0, 0)']] as const) {
    await page.evaluate((value) => localStorage.setItem('od-theme', value), theme);
    await page.reload();
    await page.locator('[data-general-chat] [data-task-card]').first().waitFor();
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), background);
    assert.match(await page.evaluate(() => getComputedStyle(document.body).fontFamily), /Inter/);
    await shot(`theme-${theme}`);
  }
  await page.goto(`${origin}/#/settings/providers`); await page.getByRole('region', { name: 'Ollama', exact: true }).waitFor(); await shot('settings-providers');
  await page.goBack(); await page.getByRole('tab', { name: 'Réglages' }).click();
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
