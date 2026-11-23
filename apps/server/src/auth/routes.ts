import { sessionStream } from './stream.ts';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import { config } from '../config.ts';
import { withAccount, type AccountContext } from './context.ts';
import { accountById, authenticate, AuthError, createSession, hasPassword, publicAccount, registerUser, revokeSession, sessionAccount, sessionInfo } from './store.ts';
import { adminOidcView, ANDROID_REDIRECT, audit, linkedIdentities, oidc, OidcError, oidcSettings, publicOidc, saveOidcSettings, unlinkIdentity } from './oidc.ts';
import { decryptSecret, encryptSecret } from '../secrets.ts';

const COOKIE = 'opendots_session';
const BROWSER = 'od_oidc';
const attempts = new Map<string, { count: number; until: number }>();
const credentials = z.object({ email: z.string().max(254), password: z.string().max(256) });
export function appOrigin(c: Context) { return new URL(config.publicUrl ?? c.req.url).origin; }
export function sameOriginMutation(c: Context) {
  return c.req.header('x-opendots-client') === '1' && (!c.req.header('origin') || c.req.header('origin') === appOrigin(c));
}
function throttle(key: string, limit: number, duration: number) {
  const now = Date.now();
  for (const [key, entry] of attempts) if (entry.until <= now) attempts.delete(key);
  const item = attempts.get(key) ?? { count: 0, until: now + duration };
  item.count++; attempts.set(key, item);
  return item.count > limit;
}
const clientIp = (c: Context) => (c.env as any)?.incoming?.socket?.remoteAddress ?? 'local';
const secure = (c: Context) => appOrigin(c).startsWith('https:');
function httpsRequired(c: Context) {
  const origin = new URL(appOrigin(c));
  return origin.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
}
async function openSession(c: Context, accountId: string, options: Parameters<typeof createSession>[1] = {}) {
  const previous = getCookie(c, COOKIE);
  if (previous) await revokeSession(previous); // no session fixation: always a fresh token
  const hours = options.hours ?? 7 * 24;
  setCookie(c, COOKIE, await createSession(accountId, options), { httpOnly: true, secure: secure(c), sameSite: 'Lax', path: '/', maxAge: hours * 3600 });
}
/** SSO errors land on the app with a stable code; the app shows a plain message, never token details. */
const webError = (c: Context, error: unknown) => c.redirect(`/?sso_error=${error instanceof OidcError ? error.code : 'sso_failed'}`, 302);

export function authRoutes() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (c.req.method !== 'GET' && !sameOriginMutation(c)) return c.json({ error: 'Origine non autorisée.' }, 403);
    const length = Number(c.req.header('content-length') ?? 0);
    if (length > 8192) return c.json({ error: 'Requête trop volumineuse.' }, 413);
    return next();
  });
  app.onError((error, c) => {
    if (!(error instanceof AuthError || error instanceof z.ZodError)) console.error('[auth]', error instanceof Error ? error.message : 'error');
    return c.json({ error: error instanceof AuthError || error instanceof z.ZodError ? error.message : 'Connexion impossible.', ...(error instanceof OidcError ? { code: error.code } : {}) }, 400);
  });
  app.get('/me', async (c) => {
    const account = await sessionAccount(getCookie(c, COOKIE));
    const sso = await publicOidc().catch(() => ({ enabled: false, label: 'SSO', localLogin: true }));
    return c.json({ account: account ? publicAccount(account) : null, registrationOpen: process.env.OPENDOTS_REGISTRATION !== 'closed' && sso.localLogin, sso });
  });
  for (const kind of ['login', 'register'] as const) app.post(`/${kind}`, async (c) => {
    if (httpsRequired(c)) return c.json({ error: 'HTTPS est requis pour se connecter ou créer un compte.' }, 403);
    const raw = await c.req.text();
    if (raw.length > 4096) return c.json({ error: 'Requête trop volumineuse.' }, 413);
    const { email, password } = credentials.parse(JSON.parse(raw));
    const ip = clientIp(c);
    if (throttle(`${kind}:ip:${ip}`, kind === 'register' ? 20 : 100, 15 * 60_000) || throttle(`${kind}:email:${email.trim().toLowerCase()}`, 10, 15 * 60_000)) return c.json({ error: 'Trop de tentatives. Réessaie dans 15 minutes.' }, 429);
    const sso = await publicOidc();
    if (kind === 'register' && (process.env.OPENDOTS_REGISTRATION === 'closed' || !sso.localLogin)) return c.json({ error: 'Les inscriptions sont fermées.' }, 403);
    const account = kind === 'register' ? await registerUser(email, password) : await authenticate(email, password);
    // SSO-only: password login stays open for administrators only (break-glass recovery when the IdP fails).
    if (!sso.localLogin && account.role !== 'admin') return c.json({ error: `Connecte-toi avec ${sso.label}.`, code: 'sso_only' }, 403);
    await openSession(c, account.id);
    return c.json({ account: publicAccount(account) });
  });
  app.post('/logout', async (c) => {
    const token = getCookie(c, COOKIE);
    let endSessionUrl: string | null = null;
    if (token) {
      const info = await sessionInfo(token);
      // RP-initiated logout: the IdP session ends too when the provider supports it (not guaranteed by generic OIDC).
      if (info?.via === 'oidc') try {
        const s = await oidcSettings(), d = await oidc.discover(s.issuer);
        if (d.end_session_endpoint) {
          const url = new URL(d.end_session_endpoint);
          if (info.id_token_hint) url.searchParams.set('id_token_hint', withAccount(undefined, () => decryptSecret(info.id_token_hint!)));
          url.searchParams.set('client_id', s.clientId);
          url.searchParams.set('post_logout_redirect_uri', `${appOrigin(c)}/`);
          endSessionUrl = url.href;
        }
      } catch { /* IdP down: the BotCircle session still ends */ }
      await revokeSession(token);
    }
    deleteCookie(c, COOKIE, { path: '/' });
    return c.json({ ok: true, endSessionUrl });
  });

  // ── SSO (OIDC) ────────────────────────────────────────────────────────────
  app.get('/oidc/start', async (c) => {
    const client = c.req.query('client') === 'android' ? 'android' : 'web';
    try {
      if (httpsRequired(c)) throw new OidcError('HTTPS est requis pour le SSO.', 'sso_misconfigured');
      if (throttle(`oidc:ip:${clientIp(c)}`, 60, 15 * 60_000)) throw new OidcError('Trop de tentatives.', 'sso_busy');
      let linkUserId: string | undefined;
      if (c.req.query('mode') === 'link') {
        const account = await sessionAccount(getCookie(c, COOKIE));
        if (!account || client !== 'web') throw new OidcError('Connecte-toi d’abord pour lier ton compte.', 'sso_invalid');
        linkUserId = account.id;
      }
      const started = await oidc.begin({ client, origin: appOrigin(c), returnTo: c.req.query('returnTo'), appChallenge: c.req.query('challenge'), linkUserId });
      if (started.browser) setCookie(c, BROWSER, started.browser, { httpOnly: true, secure: secure(c), sameSite: 'Lax', path: '/api/auth/oidc', maxAge: 600 });
      return c.redirect(started.url, 302);
    } catch (error) {
      if (client === 'android') return c.redirect(`${ANDROID_REDIRECT}?error=${error instanceof OidcError ? error.code : 'sso_failed'}`, 302);
      return webError(c, error);
    }
  });
  app.get('/oidc/callback', async (c) => {
    const browser = getCookie(c, BROWSER);
    deleteCookie(c, BROWSER, { path: '/api/auth/oidc' });
    const client = oidc.clientOf(c.req.query('state')) ?? 'web';
    try {
      const result = await oidc.complete({ origin: appOrigin(c), state: c.req.query('state'), code: c.req.query('code'), error: c.req.query('error'), browser });
      if (result.entry.client === 'android') {
        const code = oidc.issueHandoff(result.user.id, result.entry.appChallenge!, result.user.identity);
        return c.redirect(`${ANDROID_REDIRECT}?code=${code}`, 302);
      }
      if (result.entry.mode === 'link') {
        // The browser must still be signed in as the account that asked for the link.
        const current = await sessionAccount(getCookie(c, COOKIE));
        if (current?.id !== result.user.id) throw new OidcError('Session changée pendant la liaison.', 'sso_invalid');
        return c.redirect('/#/settings?sso=linked', 302);
      }
      const hint = withAccount(undefined, () => encryptSecret(result.idToken));
      await openSession(c, result.user.id, { via: 'oidc', hours: result.settings.sessionHours, idTokenHint: hint });
      return c.redirect(result.entry.returnTo, 302);
    } catch (error) {
      if (!(error instanceof OidcError)) console.error('[oidc] callback', error instanceof Error ? error.message : 'error');
      if (client === 'android') return c.redirect(`${ANDROID_REDIRECT}?error=${error instanceof OidcError ? error.code : 'sso_failed'}`, 302);
      return webError(c, error);
    }
  });
  /** Android: trades the one-time handoff code (+ its PKCE verifier) for an ordinary BotCircle session cookie. */
  app.post('/oidc/exchange', async (c) => {
    if (throttle(`oidc:exchange:${clientIp(c)}`, 30, 15 * 60_000)) return c.json({ error: 'Trop de tentatives.' }, 429);
    const { code, verifier } = z.object({ code: z.string().max(128), verifier: z.string().max(128) }).parse(await c.req.json());
    const handoff = oidc.redeemHandoff(code, verifier);
    const account = await accountById(handoff.userId);
    if (!account) throw new OidcError('Compte introuvable.', 'sso_invalid');
    const s = await oidcSettings();
    await openSession(c, account.id, { via: 'oidc', hours: s.sessionHours });
    return c.json({ account: publicAccount(account) });
  });

  // Linked identities of the signed-in account (no tokens, ever).
  app.get('/identities', async (c) => {
    const account = await sessionAccount(getCookie(c, COOKIE));
    if (!account) return c.json({ error: 'Connexion requise.' }, 401);
    return c.json({ identities: await linkedIdentities(account.id), hasPassword: await hasPassword(account.id) });
  });
  app.delete('/identities', async (c) => {
    const account = await sessionAccount(getCookie(c, COOKIE));
    if (!account) return c.json({ error: 'Connexion requise.' }, 401);
    const { issuer, subject } = z.object({ issuer: z.string().max(512), subject: z.string().max(512) }).parse(await c.req.json());
    await unlinkIdentity(account.id, issuer, subject);
    return c.json({ ok: true });
  });

  // Administration of the SSO configuration.
  const admin = async (c: Context) => {
    const account = await sessionAccount(getCookie(c, COOKIE));
    if (!account) throw new OidcError('Connexion requise.', 'sso_forbidden');
    if (account.role !== 'admin') throw new OidcError('Configuration réservée à l’administrateur.', 'sso_forbidden');
    return account;
  };
  app.get('/oidc/config', async (c) => { await admin(c); return c.json(await adminOidcView(appOrigin(c))); });
  const configInput = z.object({
    enabled: z.boolean().optional(), issuer: z.string().max(512).optional(), clientId: z.string().max(256).optional(), clientSecret: z.string().max(1024).optional(),
    scopes: z.string().max(512).optional(), label: z.string().max(40).optional(), jit: z.boolean().optional(), localLogin: z.boolean().optional(),
    allowedDomains: z.array(z.string().max(253)).max(50).optional(), allowedGroups: z.array(z.string().max(256)).max(50).optional(), adminGroups: z.array(z.string().max(256)).max(50).optional(),
    groupsClaim: z.string().max(64).optional(), sessionHours: z.number().int().min(1).max(720).optional(),
    /** Reauthentication: an administrator with a password confirms it for security-sensitive changes. */
    currentPassword: z.string().max(256).optional(),
  });
  app.put('/oidc/config', async (c) => {
    const actor = await admin(c);
    const { currentPassword, ...input } = configInput.parse(await c.req.json());
    if (await hasPassword(actor.id)) {
      if (throttle(`oidc:reauth:${actor.id}`, 10, 15 * 60_000)) return c.json({ error: 'Trop de tentatives. Réessaie dans 15 minutes.' }, 429);
      try { await authenticate(actor.email, currentPassword ?? ''); } catch { return c.json({ error: 'Confirme ton mot de passe actuel.', code: 'reauth_required' }, 403); }
    }
    // Never lock everyone out: SSO-only needs a working configuration and an administrator with a password.
    if (input.localLogin === false && !(await hasPassword(actor.id))) return c.json({ error: 'Garde au moins un administrateur avec mot de passe avant d’activer le SSO seul.', code: 'sso_lockout' }, 400);
    await saveOidcSettings(input, actor);
    return c.json(await adminOidcView(appOrigin(c)));
  });
  /** Discovery test: shows the endpoints found at the issuer, without saving anything. */
  app.post('/oidc/test', async (c) => {
    const actor = await admin(c);
    const { issuer } = z.object({ issuer: z.string().max(512).optional() }).parse(await c.req.json().catch(() => ({})));
    const target = (issuer || (await oidcSettings()).issuer).trim().replace(/\/+$/, '');
    if (!target) throw new OidcError('Renseigne l’issuer.', 'sso_misconfigured');
    const url = new URL(target);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new OidcError('L’issuer doit être en HTTPS.', 'sso_misconfigured');
    const d = await oidc.discover(target, true);
    await audit(actor.id, 'oidc.test', { issuer: target });
    return c.json({ issuer: d.issuer, authorization_endpoint: d.authorization_endpoint, token_endpoint: d.token_endpoint, jwks_uri: d.jwks_uri, end_session_endpoint: d.end_session_endpoint ?? null, userinfo_endpoint: d.userinfo_endpoint ?? null, code_challenge_methods_supported: d.code_challenge_methods_supported ?? null });
  });
  return app;
}

export function requireAccount(activate: (account: AccountContext) => Promise<void>): MiddlewareHandler {
  return async (c, next) => {
    const token = getCookie(c, COOKIE);
    let account = await sessionAccount(token);
    const hook = /^\/api\/hooks\/(usr_[a-f0-9]{32})\/[^/]+$/.exec(c.req.path);
    if (hook && c.req.method === 'POST') account = await accountById(hook[1]);
    if (!account) return c.json({ error: 'Connexion requise.' }, 401);
    if (!['GET', 'HEAD'].includes(c.req.method) && !hook && !sameOriginMutation(c)) return c.json({ error: 'Origine non autorisée.' }, 403);
    const actor = account;
    return withAccount(actor, async () => {
      await activate(actor); await next();
      if (token && c.res.body && c.res.headers.get('content-type')?.startsWith('text/event-stream') && c.req.path !== '/api/events') {
        c.res = new Response(await sessionStream(c.res.body, token), { status: c.res.status, headers: c.res.headers });
      }
    });
  };
}
