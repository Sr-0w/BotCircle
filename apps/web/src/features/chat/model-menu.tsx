import { useEffect, useMemo, useState } from 'react';
import { BrainIcon, CheckIcon, EyeIcon, LoaderIcon, SearchIcon, StarIcon, XIcon } from 'lucide-react';
import type { ModelConfig } from '@opendots/shared';
import { toast } from 'sonner';
import { api, type ModelInfo } from '@/lib/api';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type Favorite = { provider: ModelInfo['provider']; model: string };
const PROVIDER_NAMES: Record<string, string> = { openrouter: 'OpenRouter', ollama: 'Ollama', codex: 'ChatGPT / Codex' };

/**
 * The models of every configured provider, searchable, grouped by provider, favourites first. A star keeps a model on
 * top of every picker, on every device (it is an account setting).
 */
export function ModelMenu({ current, onPick, onClose, footer, unavailable }: { current: ModelConfig; onPick: (model: ModelInfo) => void; onClose: () => void; footer?: React.ReactNode;
  /** A reason (shown as a tooltip) makes that model visible but not selectable. */
  unavailable?: (model: ModelInfo) => string | undefined }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.availableModels>> | null>(null);
  const [error, setError] = useState(''), [query, setQuery] = useState('');
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  useEffect(() => { api.availableModels().then((value) => { setData(value); setFavorites(value.favorites); }).catch((e) => setError(e.message)); }, []);
  const isFavorite = (m: ModelInfo) => favorites.some((f) => f.provider === m.provider && f.model === m.id);
  async function toggle(m: ModelInfo) {
    const next = isFavorite(m) ? favorites.filter((f) => !(f.provider === m.provider && f.model === m.id)) : [...favorites, { provider: m.provider, model: m.id }];
    setFavorites(next);
    try { await api.setFavoriteModels(next); } catch (e) { toast.error((e as Error).message); }
  }
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.models ?? []).filter((m) => !q || `${m.name} ${m.id} ${m.provider}`.toLowerCase().includes(q));
  }, [data, query]);
  const groups = useMemo(() => {
    const out: [string, ModelInfo[]][] = [];
    const favs = visible.filter(isFavorite);
    if (favs.length) out.push([t('Favoris'), favs]);
    for (const provider of ['openrouter', 'ollama', 'codex'] as const) {
      const list = visible.filter((m) => m.provider === provider && !isFavorite(m)).slice(0, query ? 200 : 120);
      if (list.length) out.push([PROVIDER_NAMES[provider], list]);
    }
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, favorites, query]);
  return (
    <div className="absolute inset-x-0 bottom-full z-30 mb-2 flex max-h-[min(60vh,32rem)] flex-col overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-lg" data-model-menu onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <SearchIcon className="size-3.5 text-muted-foreground" />
        <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('Chercher un modèle…')} aria-label={t('Chercher un modèle…')} className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
        <button type="button" className="rounded p-1 text-muted-foreground hover:bg-accent" aria-label={t('Fermer')} onClick={onClose}><XIcon className="size-3.5" /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {error && <p className="px-3 py-2 text-destructive text-xs">{error}</p>}
        {!data && !error && <LoaderIcon className="m-3 size-4 animate-spin" />}
        {data && !data.providers.length && <p className="px-3 py-2 text-muted-foreground text-xs">{t('Aucun fournisseur configuré : ajoute-en un dans Paramètres → Fournisseurs.')}</p>}
        {data?.providers.filter((p) => p.error).map((p) => <p key={p.provider} className="px-3 py-1 text-destructive text-xs">{p.name} : {p.error}</p>)}
        {data && data.providers.length > 0 && !visible.length && <p className="px-3 py-2 text-muted-foreground text-xs">{t('Aucun modèle trouvé.')}</p>}
        {groups.map(([title, list]) => (
          <div key={title}>
            <p className="px-3 pt-2 pb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">{title}</p>
            {list.map((m) => {
              const on = current.provider === m.provider && current.model === m.id;
              const fav = isFavorite(m);
              return (
                <div key={`${m.provider}/${m.id}`} className={cn('group/model flex items-center gap-1 pr-2 hover:bg-accent', on && 'bg-accent/60')} data-model-option={`${m.provider}/${m.id}`}>
                  <button type="button" onClick={() => onPick(m)} disabled={!!unavailable?.(m)} title={unavailable?.(m)} className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50">
                    <span className="min-w-0 flex-1 truncate">{m.name || m.id}</span>
                    {title === t('Favoris') && <span className="shrink-0 text-[11px] text-muted-foreground">{PROVIDER_NAMES[m.provider]}</span>}
                    {m.vision && <EyeIcon className="size-3 shrink-0 text-muted-foreground" aria-label={t('Lit les images')} />}
                    {m.reasoning && <BrainIcon className="size-3 shrink-0 text-muted-foreground" aria-label={t('Raisonnement')} />}
                    {on && <CheckIcon className="size-3.5 shrink-0" />}
                  </button>
                  <button type="button" onClick={() => void toggle(m)} aria-pressed={fav} aria-label={fav ? t('Retirer des favoris') : t('Ajouter aux favoris')} title={fav ? t('Retirer des favoris') : t('Ajouter aux favoris')}
                    className={cn('rounded p-1', fav ? 'text-amber-500' : 'text-muted-foreground opacity-0 group-hover/model:opacity-100 focus-visible:opacity-100')}>
                    <StarIcon className={cn('size-3.5', fav && 'fill-current')} />
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {footer && <div className="border-t px-3 py-2">{footer}</div>}
    </div>
  );
}
