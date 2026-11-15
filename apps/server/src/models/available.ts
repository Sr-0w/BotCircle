import type { ModelConfig } from '@opendots/shared';
import { codexAccount, codexModels } from './codex.ts';
import { listOllamaModels, listOpenRouterModels } from './gateway.ts';
import { getOpenRouterKey, getSetting } from '../settings.ts';
import { errorMessage } from '../util.ts';

type Provider = ModelConfig['provider'];
export interface AvailableModel { id: string; name?: string; provider: Provider; tools?: boolean; reasoning?: boolean; vision?: boolean }

/** Every model of the providers that are configured, and the favourites (shown first by every picker). */
export async function availableModels() {
  const [key, ollamaUrl, codex] = await Promise.all([getOpenRouterKey(), getSetting('ollama.url'), codexAccount().catch(() => null)]);
  const sources: { provider: Provider; name: string; load: () => Promise<unknown[]> }[] = [];
  if (key) sources.push({ provider: 'openrouter', name: 'OpenRouter', load: listOpenRouterModels });
  if (ollamaUrl) sources.push({ provider: 'ollama', name: 'Ollama', load: () => listOllamaModels() });
  if (codex) sources.push({ provider: 'codex', name: 'ChatGPT / Codex', load: codexModels });
  const loaded = await Promise.all(sources.map(async (s) => { try { return { ...s, models: await s.load(), error: null }; } catch (error) { return { ...s, models: [] as unknown[], error: errorMessage(error) }; } }));
  return {
    providers: loaded.map((s) => ({ provider: s.provider, name: s.name, count: s.models.length, error: s.error })),
    models: loaded.flatMap((s) => s.models) as AvailableModel[],
    favorites: ((await getSetting('models.favorites')) ?? []) as { provider: Provider; model: string }[],
  };
}

/** What an agent may choose from: favourites first, then the matches of [query] (name or id), with what each model can do. */
export async function searchModels(query?: string, limit = 20) {
  const { models, favorites, providers } = await availableModels();
  const q = query?.trim().toLowerCase();
  const fav = (m: AvailableModel) => favorites.some((f) => f.provider === m.provider && f.model === m.id);
  const matches = models.filter((m) => !q || `${m.name ?? ''} ${m.id}`.toLowerCase().includes(q));
  const ranked = [...matches.filter(fav), ...matches.filter((m) => !fav(m))].slice(0, limit);
  return {
    providers: providers.map((p) => p.name),
    models: ranked.map((m) => ({ provider: m.provider, model: m.id, name: m.name ?? m.id, favorite: fav(m), tools: m.tools ?? null, vision: m.vision ?? null, reasoning: m.reasoning ?? null })),
  };
}
