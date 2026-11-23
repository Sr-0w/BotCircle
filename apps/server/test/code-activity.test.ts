import { afterAll, beforeAll, expect, it } from 'vitest';
import type { TaskDTO } from '@opendots/shared';
import { canonicalCodeTasks, codeStatus } from '../../web/src/features/code/code-activity-state.ts';
import { db, schema, openDatabase, closeDatabase } from '../src/db/client.ts';
import { taskRoutes } from '../src/tasks/routes.ts';

const task = (data: Partial<TaskDTO> = {}): TaskDTO => ({
  id: 'task_1', provider: 'opencode', conversationId: 'circle-chat',
  status: 'running', createdAt: '2026-11-01T00:00:00Z',
  external: { instanceId: 'machine', instanceName: 'OpenCode', sessionId: 'session', directory: null },
  ...data,
} as TaskDTO);

beforeAll(async () => { await openDatabase({ memory: true }); });
afterAll(closeDatabase);

it('uses the latest canonical record for each session and distinguishes machines and chat ownership', () => {
  const first = task();
  const old = task({ id: 'task_old', status: 'completed', conversationId: 'older-chat', createdAt: '2026-10-01T00:00:00Z' });
  const otherMachine = task({ id: 'task_2', external: { ...first.external!, instanceId: 'machine2' } });
  const worker = task({ id: 'worker', provider: 'worker' });
  expect(canonicalCodeTasks([first, old, otherMachine, worker])).toEqual([first, otherMachine]);
  expect(canonicalCodeTasks([first, old]).filter((row) => row.conversationId === 'older-chat')).toHaveLength(0);
});

it('distinguishes observed work from reconnecting, unreachable, waiting and finished states', () => {
  const running = task();
  expect(codeStatus(running, true)).toBe('running');
  expect(codeStatus(running, false)).toBe('disconnected');
  expect(codeStatus(task({ external: { ...running.external!, unreachable: true } }), true)).toBe('disconnected');
  expect(codeStatus(task({ status: 'waiting_for_user', phase: 'Action requise' }), true)).toBe('attention');
  expect(codeStatus(task({ status: 'waiting_for_user' }), true)).toBe('waiting_for_user');
  expect(codeStatus(task({ status: 'paused' }), true)).toBe('paused');
  expect(codeStatus(task({ status: 'cancelled' }), false)).toBe('cancelled');
});

it('keeps older active Code sessions in registry snapshots without crossing the conversation filter', async () => {
  const rows: (typeof schema.tasks.$inferInsert)[] = Array.from({ length: 51 }, (_, index) => ({
    id: 'worker_' + index, agentId: 'agent', conversationId: 'circle-chat', workConversationId: 'wc_' + index,
    title: 'Worker ' + index, instruction: 'Fixture', status: 'completed', createdAt: new Date(2000 + index),
  }));
  await db().insert(schema.tasks).values([
    ...rows,
    { ...rows[0], id: 'code_old', workConversationId: 'wc_code', status: 'running', provider: 'opencode', external: task().external, createdAt: new Date(1000) },
  ]);
  const api = taskRoutes();
  const snapshot = await (await api.request('/')).json() as TaskDTO[];
  expect(snapshot).toHaveLength(51);
  expect(snapshot).toContainEqual(expect.objectContaining({ id: 'code_old', status: 'running' }));
  expect(await (await api.request('/?conversationId=other-chat')).json()).toEqual([]);
});
