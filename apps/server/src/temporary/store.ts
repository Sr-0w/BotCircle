import { randomBytes } from 'node:crypto';
import type { ModelConfig } from '@opendots/shared';

export const IDLE_MS = 30 * 60_000;
/** Safety cap only: the Web client deletes the session as soon as the user leaves the chat. */
export const LIFETIME_MS = 12 * 60 * 60_000;
export const MAX_TEXT = 100_000;
export const MAX_ATTACHMENT_SESSION_BYTES = 50 * 1024 * 1024;
export type TemporaryAttachmentMeta = { name: string; mediaType: string; size: number };
/** Attachment bytes live here, in RAM only, and are never part of a snapshot. ytes is what the model receives. */
export type TemporaryFile = TemporaryAttachmentMeta & { kind: 'image' | 'pdf' | 'text' | 'binary'; bytes: Buffer };
export type TemporaryMessage = { role: 'user' | 'assistant'; content: string; model?: ModelConfig; attachments?: TemporaryAttachmentMeta[]; files?: TemporaryFile[] };
export type TemporarySession = {
  id: string;
  owner: string;
  expiresAt: number;
  idleUntil: number;
  messages: TemporaryMessage[];
  active?: AbortController;
  cleanup?: () => void;
};
export const attachmentBytesOf = (session: TemporarySession) => session.messages.reduce((n, m) => n + (m.files?.reduce((k, f) => k + f.size, 0) ?? 0), 0);
export class TemporaryError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 413 | 429, message: string) { super(message); }
}

/**
 * RAM only: no conversation repository, event bus, memory, audit or job queue.
 * Expiry is idle (30 min, renewed by any authenticated access: GET keepalive, turn)
 * and absolute (12 h safety cap), checked on access and every 15s. The Web client DELETEs the session on leave.
 * Logical deletion does not promise secure erasure from runtime/OS/provider memory.
 */
export class TemporaryStore {
  private sessions = new Map<string, TemporarySession>();
  constructor(private now = Date.now) {}
  create(owner: string) {
    this.sweep();
    if (this.sessions.size >= 1000 || [...this.sessions.values()].filter(s => s.owner === owner).length >= 3)
      throw new TemporaryError(429, 'Trop de chats temporaires ouverts.');
    const now = this.now();
    const session: TemporarySession = {
      id: `tmp_${randomBytes(24).toString('hex')}`, owner,
      expiresAt: now + LIFETIME_MS, idleUntil: now + IDLE_MS, messages: [],
    };
    this.sessions.set(session.id, session);
    return session;
  }
  get(id: string, owner: string) {
    this.sweep();
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner) throw new TemporaryError(404, 'Chat temporaire fermé ou expiré.');
    // Any authenticated access (GET keepalive included) renews the idle window, never past the absolute cap.
    session.idleUntil = Math.min(session.expiresAt, this.now() + IDLE_MS);
    return session;
  }
  begin(session: TemporarySession, text: string, attachmentBytes = 0) {
    this.get(session.id, session.owner);
    if (session.active) throw new TemporaryError(409, 'Une réponse est déjà en cours.');
    if (session.messages.length >= 100 || session.messages.reduce((n, m) => n + m.content.length, text.length) > MAX_TEXT)
      throw new TemporaryError(413, 'Limite du chat temporaire atteinte. Démarre un nouveau chat.');
    if (attachmentBytes && attachmentBytes + attachmentBytesOf(session) > MAX_ATTACHMENT_SESSION_BYTES)
      throw new TemporaryError(413, 'Limite de pièces jointes du chat éphémère atteinte (50 Mo). Démarre un nouveau chat.');
    session.idleUntil = Math.min(session.expiresAt, this.now() + IDLE_MS);
    const controller = new AbortController();
    session.active = controller;
    return controller;
  }
  discard(session: TemporarySession) {
    session.active?.abort();
    for (const message of session.messages) for (const file of message.files ?? []) file.bytes.fill(0);
    session.messages.length = 0;
    session.cleanup?.();
    session.cleanup = undefined;
    this.sessions.delete(session.id);
  }
  sweep() {
    const now = this.now();
    for (const session of this.sessions.values())
      if (now >= Math.min(session.expiresAt, session.idleUntil)) this.discard(session);
  }
  close() { for (const session of this.sessions.values()) this.discard(session); }
}
