import { describe, expect, it } from 'vitest';
import { classifyProviderError, nextAttempt, nextWallClock, RESET_MARGIN_MS } from '../src/opencode/quota.ts';

const now = Date.parse('2026-11-16T10:00:00Z');

describe('#49 : classement des erreurs de fournisseur', () => {
  it('Claude Code (abonnement Pro/Max) : limite avec heure de reprise exacte', () => {
    const c = classifyProviderError({ name: 'APIError', message: `Claude AI usage limit reached|${now / 1000 + 4 * 3600}` }, { now });
    expect(c).toMatchObject({ kind: 'quota', resetAt: now + 4 * 3_600_000 });
  });

  it('limite de 5 h / hebdomadaire annoncée en heure locale, avec ou sans fuseau', () => {
    const paris = classifyProviderError({ message: '5-hour limit reached ∙ resets 3pm (Europe/Paris)' }, { now });
    expect(paris).toMatchObject({ kind: 'quota', resetAt: Date.parse('2026-11-16T14:00:00Z') });
    const weekly = classifyProviderError({ message: "You've hit your weekly limit · resets 9:30am" }, { now, timezone: 'America/New_York' });
    // 9:30 in New York has passed at 10:00 UTC? (05:00 local) — no: it is later today.
    expect(weekly).toMatchObject({ kind: 'quota', resetAt: Date.parse('2026-11-16T14:30:00Z') });
    const utc = classifyProviderError({ message: 'Usage limit reached, resets at 09:00 UTC' }, { now });
    expect(utc).toMatchObject({ kind: 'quota', resetAt: Date.parse('2026-11-17T09:00:00Z') });
  });

  it('Retry-After, en-têtes de réinitialisation et durées', () => {
    expect(classifyProviderError({ statusCode: 429, message: 'Too Many Requests', responseHeaders: { 'Retry-After': '120' } }, { now })).toMatchObject({ kind: 'quota', resetAt: now + 120_000 });
    expect(classifyProviderError({ statusCode: 429, message: 'rate_limit_error', responseHeaders: { 'anthropic-ratelimit-unified-reset': String(now / 1000 + 5400) } }, { now })).toMatchObject({ kind: 'quota', resetAt: now + 5_400_000 });
    expect(classifyProviderError({ message: "You've hit your usage limit. Try again in 2 days 3 hours." }, { now })).toMatchObject({ kind: 'quota', resetAt: now + (2 * 24 + 3) * 3_600_000 });
  });

  it('quota sans heure : aucune heure inventée', () => {
    expect(classifyProviderError({ message: 'Rate limit exceeded for this model' }, { now })).toEqual(expect.objectContaining({ kind: 'quota', resetAt: null }));
  });

  it('facturation, crédits, authentification : action requise, jamais une attente', () => {
    for (const message of ['Your credit balance is too low to access the Anthropic API', 'You exceeded your current quota (insufficient_quota). Check your plan and billing details.', 'Invalid API key', 'OAuth token has expired. Please run /login']) {
      expect(classifyProviderError({ message }, { now }).kind).toBe('permanent');
    }
    expect(classifyProviderError({ statusCode: 401, message: 'nope' }, { now }).kind).toBe('permanent');
  });

  it('surcharge passagère, arrêt volontaire et erreurs ordinaires', () => {
    expect(classifyProviderError({ statusCode: 529, message: 'Overloaded' }, { now }).kind).toBe('transient');
    expect(classifyProviderError({ name: 'MessageAbortedError', message: 'Aborted' }, { now }).kind).toBe('other');
    expect(classifyProviderError({ name: 'UnknownError', message: 'Tool bash failed: exit code 1' }, { now }).kind).toBe('other');
    expect(classifyProviderError(null).kind).toBe('other');
  });

  it('prochaine tentative : heure annoncée + marge, sinon attente bornée', () => {
    expect(nextAttempt({ kind: 'quota', resetAt: now + 3_600_000, evidence: '' }, 1, now)).toBe(now + 3_600_000 + RESET_MARGIN_MS);
    expect(nextAttempt({ kind: 'quota', resetAt: null, evidence: '' }, 1, now, 0)).toBe(now + 30 * 60_000);
    expect(nextAttempt({ kind: 'quota', resetAt: null, evidence: '' }, 10, now, 0)).toBe(now + 6 * 3_600_000);
    expect(nextAttempt({ kind: 'transient', evidence: '' }, 1, now, 0)).toBe(now + 5 * 60_000);
  });

  it('heure murale à travers un changement d’heure', () => {
    // 29 March 2026: Europe/Paris switches to summer time at 02:00 → 03:00.
    const before = Date.parse('2026-03-28T22:00:00Z');
    expect(nextWallClock(9, 0, 'Europe/Paris', before)).toBe(Date.parse('2026-03-29T07:00:00Z'));
  });
});
