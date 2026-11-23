import { useEffect, useRef, useState } from 'react';
import { OpencodeLogo } from '@/components/brand/opencode-logo';
import './code-motion.css';

let observer: IntersectionObserver | undefined;
const listeners = new WeakMap<Element, (visible: boolean) => void>();

function observe(el: HTMLElement, listener: (visible: boolean) => void) {
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) listeners.get(entry.target)?.(entry.isIntersecting);
  });
  listeners.set(el, listener);
  observer.observe(el);
  return () => { observer?.unobserve(el); listeners.delete(el); };
}

/** The wrapper has no moving layout. Offscreen or background rows have no animation. */
export function CodeMotion({ running, size = 16 }: { running: boolean; size?: 16 | 20 }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [animating, setAnimating] = useState(false);
  useEffect(() => {
    if (!running || !ref.current) { setAnimating(false); return; }
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    let intersecting = false;
    const update = () => setAnimating(intersecting && !document.hidden && !preference.matches);
    const stop = observe(ref.current, (visible) => { intersecting = visible; update(); });
    document.addEventListener('visibilitychange', update);
    preference.addEventListener('change', update);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', update);
      preference.removeEventListener('change', update);
    };
  }, [running]);

  return (
    <span ref={ref} className="inline-flex shrink-0" data-code-motion={running && animating ? 'on' : 'off'}>
      <OpencodeLogo size={size} />
    </span>
  );
}

export function CodeActivityDots() {
  return <span className="code-activity-dots" aria-hidden="true"><i /><i /><i /></span>;
}
