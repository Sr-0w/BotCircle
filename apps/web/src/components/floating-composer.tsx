import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Keeps the composer floating over the conversation: the messages scroll under its glass. Its real height is shared
 * with the scroll area as `--composer-h` (on the parent), so the last message can always be read above it.
 */
export function FloatingComposer({ children, className }: { children: ReactNode; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current, host = el?.parentElement;
    if (!el || !host) return;
    const set = () => host.style.setProperty('--composer-h', `${el.offsetHeight}px`);
    set();
    const observer = new ResizeObserver(set);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return <div ref={box} data-floating-composer className={cn('pointer-events-none absolute inset-x-0 bottom-0 z-10 [&>*]:pointer-events-auto', className)}>{children}</div>;
}
