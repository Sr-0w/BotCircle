import type { MessageMention } from '@opendots/shared';
import { listConnectors } from '../connectors/repo.ts';
import type { AgentRow } from './repo.ts';

/**
 * #46: what can be called with @ in a Circle's conversation — its connected services and MCP connectors. A mention
 * is resolved HERE, on the server, into a typed id; it never grants a permission: a service the Circle may not use
 * is listed as such and stays unusable.
 */
export interface Mentionable extends MessageMention { provider: string | null; status: 'connected' | 'not_connected' | 'permission_missing' }

export async function connectorMentionables(agent: AgentRow): Promise<Mentionable[]> {
  const rows = await listConnectors();
  return rows.filter((row) => row.enabled).map((row) => {
    const allowed = row.kind === 'mail' ? agent.permissions.mail : agent.permissions.connectors;
    const provider = typeof row.config?.provider === 'string' ? row.config.provider : row.kind === 'mail' ? 'mail' : null;
    return { kind: 'connector' as const, id: row.id, name: row.name, provider, status: !allowed ? 'permission_missing' as const : row.status === 'ok' ? 'connected' as const : 'not_connected' as const };
  });
}

/** The @names of [text] that match one of [items] (longest names first, whole words, any case). */
export function resolveMentions<T extends { name: string }>(text: string, items: T[]): T[] {
  const lower = text.toLowerCase();
  const found: T[] = [];
  const taken: [number, number][] = [];
  for (const item of [...items].sort((a, b) => b.name.length - a.name.length)) {
    const needle = `@${item.name.toLowerCase()}`;
    let at = lower.indexOf(needle);
    while (at >= 0) {
      const end = at + needle.length, after = lower[end];
      const whole = (at === 0 || /\s|[(«"']/.test(lower[at - 1])) && (after === undefined || !/[\p{L}\p{N}_-]/u.test(after));
      // A longer name already matched here ("@Home Assistant" is not also "@Home").
      if (whole && !taken.some(([s, e]) => at < e && end > s)) { found.push(item); taken.push([at, end]); break; }
      at = lower.indexOf(needle, at + 1);
    }
  }
  return found;
}
