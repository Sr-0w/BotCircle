import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
let model: any;
const resolved: string[] = [];
vi.mock('../src/models/gateway.ts', () => ({
  resolveModel: async (cfg: any) => { resolved.push(`${cfg.provider}:${cfg.model}`); return { model, providerOptions: {}, label: `${cfg.provider}:${cfg.model}` }; },
  requireDesktopVision: async () => {},
  checkModel: async (cfg: any) => (cfg.model === 'missing/model' ? { ok: false, error: 'Modèle OpenRouter « missing/model » introuvable.' } : { ok: true }),
  listOpenRouterModels: async () => [{ id: 'openai/gpt-5', name: 'GPT-5', provider: 'openrouter', tools: true }, { id: 'qwen/qwen3.8-27b', name: 'Qwen 3.8 27B', provider: 'openrouter', tools: true, vision: true }],
  listOllamaModels: async () => [],
}));
vi.mock('../src/agents/capability-tools.ts', () => ({ buildCapabilityTools: async () => ({ info: { connectors: [], skills: [] }, lazy: { loaded: new Set(), names: new Set(), groups: [] }, tools: {} }) }));
import { openDatabase, closeDatabase } from '../src/db/client.ts';
import { createAgent, mainConversationId, updateAgent } from '../src/agents/repo.ts';
import { setOpenRouterKey, setSetting } from '../src/settings.ts';
import { getTask, toTaskDTO } from '../src/tasks/service.ts';
import { runTask } from '../src/tasks/runner.ts';
import { taskTools } from '../src/tasks/tools.ts';

beforeAll(async () => {
  await openDatabase({ memory: true });
  await setSetting('engine.turnStepLimit', null);
  await setSetting('models.default', { provider: 'openrouter', model: 'default/model' });
  await setOpenRouterKey('sk-test');
  await setSetting('models.favorites', [{ provider: 'openrouter', model: 'qwen/qwen3.8-27b' }]);
});
afterAll(async () => { await closeDatabase(); });
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const done = (value: string) => ({ warnings: [], stream: new ReadableStream({ start(c) { for (const p of [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: value }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }]) c.enqueue(p); c.close(); } }) }) as any;

describe('modèle des tâches (#51)', () => {
  const tools = async (name: string) => {
    const agent = await createAgent({ name });
    await updateAgent(agent.id, { model: { provider: 'openrouter', model: 'companion/model' } });
    const conv = await mainConversationId(agent.id);
    return { agent, t: taskTools({ agent: { ...agent, model: { provider: 'openrouter', model: 'companion/model' } }, conversationId: conv } as any) as any };
  };

  it('exécute la tâche avec le modèle demandé et l’affiche comme modèle réellement utilisé', async () => {
    const { t } = await tools('Explicite');
    const out = await t.task_start.execute({ title: 'Analyse', instruction: 'Analyse ce dossier.', model: { provider: 'openrouter', model: 'qwen/qwen3.8-27b' } }, {} as any);
    expect(out.ok).toBe(true);
    expect((await toTaskDTO((await getTask(out.taskId))!)).model).toEqual({ provider: 'openrouter', model: 'qwen/qwen3.8-27b' });
    model = new MockLanguageModelV4({ doStream: async () => done('Fait.') });
    resolved.length = 0;
    await runTask(out.taskId);
    expect(resolved).toEqual(['openrouter:qwen/qwen3.8-27b']);
    expect((await toTaskDTO((await getTask(out.taskId))!)).usedModel).toBe('openrouter:qwen/qwen3.8-27b');
  });

  it('sans modèle explicite : celui du compagnon, montré tel quel', async () => {
    const { t } = await tools('Hérité');
    const out = await t.task_start.execute({ title: 'Tri', instruction: 'Trie les fichiers.' }, {} as any);
    expect((await getTask(out.taskId))!.model).toBeNull();
    model = new MockLanguageModelV4({ doStream: async () => done('Fait.') });
    resolved.length = 0;
    await runTask(out.taskId);
    expect(resolved).toEqual(['openrouter:companion/model']);
    expect((await getTask(out.taskId))!.usedModel).toBe('openrouter:companion/model');
  });

  it('refuse un modèle indisponible sans créer de tâche ni substituer un autre modèle', async () => {
    const { agent, t } = await tools('Refus');
    const out = await t.task_start.execute({ title: 'X', instruction: 'Y', model: { provider: 'openrouter', model: 'missing/model' } }, {} as any);
    expect(out).toMatchObject({ ok: false, status: 'model_unavailable' });
    expect(out.error).toContain('models_available');
    const { listTasks } = await import('../src/tasks/service.ts');
    expect(await listTasks({ agentId: agent.id })).toHaveLength(0);
  });

  it('liste les modèles disponibles, favoris en premier', async () => {
    const { t } = await tools('Catalogue');
    const out = await t.models_available.execute({}, {} as any);
    expect(out.models[0]).toMatchObject({ provider: 'openrouter', model: 'qwen/qwen3.8-27b', favorite: true, vision: true });
    expect((await t.models_available.execute({ query: 'gpt' }, {} as any)).models.map((m: any) => m.model)).toEqual(['openai/gpt-5']);
  });
});
