import { useEffect, useRef, useState } from 'react';
import { CheckIcon, XIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';

/** #69: longest session title (same bound as the server). */
export const TITLE_MAX = 200;

/** Collapses whitespace like the server; empty and over-long titles are refused before any request. */
export function cleanTitle(value: string): { title: string; error: string | null } {
  const title = value.replace(/\s+/g, ' ').trim();
  if (!title) return { title, error: t('Le nom ne peut pas être vide.') };
  if (title.length > TITLE_MAX) return { title, error: t('Le nom ne peut pas dépasser {v0} caractères.', { v0: TITLE_MAX }) };
  return { title, error: null };
}

/**
 * Inline editor for a Code session's title: pre-filled and selected, Enter validates, Escape cancels. The new title
 * reaches every surface through the `task.changed` event; nothing is sent to the session itself.
 */
export function RenameTitle({ taskId, value, onDone, className }: { taskId: string; value: string; onDone: () => void; className?: string }) {
  const [draft, setDraft] = useState(value), [saving, setSaving] = useState(false), [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);

  async function submit() {
    if (saving) return;
    const { title, error: invalid } = cleanTitle(draft);
    if (invalid) { setError(invalid); return; }
    if (title === value) { onDone(); return; }
    setSaving(true);
    try { await api.renameCodeSession(taskId, title); onDone(); }
    catch (e) { setError((e as Error).message); toast.error((e as Error).message); setSaving(false); }
  }
  return (
    <form className={className ?? 'flex min-w-0 flex-1 items-center gap-1'} data-code-rename onSubmit={(e) => { e.preventDefault(); void submit(); }} onClick={(e) => e.stopPropagation()}>
      <input ref={input} value={draft} disabled={saving} maxLength={TITLE_MAX + 20} aria-label={t('Nom de la session')} aria-invalid={Boolean(error)}
        onChange={(e) => { setDraft(e.target.value); setError(null); }}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onDone(); } }}
        className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm outline-none focus:border-ring aria-[invalid=true]:border-destructive" />
      <Button type="submit" size="icon-xs" variant="ghost" disabled={saving} aria-label={t('Valider')} title={t('Valider')}><CheckIcon /></Button>
      <Button type="button" size="icon-xs" variant="ghost" disabled={saving} aria-label={t('Annuler')} title={t('Annuler')} onClick={onDone}><XIcon /></Button>
      {error && <span role="alert" className="sr-only">{error}</span>}
    </form>
  );
}
