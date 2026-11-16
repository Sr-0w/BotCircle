import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { openDatabase, closeDatabase, db, schema } from '../src/db/client.ts';
import { createAgent, mainConversationId } from '../src/agents/repo.ts';
import { cancelTask, createTask, getTask, reportRequest, taskEvents } from '../src/tasks/service.ts';
import { equivalentActiveTask, taskTools } from '../src/tasks/tools.ts';
import { guardComputerControl } from '../src/computer/ownership.ts';

beforeAll(async () => { await openDatabase({ memory: true }); });
afterAll(async () => { await closeDatabase(); });

describe('#61 : un seul exécutant par travail et par ordinateur', () => {
  it('le même travail délégué deux fois rejoint la tâche existante ; des sous-tâches distinctes restent possibles', async () => {
    const agent = await createAgent({ name: 'Ari' });
    const conv = await mainConversationId(agent.id);
    const tools = taskTools({ agent, conversationId: conv, isMain: true, userTurn: true, depth: 0, tz: 'UTC' } as any) as any;
    const first = await tools.task_start.execute({ title: 'Rice XFCE', instruction: 'Rends le bureau XFCE joli : thème sombre, icônes Papirus, police Inter. Ne change pas le fond d’écran.' }, {} as any);
    expect(first.ok).toBe(true);
    // A second spawn of the same work (retry, double delegation) joins it.
    const twin = await tools.task_start.execute({ title: 'Ricing du bureau XFCE', instruction: 'Rends le bureau XFCE joli : thème sombre, icônes Papirus, police Inter. Ne change pas le fond d’écran.' }, {} as any);
    expect(twin.status).toBe('joined_existing');
    expect(twin.taskId).toBe(first.taskId);
    const again = await tools.task_start.execute({ title: 'Rice XFCE', instruction: 'Autre formulation, même travail.' }, {} as any);
    expect(again.taskId).toBe(first.taskId);
    expect((await getTask(first.taskId))?.pendingInstructions.length).toBeGreaterThan(0);
    // A genuinely different piece of work is its own task.
    const other = await tools.task_start.execute({ title: 'Rapport mensuel', instruction: 'Rédige le rapport financier du mois à partir des factures.' }, {} as any);
    expect(other.status).not.toBe('joined_existing');
    expect(other.taskId).not.toBe(first.taskId);
    expect(await equivalentActiveTask(agent.id, 'Autre chose', 'Nettoie la boîte mail')).toBeNull();
  });

  it('pendant qu’une tâche pilote l’ordinateur, la conversation ne peut plus agir dessus, même si la tâche vient de démarrer', async () => {
    const agent = await createAgent({ name: 'Solo' });
    const conv = await mainConversationId(agent.id);
    let ran = 0;
    let inFlight = 0;
    let overlap = false;
    const make = () => ({ shell_exec: { execute: async (_i?: unknown, _o?: unknown) => { inFlight += 1; if (inFlight > 1) overlap = true; await new Promise((r) => setTimeout(r, 20)); inFlight -= 1; ran += 1; return { ok: true }; } }, computer_screenshot: { execute: async (_i?: unknown, _o?: unknown) => ({ ok: true, shot: 1 }) } });
    const conversation = make();
    guardComputerControl(conversation as any, agent.id, {});
    expect((await conversation.shell_exec.execute({}, {})).ok).toBe(true);

    const task = await createTask({ agentId: agent.id, conversationId: conv, title: 'Bureau', instruction: 'Configure le bureau.', requestedBy: 'agent' });
    await db().update(schema.tasks).set({ status: 'running' }).where(eq(schema.tasks.id, task.id));
    const refused = await conversation.shell_exec.execute({}, {}) as any;
    expect(refused).toMatchObject({ ok: false, status: 'computer_owned_by_task', taskId: task.id });
    // Watching stays possible.
    expect((await conversation.computer_screenshot.execute({}, {})).ok).toBe(true);

    // The task itself acts, one command at a time.
    const worker = make();
    guardComputerControl(worker as any, agent.id, { taskId: task.id });
    const other = make();
    guardComputerControl(other as any, agent.id, { taskId: task.id });
    await Promise.all([worker.shell_exec.execute({}, {}), other.shell_exec.execute({}, {})]);
    expect(overlap).toBe(false);
    expect(ran).toBe(3);

    await db().update(schema.tasks).set({ status: 'completed' }).where(eq(schema.tasks.id, task.id));
    expect((await conversation.shell_exec.execute({}, {})).ok).toBe(true);
  });

  it('fencing : un worker dont la tâche n’est plus en cours n’agit plus sur l’ordinateur', async () => {
    const agent = await createAgent({ name: 'Fence' });
    const task = await createTask({ agentId: agent.id, conversationId: await mainConversationId(agent.id), title: 'Bureau', instruction: 'x', requestedBy: 'agent' });
    let ran = 0;
    const worker = { shell_exec: { execute: async (_i?: unknown, _o?: unknown) => { ran += 1; return { ok: true }; } } };
    guardComputerControl(worker as any, agent.id, { taskId: task.id });
    await db().update(schema.tasks).set({ status: 'running' }).where(eq(schema.tasks.id, task.id));
    expect((await worker.shell_exec.execute({}, {})).ok).toBe(true);
    await db().update(schema.tasks).set({ status: 'cancelled' }).where(eq(schema.tasks.id, task.id));
    expect(await worker.shell_exec.execute({}, {})).toMatchObject({ ok: false, status: 'task_not_running' });
    expect(ran).toBe(1);
  });

  it('les sous-tâches d’une même demande sont rapportées ensemble, une seule fois', async () => {
    const agent = await createAgent({ name: 'Coord' });
    const conv = await mainConversationId(agent.id);
    const tools = taskTools({ agent, conversationId: conv, isMain: true, userTurn: true, depth: 0, tz: 'UTC', requestId: 'msg_req1' } as any) as any;
    const a = await tools.task_start.execute({ title: 'Thème sombre', instruction: 'Installe et applique un thème GTK sombre.' }, {} as any);
    const b = await tools.task_start.execute({ title: 'Polices', instruction: 'Installe JetBrains Mono et Inter, règle les polices du système.' }, {} as any);
    expect(a.taskId).not.toBe(b.taskId);
    expect((await getTask(a.taskId))!.requestId).toBe('msg_req1');
    await db().update(schema.tasks).set({ status: 'completed', result: 'Arc-Dark appliqué.' }).where(eq(schema.tasks.id, a.taskId));
    expect(await reportRequest((await getTask(a.taskId))!)).toBe(true);
    const wakes = async () => (await db().select().from(schema.jobs).where(eq(schema.jobs.type, 'agent.wake'))).filter((j) => (j.payload as any).agentId === agent.id);
    expect(await wakes()).toHaveLength(0);
    expect((await taskEvents(a.taskId, 5)).some((e) => e.summary.includes('Résultat gardé'))).toBe(true);
    // The last one ends (cancelled here): one wake with every real outcome.
    await cancelTask(b.taskId);
    const after = await wakes();
    expect(after).toHaveLength(1);
    expect((after[0].payload as any).text).toContain('Arc-Dark appliqué.');
    expect((after[0].payload as any).text).toContain('annulée');
    expect(await reportRequest((await getTask(b.taskId))!)).toBe(true);
    expect(await wakes()).toHaveLength(1);
  });
});
