import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { tool } from 'ai';
import { z } from 'zod';
let model: any;
let groupId = '';
vi.mock('../src/models/gateway.ts', () => ({ resolveModel: async () => ({ model, providerOptions: {}, label: 'm' }), requireDesktopVision: async () => {} }));
// A connected service with one lazy action, as buildCapabilityTools exposes it.
vi.mock('../src/agents/capability-tools.ts', () => ({ buildCapabilityTools: async () => ({
  info: { connectors: [], skills: [] },
  lazy: { loaded: new Set<string>(), names: new Set(['svc_x_issues']), groups: [{ id: groupId.slice(-8), name: 'GitHub', kind: 'service', status: 'ok', tools: ['svc_x_issues'] }] },
  tools: { svc_x_issues: tool({ description: 'GitHub : lister les issues', inputSchema: z.object({}), execute: async () => ({ ok: true, issues: [] }) }) },
}) }));
import { eq } from 'drizzle-orm';
import { openDatabase, closeDatabase, db, schema } from '../src/db/client.ts';
import { createAgent, mainConversationId } from '../src/agents/repo.ts';
import { runTurn } from '../src/agents/turn.ts';
import { loadMessages } from '../src/conversations/repo.ts';
import { setSetting } from '../src/settings.ts';
import { connectorMentionables, resolveMentions } from '../src/agents/mentions.ts';

beforeAll(async () => { await openDatabase({ memory: true }); await setSetting('engine.turnStepLimit', null); });
afterAll(async () => { await closeDatabase(); });
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };

describe('#46 : @service dans la conversation d’un Circle', () => {
  it('résout les @noms en ids typés (mots entiers, plus long d’abord)', () => {
    const items = [{ name: 'Home', id: 'a' }, { name: 'Home Assistant', id: 'b' }, { name: 'GitHub', id: 'c' }];
    expect(resolveMentions('@Home Assistant allume le salon', items).map((i) => i.id)).toEqual(['b']);
    expect(resolveMentions('mail@github.com et @GitHubX', items)).toEqual([]);
    expect(resolveMentions('(@github) liste mes issues', items).map((i) => i.id)).toEqual(['c']);
  });

  it('un @service connecté et autorisé a ses actions prêtes pour CE message ; sans permission, rien n’est donné', async () => {
    const agent = await createAgent({ name: 'Ari' });
    groupId = 'svc_0123456789abcdef';
    await db().insert(schema.connectors).values({ id: groupId, name: 'GitHub', kind: 'integration', config: { provider: 'github' }, status: 'ok' });
    await db().update(schema.agents).set({ permissions: { ...agent.permissions, connectors: true } }).where(eq(schema.agents.id, agent.id));
    const conv = await mainConversationId(agent.id);
    let active: string[] = [], system = '';
    model = new MockLanguageModelV4({ doStream: async (o: any) => {
      active = (o.tools ?? []).map((t: any) => t.name); system = JSON.stringify(o.prompt.filter((m: any) => m.role === 'system'));
      return { warnings: [], stream: new ReadableStream({ start(c) { for (const p of [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'ok' }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }]) c.enqueue(p); c.close(); } }) } as any;
    } });
    await runTurn(agent.id, conv, { kind: 'user', message: { id: 'msg_m1', role: 'user', parts: [{ type: 'text', text: '@GitHub liste mes issues ouvertes' }], metadata: { mentions: [{ kind: 'connector', id: 'forged', name: 'Forged' }] } as any } }).done;
    expect(active).toContain('svc_x_issues');
    expect(system).toContain('The user called @GitHub for this message');
    const saved = (await loadMessages(conv)).messages.find((m) => m.id === 'msg_m1')!;
    expect(saved.metadata?.mentions).toEqual([{ kind: 'connector', id: groupId, name: 'GitHub' }]);
    // Not saved as loaded for the thread: the next message without @ does not get it.
    await runTurn(agent.id, conv, { kind: 'user', message: { id: 'msg_m2', role: 'user', parts: [{ type: 'text', text: 'merci' }] } }).done;
    expect(active).not.toContain('svc_x_issues');

    // Without the permission, a mention grants nothing.
    await db().update(schema.agents).set({ permissions: { ...agent.permissions, connectors: false } }).where(eq(schema.agents.id, agent.id));
    const row = (await db().select().from(schema.agents).where(eq(schema.agents.id, agent.id)))[0] as any;
    expect((await connectorMentionables(row))[0].status).toBe('permission_missing');
    await runTurn(agent.id, conv, { kind: 'user', message: { id: 'msg_m3', role: 'user', parts: [{ type: 'text', text: '@GitHub liste mes issues' }] } }).done;
    expect(active).not.toContain('svc_x_issues');
    expect(system).toContain('you are not allowed to use it');
  });
});
