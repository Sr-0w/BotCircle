import { lazy, Suspense } from 'react';
import type { OrbState } from 'thinking-orbs';

// Thinking Orbs (MIT, Jakub Antalík, https://github.com/Jakubantalik/thinking-orbs): canvas 2D, pauses off screen,
// follows the theme and reduced motion. Loaded on demand.
const Orb = lazy(() => import('thinking-orbs').then((m) => ({ default: m.ThinkingOrb })));

export type { OrbState };

/** The activity of an AI request, as one quiet animated orb; never decorative, never more than one per request. */
export function ThinkingOrb({ state, size = 20, label }: { state: OrbState; size?: 20 | 32 | 64; label: string }) {
  return (
    <Suspense fallback={<span className="inline-block shrink-0 rounded-full bg-muted" style={{ width: size, height: size }} aria-hidden />}>
      <Orb state={state} size={size} aria-label={label} data-orb={state} />
    </Suspense>
  );
}
