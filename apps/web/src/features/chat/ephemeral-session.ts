import type { ChatTransport, UIMessageChunk } from 'ai';
import type { ModelConfig } from '@opendots/shared';
import type { ODMessage } from '@/lib/api';
import { t } from '@/lib/i18n';

/**
 * Client of the in-RAM ephemeral chat API (`/api/temporary-chats`, issue #57). Nothing here touches browser
 * storage, the URL or the normal chat store: the session id lives in this object only.
 */
const HEADERS = { 'content-type': 'application/json', 'x-opendots-client': '1' };
export class EphemeralGone extends Error {}
export const MAX_EPHEMERAL_FILES = 5, MAX_EPHEMERAL_FILE_BYTES = 10 * 1024 * 1024, MAX_EPHEMERAL_TURN_BYTES = 20 * 1024 * 1024;

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function request(path: string, init: RequestInit = {}) {
  return fetch(`/api/temporary-chats${path}`, { ...init, headers: HEADERS, cache: 'no-store' });
}

export class EphemeralSession {
  id: string | null = null;
  private creating: Promise<string> | null = null;
  private closed = false;

  /** The session is created lazily, on the first send: toggling the mode costs nothing on the server. */
  ensure(): Promise<string> {
    if (this.id) return Promise.resolve(this.id);
    this.creating ??= request('', { method: 'POST' }).then(async (res) => {
      if (res.status === 401) window.dispatchEvent(new Event('opendots:unauthorized'));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? t('Chat éphémère indisponible.'));
      if (this.closed) { void request(`/${data.id}`, { method: 'DELETE', keepalive: true }).catch(() => {}); throw new EphemeralGone(); }
      this.id = data.id as string;
      return this.id;
    }).finally(() => { this.creating = null; });
    return this.creating;
  }

  /** Heartbeat: every authenticated GET renews the server's idle window. Resolves false once the session is gone. */
  async keepalive(): Promise<boolean> {
    if (!this.id) return true;
    try {
      const res = await request(`/${this.id}`);
      if (res.status === 401) window.dispatchEvent(new Event('opendots:unauthorized'));
      return res.status !== 404 && res.status !== 401;
    } catch { return true; } // offline is not expiry
  }

  stop() { if (this.id) void request(`/${this.id}/stop`, { method: 'POST' }).catch(() => {}); }

  /** Leaving the chat: the server forgets everything. `keepalive` lets the request outlive a closing tab. */
  discard() {
    this.closed = true;
    const id = this.id;
    this.id = null;
    if (id) void request(`/${id}`, { method: 'DELETE', keepalive: true }).catch(() => {});
  }

  /** (Re)attach to a mounted view. StrictMode unmounts then remounts once in dev: a discarded session must accept sends again. */
  open() { this.closed = false; }

  /** After a server-side loss (expiry, restart): forget the id so the next send starts a clean session. */
  forget() { this.id = null; }
}

/** A ChatTransport that maps the temporary turn SSE (`delta` / `done` / `stopped` / `failure`) to UI message chunks. */
export function ephemeralTransport(session: EphemeralSession, getModel: () => ModelConfig | null, onTurnEnd: (completed: boolean) => void, onTurnStart: (committedCount: number) => void): ChatTransport<ODMessage> {
  return {
    sendMessages: async ({ messages, abortSignal }) => {
      onTurnStart(messages.length - 1); // everything before the new user message is what the server holds
      const last = messages[messages.length - 1];
      const text = last?.parts.map((part) => (part.type === 'text' ? part.text : '')).join('') ?? '';
      const model = getModel();
      onTurnEnd(true); // a new turn starts: nothing to roll back until it fails or is stopped
      if (!model) { onTurnEnd(false); throw new Error(t('Choisis un modèle compatible (OpenRouter ou Ollama).')); }
      let res: Response;
      try {
        // Attachments travel inline (base64) in the turn request: no upload endpoint, nothing stored client-side.
        const attachments = await Promise.all((last?.parts ?? []).filter((part) => part.type === 'file').map(async (part) => ({
          name: part.filename ?? 'fichier', mediaType: part.mediaType || 'application/octet-stream', data: await blobToBase64(await (await fetch(part.url)).blob()),
        })));
        const id = await session.ensure();
        res = await request(`/${id}/turn`, { method: 'POST', signal: abortSignal, body: JSON.stringify({ text, model: { provider: model.provider, model: model.model, reasoning: model.reasoning ?? null }, ...(attachments.length ? { attachments } : {}) }) });
      } catch (e) { onTurnEnd(false); throw e; }
      if (!res.ok || !res.body) {
        onTurnEnd(false);
        if (res.status === 401) window.dispatchEvent(new Event('opendots:unauthorized'));
        if (res.status === 404) { session.forget(); throw new EphemeralGone(t('Chat éphémère expiré : son contenu a été effacé.')); }
        throw new Error((await res.json().catch(() => ({}))).error ?? t('Envoi impossible.'));
      }
      const body = res.body;
      return new ReadableStream<UIMessageChunk>({
        async start(controller) {
          const reader = body.getReader();
          const decoder = new TextDecoder();
          let buffer = '', started = false, completed = false;
          controller.enqueue({ type: 'start' });
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
              let boundary: number;
              while ((boundary = buffer.indexOf('\n\n')) >= 0) {
                const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
                const kind = /^event: ?(.+)$/m.exec(frame)?.[1];
                const data = /^data: ?(.*)$/m.exec(frame)?.[1];
                if (kind === 'delta' && data) {
                  if (!started) { started = true; controller.enqueue({ type: 'text-start', id: 'text' }); }
                  controller.enqueue({ type: 'text-delta', id: 'text', delta: JSON.parse(data) });
                } else if (kind === 'done') completed = true;
                else if (kind === 'failure' && data) { onTurnEnd(false); controller.enqueue({ type: 'error', errorText: JSON.parse(data) }); }
              }
            }
          } catch { /* aborted (stop) or connection lost: the server keeps only complete turns */ }
          // Report the outcome first: the consumer may already be gone (stop), and enqueue would then throw.
          onTurnEnd(completed);
          try {
            if (started) controller.enqueue({ type: 'text-end', id: 'text' });
            controller.enqueue({ type: 'finish' });
            controller.close();
          } catch { /* stream cancelled by the consumer */ }
        },
        cancel() { void body.cancel().catch(() => {}); },
      });
    },
    reconnectToStream: async () => null,
  };
}
