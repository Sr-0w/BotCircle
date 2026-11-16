import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { tool } from 'ai';
import { z } from 'zod';

let model: any;
let releaseTool: () => void = () => {};
let toolStarted: () => void = () => {};
vi.mock('../src/models/gateway.ts', () => ({ resolveModel: async () => ({ model, providerOptions: {}, label: 'background-fixture' }), requireDesktopVision: async () => {} }));
vi.mock('../src/agents/capability-tools.ts', () => ({
  buildCapabilityTools: async () => ({
    info: { connectors: [], skills: [] },
    lazy: { loaded: new Set(), names: new Set(), groups: [] },
    tools: {
      slow_tool: tool({
        inputSchema: z.object({}),
        execute: async () => {
          toolStarted();
          await new Promise<void>((resolve) => { releaseTool = resolve; });
          return { ok: true, value: 'fait' };
        },
      }),
    },
  }),
}));

import { openDatabase, closeDatabase } from '../src/db/client.ts';
import { createAgent, mainConversationId } from '../src/agents/repo.ts';
import { loadMessages, messageText } from '../src/conversations/repo.ts';
import { runTurn } from '../src/agents/turn.ts';
import { setSetting } from '../src/settings.ts';

beforeAll(async () => { await openDatabase({ memory: true }); await setSetting('engine.turnStepLimit', null); });
afterAll(async () => { await closeDatabase(); });

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };

function streamOf(parts: any[]) {
  return { warnings: [], stream: new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); } }) } as any;
}

const prompts: string[] = [];
const text = (id: string, value: string) => [{ type: 'text-start', id }, { type: 'text-delta', id, delta: value }, { type: 'text-end', id }];

it('#55 : un message pendant le travail oriente le même tour, rien ne disparaît et le travail continue', async () => {
  let phase = 'tool';
  const started = new Promise<void>((resolve) => { toolStarted = resolve; });
  let calls = 0;
  model = new MockLanguageModelV4({ doStream: async ({ prompt }: any) => {
    calls += 1;
    prompts.push(JSON.stringify(prompt));
    const step = phase;
    if (step === 'tool') {
      phase = 'after-steer';
      return streamOf([
        { type: 'stream-start', warnings: [] },
        ...text('a', 'Je commence le bureau.'),
        { type: 'tool-call', toolCallId: 'slow', toolName: 'slow_tool', input: '{}' },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
      ]);
    }
    if (step === 'after-steer') {
      phase = 'final';
      // Still the same work: it goes on with a new step instead of ending on the acknowledgement.
      return streamOf([
        { type: 'stream-start', warnings: [] },
        ...text('b', 'Compris, je garde le fond d’écran.'),
        { type: 'tool-call', toolCallId: 'slow2', toolName: 'slow_tool', input: '{}' },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
      ]);
    }
    return streamOf([{ type: 'stream-start', warnings: [] }, ...text('c', 'Bureau terminé, fond d’écran intact.'), { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }]);
  } });

  const agent = await createAgent({ name: 'Ari' });
  const conv = await mainConversationId(agent.id);
  const work = runTurn(agent.id, conv, { kind: 'user', message: { id: 'msg_work', role: 'user', parts: [{ type: 'text', text: 'Rice mon bureau' }] } });
  await started;
  const steer = runTurn(agent.id, conv, { kind: 'user', message: { id: 'msg_steer', role: 'user', parts: [{ type: 'text', text: 'Change pas le fond d’écran' }] } });
  // Same executor: the sender follows the continuation of the running turn, not a second turn.
  expect(steer.done).toBe(work.done);
  const followed = (async () => { const chunks: any[] = []; const reader = steer.stream.readable().getReader(); for (;;) { const { done, value } = await reader.read(); if (done) return chunks; chunks.push(value); } })();
  expect(calls).toBe(1);
  releaseTool();
  for (let n = 0; n < 100 && calls < 2; n++) await new Promise((resolve) => setTimeout(resolve, 10));
  releaseTool();
  const result = await work.done;
  expect(result.error).toBeNull();
  expect(calls).toBe(3);
  // The model saw the first work (with the tool result) and then the steer, in that order.
  const second = prompts[1];
  expect(second.indexOf('fait')).toBeGreaterThan(-1);
  expect(second.indexOf('Change pas le fond')).toBeGreaterThan(second.indexOf('Rice mon bureau'));
  expect(second).toContain('adjusts the work in progress');

  const thread = (await loadMessages(conv)).messages;
  expect(thread.map((m) => [m.role, messageText(m)])).toEqual([
    ['user', 'Rice mon bureau'],
    ['assistant', 'Je commence le bureau.'],
    ['user', 'Change pas le fond d’écran'],
    ['assistant', 'Compris, je garde le fond d’écran.\nBureau terminé, fond d’écran intact.'],
  ]);
  expect(thread[1].parts.some((p: any) => p.type === 'tool-slow_tool' && p.state === 'output-available')).toBe(true);
  const chunks = await followed;
  expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta).join('')).toContain('Bureau terminé');
});

it('#55 : arrêter pendant qu’une consigne attend la garde dans le fil', async () => {
  let phase = 'tool';
  const started = new Promise<void>((resolve) => { toolStarted = resolve; });
  model = new MockLanguageModelV4({ doStream: async () => {
    if (phase === 'tool') {
      phase = 'never';
      return streamOf([{ type: 'stream-start', warnings: [] }, { type: 'tool-call', toolCallId: 'slow', toolName: 'slow_tool', input: '{}' }, { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage }]);
    }
    throw new Error('aucun nouvel appel après un arrêt');
  } });
  const agent = await createAgent({ name: 'Stop' });
  const conv = await mainConversationId(agent.id);
  const work = runTurn(agent.id, conv, { kind: 'user', message: { id: 'msg_w2', role: 'user', parts: [{ type: 'text', text: 'Travaille' }] } });
  await started;
  const steer = runTurn(agent.id, conv, { kind: 'user', message: { id: 'msg_s2', role: 'user', parts: [{ type: 'text', text: 'Ajoute ça aussi' }] } });
  steer.stream.abort.abort();
  releaseTool();
  await work.done;
  const texts = (await loadMessages(conv)).messages.map((m) => messageText(m));
  expect(texts).toContain('Ajoute ça aussi');
  expect(texts).toContain('Travaille');
});
