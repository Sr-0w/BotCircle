import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { isActionToolPart } from '@opendots/shared';
import { openDatabase, closeDatabase, db, schema } from '../src/db/client.ts';
import { createAgent, mainConversationId } from '../src/agents/repo.ts';
import { cancelTask, getTask, pauseTask, sendInstruction, taskEvents, toTaskDTO } from '../src/tasks/service.ts';
import { allSessions, attachSession, resumeAfterQuota, setAutoResume, startDirectSession } from '../src/opencode/service.ts';
import { resumeTask } from '../src/tasks/service.ts';
import { checkBaseUrl, deleteInstance, instructOpencode, listExchanges, OpencodeError, replyPermission, saveInstance, setOpencodeFetch, startOpencodeTask, syncTask, toInstanceDTO, workspace } from '../src/opencode/service.ts';
import { opencodeTools } from '../src/opencode/tools.ts';

/** Une fausse instance `opencode serve` qui parle l'API réelle (chemins et formes du SDK 1.19, API v2). */
class FakeOpencode {
  down = false;
  password = 'secret';
  sessions = new Map<string, { id: string; title: string; directory: string; time: { created: number; updated: number }; summary?: { additions: number; deletions: number; files: number } }>();
  status = new Map<string, any>();
  messages = new Map<string, any[]>();
  permissions: any[] = [];
  diffs = new Map<string, any[]>();
  calls: { method: string; path: string; directory: string | null; body: any }[] = [];
  errorData: Record<string, unknown> = {};
  private n = 0;
  fetch: typeof fetch = async (input, init) => {
    if (this.down) throw new TypeError('fetch failed');
    const url = new URL(String(input));
    const method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const auth = (init?.headers as Record<string, string>)?.authorization;
    this.calls.push({ method, path: url.pathname, directory: url.searchParams.get('directory'), body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (auth !== `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}`) return json({ error: 'unauthorized' }, 401);
    const m = /^\/session\/([^/]+)(?:\/(.+))?$/.exec(url.pathname);
    if (url.pathname === '/global/health') return json({ healthy: true, version: '1.19.5' });
    if (url.pathname === '/project') return json([{ id: 'p1', worktree: '/home/dev/opendots', name: 'opendots' }]);
    if (url.pathname === '/session/status') return json(Object.fromEntries(this.status));
    if (url.pathname === '/permission') return json(this.permissions);
    if (url.pathname === '/question') return json([]);
    if (url.pathname === '/session' && method === 'GET') return json([...this.sessions.values()]);
    if (url.pathname === '/session' && method === 'POST') { const s = { id: `ses_${++this.n}`, title: body.title, directory: url.searchParams.get('directory') ?? '/home/dev/opendots', time: { created: Date.now(), updated: Date.now() } }; this.sessions.set(s.id, s); this.messages.set(s.id, []); return json(s); }
    const reply = /^\/permission\/([^/]+)\/reply$/.exec(url.pathname);
    if (reply) { this.permissions = this.permissions.filter((p) => p.id !== reply[1]); return json(true); }
    if (!m) return json({ error: 'not found' }, 404);
    const session = this.sessions.get(m[1]);
    if (!session) return json({ error: 'not found' }, 404);
    if (!m[2]) return json(session);
    if (m[2] === 'message') return json(this.messages.get(session.id));
    if (m[2] === 'diff') return json(this.diffs.get(session.id) ?? []);
    if (m[2] === 'abort') { this.status.delete(session.id); return json(true); }
    if (m[2] === 'prompt_async') { this.messages.get(session.id)!.push({ info: { id: `msg_u${++this.n}`, role: 'user', time: { created: Date.now() } }, parts: [{ id: 'p', type: 'text', text: body.parts[0].text }] }); this.status.set(session.id, { type: 'busy' }); return new Response(null, { status: 204 }); }
    return json({ error: 'not found' }, 404);
  };
  /** OpenCode travaille : un message assistant en cours, avec des outils. */
  work(sessionId: string, tools: { tool: string; status: string; title?: string }[]) {
    const list = this.messages.get(sessionId)!;
    let message = list.find((m) => m.info.role === 'assistant' && !m.info.time.completed);
    if (!message) { message = { info: { id: `msg_a${++this.n}`, role: 'assistant', time: { created: Date.now() }, modelID: 'gpt-5', providerID: 'openai' }, parts: [] }; list.push(message); }
    message.parts = tools.map((t, i) => ({ id: `t${i}`, type: 'tool', tool: t.tool, state: { status: t.status, input: {}, title: t.title, output: t.status === 'completed' ? 'ok' : undefined } }));
  }
  finish(sessionId: string, text: string, error?: string) {
    const message = this.messages.get(sessionId)!.find((m) => m.info.role === 'assistant' && !m.info.time.completed)!;
    message.parts.push({ id: 'final', type: 'text', text });
    message.info.time.completed = Date.now();
    if (error) message.info.error = { name: 'ApiError', data: { message: error, ...this.errorData } };
    this.status.delete(sessionId);
  }
}

let fake: FakeOpencode;
beforeAll(async () => { await openDatabase({ memory: true }); });
afterAll(async () => { setOpencodeFetch(null); await closeDatabase(); });
beforeEach(() => { fake = new FakeOpencode(); setOpencodeFetch(fake.fetch); });
let counter = 0;
const instance = (over: Record<string, unknown> = {}) => saveInstance({ name: `PC de dev ${++counter}`, baseUrl: 'https://code.example.test/', password: 'secret', defaultDirectory: '/home/dev/opendots', ...over });
const wakes = async (agentId: string) => (await db().select().from(schema.jobs).where(eq(schema.jobs.agentId, agentId))).filter((job) => job.type === 'agent.wake');
async function coder(name: string) {
  const agent = await createAgent({ name });
  await db().update(schema.agents).set({ permissions: { ...agent.permissions, code: true } }).where(eq(schema.agents.id, agent.id));
  return { agent: { ...agent, permissions: { ...agent.permissions, code: true } }, conv: await mainConversationId(agent.id) };
}
const start = async (name: string) => {
  const { agent, conv } = await coder(name);
  const row = await instance();
  const task = await startOpencodeTask({ agentId: agent.id, conversationId: conv, instance: row, title: 'Refactor des réglages', instruction: 'Regroupe OAuth avec les fournisseurs.', original: 'range les réglages stp', requestedBy: 'agent' });
  return { agent, conv, row, task };
};

describe('OpenCode', () => {
  it('enregistre une instance contrôlée réellement, sans jamais renvoyer son mot de passe', async () => {
    expect(checkBaseUrl('http://100.64.0.2:4096/')).toBe('http://100.64.0.2:4096');
    expect(() => checkBaseUrl('ftp://x')).toThrow(OpencodeError);
    expect(() => checkBaseUrl('https://opencode:secret@code.example.test')).toThrow(OpencodeError);
    const online = await toInstanceDTO(await instance());
    expect(online).toMatchObject({ state: 'online', version: '1.19.5', hasPassword: true, lastError: null });
    expect(JSON.stringify(online)).not.toContain('secret');
    expect((await db().select().from(schema.opencodeInstances))[0].password).toMatch(/^v1:/); // chiffré au repos
    const refused = await toInstanceDTO(await instance({ password: 'wrong' }));
    expect(refused.state).toBe('offline');
    expect(refused.lastError).toContain('refuse ces identifiants');
    fake.down = true;
    expect((await toInstanceDTO(await instance())).lastError).toContain('injoignable');
  });

  it('délègue dans une vraie session, avec la consigne réellement envoyée et la demande d’origine', async () => {
    const { task } = await start('Délégation');
    expect(task).toMatchObject({ provider: 'opencode', status: 'running' });
    expect(task.external).toMatchObject({ sessionId: 'ses_1', directory: '/home/dev/opendots' });
    const prompt = fake.calls.find((c) => c.path === '/session/ses_1/prompt_async')!;
    expect(prompt.body.parts[0].text).toBe('Regroupe OAuth avec les fournisseurs.');
    expect(prompt.directory).toBe('/home/dev/opendots');
    expect(await listExchanges({ taskId: task.id })).toMatchObject([{ author: 'companion', kind: 'delegation', text: 'Regroupe OAuth avec les fournisseurs.', original: 'range les réglages stp' }]);
    const dto = await toTaskDTO(task);
    expect(dto.external?.instanceName).toMatch(/^PC de dev/);
    expect(isActionToolPart({ type: 'tool-opencode_start', state: 'output-available', output: { ok: true, taskId: task.id } } as any)).toBe(true);
    // Rien n'est créé si l'instance refuse la consigne.
    const { agent, conv } = await coder('Refus');
    fake.down = true;
    await expect(startOpencodeTask({ agentId: agent.id, conversationId: conv, instance: (await db().select().from(schema.opencodeInstances))[0], title: 'x', instruction: 'y', requestedBy: 'agent' })).rejects.toThrow(/injoignable/);
    expect((await db().select().from(schema.tasks).where(eq(schema.tasks.agentId, agent.id)))).toHaveLength(0);
  });

  it('suit l’activité réelle sur la carte, puis remet le résultat au compagnon une seule fois', async () => {
    const { agent, task } = await start('Suivi');
    fake.work('ses_1', [{ tool: 'read', status: 'completed', title: 'settings-page.tsx' }, { tool: 'bash', status: 'running', title: 'Lance les tests' }]);
    await syncTask((await getTask(task.id))!);
    expect(await getTask(task.id)).toMatchObject({ status: 'running', currentAction: 'Lance les tests', completedSteps: 1 });
    fake.work('ses_1', [{ tool: 'read', status: 'completed' }, { tool: 'bash', status: 'completed' }]);
    fake.diffs.set('ses_1', [{ path: 'apps/web/src/settings.tsx', status: 'modified', additions: 12, deletions: 4, patch: '@@ -1 +1 @@' }]);
    fake.finish('ses_1', 'Réglages regroupés. Tests : 12 passent.');
    await syncTask((await getTask(task.id))!);
    const done = (await getTask(task.id))!;
    expect(done).toMatchObject({ status: 'completed', result: 'Réglages regroupés. Tests : 12 passent.', completedSteps: 2 });
    const jobs = await wakes(agent.id);
    expect(jobs).toHaveLength(1);
    const text = (jobs[0].payload as { text: string }).text;
    expect(text).toContain('Réglages regroupés. Tests : 12 passent.');
    expect(text).toContain('apps/web/src/settings.tsx (+12/-4)');
    expect(text).toContain('opencode_send');
    expect((jobs[0].payload as any).conversationId).toBe(done.conversationId);
    // #43 : la carte montre les vrais changements de la session ; le réveil désigne la tâche, le compagnon ne recopie pas le rapport.
    expect(done.external?.changes).toEqual({ files: 1, additions: 12, deletions: 4 });
    expect((jobs[0].payload as any).event).toMatchObject({ type: 'task', taskId: task.id });
    expect(text).toContain('do NOT paste or restate');
    // Un second passage (événement tardif, redémarrage) ne conclut ni ne réveille une seconde fois.
    await syncTask(done);
    expect(await wakes(agent.id)).toHaveLength(1);
    expect((await listExchanges({ taskId: task.id })).map((e) => `${e.author}:${e.kind}`)).toEqual(['companion:delegation', 'opencode:result']);
    // Ni les outils ni le terminal n'entrent dans les échanges.
    expect(JSON.stringify(await listExchanges({ taskId: task.id }))).not.toContain('bash');
  });

  it('rapporte une erreur réelle comme un échec, pas comme un succès', async () => {
    const { agent, task } = await start('Échec');
    fake.work('ses_1', []);
    fake.finish('ses_1', '', 'Réponse du modèle illisible');
    await syncTask((await getTask(task.id))!);
    expect(await getTask(task.id)).toMatchObject({ status: 'failed', error: 'Réponse du modèle illisible', result: null });
    expect(((await wakes(agent.id))[0].payload as { text: string }).text).toContain('stopped with an error');
    // Le diff de la session a été lu et il est vide : « aucun fichier modifié » est un fait vérifié, pas un zéro inventé.
    expect((await getTask(task.id))!.external?.changes).toEqual({ files: 0, additions: 0, deletions: 0 });
  });

  it('ne confond jamais une instance injoignable avec un échec ou une réussite', async () => {
    const { agent, task } = await start('Coupure');
    fake.work('ses_1', [{ tool: 'edit', status: 'running', title: 'Modifie le shell' }]);
    await syncTask((await getTask(task.id))!);
    fake.down = true;
    await syncTask((await getTask(task.id))!);
    const unknown = (await getTask(task.id))!;
    expect(unknown.status).toBe('running');
    expect(unknown.external?.unreachable).toBe(true);
    expect(unknown.currentAction).toContain('Dernier état connu');
    expect(await wakes(agent.id)).toHaveLength(0);
    // L'arrêt n'est pas déclaré tant qu'il n'a pas pu être transmis.
    await expect(cancelTask(task.id)).rejects.toThrow(/injoignable/);
    expect((await getTask(task.id))!.status).toBe('running');
    // Au retour, l'état réel reprend, sans doublon.
    fake.down = false;
    fake.finish('ses_1', 'Shell modifié.');
    await syncTask((await getTask(task.id))!);
    expect(await getTask(task.id)).toMatchObject({ status: 'completed', result: 'Shell modifié.' });
    expect((await getTask(task.id))!.external?.unreachable).toBe(false);
    expect(await wakes(agent.id)).toHaveLength(1);
  });

  it('suspend sur une demande d’autorisation et transmet la décision à la bonne session', async () => {
    const { task } = await start('Autorisation');
    fake.permissions.push({ id: 'per_1', sessionID: 'ses_1', permission: 'bash', patterns: ['rm -rf dist'] }, { id: 'per_other', sessionID: 'ses_autre', permission: 'bash', patterns: ['x'] });
    await syncTask((await getTask(task.id))!);
    const waiting = (await getTask(task.id))!;
    expect(waiting).toMatchObject({ status: 'waiting_for_user', requiresUserInput: true });
    expect(waiting.blocker).toContain('bash (rm -rf dist)');
    expect((await workspace(waiting)).permissions).toEqual([{ id: 'per_1', permission: 'bash', patterns: ['rm -rf dist'] }]);
    // Une demande d'une autre session ne peut pas être tranchée depuis cette tâche.
    await expect(replyPermission(waiting, 'per_other', 'once')).rejects.toThrow(/n’attend plus/);
    await replyPermission(waiting, 'per_1', 'reject');
    expect(fake.calls.some((c) => c.path === '/permission/per_1/reply' && c.body.reply === 'reject')).toBe(true);
    expect((await getTask(task.id))!.status).toBe('running');
    expect((await listExchanges({ taskId: task.id })).at(-1)).toMatchObject({ author: 'user', kind: 'permission', text: 'Autorisation refusée' });
  });

  it('poursuit la même session : consigne en file, relance après la fin, attribution exacte', async () => {
    const { agent, task } = await start('Suite');
    fake.work('ses_1', [{ tool: 'edit', status: 'running' }]);
    expect(await instructOpencode((await getTask(task.id))!, 'Garde les animations.', 'companion', 'garde les anims')).toEqual({ queued: true, delivery: 'queue' }); // 1.x has only one mode: after the current work
    fake.finish('ses_1', 'Fait.');
    // The queued instruction has not been answered yet: the task is not over, whatever the session status says.
    await syncTask((await getTask(task.id))!);
    expect((await getTask(task.id))!.status).toBe('running');
    fake.work('ses_1', [{ tool: 'edit', status: 'completed' }]);
    fake.finish('ses_1', 'Animations gardées.');
    await syncTask((await getTask(task.id))!);
    expect((await getTask(task.id))!).toMatchObject({ status: 'completed', result: 'Animations gardées.' });
    // L'utilisateur relance depuis l'espace de code : même session, même carte, de nouveau en cours.
    await sendInstruction(task.id, 'Lance les tests.', 'user');
    const again = (await getTask(task.id))!;
    expect(again).toMatchObject({ status: 'running', result: null, finishedAt: null });
    expect(again.external?.sessionId).toBe('ses_1');
    expect(fake.calls.filter((c) => c.path === '/session').filter((c) => c.method === 'POST')).toHaveLength(1); // aucune seconde session
    fake.work('ses_1', [{ tool: 'bash', status: 'completed' }]);
    fake.finish('ses_1', 'Tests : 3 échouent.');
    await syncTask(again);
    expect((await getTask(task.id))!.result).toBe('Tests : 3 échouent.');
    expect(await wakes(agent.id)).toHaveLength(2);
    expect((await listExchanges({ taskId: task.id })).map((e) => `${e.author}:${e.kind}`)).toEqual(['companion:delegation', 'companion:instruction', 'opencode:result', 'user:instruction', 'opencode:result']);
    expect((await listExchanges({ taskId: task.id }))[1].original).toBe('garde les anims');
    await expect(pauseTask(task.id)).rejects.toThrow(/ne se met pas en pause/);
  });

  it('arrête réellement, signale une session supprimée, et garde l’historique d’une instance retirée', async () => {
    const { task, row } = await start('Arrêt');
    await expect(deleteInstance(row.id)).rejects.toThrow(/en cours/);
    expect((await cancelTask(task.id)).status).toBe('cancelled');
    expect(fake.calls.some((c) => c.path === '/session/ses_1/abort')).toBe(true);
    const second = await start('Supprimée');
    fake.sessions.delete(second.task.external!.sessionId);
    await syncTask((await getTask(second.task.id))!);
    expect(await getTask(second.task.id)).toMatchObject({ status: 'failed', error: 'La session a été supprimée dans OpenCode.' });
    await deleteInstance(second.row.id);
    expect((await listExchanges({ taskId: second.task.id })).length).toBeGreaterThan(0);
    expect((await taskEvents(second.task.id)).length).toBeGreaterThan(0);
    expect((await workspace((await getTask(second.task.id))!)).reachable).toBe(false);
  });

  it('le compagnon ne choisit pas une machine au hasard et ne voit que ses propres tâches', async () => {
    const { agent, conv } = await coder('Outils');
    await db().delete(schema.opencodeInstances);
    const ctx = { agent, conversationId: conv, isMain: true } as any;
    const tools = opencodeTools(ctx) as any;
    expect(await tools.opencode_start.execute({ title: 't', instruction: 'i' }, {})).toMatchObject({ ok: false, status: 'rejected' });
    await instance({ name: 'Bureau' }); await instance({ name: 'Serveur' });
    const ambiguous = await tools.opencode_start.execute({ title: 't', instruction: 'i' }, {});
    expect(ambiguous.error).toContain('Bureau, Serveur');
    const started = await tools.opencode_start.execute({ title: 'Titre', instruction: 'Fais X', instance: 'serveur' }, {});
    expect(started).toMatchObject({ ok: true, status: 'running' });
    fake.work(started.sessionId, [{ tool: 'grep', status: 'running', title: 'Cherche X' }]);
    expect(await tools.opencode_status.execute({}, {})).toMatchObject({ ok: true, status: 'running', currentAction: 'Cherche X', stateKnown: true });
    fake.down = true;
    expect(await tools.opencode_status.execute({}, {})).toMatchObject({ ok: true, status: 'running', stateKnown: false });
    expect(await tools.opencode_send.execute({ instruction: 'encore' }, {})).toMatchObject({ ok: false, status: 'unreachable' });
    fake.down = false;
    const other = await coder('Autre');
    expect(await (opencodeTools({ agent: other.agent, conversationId: other.conv, isMain: true } as any) as any).opencode_stop.execute({ task_id: started.taskId }, {})).toMatchObject({ ok: false, status: 'rejected' });
  });

  describe('#49 : limite d’usage', () => {
    const resumeJobs = async (taskId: string) => (await db().select().from(schema.jobs).where(eq(schema.jobs.type, 'opencode.resume'))).filter((j) => (j.payload as any).taskId === taskId);
    const prompts = () => fake.calls.filter((c) => c.path.endsWith('/prompt_async'));

    it('met la session en pause sans échec, planifie la reprise, puis reprend la MÊME session une seule fois', async () => {
      const { agent, task } = await start('Quota');
      const session = task.external!.sessionId;
      fake.work(session, [{ tool: 'edit', status: 'completed', title: 'settings.ts' }]);
      const reset = Math.floor(Date.now() / 1000) + 3600;
      fake.finish(session, '', `Claude AI usage limit reached|${reset}`);
      await syncTask((await getTask(task.id))!);
      const paused = (await getTask(task.id))!;
      expect(paused.status).toBe('paused');
      expect(paused.error).toBeNull();
      expect(paused.blocker).toMatch(/Limite d’usage atteinte .* reprise automatique vers/);
      expect(paused.external!.quota).toMatchObject({ kind: 'quota', resetAt: reset * 1000, autoResume: true, attempts: 1 });
      // Nobody is told it failed or finished.
      expect(await wakes(agent.id)).toHaveLength(0);
      const jobs = await resumeJobs(task.id);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].runAt.getTime()).toBeGreaterThanOrEqual(reset * 1000);
      // Syncing again while still on the limit changes nothing.
      await syncTask((await getTask(task.id))!);
      expect((await getTask(task.id))!.status).toBe('paused');

      const before = prompts().length;
      const fingerprint = paused.external!.quota!.fingerprint;
      // Two workers race: one continuation only.
      await Promise.all([resumeAfterQuota(task.id, { fingerprint }), resumeAfterQuota(task.id, { fingerprint })]);
      expect(prompts().length).toBe(before + 1);
      expect(prompts().at(-1)!.path).toContain(session);
      expect((await getTask(task.id))!.status).toBe('running');
      // A late duplicate of the job does nothing either.
      await resumeAfterQuota(task.id, { fingerprint });
      expect(prompts().length).toBe(before + 1);
      // The resumed work completes: one real result, the pause is cleared.
      fake.work(session, [{ tool: 'bash', status: 'completed', title: 'tests' }]);
      fake.finish(session, 'Terminé : OAuth regroupé, tests verts.');
      await syncTask((await getTask(task.id))!);
      const done = (await getTask(task.id))!;
      expect(done.status).toBe('completed');
      expect(done.external!.quota).toBeNull();
      expect(await wakes(agent.id)).toHaveLength(1);
    });

    it('un envoi ambigu n’est jamais renvoyé : l’historique de la session fait foi', async () => {
      const { task } = await start('Ambigu');
      const session = task.external!.sessionId;
      fake.work(session, [{ tool: 'edit', status: 'completed' }]);
      fake.finish(session, '', 'Rate limit exceeded for this model');
      await syncTask((await getTask(task.id))!);
      const quota = (await getTask(task.id))!.external!.quota!;
      expect(quota.resetAt).toBeNull();
      expect((await getTask(task.id))!.blocker).toMatch(/heure de réinitialisation inconnue/);
      // The continuation reached OpenCode, but the answer was lost: BotCircle sees it as a failure and stays paused.
      fake.messages.get(session)!.push({ info: { id: 'msg_lost', role: 'user', time: { created: Date.now() } }, parts: [{ id: 'p', type: 'text', text: 'Reprends' }] });
      fake.down = true;
      await resumeAfterQuota(task.id, { manual: true });
      expect((await getTask(task.id))!.status).toBe('paused');
      fake.down = false;
      const before = prompts().length;
      await resumeAfterQuota(task.id, { manual: true });
      expect(prompts().length).toBe(before);
      expect((await getTask(task.id))!.status).toBe('running');
    });

    it('arrêter annule la reprise ; « Reprendre » et le choix d’un autre modèle reprennent tout de suite', async () => {
      const { task } = await start('Contrôles');
      const session = task.external!.sessionId;
      fake.work(session, []);
      fake.finish(session, '', "You've hit your usage limit. Try again in 3 hours.");
      await syncTask((await getTask(task.id))!);
      const fingerprint = (await getTask(task.id))!.external!.quota!.fingerprint;
      await setAutoResume((await getTask(task.id))!, false);
      await resumeAfterQuota(task.id, { fingerprint });
      expect((await getTask(task.id))!.status).toBe('paused');
      const before = prompts().length;
      await resumeTask(task.id);
      expect(prompts().length).toBe(before + 1);
      expect((await getTask(task.id))!.status).toBe('running');

      const other = await start('Stop');
      fake.work(other.task.external!.sessionId, []);
      fake.finish(other.task.external!.sessionId, '', 'Claude AI usage limit reached|' + (Math.floor(Date.now() / 1000) + 600));
      await syncTask((await getTask(other.task.id))!);
      await cancelTask(other.task.id);
      const count = prompts().length;
      await resumeAfterQuota(other.task.id, { fingerprint: (await getTask(other.task.id))!.external!.quota!.fingerprint });
      expect(prompts().length).toBe(count);
      expect((await getTask(other.task.id))!.status).toBe('cancelled');
    });

    it('facturation ou accès : action requise, le Circle est prévenu une fois, rien n’est replanifié', async () => {
      const { agent, task } = await start('Crédits');
      fake.work(task.external!.sessionId, []);
      fake.finish(task.external!.sessionId, '', 'Your credit balance is too low to access the Anthropic API');
      await syncTask((await getTask(task.id))!);
      await syncTask((await getTask(task.id))!);
      const row = (await getTask(task.id))!;
      expect(row.status).toBe('waiting_for_user');
      expect(row.blocker).toMatch(/^Action requise/);
      expect(await resumeJobs(task.id)).toHaveLength(0);
      expect(await wakes(agent.id)).toHaveLength(1);
    });

    it('une erreur ordinaire reste un échec', async () => {
      const { task } = await start('Ordinaire');
      fake.work(task.external!.sessionId, []);
      fake.finish(task.external!.sessionId, '', 'Tool bash failed: exit code 1');
      await syncTask((await getTask(task.id))!);
      expect((await getTask(task.id))!.status).toBe('failed');
    });
  });

  describe('#31 / #47 : Code, sessions directes', () => {
    it('lance une vraie session sans Circle, dans un projet connu seulement ; personne n’est réveillé', async () => {
      const row = await instance();
      await expect(startDirectSession({ instanceId: row.id, directory: '/etc', instruction: 'x' })).rejects.toThrow(OpencodeError);
      const task = await startDirectSession({ instanceId: row.id, directory: '/home/dev/opendots', instruction: 'Ajoute un test pour le parseur.' });
      expect(task).toMatchObject({ agentId: 'user', requestedBy: 'user', provider: 'opencode', status: 'running' });
      const prompt = fake.calls.filter((c) => c.path.endsWith('/prompt_async')).at(-1)!;
      expect(prompt.body.parts[0].text).toBe('Ajoute un test pour le parseur.');
      fake.work(task.external!.sessionId, [{ tool: 'edit', status: 'completed' }]);
      fake.finish(task.external!.sessionId, 'Test ajouté.');
      await syncTask((await getTask(task.id))!);
      expect((await getTask(task.id))!.status).toBe('completed');
      const wakesForUser = (await db().select().from(schema.jobs).where(eq(schema.jobs.type, 'agent.wake'))).filter((j) => (j.payload as any).agentId === 'user');
      expect(wakesForUser).toHaveLength(0);
    });

    it('Code ＋ ouvre une session vide sans rien envoyer ; le premier message la lance et la titre', async () => {
      const row = await instance();
      const prompts = fake.calls.filter((c) => c.path.endsWith('/prompt_async')).length;
      const task = await startDirectSession({ instanceId: row.id, directory: '/home/dev/opendots', instruction: '' });
      expect(task).toMatchObject({ agentId: 'user', requestedBy: 'user', provider: 'opencode', status: 'completed', instruction: '', title: 'Nouvelle session' });
      expect(fake.sessions.has(task.external!.sessionId)).toBe(true);
      expect(fake.calls.filter((c) => c.path.endsWith('/prompt_async')).length).toBe(prompts);
      await sendInstruction(task.id, 'Corrige le test du parseur.');
      const after = (await getTask(task.id))!;
      expect(after).toMatchObject({ status: 'running', title: 'Corrige le test du parseur.', instruction: 'Corrige le test du parseur.' });
      expect(fake.calls.filter((c) => c.path.endsWith('/prompt_async')).at(-1)!.body.parts[0].text).toBe('Corrige le test du parseur.');
    });

    it('liste les sessions des machines et ouvre une session lancée dans OpenCode, une seule fois, sans rien lui envoyer', async () => {
      const row = await instance();
      fake.sessions.set('ses_ext', { id: 'ses_ext', title: 'Depuis le terminal', directory: '/home/dev/opendots', time: { created: Date.now() - 60_000, updated: Date.now() } });
      fake.messages.set('ses_ext', [{ info: { id: 'msg_x1', role: 'assistant', time: { created: Date.now(), completed: Date.now() } }, parts: [{ id: 'p', type: 'text', text: 'ok' }] }]);
      const listed = (await allSessions()).find((i) => i.instanceId === row.id)!;
      expect(listed.reachable).toBe(true);
      expect(listed.sessions.find((s) => s.id === 'ses_ext')).toMatchObject({ title: 'Depuis le terminal', taskId: null });
      const prompts = fake.calls.filter((c) => c.path.endsWith('/prompt_async')).length;
      const a = await attachSession({ instanceId: row.id, sessionId: 'ses_ext' });
      const b = await attachSession({ instanceId: row.id, sessionId: 'ses_ext' });
      expect(b.id).toBe(a.id);
      expect(a).toMatchObject({ requestedBy: 'opencode', status: 'completed' });
      expect(fake.calls.filter((c) => c.path.endsWith('/prompt_async')).length).toBe(prompts);
      expect((await allSessions()).find((i) => i.instanceId === row.id)!.sessions.find((s) => s.id === 'ses_ext')!.taskId).toBe(a.id);
      // Continuing it from BotCircle sends to that very session.
      await instructOpencode((await getTask(a.id))!, 'Continue', 'user');
      expect(fake.calls.filter((c) => c.path.endsWith('/prompt_async')).at(-1)!.path).toContain('ses_ext');
    });
  });
});
