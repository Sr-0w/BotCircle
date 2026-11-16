import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { openDatabase, closeDatabase, db, schema } from '../src/db/client.ts';
import { createAgent, mainConversationId } from '../src/agents/repo.ts';
import { createTask, getTask } from '../src/tasks/service.ts';
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
});
