import { and, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';

/**
 * #58: full-text search over the messages people and Circles really exchanged (not titles only). Matching is exact on
 * words and "quoted phrases", case- and accent-insensitive, with punctuation kept (`opencode.json`, paths, model ids).
 * Every query runs inside the caller's own database: no other account's text can match, and nothing is logged.
 */
export interface SearchHit {
  messageId: string; conversationId: string; seq: number; role: 'user' | 'assistant';
  kind: 'chat' | 'circle'; agentId: string | null; title: string; archived: boolean; current: boolean;
  snippet: string; highlights: [number, number][]; createdAt: string; score: number;
}
export interface SearchQuery { q: string; scope?: 'all' | 'chats' | 'circles'; agentId?: string | null; archived?: boolean; sort?: 'relevance' | 'recent'; since?: Date | null; limit?: number; offset?: number }

// Accent folding, char for char (lowercase first): the same table in JS and in SQL `translate`.
const PAIRS = 'àa áa âa ãa äa åa āa ăa ąa çc ćc čc ďd èe ée êe ëe ēe ĕe ėe ęe ěe ìi íi îi ïi ĩi īi įi ıi ñn ńn ňn òo óo ôo õo öo øo ōo őo ùu úu ûu üu ũu ūu ůu űu ųu ýy ÿy žz źz żz'.split(' ');
const FROM = PAIRS.map((p) => p[0]).join(''), TO = PAIRS.map((p) => p[1]).join('');
const MAP = new Map(PAIRS.map((p) => [p[0], p[1]]));
/** Lowercase + accents removed, one char for one char (positions in the original text stay valid). */
export const fold = (text: string) => { let out = ''; for (const ch of text) { const lower = ch.toLowerCase(); out += lower.length === 1 ? MAP.get(lower) ?? lower : ch; } return out; };
/** Same folding in SQL, so the database does the matching (no history is loaded to filter it). */
const folded = (column: SQL | typeof schema.messages.textContent) => sql`translate(lower(${column}), ${FROM}, ${TO})`;

/** Words and "exact phrases" of a query, folded. Empty when there is nothing to search. */
export function parseQuery(q: string): string[] {
  const terms: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  for (const m of q.slice(0, 300).matchAll(re)) { const term = fold((m[1] ?? m[2]).trim()); if (term && !terms.includes(term)) terms.push(term); }
  return terms.slice(0, 8);
}

const like = (term: string) => `%${term.replace(/[\\%_]/g, '\\$&')}%`;

/** Where each term occurs in [text] (folded comparison, positions in the original text). */
export function findMatches(text: string, terms: string[]): [number, number][] {
  const hay = fold(text);
  const out: [number, number][] = [];
  for (const term of terms) { let i = hay.indexOf(term); while (i >= 0 && out.length < 200) { out.push([i, i + term.length]); i = hay.indexOf(term, i + term.length); } }
  return out.sort((a, b) => a[0] - b[0]);
}

function snippetOf(text: string, matches: [number, number][]): { snippet: string; highlights: [number, number][] } {
  const clean = text.replace(/\s+/g, ' ');
  const shifted = findMatchesInClean(clean, matches.length ? text : '', matches);
  const first = shifted[0]?.[0] ?? 0;
  const start = Math.max(0, first - 60), end = Math.min(clean.length, start + 220);
  const prefix = start > 0 ? '…' : '', suffix = end < clean.length ? '…' : '';
  return {
    snippet: prefix + clean.slice(start, end) + suffix,
    highlights: shifted.filter(([a, b]) => a >= start && b <= end).map(([a, b]) => [a - start + prefix.length, b - start + prefix.length]),
  };
}
/** Positions survive whitespace collapsing: recompute on the collapsed text. */
function findMatchesInClean(clean: string, original: string, matches: [number, number][]): [number, number][] {
  if (!original) return [];
  const terms = [...new Set(matches.map(([a, b]) => fold(original.slice(a, b))))];
  return findMatches(clean, terms);
}

export async function searchMessages(input: SearchQuery): Promise<{ hits: SearchHit[]; more: boolean }> {
  const terms = parseQuery(input.q);
  if (!terms.length) return { hits: [], more: false };
  const c = schema.conversations, m = schema.messages;
  const kinds = input.scope === 'chats' ? ['chat'] : input.scope === 'circles' || input.agentId ? ['main', 'archive'] : ['chat', 'main', 'archive'];
  const where: SQL[] = [
    eq(m.hidden, false), inArray(c.kind, kinds as ('chat' | 'main' | 'archive')[]), isNull(c.deletedAt),
    ...terms.map((term) => sql`${folded(m.textContent)} LIKE ${like(term)} ESCAPE '\\'`),
  ];
  if (input.agentId) where.push(eq(c.agentId, input.agentId));
  // Archived chats, and a Circle's previous threads, only when asked (a single Circle's search covers its history).
  if (!input.archived) where.push(input.agentId ? sql`true` : or(and(eq(c.kind, 'chat'), eq(c.archived, false)), eq(c.kind, 'main'))!);
  if (input.since) where.push(sql`${m.createdAt} >= ${input.since}`);
  const rows = await db().select({
    id: m.id, conversationId: m.conversationId, seq: m.seq, role: m.role, text: m.textContent, createdAt: m.createdAt,
    kind: c.kind, agentId: c.agentId, chatTitle: c.title, chatArchived: c.archived,
  }).from(m).innerJoin(c, eq(c.id, m.conversationId)).where(and(...where)).orderBy(desc(m.createdAt)).limit(500);
  const agents = new Map((await db().select({ id: schema.agents.id, name: schema.agents.name }).from(schema.agents)).map((a) => [a.id, a.name]));
  const now = Date.now();
  const hits = rows.map((row): SearchHit => {
    const matches = findMatches(row.text, terms);
    const { snippet, highlights } = snippetOf(row.text, matches);
    const days = (now - row.createdAt.getTime()) / 86_400_000;
    const circle = row.kind !== 'chat';
    return {
      messageId: row.id, conversationId: row.conversationId, seq: row.seq, role: row.role as 'user' | 'assistant',
      kind: circle ? 'circle' : 'chat', agentId: row.agentId, archived: circle ? row.kind === 'archive' : row.chatArchived, current: row.kind === 'main',
      title: circle ? agents.get(row.agentId ?? '') ?? 'Circle' : row.chatTitle?.trim() || 'Nouveau chat',
      snippet, highlights, createdAt: row.createdAt.toISOString(),
      score: matches.length + (fold(row.text).includes(terms.join(' ')) ? 3 : 0) + Math.max(0, 2 - days / 30),
    };
  });
  if (input.sort === 'relevance') hits.sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt));
  const offset = Math.max(0, input.offset ?? 0), limit = Math.min(50, input.limit ?? 30);
  return { hits: hits.slice(offset, offset + limit), more: hits.length > offset + limit };
}

/** In-thread search: every matching message of one conversation, oldest first, for previous / next. */
export async function searchConversation(conversationId: string, q: string): Promise<{ messageId: string; seq: number; count: number }[]> {
  const terms = parseQuery(q);
  if (!terms.length) return [];
  const m = schema.messages;
  const rows = await db().select({ id: m.id, seq: m.seq, text: m.textContent }).from(m)
    .where(and(eq(m.conversationId, conversationId), eq(m.hidden, false), ...terms.map((term) => sql`${folded(m.textContent)} LIKE ${like(term)} ESCAPE '\\'`)))
    .orderBy(m.seq).limit(1000);
  return rows.map((r) => ({ messageId: r.id, seq: r.seq, count: findMatches(r.text, terms).length }));
}
