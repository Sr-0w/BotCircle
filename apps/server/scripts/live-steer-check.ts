/**
 * #55 / #61 with a REAL model and a REAL computer: while the companion works through several shell steps, the user
 * steers it. Expected: one executor, the earlier message stays, the steer is applied and the work is finished.
 *
 *   OPENROUTER_API_KEY=… pnpm --filter @opendots/server exec tsx scripts/live-steer-check.ts
 *
 * Isolated: temporary data folder, containers prefixed `bc-live-steer`, removed at the end.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const key = process.env.OPENROUTER_API_KEY;
if (!key) { console.log('OPENROUTER_API_KEY absent : essai ignoré.'); process.exit(0); }
const MODEL = { provider: 'openrouter' as const, model: process.env.OPENDOTS_LIVE_MODEL ?? 'z-ai/glm-5.3-flash', reasoning: 'low' as const };
const dir = await mkdtemp(join(tmpdir(), 'bc-live-steer-'));
process.env.OPENDOTS_DATA_DIR = dir;
process.env.OPENDOTS_CONTAINER = 'bc-live-steer';

const { openDatabase, closeDatabase, db, schema } = await import('../src/db/client.ts');
const { eq } = await import('drizzle-orm');
const { setSetting, setOpenRouterKey, BUILTIN_COMPUTER_IMAGE } = await import('../src/settings.ts');
const { createAgent, mainConversationId } = await import('../src/agents/repo.ts');
const { runTurn } = await import('../src/agents/turn.ts');
const { loadMessages, messageText } = await import('../src/conversations/repo.ts');
const { execShell } = await import('../src/computer/shell.ts');

await openDatabase({ memory: true });
await setOpenRouterKey(key);
await setSetting('onboarding.done', true);
await setSetting('models.default', MODEL);
await setSetting('engine.turnStepLimit', 40);
await setSetting('shell.config', { mode: 'docker', approval: 'auto', image: BUILTIN_COMPUTER_IMAGE, network: false, sudo: false });

let failed = false;
try {
  const agent = await createAgent({ name: 'Steer', description: 'Compagnon de test avec un ordinateur.' });
  await db().update(schema.agents).set({ permissions: { ...agent.permissions, computer: true, shell: true, mail: false, connectors: false } }).where(eq(schema.agents.id, agent.id));
  const conv = await mainConversationId(agent.id);
  await execShell(agent.id, 'rm -rf ~/steer && mkdir -p ~/steer');

  const work = runTurn(agent.id, conv, { kind: 'user', message: { id: 'msg_live_work', role: 'user', parts: [{ type: 'text', text:
    'Dans le dossier ~/steer, crée les fichiers note1.txt, note2.txt, note3.txt, note4.txt et note5.txt. Règle stricte : UN SEUL fichier par appel shell_exec, dans l’ordre, et chaque commande commence par `sleep 3 &&`. Chaque fichier contient son numéro sur la première ligne. Ne délègue pas, fais-le toi-même dans ce tour, puis dis-moi quand les cinq sont faits.' }] } });

  // Steer as soon as the first command ran.
  const reader = work.stream.readable().getReader();
  let shells = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if ((value as any).type === 'tool-output-available') shells += 1;
    if (shells >= 1) break;
  }
  void reader.cancel();
  assert.ok(shells >= 1, 'la première commande devait avoir tourné');
  const steer = runTurn(agent.id, conv, { kind: 'user', message: { id: 'msg_live_steer', role: 'user', parts: [{ type: 'text', text:
    'Petite précision : à partir de maintenant, ajoute aussi une deuxième ligne « steer ok » dans chaque fichier que tu crées. Continue jusqu’aux cinq fichiers.' }] } });
  assert.equal(steer.done, work.done, 'le message doit orienter le même tour, pas en lancer un second');
  const result = await work.done;
  assert.equal(result.error, null, `le tour a échoué : ${result.error}`);

  const thread = (await loadMessages(conv)).messages;
  const roles = thread.map((m) => `${m.role}:${messageText(m).slice(0, 60)}`);
  console.log(roles.join('\n'));
  const iWork = thread.findIndex((m) => m.id === 'msg_live_work');
  const iSteer = thread.findIndex((m) => m.id === 'msg_live_steer');
  assert.ok(iWork === 0 && iSteer > 1, 'ordre : demande, travail déjà fait, consigne');
  assert.ok(thread.slice(1, iSteer).some((m) => m.role === 'assistant' && m.parts.some((p: any) => p.type === 'tool-shell_exec')), 'le travail fait avant la consigne reste dans le fil');
  assert.ok(thread.slice(iSteer + 1).some((m) => m.role === 'assistant'), 'le travail reprend après la consigne');

  const files = await execShell(agent.id, 'cd ~/steer && for f in note1.txt note2.txt note3.txt note4.txt note5.txt; do echo "== $f"; cat "$f" 2>&1; done');
  console.log(files.stdout);
  for (const n of [1, 2, 3, 4, 5]) assert.match(files.stdout, new RegExp(`== note${n}\\.txt\\n${n}`), `note${n}.txt manquant ou incorrect`);
  assert.match(files.stdout, /== note5\.txt\n5\nsteer ok/, 'la consigne doit s’appliquer aux fichiers suivants');
  console.log(`✓ steer réel : un seul tour, ${thread.length} messages ordonnés, 5 fichiers, consigne appliquée (${result.text.slice(0, 120)})`);
} catch (error) {
  failed = true;
  console.log(`✗ steer réel — ${(error as Error).message}`);
} finally {
  const { execFile } = await import('node:child_process');
  const names = await new Promise<string>((resolve) => execFile('docker', ['ps', '-a', '--format', '{{.Names}}'], (_e, out) => resolve(String(out ?? ''))));
  for (const name of names.split('\n').filter((line) => line.startsWith('bc-live-steer'))) await new Promise((resolve) => execFile('docker', ['rm', '-f', name], resolve));
  await closeDatabase().catch(() => {});
  await rm(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
