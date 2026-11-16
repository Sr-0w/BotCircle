import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, ExternalLinkIcon, XIcon } from 'lucide-react';
import { toast } from 'sonner';
import { t } from '@/lib/i18n';

/**
 * #60: chat photos open in this in-app lightbox, never by navigating away. Wheel / pinch / double click to zoom, drag
 * to move, arrows or ← → for the thread's other photos, Esc or a click on the backdrop to close. Download and
 * "open in a new tab" are explicit actions.
 */
type Photo = { url: string; name: string };
const listeners = new Set<(photos: Photo[], index: number) => void>();

/** Opens the lightbox at `url`, with every chat photo currently on screen as its gallery. */
export function openImage(url: string, name?: string | null) {
  const nodes = [...document.querySelectorAll<HTMLImageElement>('img[data-chat-image]')];
  const photos = nodes.map((img) => ({ url: img.dataset.chatImage!, name: img.alt })).filter((p, i, all) => all.findIndex((q) => q.url === p.url) === i);
  let index = photos.findIndex((p) => p.url === url);
  if (index < 0) { photos.push({ url, name: name ?? t('Image jointe') }); index = photos.length - 1; }
  listeners.forEach((open) => open(photos, index));
}

/** Click handler for an image link: in-app viewer, unless the user explicitly asked for a new tab (Ctrl/⌘/middle click). */
export function imageClick(url: string, name?: string | null) {
  return (event: React.MouseEvent) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    openImage(url, name);
  };
}

export function ImageLightbox() {
  const [state, setState] = useState<{ photos: Photo[]; index: number } | null>(null);
  const [scale, setScale] = useState(1), [offset, setOffset] = useState({ x: 0, y: 0 }), [failed, setFailed] = useState(false);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<Element | null>(null);
  // Images inside a message's Markdown (an agent's inline picture) open here too, not in a new page.
  useEffect(() => {
    const click = (e: MouseEvent) => {
      const img = (e.target as Element | null)?.closest?.('img');
      if (!img || img.hasAttribute('data-chat-image') || img.closest('[data-image-lightbox]') || !img.closest('[data-bubble]')) return;
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault(); openImage(img.currentSrc || img.src, img.alt);
    };
    document.addEventListener('click', click, true);
    return () => document.removeEventListener('click', click, true);
  }, []);
  useEffect(() => { const open = (photos: Photo[], index: number) => { returnFocus.current = document.activeElement; setState({ photos, index }); }; listeners.add(open); return () => { listeners.delete(open); }; }, []);
  const reset = () => { setScale(1); setOffset({ x: 0, y: 0 }); setFailed(false); };
  const close = useCallback(() => { setState(null); reset(); (returnFocus.current as HTMLElement | null)?.focus?.(); }, []);
  const go = useCallback((delta: number) => setState((s) => (s && s.photos.length > 1 ? { ...s, index: (s.index + delta + s.photos.length) % s.photos.length } : s)), []);
  useEffect(() => { reset(); }, [state?.index]);
  useEffect(() => {
    if (!state) return;
    closeRef.current?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); else if (e.key === 'ArrowLeft') go(-1); else if (e.key === 'ArrowRight') go(1); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [state, close, go]);
  if (!state) return null;
  const photo = state.photos[state.index];
  const zoom = (factor: number) => setScale((s) => { const next = Math.min(6, Math.max(1, s * factor)); if (next === 1) setOffset({ x: 0, y: 0 }); return next; });
  async function download() {
    try {
      const blob = await (await fetch(photo.url, { credentials: 'include' })).blob();
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: photo.name || 'image' });
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch { toast.error(t('Téléchargement impossible')); }
  }
  const button = 'flex size-9 items-center justify-center rounded-full text-white/85 hover:bg-white/15 hover:text-white focus-visible:outline-2 focus-visible:outline-white';
  return (
    <div role="dialog" aria-modal="true" aria-label={photo.name} className="fixed inset-0 z-[100] flex flex-col bg-black" data-image-lightbox onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="flex items-center gap-2 px-3 py-2 text-white">
        <button ref={closeRef} type="button" className={button} onClick={close} aria-label={t('Fermer')}><XIcon className="size-5" /></button>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-sm">{photo.name}</p>
          {state.photos.length > 1 && <p className="text-white/60 text-xs" data-lightbox-position>{state.index + 1} / {state.photos.length}</p>}
        </div>
        <button type="button" className={button} onClick={() => void download()} aria-label={t('Télécharger')} title={t('Télécharger')}><DownloadIcon className="size-4" /></button>
        <a className={button} href={photo.url} target="_blank" rel="noreferrer" aria-label={t('Ouvrir dans un nouvel onglet')} title={t('Ouvrir dans un nouvel onglet')}><ExternalLinkIcon className="size-4" /></a>
      </div>
      <div
        className="relative flex min-h-0 flex-1 touch-none select-none items-center justify-center overflow-hidden"
        onClick={(e) => { if (e.target === e.currentTarget) close(); }}
        onWheel={(e) => zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15)}
        onPointerDown={(e) => { if (scale > 1) { drag.current = { x: e.clientX - offset.x, y: e.clientY - offset.y }; (e.target as Element).setPointerCapture?.(e.pointerId); } }}
        onPointerMove={(e) => { if (drag.current) setOffset({ x: e.clientX - drag.current.x, y: e.clientY - drag.current.y }); }}
        onPointerUp={() => { drag.current = null; }}
      >
        {failed ? (
          <div className="text-center text-sm text-white/80" data-lightbox-error>
            <p>{t('Image indisponible')}</p>
            <button type="button" className="mt-2 rounded-full bg-white/15 px-3 py-1.5 text-xs hover:bg-white/25" onClick={() => setFailed(false)}>{t('Réessayer')}</button>
          </div>
        ) : (
          <img key={photo.url} src={photo.url} alt={photo.name} draggable={false} onError={() => setFailed(true)}
            onDoubleClick={() => (scale > 1 ? (setScale(1), setOffset({ x: 0, y: 0 })) : setScale(2.5))}
            className="max-h-full max-w-full object-contain transition-transform duration-75" style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`, cursor: scale > 1 ? 'grab' : 'zoom-in' }} data-lightbox-image />
        )}
        {state.photos.length > 1 && <>
          <button type="button" className={`${button} absolute left-3`} onClick={() => go(-1)} aria-label={t('Image précédente')}><ChevronLeftIcon className="size-5" /></button>
          <button type="button" className={`${button} absolute right-3`} onClick={() => go(1)} aria-label={t('Image suivante')}><ChevronRightIcon className="size-5" /></button>
        </>}
      </div>
    </div>
  );
}
