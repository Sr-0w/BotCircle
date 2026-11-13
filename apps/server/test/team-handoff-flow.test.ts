import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { eq } from 'drizzle-orm';
import { createAgent, getAgent, mainConversationId } from '../src/agents/repo.ts';
import { createApi } from '../src/api/routes.ts';
import { loadMessages } from '../src/conversations/repo.ts';
import { closeDatabase, db, openDatabase, schema } from '../src/db/client.ts';
import { startQueue, stopQueue } from '../src/jobs/queue.ts';
import { registerLifeHandlers } from '../src/life/engine.ts';
import { sendTeamMessage, getTeamMessage } from '../src/team/service.ts';

let model: MockLanguageModelV4;
vi.mock('../src/models/gateway.ts', () => ({
  resolveModel: async () => ({ model, providerOptions: {}, label: 'team-handoff-fixture' }),
  requireDesktopVision: async () => {},
}));

beforeAll(async () => {
  await openDatabase({ memory: true });
  registerLifeHandlers();
});
afterAll(async () => {
  await stopQueue();
  await closeDatabase();
});

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const call = (toolName: string, toolCallId: string, input: object) => ({ type: 'tool-call' as const, toolCallId, toolName, input: JSON.stringify(input) });
const say = (delta: string) => [{ type: 'text-start' as const, id: 'text' }, { type: 'text-delta' as const, id: 'text', delta }, { type: 'text-end' as const, id: 'text' }];
function reply(parts: ReturnType<typeof call>[] | ReturnType<typeof say>) {
  const more = parts.some((part) => part.type === 'tool-call');
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        for (const part of parts) controller.enqueue(part);
        controller.enqueue({ type: 'finish', finishReason: { unified: more ? 'tool-calls' : 'stop', raw: more ? 'tool_calls' : 'stop' }, usage });
        controller.close();
      },
    }),
  };
}

it('attend chaque décision, puis reprend le fil d’origine et renvoie un seul résultat au bon relais', async () => {
  const sender = await createAgent({ name: 'Ari', permissions: { createAgents: 'allow' } });
  const receiver = await createAgent({ name: 'Dev', permissions: { createAgents: 'allow' } });
  const senderMain = await mainConversationId(sender.id);
  const receiverMain = await mainConversationId(receiver.id);
  const prompts: string[] = [];
  const toolsByCall: string[][] = [];
  const ask = { title: 'Quel délai ?', questions: [{ id: 'd', label: 'Délai', type: 'text', required: true }] };
  const sequence = [
    [
      call('agent_update_profile', 'self-approval', { color: '#113355' }),
      call('agent_update_profile', 'peer-approval', { target: sender.id, color: '#335577' }),
    ],
    say('Deux changements attendent ta décision.'),
    say('Le premier changement est fait.'),
    [call('ask_user', 'question', ask)],
    say('Profil configuré. Échéance vendredi.'),
    say('Merci, résultat reçu.'),
  ];
  model = new MockLanguageModelV4({ doStream: async (options) => {
    prompts.push(JSON.stringify(options.prompt));
    toolsByCall.push((options.tools ?? []).map((tool) => tool.name));
    const parts = sequence[prompts.length - 1];
    if (!parts) throw new Error('Tour inattendu');
    return reply(parts);
  } });
  const message = await sendTeamMessage({
    fromAgentId: sender.id, toAgentId: receiver.id, content: 'Prépare nos profils et demande l’échéance.',
    expectsReply: true, replyToConversationId: senderMain, depth: 4,
  });
  await startQueue();
  const status = async () => (await getTeamMessage(message.id))?.status;
  const wakes = async (agentId: string) => (await db().select().from(schema.jobs).where(eq(schema.jobs.agentId, agentId))).filter((job) => job.type === 'agent.wake');
  await expect.poll(status, { timeout: 5000 }).toBe('waiting_for_user');
  for (const name of ['agent_create', 'avatar_propose', 'agent_update_instructions', 'agent_update_permissions', 'agent_configure_model', 'skill_save', 'approval_respond']) {
    expect(toolsByCall[0]).not.toContain(name);
  }
  expect(toolsByCall[0]).toContain('agent_update_profile');
  expect(await wakes(sender.id)).toHaveLength(0);

  const api = createApi();
  const post = (path: string, body: object) => api.request(path, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-opendots-client': '1' }, body: JSON.stringify(body),
  });
  const approvals = await db().select().from(schema.approvals).where(eq(schema.approvals.agentId, receiver.id));
  const self = approvals.find((approval) => approval.toolCallId === 'self-approval')!;
  const peer = approvals.find((approval) => approval.toolCallId === 'peer-approval')!;
  expect((await post(`/approvals/${self.id}`, { decision: 'approve' })).status).toBe(200);
  await expect.poll(async () => (await wakes(receiver.id)).find((job) => job.dedupeKey?.startsWith('handoff:'))?.status, { timeout: 5000 }).toBe('done');
  expect(await status()).toBe('waiting_for_user');
  expect(await wakes(sender.id)).toHaveLength(0);
  expect((await getAgent(receiver.id))?.color).toBe('#113355');
  expect(prompts[2]).toContain('a approuvé');

  expect((await post(`/approvals/${peer.id}`, { decision: 'reject' })).status).toBe(200);
  const requests = () => db().select().from(schema.userRequests).where(eq(schema.userRequests.agentId, receiver.id));
  await expect.poll(async () => (await requests())[0]?.status, { timeout: 5000 }).toBe('pending');
  const [question] = await requests();
  expect(question.conversationId).toBe(receiverMain);
  expect(prompts[3]).toContain('a refusé');
  expect((await getAgent(sender.id))?.color).toBe(sender.color);
  expect(await wakes(sender.id)).toHaveLength(0);

  const response = await post(`/agents/${receiver.id}/chat`, {
    message: {
      id: 'deadline-answer', role: 'user', parts: [{ type: 'text', text: 'Vendredi' }],
      metadata: { answer: { requestId: question.id, answers: { d: 'Vendredi' } } },
    },
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('Je reprends la tâche');
  await expect.poll(async () => (await wakes(sender.id))[0]?.status, { timeout: 5000 }).toBe('done');
  expect(await status()).toBe('answered');
  expect(await wakes(sender.id)).toMatchObject([{ payload: { depth: 5, conversationId: senderMain } }]);
  expect(await wakes(receiver.id)).toMatchObject([
    { payload: { depth: 4, teamResume: { teamMessageId: message.id }, conversationId: message.conversationId } },
    { payload: { depth: 4, teamResume: { teamMessageId: message.id }, conversationId: message.conversationId } },
    { payload: { depth: 4, teamResume: { teamMessageId: message.id }, conversationId: message.conversationId } },
  ]);
  expect(prompts[4]).toContain('Vendredi');
  expect(prompts[5]).toContain('Profil configuré. Échéance vendredi.');
  expect(toolsByCall[5]).not.toContain('agent_create');
  expect((await loadMessages(receiverMain)).messages).toContainEqual(expect.objectContaining({
    role: 'assistant', parts: [{ type: 'text', text: 'Profil configuré. Échéance vendredi.' }],
    metadata: expect.objectContaining({ replyTo: expect.objectContaining({ messageId: `msg_rcv_${message.id}` }) }),
  }));
});
