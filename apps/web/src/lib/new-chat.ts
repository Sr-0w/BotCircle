import type { ModelConfig } from "@opendots/shared";

/**
 * A new general chat is a local draft until its first message: nothing exists on the server, nothing is listed.
 * The chat is created (with the draft's settings) only when that first message is sent.
 */
export interface DraftSeed {
  /** The chat's own model; null = the default model. */
  model?: ModelConfig | null;
  webSearch?: boolean;
}

const EVENT = "opendots:new-chat";

/** Opens a fresh draft chat (the shell owns the route), optionally with the settings of the chat it replaces. */
export function openNewChat(seed?: DraftSeed) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: seed }));
}

export function onNewChatRequested(fn: (seed?: DraftSeed) => void) {
  const handler = (event: Event) => fn((event as CustomEvent<DraftSeed | undefined>).detail);
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
