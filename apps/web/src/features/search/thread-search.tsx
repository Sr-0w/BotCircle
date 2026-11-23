import { useEffect, useRef, useState } from 'react';
import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { focusMessage, highlightTerms, termsOf } from '@/lib/search-focus';
import { t } from '@/lib/i18n';

/** #58: find in the open thread — matches across its whole history, previous / next, position "2 / 5". */
export function ThreadSearchBar({ conversationId, onClose }: { conversationId: string; onClose: () => void }) {
  const [q, setQ] = useState(''), [matches, setMatches] = useState<{ messageId: string }[] | null>(null), [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    const query = q.trim();
    if (!query) { setMatches(null); highlightTerms(null, []); return; }
    let live = true;
    const timer = window.setTimeout(() => void api.searchThread(conversationId, query).then((found) => {
      if (!live) return;
      setMatches(found);
      // Start from the most recent match, like a chat app.
      const last = Math.max(0, found.length - 1); setIndex(last);
      if (found.length) focusMessage({ conversationId, messageId: found[last].messageId, terms: termsOf(query) });
    }).catch(() => live && setMatches([])), 250);
    return () => { live = false; window.clearTimeout(timer); };
  }, [q, conversationId]);
  useEffect(() => () => highlightTerms(null, []), []);
  const go = (delta: number) => {
    if (!matches?.length) return;
    const next = (index + delta + matches.length) % matches.length; setIndex(next);
    focusMessage({ conversationId, messageId: matches[next].messageId, terms: termsOf(q) });
  };
  return (
    <div className="mt-[var(--header-h,0px)] flex items-center gap-1.5 border-b bg-background/95 px-3 py-1.5" role="search" data-thread-search onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } }}>
      <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
      <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Rechercher dans ce fil…')} aria-label={t('Rechercher dans ce fil…')}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); go(e.shiftKey ? 1 : -1); } }}
        className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none" />
      <span className="shrink-0 text-muted-foreground text-xs tabular-nums" aria-live="polite" data-thread-search-position>
        {matches === null ? '' : matches.length ? `${index + 1} / ${matches.length}` : t('Aucun résultat')}
      </span>
      <button type="button" className="rounded-md p-1 text-muted-foreground hover:bg-accent disabled:opacity-40" onClick={() => go(-1)} disabled={!matches?.length} aria-label={t('Résultat précédent')}><ChevronUpIcon className="size-4" /></button>
      <button type="button" className="rounded-md p-1 text-muted-foreground hover:bg-accent disabled:opacity-40" onClick={() => go(1)} disabled={!matches?.length} aria-label={t('Résultat suivant')}><ChevronDownIcon className="size-4" /></button>
      <button type="button" className="rounded-md p-1 text-muted-foreground hover:bg-accent" onClick={onClose} aria-label={t('Fermer la recherche')}><XIcon className="size-4" /></button>
    </div>
  );
}
