import { useSyncExternalStore } from "react";
import type { ODMessage } from "./api";

/**
 * Le travail d'un Circle (raisonnement, appels d'outils) ne s'affiche plus
 * dans le fil : la conversation le publie ici et le panneau latéral le lit.
 */
interface WorkState {
  messages: ODMessage[];
  /** Message en cours de diffusion, s'il y en a un. */
  streamingId: string | null;
}

const EMPTY: WorkState = { messages: [], streamingId: null };
const byAgent = new Map<string, WorkState>();
const listeners = new Set<() => void>();

export function publishWork(agentId: string, messages: ODMessage[], streamingId: string | null) {
  const previous = byAgent.get(agentId);
  if (previous && previous.messages === messages && previous.streamingId === streamingId) return;
  byAgent.set(agentId, { messages, streamingId });
  for (const l of listeners) l();
}

export function useWork(agentId: string): WorkState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => byAgent.get(agentId) ?? EMPTY,
  );
}

const PANEL_EVENT = "opendots:work-panel";

/** Ouvre le panneau du compagnon sur l'onglet « Travail ». */
/** Opens the side panel, on its work tab or on another one (`tasks`, `permissions`…, from `/` commands). */
export function openWorkPanel(tab?: string) {
  window.dispatchEvent(new CustomEvent(PANEL_EVENT, { detail: tab }));
}

export function onWorkPanelRequested(fn: (tab?: string) => void) {
  const listener = (event: Event) => fn((event as CustomEvent<string | undefined>).detail);
  window.addEventListener(PANEL_EVENT, listener);
  return () => window.removeEventListener(PANEL_EVENT, listener);
}

const CODE_EVENT = "opendots:code-workspace";

/** Ouvre l'espace de code d'une tâche OpenCode : cette session-là, pas une page d'accueil. */
export function openCodeWorkspace(taskId: string) {
  window.dispatchEvent(new CustomEvent(CODE_EVENT, { detail: taskId }));
}

export function onCodeWorkspaceRequested(fn: (taskId: string) => void) {
  const handler = (event: Event) => fn((event as CustomEvent<string>).detail);
  window.addEventListener(CODE_EVENT, handler);
  return () => window.removeEventListener(CODE_EVENT, handler);
}
