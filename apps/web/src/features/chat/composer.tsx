import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowUpIcon, AtSignIcon, FileIcon, LoaderIcon, PaperclipIcon, PlusIcon, SquareIcon, XIcon } from 'lucide-react';
import { DotAvatar } from '../dot-avatar';
import { ARTIFACT_MAX_BYTES, IMAGE_MAX_BYTES } from '@opendots/shared';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

const MAX_FILES = 10;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const isChatImage = (file: File) => IMAGE_TYPES.includes(file.type) || (file.type === '' && /\.(png|jpe?g|webp|gif)$/i.test(file.name));
export function formatBytes(size: number) { return size < 1024 ? `${size} o` : size < 1024 * 1024 ? `${Math.round(size / 1024)} Ko` : `${(size / 1024 / 1024).toFixed(1)} Mo`; }

type DraftFile = { id: string; file: File; preview: string | null };
export type MentionTarget = { id: string; name: string; color?: string; description?: string };

/**
 * File picker, drag-and-drop and paste share one draft. Images keep their preview; any other file is listed
 * with its name and size and sent unchanged. `mentions` enables @companion completion.
 */
export function Composer({ onSubmit, onStop, busy, placeholder, autoFocus, reply, onClearReply, mentions, tools, onCommand }: {
  onSubmit: (text: string, files: File[]) => void | Promise<void>;
  onStop: () => void; busy: boolean; placeholder: string; autoFocus?: boolean;
  /** The conversation's own controls (model, effort, web…), under the text. */
  tools?: ReactNode;
  /** Handles a typed command (`/clear`…); returns true when it was one. */
  onCommand?: (text: string) => boolean;
  reply?: { preview: string } | null;
  onClearReply?: () => void;
  mentions?: MentionTarget[];
}) {
  const [value, setValue] = useState(''), [files, setFiles] = useState<DraftFile[]>([]), [uploading, setUploading] = useState(false), [error, setError] = useState(''), [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null), picker = useRef<HTMLInputElement>(null), draft = useRef<DraftFile[]>([]), submitting = useRef(false);
  useEffect(() => { const el = ref.current; if (el) { el.style.height = '0px'; el.style.height = `${Math.min(el.scrollHeight, 220)}px`; } }, [value]);
  useEffect(() => { if (autoFocus && window.matchMedia('(pointer: fine)').matches) ref.current?.focus(); }, [autoFocus]);
  useEffect(() => () => { for (const item of draft.current) if (item.preview) URL.revokeObjectURL(item.preview); }, []);
  function replace(next: DraftFile[]) { draft.current = next; setFiles(next); }
  function add(incoming: File[]) {
    if (submitting.current) return;
    let warning = ''; const next = [...draft.current];
    for (const file of incoming) {
      if (next.length >= MAX_FILES) { warning = t('Tu peux joindre jusqu’à {n} fichiers par message.', { n: MAX_FILES }); break; }
      const image = isChatImage(file);
      if (!file.size) { warning = t('Ce fichier est vide.'); continue; }
      if (image && file.size > IMAGE_MAX_BYTES) { warning = t('Chaque image doit faire moins de 10 Mo.'); continue; }
      if (!image && file.size > ARTIFACT_MAX_BYTES) { warning = t('Chaque fichier doit faire moins de {n} Mo.', { n: Math.round(ARTIFACT_MAX_BYTES / 1024 / 1024) }); continue; }
      next.push({ id: crypto.randomUUID(), file, preview: image ? URL.createObjectURL(file) : null });
    }
    replace(next); setError(warning);
    if (window.matchMedia('(pointer: fine)').matches) ref.current?.focus();
  }
  function remove(id: string) { const old = draft.current.find((item) => item.id === id); if (old?.preview) URL.revokeObjectURL(old.preview); replace(draft.current.filter((item) => item.id !== id)); }
  async function submit() {
    const text = value.trim();
    if ((!text && !draft.current.length) || submitting.current) return;
    // A command typed by the user (e.g. /clear) only opens its own confirmation; it is never sent as a message.
    if (!draft.current.length && onCommand?.(text)) { setValue(''); return; }
    submitting.current = true; setUploading(true); setError('');
    try {
      await onSubmit(text, draft.current.map((item) => item.file));
      for (const item of draft.current) if (item.preview) URL.revokeObjectURL(item.preview);
      replace([]); setValue('');
    } catch (error) { setError(error instanceof Error ? error.message : t('Impossible de joindre les fichiers. Réessaie.')); } // the draft is kept
    finally { submitting.current = false; setUploading(false); }
  }

  // @mention completion: the word being typed at the caret, if it starts with "@".
  const [caret, setCaret] = useState(0);
  const mention = useMemo(() => {
    if (!mentions?.length) return null;
    const match = /(^|\s)@([\p{L}\p{N}_-]*)$/u.exec(value.slice(0, caret));
    if (!match) return null;
    const query = match[2].toLowerCase();
    const options = mentions.filter((m) => m.name.toLowerCase().startsWith(query)).slice(0, 6);
    return options.length ? { start: caret - match[2].length - 1, options } : null;
  }, [value, caret, mentions]);
  function pick(name: string) {
    if (!mention) return;
    const next = `${value.slice(0, mention.start)}@${name} ${value.slice(caret)}`;
    setValue(next);
    pendingCaret.current = mention.start + name.length + 2;
  }
  // Le curseur est replacé dans le même rendu que le texte : une frappe rapide ne s'insère pas au mauvais endroit.
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const position = pendingCaret.current;
    if (position === null) return;
    pendingCaret.current = null;
    ref.current?.focus(); ref.current?.setSelectionRange(position, position); setCaret(position);
  }, [value]);

  return <form
    onSubmit={(event) => { event.preventDefault(); void submit(); }}
    onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true); } }}
    onDragLeave={() => setDragging(false)}
    onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); add(Array.from(event.dataTransfer.files)); } setDragging(false); }}
    className={cn('quiet-glass relative flex w-full flex-col gap-2 rounded-3xl border p-2 shadow-sm transition-shadow', 'focus-within:border-ring/60 focus-within:shadow-md', dragging && 'border-ring ring-2 ring-ring/30')}>
    <input ref={picker} type="file" multiple className="hidden" aria-label={t('Choisir des fichiers')} onChange={(event) => { add(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
    {mention && <div role="listbox" aria-label={t('Compagnons')} className="absolute bottom-full left-3 mb-2 w-64 overflow-hidden rounded-xl border bg-popover p-1 shadow-md">{mention.options.map((option) => <button key={option.id} type="button" role="option" aria-selected={false} onMouseDown={(event) => { event.preventDefault(); pick(option.name); }} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent">{option.color && <DotAvatar color={option.color} size={18} />}<span className="min-w-0"><span className="block font-medium">@{option.name}</span>{option.description && <span className="block truncate text-muted-foreground text-xs">{option.description}</span>}</span></button>)}</div>}
    {reply && <div className="flex items-start gap-2 px-3 pt-2 text-xs"><div className="min-w-0 flex-1 border-l-2 border-foreground/30 pl-2"><p className="font-medium">{t('En réponse à')}</p><p className="truncate text-muted-foreground">{reply.preview || t('Message')}</p></div><Button type="button" size="icon-xs" variant="ghost" aria-label={t('Annuler la réponse')} onClick={onClearReply}><XIcon /></Button></div>}
    {files.length > 0 && <div className="flex flex-wrap gap-2 px-2 pt-2" aria-label={t('Fichiers joints')}>{files.map((item) => <div key={item.id} className="relative">
      {item.preview
        ? <a href={item.preview} target="_blank" rel="noreferrer"><img src={item.preview} alt={item.file.name} className="size-20 rounded-xl border object-cover" /></a>
        : <div className="flex h-20 w-44 items-center gap-2 rounded-xl border bg-background px-3"><FileIcon className="size-5 shrink-0 text-muted-foreground" /><div className="min-w-0"><p className="truncate font-medium text-xs">{item.file.name}</p><p className="text-[11px] text-muted-foreground">{formatBytes(item.file.size)}</p></div></div>}
      <Button type="button" size="icon" variant="secondary" disabled={uploading} className="absolute -top-1.5 -right-1.5 size-6 rounded-full" aria-label={t('Retirer {name}', { name: item.file.name })} onClick={() => remove(item.id)}><XIcon className="size-3" /></Button>
    </div>)}</div>}
    {error && <p role="alert" className="px-3 text-xs text-destructive">{error}</p>}
    <div className="flex items-end gap-2">
      {/* "+" holds the less frequent actions: attach files, ask a companion (no separate @ button). */}
      {mentions?.length ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button type="button" size="icon" variant="ghost" className="size-9 shrink-0 rounded-full" disabled={uploading} aria-label={t('Ajouter')}><PlusIcon /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top">
            <DropdownMenuItem disabled={files.length >= MAX_FILES} onSelect={() => picker.current?.click()}><PaperclipIcon />{t('Joindre des fichiers')}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => { const next = value && !/\s$/.test(value) ? `${value} @` : `${value}@`; setValue(next); pendingCaret.current = next.length; window.setTimeout(() => ref.current?.focus(), 0); }}><AtSignIcon />{t('Demander à un compagnon')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : <Button type="button" size="icon" variant="ghost" className="size-9 shrink-0 rounded-full" disabled={uploading || files.length >= MAX_FILES} onClick={() => picker.current?.click()} aria-label={t('Joindre des fichiers')}><PlusIcon /></Button>}
      <textarea ref={ref} rows={1} value={value} disabled={uploading} maxLength={50_000}
        onChange={(event) => { setValue(event.target.value); setCaret(event.target.selectionStart ?? event.target.value.length); }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
        onPaste={(event) => {
          const pasted = Array.from(event.clipboardData.items).filter((item) => item.kind === 'file').map((item) => item.getAsFile()).filter((file): file is File => file !== null);
          if (pasted.length) { event.preventDefault(); add(pasted); }
        }}
        onKeyDown={(event) => {
          if (mention && (event.key === 'Tab' || event.key === 'Enter') && !event.shiftKey) { event.preventDefault(); pick(mention.options[0].name); return; }
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
        }}
        placeholder={placeholder} aria-label={placeholder} className="max-h-[220px] min-h-9 flex-1 resize-none bg-transparent py-2 text-[15px] leading-relaxed outline-none placeholder:text-muted-foreground" />
      {busy && <Button type="button" size="icon" variant="secondary" className="size-9 rounded-full" onClick={onStop} aria-label={t('Arrêter')}><SquareIcon className="size-3.5 fill-current" /></Button>}
      <Button type="submit" size="icon" className="size-9 shrink-0 rounded-full" disabled={uploading || (!value.trim() && !files.length)} aria-label={t('Envoyer')}>{uploading ? <LoaderIcon className="animate-spin" /> : <ArrowUpIcon />}</Button>
    </div>
    {tools && <div className="-mt-1 flex items-center pl-10">{tools}</div>}
  </form>;
}
