import { useEffect, useRef } from 'react';
import { scrollToMessage } from '@/features/chat/message-actions';

/**
 * #58: "open this conversation at this message" (from a search result, or previous / next in a thread). A view that
 * shows the conversation loads enough history for the message, scrolls to it and highlights the searched words.
 */
export interface Focus { conversationId: string; messageId: string; terms: string[] }
let pending: Focus | null = null;
const listeners = new Set<() => void>();

export function focusMessage(focus: Focus) { pending = focus; listeners.forEach((l) => l()); }

/** Highlights [terms] inside the message (CSS Custom Highlight API; the message itself is ringed in any case). */
export function highlightTerms(root: Element | null, terms: string[]) {
  const registry = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
  const Highlight = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!registry || !Highlight) return;
  if (!root || !terms.length) { registry.delete('od-search'); return; }
  const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? '';
    // NFD can change lengths; map folded positions back through a per-character fold.
    const chars = [...text]; let folded = ''; const index: number[] = []; let offset = 0;
    for (const ch of chars) { const f = fold(ch); for (let k = 0; k < f.length; k++) index.push(offset); folded += f; offset += ch.length; }
    index.push(offset);
    for (const term of terms) {
      let i = folded.indexOf(term);
      while (i >= 0) { const r = document.createRange(); r.setStart(node, index[i]); r.setEnd(node, index[i + term.length] ?? offset); ranges.push(r); i = folded.indexOf(term, i + term.length); }
    }
  }
  registry.set('od-search', new Highlight(...ranges));
}

/** Search terms as the server reads them: words and "phrases", lowercased, accents removed. */
export function termsOf(q: string): string[] {
  const out: string[] = [];
  for (const m of q.matchAll(/"([^"]+)"|(\S+)/g)) { const term = (m[1] ?? m[2]).trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); if (term && !out.includes(term)) out.push(term); }
  return out;
}

/**
 * In a conversation view: when a focus targets [conversationId], make sure [messageId] is loaded ([loadAround]),
 * then scroll to it and highlight.
 */
export function useMessageFocus(conversationId: string | null | undefined, messageIds: string[], loadAround: (messageId: string) => Promise<void>) {
  const ids = useRef(messageIds); ids.current = messageIds;
  const load = useRef(loadAround); load.current = loadAround;
  useEffect(() => {
    const run = async () => {
      const focus = pending;
      if (!focus || !conversationId || focus.conversationId !== conversationId) return;
      pending = null;
      if (!ids.current.includes(focus.messageId)) await load.current(focus.messageId).catch(() => {});
      for (let i = 0; i < 20 && !document.getElementById(`message-${focus.messageId}`); i++) await new Promise((r) => setTimeout(r, 100));
      const el = document.getElementById(`message-${focus.messageId}`);
      if (el) {
        scrollToMessage(focus.messageId);
        highlightTerms(el, focus.terms);
      }
    };
    listeners.add(run); void run();
    return () => { listeners.delete(run); };
  }, [conversationId]);
}
