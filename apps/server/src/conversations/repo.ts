import { and, asc, count, desc, eq, gte, inArray, lt, or } from 'drizzle-orm';
import type { UIMessage } from 'ai';
import { cleanModelText, isSingleEmoji, stripTranscriptNotes, type MessageMetadata, type MessageReaction, type MessageReplyRef, type TeamThreadDTO } from '@opendots/shared';
import { db, schema } from '../db/client.ts';
import { publish } from '../bus.ts';
import { enqueue } from '../jobs/queue.ts';
import { newId } from '../util.ts';

export type OpenDotsUIMessage = UIMessage<MessageMetadata>;

export function messageText(msg: Pick<UIMessage, 'parts'>): string {
  const text = msg.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => stripTranscriptNotes(p.text))
    .join('\n')
    .trim();
  const images = msg.parts.filter((part) => part.type === 'file' && part.mediaType?.startsWith('image/')).length;
  return text || (images ? `[${images} image${images > 1 ? 's' : ''} jointe${images > 1 ? 's' : ''}]` : '');
}

/**
 * Ce qu'un compagnon a répondu au terme d'un tour : le texte écrit après son dernier
 * appel d'outil. Les phrases d'étape (« Je vais vérifier… ») émises entre deux outils
 * n'en font pas partie. Sans texte final, on retombe sur tout le texte du tour.
 */
export function finalText(msg: Pick<UIMessage, 'parts'>): string {
  let lastTool = -1;
  msg.parts.forEach((part, index) => { if (part.type === 'dynamic-tool' || part.type.startsWith('tool-')) lastTool = index; });
  const tail = msg.parts
    .slice(lastTool + 1)
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => stripTranscriptNotes(p.text))
    .join('\n')
    .trim();
  return tail || messageText(msg);
}

export async function getConversation(id: string) {
  const [row] = await db().select().from(schema.conversations).where(eq(schema.conversations.id, id));
  return row ?? null;
}

export async function pairConversationId(a: string, b: string): Promise<string> {
  const [agentA, agentB] = [a, b].sort();
  const find = async () => {
    const [row] = await db()
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.kind, 'pair'),
          eq(schema.conversations.agentA, agentA),
          eq(schema.conversations.agentB, agentB),
        ),
      );
    return row?.id ?? null;
  };
  const existing = await find();
  if (existing) return existing;
  await db()
    .insert(schema.conversations)
    .values({ id: newId('cv'), kind: 'pair', agentA, agentB })
    .onConflictDoNothing();
  return (await find())!;
}

export async function saveMessage(
  conversationId: string,
  msg: OpenDotsUIMessage,
  opts: { author: 'user' | 'agent' | 'event'; agentId?: string | null; hidden?: boolean; /** #65: insert once; a replay (job retry, restart) of an already stored id changes and announces nothing. */ ifAbsent?: boolean },
): Promise<boolean> {
  // #56: nothing is written into a deleted conversation. A Circle's late result goes to its current thread instead;
  // a deleted general chat's is dropped (the task keeps its own record in Activity).
  const [target] = await db().select({ deletedAt: schema.conversations.deletedAt, agentId: schema.conversations.agentId, kind: schema.conversations.kind }).from(schema.conversations).where(eq(schema.conversations.id, conversationId));
  if (target?.deletedAt) {
    if (!target.agentId || (target.kind !== 'main' && target.kind !== 'archive')) return false;
    const [main] = await db().select({ id: schema.conversations.id }).from(schema.conversations).where(and(eq(schema.conversations.kind, 'main'), eq(schema.conversations.agentId, target.agentId)));
    if (!main) return false;
    conversationId = main.id;
  }
  const text = messageText(msg);
  const metadata = { ...(msg.metadata ?? {}), hidden: opts.hidden ?? false };
  delete (metadata as { reactions?: unknown }).reactions;
  const createdAt = metadata.createdAt ? new Date(metadata.createdAt) : new Date();
  const replyToId = metadata.replyTo?.messageId ?? null;
  const insert = db()
    .insert(schema.messages)
    .values({
      id: msg.id,
      conversationId,
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      author: opts.author,
      agentId: opts.agentId ?? null,
      parts: msg.parts as unknown[],
      metadata: metadata as Record<string, unknown>,
      hidden: opts.hidden ?? false,
      textContent: text,
      replyToId,
      createdAt,
    });
  if (opts.ifAbsent) {
    const inserted = await insert.onConflictDoNothing().returning({ id: schema.messages.id });
    if (!inserted.length) return false;
  } else await insert
    .onConflictDoUpdate({
      target: schema.messages.id,
      set: {
        parts: msg.parts as unknown[],
        metadata: metadata as Record<string, unknown>,
        textContent: text,
        hidden: opts.hidden ?? false,
        replyToId,
      },
    });
  await db().update(schema.conversations).set({ updatedAt: new Date() }).where(eq(schema.conversations.id, conversationId));
  publish({
    type: 'message.created',
    conversationId,
    agentId: opts.agentId ?? null,
    messageId: msg.id,
    hidden: opts.hidden ?? false,
    author: opts.author,
    preview: text.slice(0, 160),
  });
  return true;
}

function rowToUI(r: typeof schema.messages.$inferSelect, reactions?: MessageReaction[]): OpenDotsUIMessage {
  const metadata = { ...(r.metadata as MessageMetadata), createdAt: r.createdAt.toISOString(), hidden: r.hidden };
  delete metadata.reactions;
  if (reactions?.length) metadata.reactions = reactions;
  return {
    id: r.id,
    role: r.role,
    parts: (r.parts as OpenDotsUIMessage['parts']).map(p => r.role === 'assistant' && p.type === 'text' ? { ...p, text: cleanModelText(p.text) } : p),
    metadata,
  };
}

async function reactionsFor(ids: string[]): Promise<Map<string, MessageReaction[]>> {
  const map = new Map<string, MessageReaction[]>();
  if (!ids.length) return map;
  const rows = await db()
    .select({ messageId: schema.messageReactions.messageId, emoji: schema.messageReactions.emoji, actor: schema.messageReactions.actor })
    .from(schema.messageReactions)
    .where(inArray(schema.messageReactions.messageId, ids));
  for (const row of rows) {
    const list = map.get(row.messageId) ?? [];
    list.push({ emoji: row.emoji, actor: row.actor });
    map.set(row.messageId, list);
  }
  return map;
}

/** #58: how many messages to load so that [messageId] (and a little before it) is in the page — for "open at this message". */
export async function limitAround(conversationId: string, messageId: string | undefined, base: number): Promise<number> {
  if (!messageId) return base;
  const [target] = await db().select({ seq: schema.messages.seq }).from(schema.messages).where(and(eq(schema.messages.id, messageId), eq(schema.messages.conversationId, conversationId)));
  if (!target) return base;
  const [{ n }] = await db().select({ n: count() }).from(schema.messages).where(and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.hidden, false), gte(schema.messages.seq, target.seq)));
  return Math.min(2000, Math.max(base, Number(n) + 10));
}

/** Derniers messages d'une conversation, du plus ancien au plus récent. */
export async function loadMessages(
  conversationId: string,
  opts: { limit?: number; includeHidden?: boolean; beforeSeq?: number } = {},
): Promise<{ messages: OpenDotsUIMessage[]; rows: (typeof schema.messages.$inferSelect)[] }> {
  const where = [eq(schema.messages.conversationId, conversationId)];
  if (!opts.includeHidden) where.push(eq(schema.messages.hidden, false));
  if (opts.beforeSeq) where.push(lt(schema.messages.seq, opts.beforeSeq));
  const rows = await db()
    .select()
    .from(schema.messages)
    .where(and(...where))
    .orderBy(desc(schema.messages.seq))
    .limit(opts.limit ?? 200);
  rows.reverse();
  const reactions = await reactionsFor(rows.map((row) => row.id));
  return { messages: rows.map((row) => rowToUI(row, reactions.get(row.id))), rows };
}

/** Aperçu serveur d'un message de la même conversation, pour une réponse. */
export async function resolveReply(conversationId: string, messageId: string): Promise<MessageReplyRef | null> {
  const row = await getMessageRow(messageId);
  if (!row || row.conversationId !== conversationId || row.hidden) return null;
  return { messageId: row.id, preview: row.textContent.replace(/\s+/g, ' ').trim().slice(0, 180), role: row.role };
}

/**
 * Ajoute ou retire la réaction d'un acteur. Une réaction de l'utilisateur sur
 * un message du compagnon le réveille par un événement léger.
 */
export async function toggleReaction(messageId: string, actor: string, emoji: string): Promise<{ added: boolean; reactions: MessageReaction[] } | null> {
  const row = await getMessageRow(messageId);
  if (!row) return null;
  const clean = emoji.trim();
  if (!isSingleEmoji(clean)) throw new Error('Choisis un seul emoji.');
  const [existing] = await db()
    .select({ id: schema.messageReactions.id })
    .from(schema.messageReactions)
    .where(and(eq(schema.messageReactions.messageId, messageId), eq(schema.messageReactions.emoji, clean), eq(schema.messageReactions.actor, actor)));
  let added = false;
  if (existing) await db().delete(schema.messageReactions).where(eq(schema.messageReactions.id, existing.id));
  else {
    await db().insert(schema.messageReactions).values({ id: newId('rx'), messageId, conversationId: row.conversationId, emoji: clean, actor });
    added = true;
  }
  const reactions = (await reactionsFor([messageId])).get(messageId) ?? [];
  publish({ type: 'message.reaction', conversationId: row.conversationId, messageId, reactions });
  if (added && actor === 'user' && row.author === 'agent' && row.agentId) {
    const conversation = await getConversation(row.conversationId);
    if (conversation?.kind === 'main') {
      const preview = row.textContent.replace(/\s+/g, ' ').trim().slice(0, 180);
      await enqueue('agent.wake', {
        agentId: row.agentId,
        conversationId: row.conversationId,
        event: { type: 'reaction', title: 'Réaction' },
        text: `L'utilisateur a réagi ${clean} à ton message (id ${row.id})${preview ? ` : « ${preview} »` : ''}.\nCe n'est pas une nouvelle demande. Réponds seulement si la réaction appelle vraiment une suite. Pour un remerciement ou un accusé, appelle react_to_message ou réponds exactement <silence/>. Ne raconte pas la réaction comme un compte-rendu.`,
        depth: 0,
      }, { agentId: row.agentId });
    }
  }
  return { added, reactions };
}

export async function getMessageRow(id: string) {
  const [row] = await db().select().from(schema.messages).where(eq(schema.messages.id, id));
  return row ?? null;
}

export async function listTeamThreads(): Promise<TeamThreadDTO[]> {
  const convs = await db()
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.kind, 'pair'))
    .orderBy(desc(schema.conversations.updatedAt));
  const out: TeamThreadDTO[] = [];
  for (const c of convs) {
    const [last] = await db()
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, c.id))
      .orderBy(desc(schema.messages.seq))
      .limit(1);
    const [{ value }] = await db()
      .select({ value: count() })
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, c.id));
    out.push({
      conversationId: c.id,
      agentIds: [c.agentA!, c.agentB!],
      lastMessageAt: last?.createdAt.toISOString() ?? null,
      lastMessagePreview: last?.textContent.slice(0, 140) ?? null,
      messageCount: Number(value),
    });
  }
  return out;
}

export async function threadsForAgent(agentId: string): Promise<string[]> {
  const rows = await db()
    .select({ id: schema.conversations.id })
    .from(schema.conversations)
    .where(and(eq(schema.conversations.kind, 'pair'), or(eq(schema.conversations.agentA, agentId), eq(schema.conversations.agentB, agentId))))
    .orderBy(asc(schema.conversations.createdAt));
  return rows.map((r) => r.id);
}
