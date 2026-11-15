/**
 * Essais avec un VRAI modèle, pour ce que les tests à modèle simulé ne peuvent pas montrer : le compagnon
 * délègue-t-il au bon moment, ne répond-il qu'une fois, lit-il un fichier joint, signe-t-il une intervention ?
 *
 *   OPENROUTER_API_KEY=… pnpm --filter @opendots/server exec tsx scripts/live-model-check.ts
 *
 * La clé n'est lue que dans l'environnement et n'est écrite nulle part. Base en mémoire, aucun bureau, aucune
 * instance OpenCode réelle (une fausse API OpenCode locale répond aux appels).
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const key = process.env.OPENROUTER_API_KEY;
if (!key) { console.log('OPENROUTER_API_KEY absent : essais avec modèle réel ignorés.'); process.exit(0); }
const MODEL = { provider: 'openrouter' as const, model: process.env.OPENDOTS_LIVE_MODEL ?? 'openai/gpt-oss-120b', reasoning: 'low' as const, providerOrder: [process.env.OPENDOTS_LIVE_PROVIDER ?? 'Cerebras'] };
const dir = await mkdtemp(join(tmpdir(), 'opendots-live-'));
process.env.OPENDOTS_DATA_DIR = dir;

const { openDatabase, closeDatabase, db, schema } = await import('../src/db/client.ts');
const { eq } = await import('drizzle-orm');
const { setSetting, setOpenRouterKey } = await import('../src/settings.ts');
const { createAgent, mainConversationId } = await import('../src/agents/repo.ts');
const { runTurn } = await import('../src/agents/turn.ts');
const { loadMessages, messageText } = await import('../src/conversations/repo.ts');
const { registerLifeHandlers } = await import('../src/life/engine.ts');
const { startQueue, stopQueue } = await import('../src/jobs/queue.ts');
const { listTasks, getTask } = await import('../src/tasks/service.ts');
const { createArtifact, grantArtifact, listArtifacts } = await import('../src/artifacts/service.ts');
const { createChat } = await import('../src/chats/repo.ts');
const { runChatTurn } = await import('../src/chats/turn.ts');
const { saveInstance, setOpencodeFetch, syncOpencodeTasks, listExchanges } = await import('../src/opencode/service.ts');
const { artifactUrl } = await import('@opendots/shared');

await openDatabase({ memory: true });
await setOpenRouterKey(key);
await setSetting('onboarding.done', true);
await setSetting('models.default', MODEL);
await setSetting('engine.turnStepLimit', 30);
registerLifeHandlers();
await startQueue();

const results: { name: string; ok: boolean; note: string }[] = [];
async function check(name: string, run: () => Promise<string>) {
  const started = Date.now();
  try { const note = await run(); results.push({ name, ok: true, note }); console.log(`✓ ${name} (${Math.round((Date.now() - started) / 1000)} s) — ${note}`); }
  catch (error) { results.push({ name, ok: false, note: (error as Error).message }); console.log(`✗ ${name} — ${(error as Error).message}`); }
}
let n = 0;
const say = (agentId: string, conv: string, text: string, parts: any[] = []) => runTurn(agentId, conv, { kind: 'user', message: { id: `msg_live_${++n}`, role: 'user', parts: [{ type: 'text', text }, ...parts] } }).done;
const toolsOf = async (conv: string) => (await loadMessages(conv, { limit: 40 })).messages.flatMap((m) => m.parts.filter((p) => p.type.startsWith('tool-')).map((p) => p.type.slice(5)));
const until = async (what: string, test: () => Promise<boolean>, seconds = 150) => { const end = Date.now() + seconds * 1000; while (Date.now() < end) { if (await test()) return; await new Promise((r) => setTimeout(r, 1500)); } throw new Error(`Délai dépassé : ${what}`); };
async function companion(name: string, permissions: Record<string, unknown> = {}) {
  const agent = await createAgent({ name, description: 'Assistant de test.' });
  await db().update(schema.agents).set({ permissions: { ...agent.permissions, shell: false, computer: false, mail: false, connectors: false, ...permissions } }).where(eq(schema.agents.id, agent.id));
  return { id: agent.id, conv: await mainConversationId(agent.id) };
}

try {
  await check('#24 délègue un travail long, ne répond qu’une fois, puis livre un seul résultat', async () => {
    const ari = await companion('Ari');
    const first = await say(ari.id, ari.conv, 'Lance en arrière-plan une tâche : rédige un haïku pour chacune des quatre saisons, puis rends-moi les quatre ensemble. Pendant ce temps je continue à te parler.');
    assert.equal(first.error, null, String(first.error));
    const [task] = await listTasks({ agentId: ari.id });
    assert.ok(task, `aucune tâche créée (outils appelés : ${(await toolsOf(ari.conv)).join(', ') || 'aucun'})`);
    const bubblesBefore = (await loadMessages(ari.conv, { limit: 40 })).messages.filter((m) => m.role === 'assistant' && messageText(m).trim()).length;
    const meanwhile = await say(ari.id, ari.conv, 'Ça en est où ?');
    assert.equal(meanwhile.error, null, String(meanwhile.error));
    const asked = (await toolsOf(ari.conv)).includes('task_status');
    await until('fin de la tâche', async () => ['completed', 'failed'].includes((await getTask(task.id))!.status));
    const done = (await getTask(task.id))!;
    assert.equal(done.status, 'completed', done.error ?? '');
    await new Promise((r) => setTimeout(r, 1000));
    const after = (await loadMessages(ari.conv, { limit: 40 })).messages.filter((m) => m.metadata?.taskId === task.id);
    assert.equal(after.length, 1, `${after.length} messages de résultat au lieu d’un`);
    return `tâche « ${task.title} », ${done.completedSteps} étape(s) ; ${bubblesBefore} bulle(s) avant le résultat ; « ça en est où ? » ${asked ? 'a interrogé task_status' : 'N’A PAS interrogé task_status'} ; résultat : ${messageText(after[0]).replace(/\s+/g, ' ').slice(0, 110)}…`;
  });

  await check('#21 exécute ce qu’il annonce : pas d’annonces répétées sans action, et une relance obtient un résultat', async () => {
    const ari = await companion('Méthodique');
    const turn = await say(ari.id, ari.conv, 'Mémorise ces cinq faits, un par un, puis confirme : 1) mon chat s’appelle Pixel 2) je suis allergique aux noix 3) mon bureau est au 3e étage 4) je préfère le thé au café 5) mon anniversaire est le 9 mars.');
    assert.equal(turn.error, null, String(turn.error));
    const message = (await loadMessages(ari.conv, { limit: 6 })).messages.at(-1)!;
    const calls = message.parts.filter((p) => p.type === 'tool-memory_remember').length;
    const bubbles = message.parts.flatMap((p: any) => p.type === 'text' ? [p.text] : p.type === 'tool-text_user' ? [p.input?.text ?? ''] : []).map((t: string) => t.trim()).filter(Boolean);
    assert.ok(calls >= 5, `${calls} mémorisation(s) au lieu de 5`);
    // Une annonce = une bulle au futur (« je vais… ») ; elles ne doivent ni se répéter ni dépasser les actions.
    const announcements = bubbles.filter((t: string) => /\b(je vais|je m[’']en occupe|je commence|je poursuis|je reprends)\b/i.test(t));
    const normalized = bubbles.map((t: string) => t.toLowerCase().replace(/[^a-zà-ÿ ]/g, '').slice(0, 60));
    const duplicates = normalized.length - new Set(normalized).size;
    assert.ok(announcements.length <= 1, `${announcements.length} annonces pour ${calls} actions : ${announcements.join(' | ').slice(0, 300)}`);
    assert.equal(duplicates, 0, `${duplicates} bulle(s) répétée(s)`);
    const nudge = await say(ari.id, ari.conv, 'Tu n’as encore rien livré ? Dis-moi exactement ce qui est fait.');
    assert.equal(nudge.error, null, String(nudge.error));
    assert.ok(/pixel/i.test(nudge.text) && /noix/i.test(nudge.text), `la relance n’obtient pas l’état réel : ${nudge.text.slice(0, 200)}`);
    assert.ok(!/^\s*(je vais|je commence|je m[’']en occupe)/i.test(nudge.text), `la relance obtient une nouvelle promesse : ${nudge.text.slice(0, 160)}`);
    return `${calls} actions, ${bubbles.length} bulle(s) dont ${announcements.length} annonce ; relance : « ${nudge.text.replace(/\s+/g, ' ').slice(0, 110)}… »`;
  });

  await check('#30 lit un fichier joint à la demande, puis remet un vrai fichier', async () => {
    const ari = await companion('Lectrice');
    const file = await createArtifact({ bytes: new TextEncoder().encode('# Réunion du 12\n\nDécision : la livraison est fixée au vendredi 21.\nBudget validé : 4 200 euros.\n'), name: 'compte-rendu.md', authorKind: 'user', source: 'upload', conversationId: ari.conv });
    await grantArtifact(file.id, ari.id, 'user', 'upload', { conversationId: ari.conv });
    const read = await say(ari.id, ari.conv, 'Quel budget a été validé dans ce fichier ?', [{ type: 'file', url: artifactUrl(file.id), filename: file.name, mediaType: file.mediaType }]);
    assert.equal(read.error, null, String(read.error));
    assert.match(read.text, /4[\s  .]?200/, `réponse : ${read.text.slice(0, 200)}`);
    const usedRead = (await toolsOf(ari.conv)).includes('artifact_read');
    const made = await say(ari.id, ari.conv, 'Écris un fichier resume.md de deux lignes qui résume ce compte rendu, et remets-le-moi ici.');
    assert.equal(made.error, null, String(made.error));
    const last = (await loadMessages(ari.conv, { limit: 6 })).messages.at(-1)!;
    const published = last.parts.find((p: any) => p.type === 'tool-artifact_publish_to_chat' && p.output?.status === 'published') as any;
    assert.ok(published, `aucun fichier publié (outils : ${(await toolsOf(ari.conv)).join(', ')})`);
    const mine = (await listArtifacts({ agentId: ari.id })).find((a) => a.id === published.output.artifact.id);
    assert.ok(mine && mine.size > 0, 'fichier publié introuvable ou vide');
    return `contenu lu ${usedRead ? 'via artifact_read' : 'SANS artifact_read'} ; fichier remis : ${mine.name} (${mine.size} octets)`;
  });

  await check('#29 chat général : réponse de l’assistant, puis intervention signée d’un compagnon mentionné', async () => {
    const dev = await companion('Dev');
    const chat = await createChat({});
    const plain = await runChatTurn(chat.id, { id: `msg_live_${++n}`, role: 'user', parts: [{ type: 'text', text: 'En une phrase : à quoi sert un reverse proxy ?' }], metadata: {} }).done;
    assert.equal(plain.error, null, String(plain.error));
    assert.ok(plain.text.length > 20 && plain.interventions.length === 0, `réponse : ${plain.text.slice(0, 120)}`);
    const mention = await runChatTurn(chat.id, { id: `msg_live_${++n}`, role: 'user', parts: [{ type: 'text', text: '@Dev donne-moi trois noms possibles pour un projet de domotique.' }], metadata: {} }).done;
    assert.equal(mention.interventions.length, 1, 'aucune intervention créée');
    await until('réponse de Dev', async () => ['completed', 'failed'].includes((await getTask(mention.interventions[0]))!.status));
    assert.equal((await getTask(mention.interventions[0]))!.status, 'completed', (await getTask(mention.interventions[0]))!.error ?? '');
    await new Promise((r) => setTimeout(r, 1000));
    const signed = (await loadMessages(chat.id, { limit: 20 })).messages.filter((m) => m.metadata?.agentId === dev.id && messageText(m).trim());
    assert.equal(signed.length, 1, `${signed.length} réponse(s) signée(s) de Dev`);
    return `assistant : « ${plain.text.replace(/\s+/g, ' ').slice(0, 70)}… » ; Dev (signé) : « ${messageText(signed[0]).replace(/\s+/g, ' ').slice(0, 90)}… »`;
  });

  await check('#31 délègue du code à OpenCode, reste disponible, puis relit et rend compte du résultat réel', async () => {
    const session = { busy: true, prompts: [] as string[], messages: [] as any[] };
    setOpencodeFetch(async (input, init) => {
      const url = new URL(String(input)), path = url.pathname, json = (v: unknown) => Response.json(v);
      if (path === '/global/health') return json({ healthy: true, version: '1.19.5' });
      if (path === '/session' && init?.method === 'POST') return json({ id: 'ses_live', title: 'x', directory: '/home/dev/app', time: { created: Date.now(), updated: Date.now() } });
      if (path === '/session/ses_live') return json({ id: 'ses_live', title: 'x', directory: '/home/dev/app', time: { created: Date.now(), updated: Date.now() } });
      if (path === '/session/status') return json(session.busy ? { ses_live: { type: 'busy' } } : {});
      if (path === '/session/ses_live/message') return json(session.messages);
      if (path === '/session/ses_live/diff') return json([{ path: 'src/date.ts', status: 'modified', additions: 6, deletions: 2, patch: '@@' }, { path: 'src/date.test.ts', status: 'added', additions: 14, deletions: 0, patch: '@@' }]);
      if (path === '/session/ses_live/prompt_async') { session.prompts.push(JSON.parse(String(init!.body)).parts[0].text); return new Response(null, { status: 204 }); }
      if (path === '/permission' || path === '/question') return json([]);
      return Response.json({}, { status: 404 });
    });
    await saveInstance({ name: 'PC de dev', baseUrl: 'https://code.example.test', password: 'x', defaultDirectory: '/home/dev/app' });
    const ari = await companion('Codeuse', { code: true });
    const first = await say(ari.id, ari.conv, 'Demande à OpenCode de corriger le bug de fuseau horaire dans src/date.ts de mon projet et d’ajouter un test.');
    assert.equal(first.error, null, String(first.error));
    const [task] = (await listTasks({ agentId: ari.id })).filter((t) => t.provider === 'opencode');
    assert.ok(task, `opencode_start non appelé (outils : ${(await toolsOf(ari.conv)).join(', ') || 'aucun'})`);
    assert.equal(session.prompts.length, 1);
    session.messages.push({ info: { id: 'm1', role: 'assistant', time: { created: Date.now() + 60_000, completed: Date.now() + 61_000 } }, parts: [{ id: 'p', type: 'text', text: 'Bug corrigé dans src/date.ts (conversion UTC). Test ajouté dans src/date.test.ts. Je n’ai PAS pu lancer les tests : pnpm est absent de cette machine.' }] });
    session.busy = false;
    await syncOpencodeTasks();
    assert.equal((await getTask(task.id))!.status, 'completed');
    await until('compte rendu du compagnon', async () => (await loadMessages(ari.conv, { limit: 30 })).messages.some((m) => m.metadata?.kind === 'event' && m.metadata.event?.type === 'task') && (await db().select().from(schema.jobs).where(eq(schema.jobs.agentId, ari.id))).every((j) => j.status !== 'pending' && j.status !== 'running'), 120);
    const report = messageText((await loadMessages(ari.conv, { limit: 30 })).messages.filter((m) => m.role === 'assistant' && m.metadata?.kind !== 'event').at(-1)!);
    assert.ok(report.length > 20, 'aucun compte rendu');
    const honest = !/tests? (passent|réussi|ok|sont verts)/i.test(report) || /pas (pu|été)|n['’]ont pas|non lancé|absent/i.test(report);
    const exchanges = await listExchanges({ taskId: task.id });
    return `consigne envoyée : « ${session.prompts[0].replace(/\s+/g, ' ').slice(0, 80)}… » ; demande d’origine conservée : ${exchanges[0].original ? 'oui' : 'non'} ; compte rendu ${honest ? 'fidèle (tests non lancés signalés ou non revendiqués)' : 'DOUTEUX (revendique des tests)'} : « ${report.replace(/\s+/g, ' ').slice(0, 140)}… »`;
  });
} finally {
  await stopQueue().catch(() => {});
  await closeDatabase().catch(() => {});
  await rm(dir, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} essais réussis avec ${MODEL.model} (${MODEL.providerOrder[0]}).`);
process.exit(failed.length ? 1 : 0);
