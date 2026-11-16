/**
 * #39: who may do what with a Home Assistant instance. Checked on EVERY tool call, on the server; hiding a tool from
 * the model is not a control. Home Assistant itself still limits what the token and the exposed entities allow.
 */
export type HaAccess = 'none' | 'read' | 'control';
export interface HaPolicy {
  /** Per Circle (agent id). Absent = none. */
  agents: Record<string, HaAccess>;
  /** General chats (no Circle). */
  chats: HaAccess;
  /** Domains that always wait for the user's approval, even with control access (locks, alarms…). */
  sensitive: string[];
  /** Optional allowlists: when set, a control call outside them is refused. */
  areas: string[];
  domains: string[];
}

export const DEFAULT_SENSITIVE = ['lock', 'alarm_control_panel', 'cover', 'camera', 'siren', 'valve'];
export const defaultPolicy = (): HaPolicy => ({ agents: {}, chats: 'none', sensitive: [...DEFAULT_SENSITIVE], areas: [], domains: [] });

/** Read tools only observe (live context, date, lists and calendars read); everything else acts. */
export function isReadTool(name: string): boolean {
  return /^(GetLiveContext|GetDateTime|Get[A-Z]|todo_get|calendar_get)/.test(name) || /^(get|list|search)_/i.test(name);
}

export function accessFor(policy: HaPolicy, principal: { agentId?: string; chat?: boolean }): HaAccess {
  if (principal.chat) return policy.chats ?? 'none';
  return (principal.agentId && policy.agents?.[principal.agentId]) || 'none';
}

const lower = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(lower).filter(Boolean) : lower(v) ? [lower(v)] : []);

/**
 * The decision for one call: allow, ask (approval), or deny with the reason. Home Assistant's intent tools target by
 * name/area/floor/domain/device_class; a control call is checked against the allowlists and the sensitive domains.
 */
export function decide(policy: HaPolicy, access: HaAccess, tool: string, args: Record<string, unknown>): { verdict: 'allow' | 'ask' | 'deny'; reason?: string } {
  if (access === 'none') return { verdict: 'deny', reason: 'Home Assistant n’est pas autorisé ici.' };
  if (isReadTool(tool)) return { verdict: 'allow' };
  if (access !== 'control') return { verdict: 'deny', reason: 'Accès en lecture seule à Home Assistant : aucune commande n’est permise.' };
  const domains = list(args.domain), areas = [...list(args.area), ...list(args.floor)];
  if (policy.domains.length && !domains.some((d) => policy.domains.includes(d))) return { verdict: 'deny', reason: `Commande refusée : seuls ces domaines sont permis (${policy.domains.join(', ')}). Précise le domaine.` };
  if (policy.areas.length && !areas.some((a) => policy.areas.map(lower).includes(a))) return { verdict: 'deny', reason: `Commande refusée : seules ces pièces sont permises (${policy.areas.join(', ')}). Précise la pièce.` };
  const sensitive = domains.some((d) => policy.sensitive.includes(d)) || /lock|alarm|unlock|disarm|arm/i.test(tool) || /(serrure|lock|alarme|alarm|porte|door|garage)/i.test(lower(args.name) + ' ' + lower(args.device_class));
  return sensitive ? { verdict: 'ask', reason: 'Appareil sensible : ta validation est demandée.' } : { verdict: 'allow' };
}
