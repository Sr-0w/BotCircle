import { useEffect, useRef, useState } from 'react';
import { ArchiveIcon, LoaderIcon, MessagesSquareIcon, SearchIcon } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { api, type SearchHit } from '@/lib/api';
import { useStore } from '@/lib/store';
import { openDialog } from '@/lib/dialogs';
import { focusMessage, termsOf } from '@/lib/search-focus';
import { t } from '@/lib/i18n';
import { cn, relativeTime } from '@/lib/utils';
import { DotAvatar } from '../dot-avatar';

const listeners = new Set<(q?: string) => void>();
/** Opens the global search (optionally with a query, e.g. from the chat list's field). */
export function openSearch(q?: string) { listeners.forEach((open) => open(q)); }

/**
 * #58: search every conversation's messages — all, chats only, Circles (or one Circle), archives on request —
 * and open a result at its exact message.
 */
export function SearchDialog() {
  const agents = useStore((s) => s.agents);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState(''), [scope, setScope] = useState<'all' | 'chats' | 'circles'>('all'), [agentId, setAgentId] = useState('');
  const [archived, setArchived] = useState(false), [sort, setSort] = useState<'relevance' | 'recent'>('relevance');
  const [hits, setHits] = useState<SearchHit[] | null>(null), [more, setMore] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { const l = (initial?: string) => { setOpen(true); if (initial !== undefined) setQ(initial); }; listeners.add(l); return () => { listeners.delete(l); }; }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); setOpen(true); } };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, []);
  const params = { q: q.trim(), scope, agentId: scope === 'circles' && agentId ? agentId : null, archived, sort };
  useEffect(() => {
    if (!open) return;
    if (!params.q) { setHits(null); setMore(false); return; }
    let live = true; setLoading(true); setError(null);
    const timer = window.setTimeout(() => void api.search(params).then((r) => { if (live) { setHits(r.hits); setMore(r.more); setActive(0); } })
      .catch((e) => live && setError((e as Error).message)).finally(() => live && setLoading(false)), 250);
    return () => { live = false; window.clearTimeout(timer); };
  }, [open, params.q, scope, params.agentId, archived, sort]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadMore = () => void api.search({ ...params, offset: hits?.length ?? 0 }).then((r) => { setHits((h) => [...(h ?? []), ...r.hits]); setMore(r.more); }).catch((e) => setError((e as Error).message));
  function openHit(hit: SearchHit) {
    const terms = termsOf(q);
    setOpen(false);
    if (hit.kind === 'chat') window.location.hash = `#/chat/${hit.conversationId}`;
    else if (hit.current) window.location.hash = `#agent/${hit.agentId}`;
    else { openDialog({ kind: 'archive', agentId: hit.agentId!, conversationId: hit.conversationId, archivedAt: hit.createdAt, focus: { messageId: hit.messageId, terms } }); return; }
    window.setTimeout(() => focusMessage({ conversationId: hit.conversationId, messageId: hit.messageId, terms }), 50);
  }
  const chip = (on: boolean) => cn('rounded-full border px-2.5 py-1 text-xs', on ? 'border-foreground bg-foreground text-background' : 'hover:bg-accent');
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex max-h-[80vh] max-w-2xl flex-col gap-3 p-4" data-search-dialog>
        <DialogTitle className="sr-only">{t('Rechercher dans les conversations')}</DialogTitle>
        <div className="flex items-center gap-2 rounded-xl border px-3">
          <SearchIcon className="size-4 text-muted-foreground" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Rechercher dans tous les messages… ("phrase exacte")')} aria-label={t('Rechercher dans les conversations')}
            onKeyDown={(e) => {
              if (!hits?.length) return;
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(hits.length - 1, i + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
              else if (e.key === 'Enter') { e.preventDefault(); openHit(hits[active]); }
            }}
            className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none" />
          {loading && <LoaderIcon className="size-4 animate-spin text-muted-foreground" />}
        </div>
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('Portée')}>
          {(['all', 'chats', 'circles'] as const).map((s) => <button key={s} type="button" aria-pressed={scope === s} className={chip(scope === s)} onClick={() => setScope(s)}>{s === 'all' ? t('Tout') : s === 'chats' ? t('Chats') : t('Circles')}</button>)}
          {scope === 'circles' && (
            <select aria-label={t('Circle')} value={agentId} onChange={(e) => setAgentId(e.target.value)} className="h-7 rounded-full border bg-background px-2 text-xs">
              <option value="">{t('Tous les Circles')}</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          )}
          <label className="ml-auto flex items-center gap-1.5 text-xs"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />{t('Inclure les archives')}</label>
          <select aria-label={t('Tri')} value={sort} onChange={(e) => setSort(e.target.value as 'relevance' | 'recent')} className="h-7 rounded-full border bg-background px-2 text-xs">
            <option value="relevance">{t('Pertinence')}</option><option value="recent">{t('Plus récent')}</option>
          </select>
        </div>
        <div ref={list} className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label={t('Résultats')}>
          {error && <p className="p-3 text-destructive text-sm">{error}</p>}
          {!error && hits?.length === 0 && <p className="p-6 text-center text-muted-foreground text-sm">{t('Aucun message ne correspond.')}</p>}
          {!hits && !error && <p className="p-6 text-center text-muted-foreground text-sm">{t('Les mots de tes messages et de ceux des Circles, dans les chats et les fils. Entre guillemets pour une phrase exacte.')}</p>}
          {hits?.map((hit, i) => {
            const agent = agents.find((a) => a.id === hit.agentId);
            return (
              <button key={`${hit.messageId}`} type="button" role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={() => openHit(hit)} data-search-hit={hit.messageId}
                className={cn('flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left', i === active && 'bg-accent')}>
                {hit.kind === 'circle' && agent ? <DotAvatar color={agent.color} shape={agent.avatar} size={28} /> : <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted"><MessagesSquareIcon className="size-3.5 text-muted-foreground" /></span>}
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-sm">
                    <span className="truncate font-medium">{hit.title}</span>
                    <span className="shrink-0 text-muted-foreground text-xs">{hit.kind === 'chat' ? t('Chat') : hit.current ? t('Circle') : t('Ancien fil')}</span>
                    {hit.archived && <ArchiveIcon className="size-3 shrink-0 text-muted-foreground" aria-label={t('Archivé')} />}
                    <span className="ml-auto shrink-0 text-muted-foreground text-xs" title={new Date(hit.createdAt).toLocaleString()}>{relativeTime(hit.createdAt)}</span>
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-muted-foreground text-xs">
                    <span className="mr-1 font-medium">{hit.role === 'user' ? t('Toi') : hit.kind === 'circle' ? hit.title : t('Assistant')} :</span>
                    <Snippet text={hit.snippet} highlights={hit.highlights} />
                  </span>
                </span>
              </button>
            );
          })}
          {more && <button type="button" className="w-full rounded-xl py-2 text-muted-foreground text-xs hover:bg-accent" onClick={loadMore}>{t('Plus de résultats')}</button>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Snippet({ text, highlights }: { text: string; highlights: [number, number][] }) {
  const parts: React.ReactNode[] = []; let at = 0;
  highlights.forEach(([a, b], i) => { if (a < at) return; parts.push(text.slice(at, a)); parts.push(<mark key={i} className="rounded bg-yellow-300/60 px-0.5 text-foreground dark:bg-yellow-500/40">{text.slice(a, b)}</mark>); at = b; });
  parts.push(text.slice(at));
  return <>{parts}</>;
}
