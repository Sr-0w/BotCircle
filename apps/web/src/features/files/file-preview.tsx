import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDownIcon, ChevronUpIcon, CopyIcon, DownloadIcon, LoaderIcon, Maximize2Icon, Minimize2Icon, MinusIcon, PlusIcon, SearchIcon, XIcon } from 'lucide-react';
import type { PresentedFile } from '@opendots/shared';
import { toast } from 'sonner';
import { MessageResponse } from '@/components/ai-elements/message';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { formatBytes } from '../chat/composer';
import { FileTypeIcon } from './file-icon';
import { codeLanguage, fileKindLabel, previewKind } from './file-kind';

/** Text previews stop here: longer files are shown truncated, the download keeps everything. */
const TEXT_LIMIT = 2 * 1024 * 1024;

/**
 * Read-only preview of a file of the conversation, in the page: code with syntax highlighting, Markdown rendered or
 * as source, images with zoom, PDF pages. Nothing received is executed: code and Markdown are rendered as text,
 * SVG only as an image, PDF without scripts.
 */
export function FilePreviewDialog({ file, onClose }: { file: PresentedFile; onClose: () => void }) {
  const kind = previewKind(file.filename, file.mediaType);
  const [full, setFull] = useState(false);
  const [data, setData] = useState<{ text?: string; truncated?: boolean; buffer?: ArrayBuffer; blobUrl?: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true, made: string | null = null;
    (async () => {
      const response = await fetch(file.url, { headers: { 'x-opendots-client': '1' } });
      if (!response.ok) throw new Error(response.status === 404 ? t('Ce fichier n’est plus disponible.') : response.status === 403 ? t('Tu n’as pas accès à ce fichier.') : t('Aperçu impossible ({v0}).', { v0: response.status }));
      const blob = await response.blob();
      if (kind === 'image') { made = URL.createObjectURL(file.mediaType === 'image/svg+xml' || file.filename.endsWith('.svg') ? new Blob([blob], { type: 'image/svg+xml' }) : blob); return { blobUrl: made }; }
      if (kind === 'pdf') return { buffer: await blob.arrayBuffer() };
      const truncated = blob.size > TEXT_LIMIT;
      return { text: await (truncated ? blob.slice(0, TEXT_LIMIT) : blob).text(), truncated };
    })().then((value) => active && setData(value)).catch((e) => active && setError((e as Error).message));
    return () => { active = false; if (made) URL.revokeObjectURL(made); };
  }, [file.url, file.filename, file.mediaType, kind]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton={false} className={cn('flex flex-col gap-0 overflow-hidden p-0', full ? 'h-[100dvh] max-h-none w-screen max-w-none rounded-none sm:max-w-none' : 'h-[85vh] sm:max-w-4xl')} data-file-preview={kind ?? 'none'}>
        <div className="flex shrink-0 items-center gap-3 border-b px-3 py-2.5">
          <FileTypeIcon name={file.filename} mediaType={file.mediaType} />
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate font-medium text-sm">{file.filename}</DialogTitle>
            <DialogDescription className="truncate text-xs">{[fileKindLabel(file.filename, file.mediaType), file.size != null ? formatBytes(file.size) : null].filter(Boolean).join(' · ')}</DialogDescription>
          </div>
          <Button asChild size="icon" variant="ghost" className="size-8 rounded-full"><a href={`${file.url}?download=1`} download={file.filename} aria-label={t('Télécharger')} title={t('Télécharger')}><DownloadIcon /></a></Button>
          <Button size="icon" variant="ghost" className="size-8 rounded-full" aria-label={full ? t('Réduire') : t('Plein écran')} onClick={() => setFull(!full)}>{full ? <Minimize2Icon /> : <Maximize2Icon />}</Button>
          <Button size="icon" variant="ghost" className="size-8 rounded-full" aria-label={t('Fermer')} onClick={onClose}><XIcon /></Button>
        </div>
        <div className="relative min-h-0 flex-1">
          {error ? <p className="p-6 text-destructive text-sm">{error}</p>
            : !data ? <div className="flex h-full items-center justify-center"><LoaderIcon className="animate-spin text-muted-foreground" /></div>
            : kind === 'image' ? <ImageView src={data.blobUrl!} alt={file.filename} />
            : kind === 'pdf' ? <PdfView buffer={data.buffer!} />
            : kind === 'markdown' ? <MarkdownView text={data.text!} truncated={data.truncated} name={file.filename} />
            : <CodeView text={data.text!} truncated={data.truncated} lang={codeLanguage(file.filename) ?? 'text'} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Truncated() {
  return <p className="border-b bg-muted/60 px-4 py-1.5 text-muted-foreground text-xs">{t('Fichier long : seuls les 2 premiers Mo sont affichés. Télécharge-le pour tout voir.')}</p>;
}

/** Code and text: highlighted by Shiki (escaped text only), line numbers, search, copy. */
function CodeView({ text, truncated, lang }: { text: string; truncated?: boolean; lang: string }) {
  const [tokens, setTokens] = useState<{ content: string; htmlStyle?: Record<string, string> }[][] | null>(null);
  const [query, setQuery] = useState(''), [index, setIndex] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  // The same Shiki engine as the conversation's code blocks; tokens are rendered as text, never as HTML.
  useEffect(() => {
    let active = true;
    setTokens(null);
    // Very long files are shown plain: highlighting them would freeze the page.
    if (text.length > 400_000) return;
    import('@streamdown/code').then(({ code }) => {
      if (!code.supportsLanguage(lang as never)) return;
      const done = (result: { tokens: typeof tokens }) => active && setTokens(result.tokens);
      const ready = code.highlight({ code: text, language: lang as never, themes: ['github-light', 'github-dark'] }, done as never);
      if (ready) done(ready as never);
    }).catch(() => {});
    return () => { active = false; };
  }, [text, lang]);
  const lines = useMemo(() => text.split('\n'), [text]);
  const matches = useMemo(() => { const q = query.trim().toLowerCase(); return q ? lines.flatMap((line, i) => (line.toLowerCase().includes(q) ? [i] : [])) : []; }, [lines, query]);
  useEffect(() => {
    const root = box.current; if (!root) return;
    root.querySelectorAll('.line[data-hit]').forEach((el) => el.removeAttribute('data-hit'));
    const rows = root.querySelectorAll<HTMLElement>('.line');
    for (const i of matches) rows[i]?.setAttribute('data-hit', i === matches[index] ? 'current' : 'yes');
    // Scroll only the code, never the dialog around it.
    const target = rows[matches[index]];
    if (target) root.scrollTop = Math.max(0, target.offsetTop - root.clientHeight / 2);
  }, [matches, index, tokens]);
  return (
    <div className="flex h-full flex-col">
      {truncated && <Truncated />}
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <SearchIcon className="size-3.5 text-muted-foreground" />
        <input value={query} onChange={(e) => { setQuery(e.target.value); setIndex(0); }} onKeyDown={(e) => { if (e.key === 'Enter' && matches.length) setIndex((index + (e.shiftKey ? matches.length - 1 : 1)) % matches.length); }} placeholder={t('Rechercher dans le fichier')} aria-label={t('Rechercher dans le fichier')} className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
        {query && <span className="text-muted-foreground text-xs tabular-nums">{matches.length ? `${index + 1}/${matches.length}` : t('Aucun résultat')}</span>}
        <Button size="icon" variant="ghost" className="size-7" disabled={!matches.length} aria-label={t('Précédent')} onClick={() => setIndex((index + matches.length - 1) % matches.length)}><ChevronUpIcon /></Button>
        <Button size="icon" variant="ghost" className="size-7" disabled={!matches.length} aria-label={t('Suivant')} onClick={() => setIndex((index + 1) % matches.length)}><ChevronDownIcon /></Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => void navigator.clipboard.writeText(text).then(() => toast.success(t('Copié')))}><CopyIcon /> {t('Copier')}</Button>
      </div>
      <div ref={box} className="code-preview relative min-h-0 flex-1 overflow-auto text-[12.5px] leading-relaxed" data-code-preview={tokens ? 'highlighted' : 'plain'}>
        <pre className="shiki"><code>{tokens
          ? tokens.map((line, i) => <span key={i} className="line">{line.map((token, j) => <span key={j} style={token.htmlStyle as React.CSSProperties}>{token.content}</span>)}{'\n'}</span>)
          : lines.map((line, i) => <span key={i} className="line">{line}{'\n'}</span>)}</code></pre>
      </div>
    </div>
  );
}

function MarkdownView({ text, truncated, name }: { text: string; truncated?: boolean; name: string }) {
  const [tab, setTab] = useState<'rendered' | 'source'>('rendered');
  return (
    <div className="flex h-full flex-col">
      {truncated && <Truncated />}
      <div className="flex shrink-0 gap-1 border-b px-3 py-1.5" role="tablist">
        {(['rendered', 'source'] as const).map((value) => <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)} className={cn('rounded-full px-3 py-1 text-xs', tab === value ? 'bg-secondary font-medium' : 'text-muted-foreground hover:text-foreground')}>{t(value === 'rendered' ? 'Rendu' : 'Source')}</button>)}
      </div>
      <div className="min-h-0 flex-1">
        {tab === 'rendered' ? <div className="h-full overflow-auto px-6 py-4 text-sm"><MessageResponse>{text}</MessageResponse></div> : <CodeView text={text} lang={codeLanguage(name) ?? 'markdown'} />}
      </div>
    </div>
  );
}

/** Images: fit by default; zoom with the buttons or Ctrl + wheel, drag to move. */
function ImageView({ src, alt }: { src: string; alt: string }) {
  const [zoom, setZoom] = useState(1), [size, setSize] = useState<[number, number] | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 }); const drag = useRef<{ x: number; y: number } | null>(null);
  const set = (value: number) => { const next = Math.min(8, Math.max(0.25, value)); setZoom(next); if (next <= 1) setOffset({ x: 0, y: 0 }); };
  return (
    <div className="relative flex h-full flex-col">
      <div className="relative min-h-0 flex-1 overflow-hidden bg-[repeating-conic-gradient(var(--color-muted)_0_25%,transparent_0_50%)] bg-[length:16px_16px]"
        onWheel={(e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); set(zoom * (e.deltaY < 0 ? 1.15 : 0.87)); } }}
        onPointerDown={(e) => { if (zoom > 1) { drag.current = { x: e.clientX - offset.x, y: e.clientY - offset.y }; e.currentTarget.setPointerCapture(e.pointerId); } }}
        onPointerMove={(e) => { if (drag.current) setOffset({ x: e.clientX - drag.current.x, y: e.clientY - drag.current.y }); }}
        onPointerUp={() => { drag.current = null; }}>
        <img src={src} alt={alt} draggable={false} onLoad={(e) => setSize([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight])} data-image-preview
          className={cn('absolute inset-0 m-auto max-h-full max-w-full select-none object-contain', zoom > 1 && 'cursor-grab')} style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }} />
      </div>
      <div className="flex shrink-0 items-center justify-center gap-2 border-t px-3 py-1.5 text-muted-foreground text-xs">
        <Button size="icon" variant="ghost" className="size-7" aria-label={t('Dézoomer')} onClick={() => set(zoom / 1.25)}><MinusIcon /></Button>
        <button type="button" className="w-12 tabular-nums" onClick={() => set(1)}>{Math.round(zoom * 100)} %</button>
        <Button size="icon" variant="ghost" className="size-7" aria-label={t('Zoomer')} onClick={() => set(zoom * 1.25)}><PlusIcon /></Button>
        {size && <span className="ml-2 tabular-nums">{size[0]} × {size[1]}</span>}
      </div>
    </div>
  );
}

/** PDF pages drawn by PDF.js (no scripting sandbox is loaded, XFA forms off), with zoom, page count and text search. */
function PdfView({ buffer }: { buffer: ArrayBuffer }) {
  const [doc, setDoc] = useState<import('pdfjs-dist').PDFDocumentProxy | null>(null);
  const [error, setError] = useState(''), [scale, setScale] = useState(1.2), [page, setPage] = useState(1);
  const [query, setQuery] = useState(''), [hits, setHits] = useState<number[] | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true, loaded: import('pdfjs-dist').PDFDocumentProxy | null = null;
    (async () => {
      const pdfjs = await import('pdfjs-dist');
      pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
      loaded = await pdfjs.getDocument({ data: buffer.slice(0), enableXfa: false }).promise;
      if (active) setDoc(loaded);
    })().catch((e) => active && setError(t('PDF illisible : {v0}', { v0: (e as Error).message })));
    return () => { active = false; void loaded?.loadingTask.destroy(); };
  }, [buffer]);
  async function search() {
    const q = query.trim().toLowerCase();
    if (!doc || !q) { setHits(null); return; }
    const found: number[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      if (content.items.map((item) => ('str' in item ? item.str : '')).join(' ').toLowerCase().includes(q)) found.push(n);
    }
    setHits(found);
    const target = found.length ? box.current?.querySelector<HTMLElement>(`[data-pdf-page="${found[0]}"]`) : null;
    if (target && box.current) box.current.scrollTop = target.offsetTop - 12;
  }
  if (error) return <p className="p-6 text-destructive text-sm">{error}</p>;
  if (!doc) return <div className="flex h-full items-center justify-center"><LoaderIcon className="animate-spin text-muted-foreground" /></div>;
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-muted-foreground text-xs">
        <span className="tabular-nums" data-pdf-pages={doc.numPages}>{t('Page {v0} / {v1}', { v0: page, v1: doc.numPages })}</span>
        <Button size="icon" variant="ghost" className="size-7" aria-label={t('Dézoomer')} onClick={() => setScale(Math.max(0.5, scale / 1.2))}><MinusIcon /></Button>
        <span className="w-10 text-center tabular-nums">{Math.round(scale * 100 / 1.2)} %</span>
        <Button size="icon" variant="ghost" className="size-7" aria-label={t('Zoomer')} onClick={() => setScale(Math.min(4, scale * 1.2))}><PlusIcon /></Button>
        <span className="flex-1" />
        <SearchIcon className="size-3.5" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void search()} placeholder={t('Rechercher')} aria-label={t('Rechercher dans le PDF')} className="w-40 bg-transparent text-foreground text-sm outline-none" />
        {hits && <span>{hits.length ? t('Pages : {v0}', { v0: hits.slice(0, 8).join(', ') }) : t('Aucun résultat')}</span>}
      </div>
      <div ref={box} className="relative min-h-0 flex-1 space-y-3 overflow-auto bg-muted/50 p-3"
        onScroll={(e) => { const top = e.currentTarget.scrollTop; let current = 1; e.currentTarget.querySelectorAll<HTMLElement>('[data-pdf-page]').forEach((el) => { if (el.offsetTop - 40 <= top) current = Number(el.dataset.pdfPage); }); setPage(current); }}>
        {Array.from({ length: doc.numPages }, (_, i) => <PdfPage key={i} doc={doc} number={i + 1} scale={scale} highlight={Boolean(hits?.includes(i + 1))} />)}
      </div>
    </div>
  );
}

function PdfPage({ doc, number, scale, highlight }: { doc: import('pdfjs-dist').PDFDocumentProxy; number: number; scale: number; highlight: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null), [visible, setVisible] = useState(number <= 2), [ratio, setRatio] = useState(1.414);
  const holder = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = holder.current; if (!el) return;
    const observer = new IntersectionObserver(([entry]) => entry.isIntersecting && setVisible(true), { rootMargin: '600px' });
    observer.observe(el); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let task: { cancel: () => void } | null = null, active = true;
    doc.getPage(number).then((p) => {
      if (!active || !canvas.current) return;
      const viewport = p.getViewport({ scale: scale * (window.devicePixelRatio || 1) });
      setRatio(viewport.height / viewport.width);
      canvas.current.width = viewport.width; canvas.current.height = viewport.height;
      const render = p.render({ canvas: canvas.current, viewport }); task = render; return render.promise;
    }).catch(() => {});
    return () => { active = false; task?.cancel(); };
  }, [doc, number, scale, visible]);
  const width = Math.round(595 * scale);
  return (
    <div ref={holder} data-pdf-page={number} className={cn('mx-auto bg-white shadow-sm', highlight && 'ring-2 ring-primary')} style={{ width, maxWidth: '100%', aspectRatio: `1 / ${ratio}` }}>
      <canvas ref={canvas} className="h-full w-full" aria-label={t('Page {v0}', { v0: number })} />
    </div>
  );
}
