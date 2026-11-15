/**
 * The OpenCode integration against a REAL `opencode serve` 2.x (no fake): pairing with a one-time link, delegation,
 * live state, a permission request, the real result and diff, files, and the second use of a link.
 *
 *   OPENCODE_URL=http://127.0.0.1:4196 OPENCODE_PASSWORD=… OPENCODE_PROJECT=/path/to/repo \
 *     pnpm --filter @opendots/server exec tsx scripts/opencode-real-check.ts
 *
 * The server's password is only used to ask it for a pairing code, as `opencode pair` does; BotCircle itself only
 * ever sees the link. OpenCode needs a model configured; it does the coding.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = process.env.OPENCODE_URL, password = process.env.OPENCODE_PASSWORD, project = process.env.OPENCODE_PROJECT;
if (!base || !password || !project) { console.log('OPENCODE_URL, OPENCODE_PASSWORD et OPENCODE_PROJECT requis.'); process.exit(0); }
const dir = await mkdtemp(join(tmpdir(), 'bc-opencode-real-'));
process.env.OPENDOTS_DATA_DIR = dir;
const { openDatabase, closeDatabase, db, schema } = await import('../src/db/client.ts');
const { eq } = await import('drizzle-orm');
const { createAgent, mainConversationId } = await import('../src/agents/repo.ts');
const { getTask, cancelTask } = await import('../src/tasks/service.ts');
const svc = await import('../src/opencode/service.ts');
await openDatabase({ memory: true });

const auth = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` };
const pairingLink = async () => { const r = await fetch(`${base}/api/pair`, { method: 'POST', headers: auth }); assert.equal(r.status, 200); return `${base}/auth/connect/${(await r.json()).code}`; };
const until = async (what: string, test: () => Promise<boolean>, seconds = 180) => { const end = Date.now() + seconds * 1000; while (Date.now() < end) { if (await test()) return; await new Promise((r) => setTimeout(r, 2000)); } throw new Error(`Délai dépassé : ${what}`); };
const results: string[] = [];
const ok = (line: string) => { results.push(line); console.log('✓ ' + line); };

try {
  // 1. Pairing: the link is redeemed once; the stored secret is a session token, never shown.
  const link = await pairingLink();
  const row = await svc.pairInstance({ link, defaultDirectory: project });
  const dto = await svc.toInstanceDTO(row);
  assert.equal(dto.state, 'online'); assert.equal(dto.apiVersion, 'v2'); assert.equal(dto.authKind, 'pairing');
  assert.ok(dto.tokenExpiresAt && new Date(dto.tokenExpiresAt).getTime() > Date.now() + 29 * 86400_000);
  assert.ok(!JSON.stringify(dto).includes(password));
  ok(`jumelage par lien : « ${dto.name} », OpenCode ${dto.version}, API ${dto.apiVersion}, jeton valable jusqu’au ${dto.tokenExpiresAt!.slice(0, 10)}`);
  await assert.rejects(svc.pairInstance({ link }), /expiré ou a déjà servi/);
  ok('le même lien ne sert pas deux fois (message clair)');
  ok(`projets vus : ${(await svc.instanceProjects(row)).map((p) => p.worktree).join(', ')}`);

  // 2. Delegation in a real session; live state; real result and diff handed to the companion once.
  const agent = await createAgent({ name: 'Codeuse' });
  const conv = await mainConversationId(agent.id);
  const task = await svc.startOpencodeTask({ agentId: agent.id, conversationId: conv, instance: row, title: 'Ajouter mul', instruction: 'Add an exported function `mul(a: number, b: number)` to math.ts that multiplies a and b. Do not run anything. Reply with one short sentence.', requestedBy: 'agent' });
  assert.equal(task.status, 'running');
  let sawActivity = '';
  await until('fin de la tâche', async () => { await svc.syncTask((await getTask(task.id))!); const t = (await getTask(task.id))!; if (t.currentAction && !sawActivity) sawActivity = t.currentAction; return !['running', 'queued'].includes(t.status); });
  const done = (await getTask(task.id))!;
  assert.equal(done.status, 'completed', done.error ?? '');
  const file = await readFile(join(project, 'math.ts'), 'utf8');
  assert.match(file, /mul/);
  const wakes = (await db().select().from(schema.jobs).where(eq(schema.jobs.agentId, agent.id))).filter((j) => j.type === 'agent.wake');
  assert.equal(wakes.length, 1);
  assert.match((wakes[0].payload as { text: string }).text, /math\.ts \(\+\d+\/-\d+\)/);
  ok(`tâche réelle terminée en ${done.completedSteps} action(s), activité vue : « ${sawActivity || '—'} » ; résultat : « ${(done.result ?? '').replace(/\s+/g, ' ').slice(0, 90)} » ; compagnon réveillé une fois avec le diff`);
  const space = await svc.workspace(done);
  assert.ok(space.reachable && space.messages.some((m) => m.role === 'assistant') && space.diffs.some((d) => d.path === 'math.ts'));
  ok(`espace de code : ${space.messages.length} messages, ${space.diffs.length} fichier(s) modifié(s) : ${space.diffs.map((d) => `${d.path} +${d.additions}/-${d.deletions}`).join(', ')}`);
  const files = await svc.listFiles(done, '');
  assert.ok(files.some((f) => f.path === 'math.ts'));
  const read = await svc.readFile(done, 'math.ts');
  assert.ok(!read.binary && read.content.includes('mul'));
  ok(`fichiers du projet lus sur la machine : ${files.map((f) => f.name).join(', ')}`);

  // 3. Continue the same session; a refused permission ends the turn as a failure with OpenCode's reason.
  const before = (await getTask(task.id))!.external!.sessionId;
  await svc.instructOpencode(done, 'Now run the shell command `ls` and tell me its output.', 'user');
  await until('demande d’autorisation', async () => { await svc.syncTask((await getTask(task.id))!); return (await getTask(task.id))!.status === 'waiting_for_user'; }, 120).catch(() => {});
  const waiting = (await getTask(task.id))!;
  if (waiting.status === 'waiting_for_user') {
    const request = (await svc.workspace(waiting)).permissions[0];
    ok(`autorisation demandée dans la même session : ${request.permission} (${request.patterns.join(', ')})`);
    await svc.replyPermission(waiting, request.id, 'reject');
    await until('fin après refus', async () => { await svc.syncTask((await getTask(task.id))!); return !['running', 'queued', 'waiting_for_user'].includes((await getTask(task.id))!.status); }, 120);
    const after = (await getTask(task.id))!;
    ok(`après refus : tâche « ${after.status} » — ${(after.error ?? after.result ?? '').slice(0, 90)}`);
  } else ok(`pas d’autorisation demandée par cette configuration (statut ${waiting.status}) : refus non testé`);
  assert.equal((await getTask(task.id))!.external!.sessionId, before);

  // 4. Stop really interrupts.
  const long = await svc.startOpencodeTask({ agentId: agent.id, conversationId: conv, instance: row, title: 'Long', instruction: 'Write a 2000-word essay about rivers into essay.md.', requestedBy: 'agent' });
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal((await cancelTask(long.id)).status, 'cancelled');
  await new Promise((r) => setTimeout(r, 2000));
  const active = await fetch(`${base}/api/session/active`, { headers: auth }).then((r) => r.json()) as { data: Record<string, unknown> };
  assert.ok(!(long.external!.sessionId in active.data));
  ok('arrêt transmis : la session n’est plus active sur la machine');
  console.log(`\n${results.length} vérifications réussies contre un vrai OpenCode.`);
} catch (error) {
  console.log('✗ ' + (error as Error).message);
  process.exitCode = 1;
} finally {
  await closeDatabase().catch(() => {});
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
