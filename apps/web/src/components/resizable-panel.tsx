import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const panels = {
  navigation: { initial: 288, min: 216, max: 480, reserve: 480, label: 'Navigation' },
  circle: { initial: 340, min: 284, max: 560, reserve: 340, label: 'Panneau du Circle' },
  chat: { initial: 340, min: 312, max: 520, reserve: 340, label: 'Panneau du chat' },
  code: { initial: 640, min: 312, max: 880, reserve: 340, label: 'Espace de code' },
  settings: { initial: 208, min: 176, max: 320, reserve: 480, label: 'Rubriques des paramètres' },
  team: { initial: 288, min: 172, max: 440, reserve: 300, label: 'Échanges de l’équipe' },
};
type Panel = keyof typeof panels;
const key = (id: Panel) => 'bc-panel-width-' + id;
function preference(id: Panel) {
  try {
    const value = Number(localStorage.getItem(key(id)));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch { return null; }
}

export function ResizablePanel({ panel, className, children }: { panel: Panel; className?: string; children: ReactNode }) {
  const config = panels[panel];
  const right = panel === 'circle' || panel === 'chat' || panel === 'code';
  const medium = panel === 'navigation' || panel === 'team';
  const element = useRef<HTMLElement>(null);
  const contentId = useId();
  const [available, setAvailable] = useState(window.innerWidth);
  const [saved, setSaved] = useState(() => preference(panel));
  const [preview, setPreview] = useState<number | null>(null);
  const cancelDrag = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    setSaved(preference(panel));
    const layout = element.current!.parentElement!.closest<HTMLElement>('[data-panel-layout]')!;
    const measure = () => { if (layout.clientWidth) setAvailable(layout.clientWidth); };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(layout);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); cancelDrag.current?.(); };
  }, [panel]);

  // Leave enough room for nested settings, team navigation and the conversation at each breakpoint.
  const cap = panel === 'navigation' ? available * 0.36 : config.max;
  const max = Math.max(1, Math.floor(Math.min(config.max, cap, available - config.reserve)));
  const min = Math.min(config.min, max);
  const clamp = (value: number) => Math.max(min, Math.min(max, Math.round(value)));
  const initial = panel === 'code' ? Math.min(config.initial, window.innerWidth * 0.46) : config.initial;
  const width = clamp(preview ?? saved ?? initial);
  function commit(value: number | null) {
    setSaved(value);
    try {
      if (value === null) localStorage.removeItem(key(panel));
      else localStorage.setItem(key(panel), String(value));
    } catch { /* The pane remains adjustable when browser storage is disabled. */ }
  }

  function start(event: ReactPointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || event.button !== 0) return;
    cancelDrag.current?.();
    const handle = event.currentTarget;
    const pointer = event.pointerId;
    const origin = event.clientX;
    const startWidth = element.current!.getBoundingClientRect().width;
    const position = (x: number) => clamp(startWidth + (x - origin) * (right ? -1 : 1));
    handle.focus({ preventScroll: true });
    event.preventDefault();
    try { handle.setPointerCapture(pointer); } catch { /* Window listeners also work without capture. */ }
    const controller = new AbortController();
    const options = { signal: controller.signal };
    let frame = 0;
    let x = origin;
    const stop = () => {
      controller.abort();
      cancelAnimationFrame(frame);
      if (handle.hasPointerCapture?.(pointer)) handle.releasePointerCapture(pointer);
      document.documentElement.classList.remove('resizing-panel');
      setPreview(null);
      cancelDrag.current = null;
    };
    cancelDrag.current = stop;
    document.documentElement.classList.add('resizing-panel');
    setPreview(startWidth);
    window.addEventListener('pointermove', e => {
      if (e.pointerId !== pointer) return;
      x = e.clientX;
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; setPreview(position(x)); });
    }, options);
    window.addEventListener('pointerup', e => {
      if (e.pointerId !== pointer) return;
      if (e.clientX !== origin) commit(position(e.clientX));
      stop();
    }, options);
    window.addEventListener('pointercancel', e => { if (e.pointerId === pointer) stop(); }, options);
    handle.addEventListener('lostpointercapture', stop, options);
    window.addEventListener('resize', stop, options);
    window.addEventListener('blur', stop, options);
  }

  return <aside ref={element} id={contentId} aria-label={t(config.label)} data-panel={panel}
    className={cn('relative shrink-0', medium ? 'md:w-[var(--panel-width)]' : 'lg:w-[var(--panel-width)]', className)}
    style={{ '--panel-width': width + 'px' } as CSSProperties}>
    {children}
    <div role="separator" aria-label={t(config.label)} aria-orientation="vertical" aria-controls={contentId}
      aria-valuemin={min} aria-valuemax={max} aria-valuenow={width} aria-valuetext={width + ' px'}
      className={cn('panel-divider', medium ? 'hidden md:block' : 'hidden lg:block', right ? 'left-0 -translate-x-1/2' : 'right-0 translate-x-1/2')}
      tabIndex={0} data-dragging={preview !== null || undefined} onPointerDown={start} onDoubleClick={() => commit(null)}
      onKeyDown={e => {
        const step = e.shiftKey ? 48 : 12;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') commit(clamp(width + (e.key === 'ArrowRight' ? step : -step) * (right ? -1 : 1)));
        else if (e.key === 'Home') commit(min);
        else if (e.key === 'End') commit(max);
        else if (e.key === 'Enter') commit(null);
        else return;
        e.preventDefault();
        e.stopPropagation();
      }} />
  </aside>;
}
