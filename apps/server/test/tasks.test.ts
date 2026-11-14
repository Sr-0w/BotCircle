import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { tool } from 'ai';
import { z } from 'zod';
let model: any;
let executed = 0;
vi.mock('../src/models/gateway.ts', () => ({ resolveModel: async () => ({ model, providerOptions: {}, label: 'task-fixture' }), requireDesktopVision: async () => {} }));
vi.mock('../src/agents/capability-tools.ts', () => ({ buildCapabilityTools: async () => ({ info: { connectors: [], skills: [] }, lazy: { loaded: new Set(), names: new Set(), groups: [] }, tools: { fixture_read: tool({ inputSchema: z.object({ n: z.number().optional() }), execute: async () => ({ ok: true, value: `result-${++executed}` }) }) } }) }));
import { openDatabase, closeDatabase } from '../src/db/client.ts';
import { createAgent, mainConversationId } from '../src/agents/repo.ts';
import { loadMessages, messageText } from '../src/conversations/repo.ts';
import { runTurn } from '../src/agents/turn.ts';
import { setSetting } from '../src/settings.ts';
import { cancelTask, createTask, failStalledTasks, getTask, listTasks, pauseTask, redact, sendInstruction, taskEvents, TASK_LOOP_REPEATS } from '../src/tasks/service.ts';
import { runTask } from '../src/tasks/runner.ts';
import { taskTools } from '../src/tasks/tools.ts';
import { db, schema } from '../src/db/client.ts';
import { eq } from 'drizzle-orm';
import { buildSystemPrompt } from '../src/agents/prompt.ts';
import { isActionToolPart } from '@opendots/shared';

beforeAll(async () => { await openDatabase({ memory: true }); await setSetting('engine.turnStepLimit', null); });
afterAll(async () => { await closeDatabase(); });
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const reply = (parts: any[], more: boolean) => ({ warnings: [], stream: new ReadableStream({ start(c) { for (const p of [{ type: 'stream-start', warnings: [] }, ...parts, { type: 'finish', finishReason: { unified: more ? 'tool-calls' : 'stop', raw: more ? 'tool_calls' : 'stop' }, usage }]) c.enqueue(p); c.close(); } }) }) as any;
const text = (value: string) => [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: value }, { type: 'text-end', id: 't' }];
const call = (name: string, input: unknown, id: string) => ({ type: 'tool-call', toolCallId: id, toolName: name, input: JSON.stringify(input) });
/** Scripted model: one entry per model step. */
const script = (steps: Array<(options: any) => any>) => { let i = 0; model = new MockLanguageModelV4({ doStream: async (options: any) => steps[Math.min(i++, steps.length - 1)](options) }); };

describe('tâches en arrière-plan', () => {
  it('exécute le travail hors du fil, compte les étapes réelles et poste une seule synthèse', async () => {
    const agent = await createAgent({ name: 'Ari' });
    const conv = await mainConversationId(agent.id);
    const task = await createTask({ agentId: agent.id, conversationId: conv, title: 'Exploration du bureau', instruction: 'Explore le bureau XFCE.', requestedBy: 'agent' });
    expect((await getTask(task.id))!.status).toBe('running');
    const tools: string[][] = [];
    script([
      (o) => { tools.push(o.tools.map((t: any) => t.name)); return reply([call('fixture_read', { n: 1 }, 'a')], true); },
      () => reply([call('task_report', { phase: 'Paramètres XFCE' }, 'b')], true),
      () => reply([call('fixture_read', { n: 2 }, 'c')], true),
      () => reply(text('Deux écrans explorés, rien à signaler.'), false),
    ]);
    await runTask(task.id);
    const done = (await getTask(task.id))!;
    expect(done.status).toBe('completed');
    expect(done.completedSteps).toBe(2);
    expect(done.phase).toBe('Paramètres XFCE');
    expect(done.result).toBe('Deux écrans explorés, rien à signaler.');
    // Le worker n'a ni text_user ni ask_user : il rapporte de façon structurée.
    expect(tools[0]).toEqual(expect.arrayContaining(['task_report', 'fixture_read']));
    expect(tools[0]).not.toEqual(expect.arrayContaining(['text_user']));
    expect(tools[0]).not.toEqual(expect.arrayContaining(['task_start']));
    // Un seul message dans le fil de l'utilisateur : la synthèse, signée du compagnon et liée à la tâche.
    const visible = (await loadMessages(conv, { limit: 20 })).messages;
    expect(visible).toHaveLength(1);
    expect(visible[0].role).toBe('assistant');
    expect(visible[0].metadata?.taskId).toBe(task.id);
    expect(messageText(visible[0])).toBe('Deux écrans explorés, rien à signaler.');
    // Le journal technique est consultable, hors du fil.
    expect((await taskEvents(task.id)).map((e) => e.kind)).toEqual(expect.arrayContaining(['status', 'step', 'note']));
    expect((await loadMessages(done.workConversationId, { limit: 20 })).messages.length).toBeGreaterThan(1);
  });

  it('laisse le compagnon répondre pendant que le worker travaille, et lui retire le bureau', async () => {
    const agent = await createAgent({ name: 'Disponible' });
    const conv = await mainConversationId(agent.id);
    const task = await createTask({ agentId: agent.id, conversationId: conv, title: 'Longue tâche', instruction: 'Travaille longtemps.', requestedBy: 'agent' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let chatPrompt = '';
    model = new MockLanguageModelV4({ doStream: async (options: any) => {
      const system = JSON.stringify(options.prompt);
      if (system.includes('you are a background worker')) { await gate; return reply(text('Terminé.'), false); }
      chatPrompt = system;
      return reply(text('Le modèle utilisé est task-fixture.'), false);
    } });
    const worker = runTask(task.id);
    const answer = await runTurn(agent.id, conv, { kind: 'user', message: { id: 'msg_meanwhile', role: 'user', parts: [{ type: 'text', text: 'Quel modèle utilises-tu ?' }] } }).done;
    expect(answer.text).toBe('Le modèle utilisé est task-fixture.');
    expect((await getTask(task.id))!.status).toBe('running');
    expect(chatPrompt).toContain('Longue tâche');
    expect(chatPrompt).toContain('task_status');
    release();
    await worker;
    expect((await getTask(task.id))!.status).toBe('completed');
  });

  it('transmet une consigne au worker à son étape suivante', async () => {
    const agent = await createAgent({ name: 'Consigne' });
    const task = await createTask({ agentId: agent.id, conversationId: await mainConversationId(agent.id), title: 'Intégration', instruction: 'Intègre Bitwarden.', requestedBy: 'agent' });
    const seen: string[] = [];
    script([
      async () => { await sendInstruction(task.id, 'Compatible Vaultwarden auto-hébergé.'); return reply([call('fixture_read', { n: 1 }, 'a')], true); },
      (o) => { seen.push(JSON.stringify(o.prompt)); return reply(text('Fait, compatible Vaultwarden.'), false); },
    ]);
    await runTask(task.id);
    expect(seen[0]).toContain('Compatible Vaultwarden auto-hébergé.');
    expect((await getTask(task.id))!.status).toBe('completed');
  });

  it('arrête une boucle et le dit, au lieu de tourner indéfiniment', async () => {
    const agent = await createAgent({ name: 'Boucle' });
    const conv = await mainConversationId(agent.id);
    const task = await createTask({ agentId: agent.id, conversationId: conv, title: 'Boucle', instruction: 'Vérifie.', requestedBy: 'agent' });
    let n = 0;
    model = new MockLanguageModelV4({ doStream: async (options: any) => options.toolChoice?.type === 'none' ? reply(text('Je n’ai pas pu avancer : la lecture renvoie toujours la même chose.'), false) : reply([call('fixture_read', { n: 7 }, `loop-${n++}`)], true) });
    await runTask(task.id);
    const done = (await getTask(task.id))!;
    expect(done.status).toBe('failed');
    expect(done.completedSteps).toBe(TASK_LOOP_REPEATS);
    expect(done.error).toContain('répétée');
    expect(messageText((await loadMessages(conv, { limit: 5 })).messages.at(-1)!)).toContain("n'a pas abouti");
  });

  it('annule proprement et démarre la tâche suivante du même compagnon', async () => {
    const agent = await createAgent({ name: 'Annule' });
    const conv = await mainConversationId(agent.id);
    const first = await createTask({ agentId: agent.id, conversationId: conv, title: 'Première', instruction: 'A', requestedBy: 'agent' });
    const second = await createTask({ agentId: agent.id, conversationId: conv, title: 'Seconde', instruction: 'B', requestedBy: 'agent' });
    // Sérialisées : la seconde attend que la première rende la main (un seul worker sur le bureau).
    expect((await getTask(second.id))!.status).toBe('queued');
    model = new MockLanguageModelV4({ doStream: async (options: any) => { await new Promise<void>((resolve) => options.abortSignal?.addEventListener('abort', () => resolve())); throw new Error('aborted'); } });
    const run = runTask(first.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await cancelTask(first.id);
    await run;
    expect((await getTask(first.id))!.status).toBe('cancelled');
    expect((await getTask(second.id))!.status).toBe('running');
    expect((await loadMessages(conv, { limit: 5 })).messages).toHaveLength(0);
  });

  it('suspend sur une question pour l’utilisateur puis reprend avec sa réponse', async () => {
    const agent = await createAgent({ name: 'Attente' });
    const conv = await mainConversationId(agent.id);
    const task = await createTask({ agentId: agent.id, conversationId: conv, title: 'Choix', instruction: 'Compare.', requestedBy: 'agent' });
    script([
      () => reply([call('task_report', { phase: 'Comparaison', requires_user_input: true, blocker: 'Quelle page garder ?' }, 'a')], true),
      () => reply(text('J’ai besoin de savoir quelle page garder.'), false),
    ]);
    await runTask(task.id);
    const waiting = (await getTask(task.id))!;
    expect(waiting.status).toBe('waiting_for_user');
    expect(waiting.requiresUserInput).toBe(true);
    expect(messageText((await loadMessages(conv, { limit: 5 })).messages.at(-1)!)).toContain('quelle page garder');
    await sendInstruction(task.id, 'Garde la première.');
    expect((await getTask(task.id))!.status).toBe('running');
    const seen: string[] = [];
    script([(o) => { seen.push(JSON.stringify(o.prompt)); return reply(text('Première page gardée.'), false); }]);
    await runTask(task.id);
    expect(seen[0]).toContain('Garde la première.');
    expect((await getTask(task.id))!.status).toBe('completed');
  });

  it('met en pause, déclare en échec une tâche sans signe de vie, et masque les secrets du journal', async () => {
    const agent = await createAgent({ name: 'Pause' });
    const task = await createTask({ agentId: agent.id, conversationId: await mainConversationId(agent.id), title: 'Pause', instruction: 'A', requestedBy: 'agent' });
    expect((await pauseTask(task.id)).status).toBe('paused');
    const stalled = await createTask({ agentId: agent.id, conversationId: await mainConversationId(agent.id), title: 'Figée', instruction: 'B', requestedBy: 'agent' });
    await db().update(schema.tasks).set({ lastHeartbeat: new Date(Date.now() - 3 * 3600_000) }).where(eq(schema.tasks.id, stalled.id));
    expect(await failStalledTasks()).toBe(1);
    expect((await getTask(stalled.id))!.status).toBe('failed');
    expect(redact('curl -H "Authorization: Bearer abcdef123456" token=supersecretvalue sk-abcdefghijklmnop')).not.toMatch(/abcdef123456|supersecretvalue|sk-abcdefghijklmnop/);
  });

  it('le compagnon ne rapporte que l’état observé, et la délégation laisse une carte dans le fil', async () => {
    const agent = await createAgent({ name: 'Statut' });
    const conv = await mainConversationId(agent.id);
    const tools: any = taskTools({ agent, conversationId: conv, isMain: true, userTurn: true, depth: 0, tz: 'UTC' } as any);
    const started = await tools.task_start.execute({ title: 'Recherche', instruction: 'Cherche X.' }, { toolCallId: 't', messages: [] });
    expect(started).toMatchObject({ ok: true, status: 'running', title: 'Recherche' });
    expect(isActionToolPart({ type: 'tool-task_start', state: 'output-available', output: started })).toBe(true);
    const status = await tools.task_status.execute({}, { toolCallId: 't', messages: [] });
    expect(status).toMatchObject({ ok: true, taskId: started.taskId, status: 'running', completedSteps: 0, totalSteps: null });
    expect((await listTasks({ agentId: agent.id, active: true })).length).toBe(1);
    const other = await createAgent({ name: 'Intrus' });
    const foreign: any = taskTools({ agent: other, conversationId: await mainConversationId(other.id), isMain: true, userTurn: true, depth: 0, tz: 'UTC' } as any);
    expect((await foreign.task_cancel.execute({ task_id: started.taskId }, { toolCallId: 't', messages: [] })).ok).toBe(false);
    const prompt = buildSystemPrompt({ agent, team: [agent], memories: [], activities: [], pendingApprovals: [], tz: 'UTC', now: new Date(), toolNames: ['task_start'], mode: { kind: 'user' }, tasks: [{ id: started.taskId, title: 'Recherche', status: 'running', phase: null, currentAction: null, completedSteps: 0, blocker: null }] } as any);
    expect(prompt).toContain('never invent a percentage');
    expect(prompt).toContain('owns your desktop');
  });
});
