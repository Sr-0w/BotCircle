import { and, desc, eq, ilike, inArray, sql } from 'drizzle-orm';
import type { ChatDTO, ModelConfig } from '@opendots/shared';
import { db, schema } from '../db/client.ts';
import { publish } from '../bus.ts';
import { getDefaultModel } from '../settings.ts';
import { newId } from '../util.ts';

/*
 * Chats généraux : des conversations qui n'appartiennent à aucun compagnon. Elles ont leur propre
 * titre et leur propre modèle ; en créer une ne crée ni compagnon ni réglage de compagnon.
 */

export type ChatRow = typeof schema.conversations.$inferSelect;
export class ChatError extends Error {}

export async function toChatDTO(row: ChatRow): Promise<ChatDTO> {
  const [last] = await db().select({ text: schema.messages.textContent }).from(schema.messages)
    .where(and(eq(schema.messages.conversationId, row.id), eq(schema.messages.hidden, false), sql`${schema.messages.textContent} <> ''`)).orderBy(desc(schema.messages.seq)).limit(1);
  return {
    id: row.id, title: row.title?.trim() || 'Nouveau chat', model: row.model ?? null, effectiveModel: row.model ?? (await getDefaultModel()), webSearch: row.webSearch, pinned: row.pinned,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), lastMessagePreview: last?.text.replace(/\s+/g, ' ').slice(0, 160) ?? null,
  };
}

export async function getChat(id: string): Promise<ChatRow | null> {
  const [row] = await db().select().from(schema.conversations).where(and(eq(schema.conversations.id, id), eq(schema.conversations.kind, 'chat'), eq(schema.conversations.archived, false)));
  return row ?? null;
}

/** Les chats, du plus récent au plus ancien ; `query` cherche dans les titres et le contenu des messages. */
export async function listChats(query?: string): Promise<ChatRow[]> {
  const base = and(eq(schema.conversations.kind, 'chat'), eq(schema.conversations.archived, false));
  const q = query?.trim();
  if (!q) return db().select().from(schema.conversations).where(base).orderBy(desc(schema.conversations.pinned), desc(schema.conversations.updatedAt)).limit(200);
  const pattern = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
  const inMessages = await db().selectDistinct({ id: schema.messages.conversationId }).from(schema.messages).where(ilike(schema.messages.textContent, pattern)).limit(500);
  const ids = inMessages.map((m) => m.id);
  return db().select().from(schema.conversations)
    .where(and(base, ids.length ? sql`(${ilike(schema.conversations.title, pattern)} OR ${inArray(schema.conversations.id, ids)})` : ilike(schema.conversations.title, pattern)))
    .orderBy(desc(schema.conversations.pinned), desc(schema.conversations.updatedAt)).limit(200);
}

export async function createChat(input: { title?: string | null; model?: ModelConfig | null } = {}): Promise<ChatRow> {
  const id = newId('chat');
  await db().insert(schema.conversations).values({ id, kind: 'chat', title: input.title?.trim().slice(0, 200) || null, model: input.model ?? null });
  publish({ type: 'chat.changed', chatId: id });
  return (await getChat(id))!;
}

export async function updateChat(id: string, patch: { title?: string; model?: ModelConfig | null; webSearch?: boolean; pinned?: boolean }): Promise<ChatRow> {
  if (!await getChat(id)) throw new ChatError('Chat introuvable.');
  await db().update(schema.conversations).set({
    ...(patch.webSearch !== undefined ? { webSearch: patch.webSearch } : {}),
    ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
    ...(patch.title !== undefined ? { title: patch.title.trim().slice(0, 200) || null } : {}),
    ...(patch.model !== undefined ? { model: patch.model } : {}),
  }).where(eq(schema.conversations.id, id));
  publish({ type: 'chat.changed', chatId: id });
  return (await getChat(id))!;
}

/** Supprime le chat et ses messages. Les tâches et fichiers qu'il a fait naître restent dans leurs registres. */
export async function deleteChat(id: string): Promise<boolean> {
  if (!await getChat(id)) return false;
  await db().delete(schema.messageReactions).where(eq(schema.messageReactions.conversationId, id));
  await db().delete(schema.messages).where(eq(schema.messages.conversationId, id));
  await db().update(schema.conversations).set({ archived: true, title: null }).where(eq(schema.conversations.id, id));
  publish({ type: 'chat.changed', chatId: id, deleted: true });
  return true;
}

/** Titre par défaut : le début du premier message. */
export async function titleFromFirstMessage(id: string, text: string) {
  const row = await getChat(id);
  if (!row || row.title) return;
  const title = text.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (title) await db().update(schema.conversations).set({ title }).where(eq(schema.conversations.id, id));
}
