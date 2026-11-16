/**
 * #49: tells a provider usage limit (temporary, resumable) from everything else, from what OpenCode reports for the
 * failed turn. Structured data first (HTTP status, Retry-After and reset headers), then a few narrow, tested vendor
 * messages. Never invents a reset time: when none is given, `resetAt` is null.
 */
export interface ProviderError {
  name?: string;
  message?: string;
  statusCode?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
}

export type Classified =
  /** A usage limit or quota that resets: the work waits, then resumes in the same session. */
  | { kind: 'quota'; resetAt: number | null; evidence: string }
  /** A short-lived failure (overload, 5xx): retried after a brief, bounded backoff. */
  | { kind: 'transient'; evidence: string }
  /** Billing, credits, authentication, access: waiting will not help; the user must act. */
  | { kind: 'permanent'; evidence: string }
  | { kind: 'other' };

/** Added to any announced reset: the provider's clock and ours differ a little. */
export const RESET_MARGIN_MS = 2 * 60_000;

const PERMANENT = /(credit balance|insufficient[_ ]quota|billing|payment (?:required|failed)|subscription (?:has )?(?:expired|ended|inactive|cancel)|invalid (?:api[_ ]?)?key|invalid x-api-key|authentication|unauthori[sz]ed|forbidden|permission denied|account (?:is )?(?:disabled|suspended|banned)|oauth token (?:has )?(?:expired|been revoked)|please run \/login)/i;
const QUOTA = /(usage limit|rate limit|rate_limit|quota|limit reached|limit exceeded|hit your (?:usage )?limit|too many requests|session limit|weekly limit|5-hour limit|five-hour limit|out of (?:extra )?usage)/i;
const TRANSIENT = /(overloaded|temporarily unavailable|service unavailable|bad gateway|gateway timeout|internal server error|timed? ?out|ECONNRESET|socket hang up)/i;

function header(headers: Record<string, string> | undefined, name: string) {
  if (!headers) return undefined;
  const found = Object.keys(headers).find((key) => key.toLowerCase() === name);
  return found ? String(headers[found]) : undefined;
}

/** Epoch seconds, epoch milliseconds or an ISO/HTTP date. */
function parseInstant(value: string, now: number): number | null {
  const trimmed = value.trim();
  if (/^\d{10}$/.test(trimmed)) return Number(trimmed) * 1000;
  if (/^\d{13}$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  return Number.isFinite(date) && date > now - 60_000 ? date : null;
}

function fromHeaders(headers: Record<string, string> | undefined, now: number): number | null {
  const retry = header(headers, 'retry-after');
  if (retry) {
    if (/^\d+(\.\d+)?$/.test(retry.trim())) return now + Number(retry.trim()) * 1000;
    const at = parseInstant(retry, now);
    if (at) return at;
  }
  for (const name of ['anthropic-ratelimit-unified-reset', 'anthropic-ratelimit-requests-reset', 'anthropic-ratelimit-tokens-reset', 'x-ratelimit-reset', 'x-ratelimit-reset-requests', 'ratelimit-reset']) {
    const value = header(headers, name);
    if (!value) continue;
    // "ratelimit-reset" style: seconds from now when small.
    if (/^\d{1,6}$/.test(value.trim())) return now + Number(value.trim()) * 1000;
    const at = parseInstant(value, now);
    if (at) return at;
  }
  return null;
}

const UNIT: Record<string, number> = { d: 86_400_000, day: 86_400_000, days: 86_400_000, h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000, m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000, s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000 };

/** "try again in 2 days 3 hours", "retry in 45 minutes", "resets in 4h 12m". */
function fromDuration(message: string, now: number): number | null {
  const match = /(?:try again|retry|resets?|available again)\s+in\s+((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|min|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)/i.exec(message);
  if (!match) return null;
  let total = 0;
  for (const [, amount, unit] of match[1].matchAll(/(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|min|m|seconds?|secs?|s)\b/gi)) total += Number(amount) * (UNIT[unit.toLowerCase()] ?? 0);
  return total > 0 ? now + total : null;
}

function zoneOffsetMs(zone: string, at: number): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return local - Math.floor(at / 1000) * 1000;
}

/** The next instant at which the wall clock of [zone] shows hour:minute. */
export function nextWallClock(hour: number, minute: number, zone: string, now: number): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  for (let day = 0; day < 3; day++) {
    const guess = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + day, hour, minute);
    let at = guess - zoneOffsetMs(zone, guess);
    at = guess - zoneOffsetMs(zone, at); // second pass for DST edges
    if (at > now) return at;
  }
  return now + 86_400_000;
}

function validZone(zone: string) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; }
}

/** "resets 3pm (Europe/Paris)", "resets at 15:00 UTC", "resets 9:30am". */
function fromWallClock(message: string, now: number, defaultZone: string): number | null {
  const match = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\)|\s+(UTC|GMT))?/i.exec(message);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const meridiem = match[3]?.toLowerCase();
  if (!match[2] && !meridiem) return null; // a bare number is not a time
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  const zone = match[4]?.trim() || (match[5] ? 'UTC' : defaultZone);
  return nextWallClock(hour, minute, validZone(zone) ? zone : defaultZone, now);
}

export function classifyProviderError(error: ProviderError | null | undefined, opts: { now?: number; timezone?: string } = {}): Classified {
  if (!error) return { kind: 'other' };
  const now = opts.now ?? Date.now();
  const message = [error.message, error.responseBody].filter(Boolean).join('\n');
  const evidence = `${error.name ?? 'Error'}${error.statusCode ? ` ${error.statusCode}` : ''}: ${(error.message ?? '').slice(0, 300)}`;
  if (/abort/i.test(error.name ?? '')) return { kind: 'other' };
  if (error.statusCode === 401 || error.statusCode === 403 || error.statusCode === 402 || PERMANENT.test(message)) return { kind: 'permanent', evidence };

  // Claude Code reports "Claude AI usage limit reached|<epoch seconds>".
  const claude = /usage limit reached\|(\d{10,13})/i.exec(message);
  if (claude) return { kind: 'quota', resetAt: parseInstant(claude[1], now), evidence };

  const quota = error.statusCode === 429 || QUOTA.test(message);
  if (quota) {
    const resetAt = fromHeaders(error.responseHeaders, now) ?? fromDuration(message, now) ?? fromWallClock(message, now, opts.timezone ?? 'UTC');
    return { kind: 'quota', resetAt: resetAt && resetAt > now - 60_000 ? resetAt : null, evidence };
  }
  if ((error.statusCode && error.statusCode >= 500) || error.statusCode === 529 || TRANSIENT.test(message)) return { kind: 'transient', evidence };
  return { kind: 'other' };
}

/** When to try again: the announced reset plus a margin, else a bounded backoff (30 min, 1 h, 2 h, … 6 h). */
export function nextAttempt(classified: Extract<Classified, { kind: 'quota' | 'transient' }>, attempt: number, now = Date.now(), jitter = Math.random()): number {
  if (classified.kind === 'quota' && classified.resetAt) return Math.max(classified.resetAt, now) + RESET_MARGIN_MS;
  const base = classified.kind === 'transient' ? 5 * 60_000 : 30 * 60_000;
  const delay = Math.min(base * 2 ** Math.max(0, attempt - 1), 6 * 3_600_000);
  return now + delay + Math.round(delay * 0.1 * jitter);
}
