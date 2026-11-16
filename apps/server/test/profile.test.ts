import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
let model: any;
vi.mock('../src/models/gateway.ts', () => ({ resolveModel: async (cfg: any) => ({ model, providerOptions: {}, label: cfg?.model ?? 'm' }), requireDesktopVision: async () => {}, checkModel: async () => ({ ok: true }) }));
vi.mock('../src/agents/capability-tools.ts', () => ({ buildCapabilityTools: async () => ({ info: { connectors: [], skills: [] }, lazy: { loaded: new Set(), names: new Set(), groups: [] }, tools: {} }) }));
import { openDatabase, closeDatabase } from '../src/db/client.ts';
import { createAgent, mainConversationId } from '../src/agents/repo.ts';
import { runTurn } from '../src/agents/turn.ts';
import { setSetting } from '../src/settings.ts';
import { createChat } from '../src/chats/repo.ts';
import { runChatTurn } from '../src/chats/turn.ts';
import { getUserProfile, setUserProfile } from '../src/profile.ts';

beforeAll(async () => { await openDatabase({ memory: true }); await setSetting('engine.turnStepLimit', null); await setSetting('models.default', { provider: 'openrouter', model: 'm' }); });
afterAll(async () => { await closeDatabase(); });
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
let system = '';
const capture = () => new MockLanguageModelV4({ doStream: async (o: any) => {
  system = JSON.stringify(o.prompt.filter((m: any) => m.role === 'system'));
  return { warnings: [], stream: new ReadableStream({ start(c) { for (const p of [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'ok' }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }]) c.enqueue(p); c.close(); } }) } as any;
} });
let n = 0;
const say = (agentId: string, conv: string) => runTurn(agentId, conv, { kind: 'user', message: { id: `msg_p${++n}`, role: 'user', parts: [{ type: 'text', text: 'Salut' }] } }).done;

describe('#54 : le nom de l’utilisateur', () => {
  it('sans nom : les agents n’en devinent aucun', async () => {
    expect(await getUserProfile()).toEqual({ firstName: null, lastName: null });
    const agent = await createAgent({ name: 'Ari' });
    model = capture();
    await say(agent.id, await mainConversationId(agent.id));
    expect(system).toContain('has not given their name');
  });

  it('nom enregistré, nettoyé, puis lu par les Circles et les chats à leur exécution suivante ; effacé, il disparaît', async () => {
    expect(await setUserProfile({ firstName: '  Robin  ', lastName: '<b>Doe</b>' })).toEqual({ firstName: 'Robin', lastName: 'Doe' });
    const agent = await createAgent({ name: 'Venty' });
    model = capture();
    await say(agent.id, await mainConversationId(agent.id));
    expect(system).toContain('Call them by their first name, Robin');
    const chat = await createChat();
    await runChatTurn(chat.id, { id: 'msg_c1', role: 'user', parts: [{ type: 'text', text: 'Salut' }] }).done;
    expect(system).toContain('first name, Robin');
    await setUserProfile({ firstName: 'Sam', lastName: '' });
    await say(agent.id, await mainConversationId(agent.id));
    expect(system).toContain('first name, Sam');
    expect(system).not.toContain('Robin');
    await setUserProfile({ firstName: null, lastName: null });
    await say(agent.id, await mainConversationId(agent.id));
    expect(system).toContain('has not given their name');
  });
});
