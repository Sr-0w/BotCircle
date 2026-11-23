import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { createApplication } from '../src/app.ts';
import { authStore, closeAuthStore, promoteAdmin } from '../src/auth/store.ts';
import { closeAllDatabases, openDatabase } from '../src/db/client.ts';

/**
 * #77 — OIDC SSO against a fake, standards-conforming provider (Authentik-shaped issuer with a trailing slash).
 * Every security property of the flow has a negative test here.
 */
const ISSUER = 'https://idp.example/application/o/botcircle/';
const CLIENT_ID = 'botcircle-client', CLIENT_SECRET = 'idp-client-secret-value-0123456789';
const app = createApplication(async () => { await openDatabase({ memory: true }); });
const sha = (v: string) => createHash('sha256').update(v).digest('base64url');

type Keys = { kid: string; privateKey: CryptoKey; jwk: JWK };
async function keyPair(kid: string): Promise<Keys> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  return { kid, privateKey: privateKey as CryptoKey, jwk: { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' } };
}
const idp = {
  keys: [] as Keys[], signer: undefined as Keys | undefined,
  codes: new Map<string, { challenge: string; nonce: string; redirect: string }>(),
  user: {} as Record<string, unknown>,
  override: {} as Record<string, unknown>,
  discovery: {} as Record<string, unknown>,
  tokenCalls: 0,
};
async function idToken(nonce: string, extra: Record<string, unknown> = {}) {
  const signer = idp.signer!;
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: ISSUER, aud: CLIENT_ID, iat: now, exp: now + 300, nonce, ...idp.user, ...extra }).setProtectedHeader({ alg: 'RS256', kid: signer.kid }).sign(signer.privateKey);
}
const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  if (url.href === `${ISSUER}.well-known/openid-configuration`) return json({
    issuer: ISSUER, authorization_endpoint: 'https://idp.example/application/o/authorize/', token_endpoint: 'https://idp.example/application/o/token/',
    jwks_uri: `${ISSUER}jwks/`, end_session_endpoint: `${ISSUER}end-session/`, userinfo_endpoint: 'https://idp.example/application/o/userinfo/',
    code_challenge_methods_supported: ['plain', 'S256'], token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'], id_token_signing_alg_values_supported: ['RS256'], ...idp.discovery,
  });
  if (url.href === `${ISSUER}jwks/`) return json({ keys: idp.keys.map((k) => k.jwk) });
  if (url.href === 'https://idp.example/application/o/token/') {
    idp.tokenCalls++;
    const body = new URLSearchParams(String(init?.body));
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    if (auth !== `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`) return json({ error: 'invalid_client' }, 401);
    const grant = idp.codes.get(body.get('code') ?? '');
    idp.codes.delete(body.get('code') ?? '');
    if (!grant || sha(body.get('code_verifier') ?? '') !== grant.challenge || body.get('redirect_uri') !== grant.redirect) return json({ error: 'invalid_grant' }, 400);
    return json({ access_token: 'idp-access-token', token_type: 'Bearer', expires_in: 300, id_token: await idToken(grant.nonce, idp.override) });
  }
  throw new Error(`unexpected fetch ${url.href}`);
});

const call = (path: string, method = 'GET', body?: unknown, cookie?: string, headers: Record<string, string> = {}) => app.request(`https://app.example/api${path}`, { method, headers: { 'content-type': 'application/json', 'x-opendots-client': '1', ...(cookie ? { cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
const cookieOf = (res: Response, name: string) => res.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`) && c.length > name.length + 1);
/** Simulates the IdP: user authenticates (MFA etc. are the IdP's business) and is redirected back with a code. */
function authorize(location: string) {
  const url = new URL(location);
  expect(url.origin + url.pathname).toBe('https://idp.example/application/o/authorize/');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('response_type')).toBe('code');
  expect(url.searchParams.get('scope')).toBe('openid profile email');
  const code = randomBytes(16).toString('hex');
  idp.codes.set(code, { challenge: url.searchParams.get('code_challenge')!, nonce: url.searchParams.get('nonce')!, redirect: url.searchParams.get('redirect_uri')! });
  return { code, state: url.searchParams.get('state')!, nonce: url.searchParams.get('nonce')!, redirect: url.searchParams.get('redirect_uri')! };
}
async function webLogin(cookie = '', returnTo = '/') {
  const start = await call(`/auth/oidc/start?client=web&returnTo=${encodeURIComponent(returnTo)}`, 'GET', undefined, cookie);
  expect(start.status).toBe(302);
  const browser = cookieOf(start, 'od_oidc')!;
  const grant = authorize(start.headers.get('location')!);
  const back = await call(`/auth/oidc/callback?state=${grant.state}&code=${grant.code}`, 'GET', undefined, [cookie, browser].filter(Boolean).join('; '));
  return { back, session: cookieOf(back, 'opendots_session'), grant, browser };
}

let adminCookie = '';
const configure = (patch: Record<string, unknown>, cookie = adminCookie) => call('/auth/oidc/config', 'PUT', { currentPassword: 'admin password 123', ...patch }, cookie);
beforeAll(async () => {
  vi.stubGlobal('fetch', fakeFetch);
  await authStore(true);
  idp.signer = await keyPair('k1'); idp.keys = [idp.signer];
  const res = await call('/auth/register', 'POST', { email: 'admin@example.com', password: 'admin password 123' });
  await promoteAdmin('admin@example.com');
  adminCookie = cookieOf(res, 'opendots_session')!;
  expect((await configure({ enabled: true, issuer: ISSUER, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, jit: true, label: 'Authentik' })).status).toBe(200);
});
afterAll(async () => { vi.unstubAllGlobals(); await closeAllDatabases(); await closeAuthStore(); });
beforeEach(() => { idp.user = { sub: `sub-${randomBytes(6).toString('hex')}`, email: `u${randomBytes(4).toString('hex')}@example.com`, email_verified: true, name: 'Test User', groups: [] }; idp.override = {}; idp.discovery = {}; });

describe('SSO OIDC — configuration', () => {
  it('ne renvoie jamais le secret, refuse les non-admins, exige la réauthentification', async () => {
    const view = await (await call('/auth/oidc/config', 'GET', undefined, adminCookie)).json();
    expect(view).toMatchObject({ enabled: true, issuer: ISSUER.replace(/\/$/, ''), clientId: CLIENT_ID, hasSecret: true, callbackUrl: 'https://app.example/api/auth/oidc/callback', androidRedirect: 'botcircle://auth/callback' });
    expect(JSON.stringify(view)).not.toContain(CLIENT_SECRET);
    const user = cookieOf(await call('/auth/register', 'POST', { email: 'plain@example.com', password: 'plain password 123' }), 'opendots_session')!;
    expect((await call('/auth/oidc/config', 'GET', undefined, user)).status).toBe(400);
    expect((await configure({ label: 'X' }, user)).status).toBe(400);
    expect((await call('/auth/oidc/config', 'PUT', { label: 'X', currentPassword: 'wrong password' }, adminCookie)).status).toBe(403);
    const stored = await (await authStore()).query<{ value: string }>("SELECT value FROM instance_settings WHERE key='oidc'");
    expect(stored.rows[0].value).not.toContain(CLIENT_SECRET); // encrypted at rest
    const audit = await (await authStore()).query<{ detail: string }>("SELECT detail FROM auth_audit WHERE action='oidc.config'");
    expect(audit.rows.length).toBeGreaterThan(0); expect(audit.rows.map((r) => r.detail).join()).not.toContain(CLIENT_SECRET);
  });
  it('teste la découverte et refuse un issuer différent', async () => {
    const ok = await (await call('/auth/oidc/test', 'POST', { issuer: ISSUER }, adminCookie)).json();
    expect(ok).toMatchObject({ issuer: ISSUER, end_session_endpoint: `${ISSUER}end-session/` });
    idp.discovery = { issuer: 'https://evil.example/' };
    const bad = await call('/auth/oidc/test', 'POST', { issuer: ISSUER }, adminCookie);
    expect(bad.status).toBe(400); expect((await bad.json()).code).toBe('sso_misconfigured');
    expect((await call('/auth/oidc/test', 'POST', { issuer: 'http://idp.example/x' }, adminCookie)).status).toBe(400);
  });
  it('expose le bouton sur /me sans détails sensibles', async () => {
    const me = await (await call('/auth/me')).json();
    expect(me.sso).toEqual({ enabled: true, label: 'Authentik', localLogin: true });
  });
});

describe('SSO OIDC — connexion Web', () => {
  it('code + PKCE + state + nonce : crée le compte JIT, ouvre une session et revient à la destination', async () => {
    const { back, session } = await webLogin('', '/#/settings');
    expect(back.status).toBe(302); expect(back.headers.get('location')).toBe('/#/settings');
    expect(session).toBeTruthy();
    const set = back.headers.getSetCookie().join('\n');
    expect(set).toMatch(/opendots_session=.*HttpOnly.*Secure|opendots_session=.*Secure.*HttpOnly/);
    const me = await (await call('/auth/me', 'GET', undefined, session)).json();
    expect(me.account).toMatchObject({ email: idp.user.email, role: 'user' });
    // Same (issuer, sub) next time → same account.
    const again = await webLogin();
    expect((await (await call('/auth/me', 'GET', undefined, again.session)).json()).account.id).toBe(me.account.id);
  });
  it('le nom vérifié remplit le profil jamais renseigné, sans écraser une modification manuelle', async () => {
    idp.user.given_name = 'Ada'; idp.user.family_name = 'Lovelace';
    const { session } = await webLogin();
    expect(await (await call('/profile', 'GET', undefined, session)).json()).toEqual({ firstName: 'Ada', lastName: 'Lovelace' });
    expect((await call('/profile', 'PUT', { firstName: 'Augusta', lastName: null }, session)).status).toBe(200);
    idp.user.given_name = 'Changed';
    const again = await webLogin();
    expect(await (await call('/profile', 'GET', undefined, again.session)).json()).toEqual({ firstName: 'Augusta', lastName: null });
  });
  it('refuse un état rejoué, un autre navigateur et une redirection ouverte', async () => {
    const start = await call('/auth/oidc/start?client=web&returnTo=//evil.example/x');
    const browser = cookieOf(start, 'od_oidc')!;
    const grant = authorize(start.headers.get('location')!);
    const other = await call(`/auth/oidc/callback?state=${grant.state}&code=${grant.code}`, 'GET', undefined, 'od_oidc=someone-else');
    expect(other.headers.get('location')).toBe('/?sso_error=sso_invalid');
    const ok = await call(`/auth/oidc/callback?state=${grant.state}&code=${grant.code}`, 'GET', undefined, browser);
    expect(ok.headers.get('location')).toBe('/'); // //evil.example dropped
    const replay = await call(`/auth/oidc/callback?state=${grant.state}&code=${grant.code}`, 'GET', undefined, browser);
    expect(replay.headers.get('location')).toBe('/?sso_error=sso_expired');
    expect(cookieOf(replay, 'opendots_session')).toBeUndefined();
  });
  it('vérifie nonce, audience, expiration et signature du jeton d’identité', async () => {
    for (const [override, label] of [[{ nonce: 'other-nonce' }, 'nonce'], [{ aud: 'another-client' }, 'aud'], [{ exp: Math.floor(Date.now() / 1000) - 3600 }, 'exp'], [{ iss: 'https://evil.example/' }, 'iss']] as const) {
      idp.override = override;
      const { back, session } = await webLogin();
      expect(back.headers.get('location'), label).toBe('/?sso_error=sso_invalid');
      expect(session, label).toBeUndefined();
    }
    // Signed by a key that is not in the provider's JWKS.
    const rogue = await keyPair('k1'); const real = idp.signer; idp.signer = rogue;
    expect((await webLogin()).back.headers.get('location')).toBe('/?sso_error=sso_invalid');
    idp.signer = real;
  });
  it('suit la rotation des clés de signature (nouveau kid → JWKS rechargé)', async () => {
    const next = await keyPair('k2');
    idp.keys = [idp.signer!, next]; idp.signer = next;
    const { session } = await webLogin();
    expect(session).toBeTruthy();
  });
  it('refus de consentement et annulation : aucun compte, aucun échange', async () => {
    const start = await call('/auth/oidc/start?client=web');
    const browser = cookieOf(start, 'od_oidc')!;
    const { state } = authorize(start.headers.get('location')!);
    const calls = idp.tokenCalls;
    const res = await call(`/auth/oidc/callback?state=${state}&error=access_denied`, 'GET', undefined, browser);
    expect(res.headers.get('location')).toBe('/?sso_error=sso_denied'); expect(idp.tokenCalls).toBe(calls);
  });
  it('ne fusionne jamais sur l’adresse e-mail, même vérifiée', async () => {
    idp.user.email = 'admin@example.com';
    const { back, session } = await webLogin();
    expect(back.headers.get('location')).toBe('/?sso_error=sso_conflict'); expect(session).toBeUndefined();
    const linked = await (await authStore()).query("SELECT 1 FROM identities i JOIN users u ON u.id=i.user_id WHERE u.email='admin@example.com'");
    expect(linked.rows.length).toBe(0);
  });
  it('JIT désactivé : identité inconnue refusée ; e-mail non vérifié refusé', async () => {
    await configure({ jit: false });
    expect((await webLogin()).back.headers.get('location')).toBe('/?sso_error=sso_unlinked');
    await configure({ jit: true });
    idp.user.email_verified = false;
    expect((await webLogin()).back.headers.get('location')).toBe('/?sso_error=sso_unlinked');
  });
  it('groupes autorisés et groupes administrateurs explicites', async () => {
    await configure({ allowedGroups: ['botcircle-users'], adminGroups: ['botcircle-admins'] });
    idp.user.groups = ['other'];
    expect((await webLogin()).back.headers.get('location')).toBe('/?sso_error=sso_forbidden');
    idp.user.groups = ['botcircle-users'];
    const user = await webLogin();
    expect((await (await call('/auth/me', 'GET', undefined, user.session)).json()).account.role).toBe('user');
    idp.user.groups = ['botcircle-users', 'botcircle-admins'];
    const admin = await webLogin();
    expect((await (await call('/auth/me', 'GET', undefined, admin.session)).json()).account.role).toBe('admin');
    idp.user.groups = ['botcircle-users']; // removed from the admin group → demoted at next login
    const demoted = await webLogin();
    expect((await (await call('/auth/me', 'GET', undefined, demoted.session)).json()).account.role).toBe('user');
    await configure({ allowedGroups: [], adminGroups: [] });
  });
});

describe('SSO OIDC — compte existant, SSO seul, déconnexion', () => {
  it('lie un compte local existant via un flux authentifié, sans perte, puis délie', async () => {
    const local = await call('/auth/register', 'POST', { email: 'local@example.com', password: 'local password 123' });
    const cookie = cookieOf(local, 'opendots_session')!;
    const id = (await local.json()).account.id;
    const start = await call('/auth/oidc/start?client=web&mode=link', 'GET', undefined, cookie);
    const browser = cookieOf(start, 'od_oidc')!;
    const grant = authorize(start.headers.get('location')!);
    const back = await call(`/auth/oidc/callback?state=${grant.state}&code=${grant.code}`, 'GET', undefined, `${cookie}; ${browser}`);
    expect(back.headers.get('location')).toBe('/#/settings?sso=linked');
    const list = await (await call('/auth/identities', 'GET', undefined, cookie)).json();
    expect(list).toMatchObject({ hasPassword: true, identities: [{ issuer: ISSUER, subject: idp.user.sub }] });
    expect(JSON.stringify(list)).not.toMatch(/token/i);
    const sso = await webLogin();
    expect((await (await call('/auth/me', 'GET', undefined, sso.session)).json()).account.id).toBe(id);
    expect((await call('/auth/identities', 'DELETE', { issuer: ISSUER, subject: idp.user.sub }, cookie)).status).toBe(200);
    await configure({ jit: false });
    expect((await webLogin()).back.headers.get('location')).toBe('/?sso_error=sso_unlinked');
    await configure({ jit: true });
  });
  it('un compte SSO sans mot de passe ne peut ni se connecter par mot de passe ni délier sa seule identité', async () => {
    const { session } = await webLogin();
    expect((await call('/auth/login', 'POST', { email: idp.user.email, password: '!' })).status).toBe(400);
    const res = await call('/auth/identities', 'DELETE', { issuer: ISSUER, subject: idp.user.sub }, session);
    expect((await res.json()).code).toBe('sso_lockout');
  });
  it('SSO seul : mot de passe refusé aux utilisateurs, gardé pour l’administrateur (secours)', async () => {
    await call('/auth/register', 'POST', { email: 'user2@example.com', password: 'user2 password 123' });
    await configure({ localLogin: false });
    expect((await (await call('/auth/me')).json()).registrationOpen).toBe(false);
    const user = await call('/auth/login', 'POST', { email: 'user2@example.com', password: 'user2 password 123' });
    expect(user.status).toBe(403); expect((await user.json()).code).toBe('sso_only');
    expect((await call('/auth/login', 'POST', { email: 'admin@example.com', password: 'admin password 123' })).status).toBe(200);
    process.env.OPENDOTS_OIDC = 'off'; // break-glass switch for an IdP outage
    expect((await call('/auth/login', 'POST', { email: 'user2@example.com', password: 'user2 password 123' })).status).toBe(200);
    delete process.env.OPENDOTS_OIDC;
    await configure({ localLogin: true });
  });
  it('déconnexion : session révoquée et URL de fin de session du fournisseur', async () => {
    const { session } = await webLogin();
    const out = await (await call('/auth/logout', 'POST', undefined, session)).json();
    const url = new URL(out.endSessionUrl);
    expect(url.origin + url.pathname).toBe(`${ISSUER}end-session/`);
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('https://app.example/');
    expect(url.searchParams.get('id_token_hint')).toBeTruthy();
    expect((await (await call('/auth/me', 'GET', undefined, session)).json()).account).toBeNull();
  });
  it('fournisseur injoignable : message clair, connexion par mot de passe intacte', async () => {
    fakeFetch.mockImplementationOnce(async () => { throw new TypeError('fetch failed'); });
    const { oidc } = await import('../src/auth/oidc.ts');
    await expect(oidc.discover('https://down.example')).rejects.toMatchObject({ code: 'sso_unavailable' });
    expect((await call('/auth/login', 'POST', { email: 'admin@example.com', password: 'admin password 123' })).status).toBe(200);
  });
});

describe('SSO OIDC — Android (Custom Tabs + code de remise lié au PKCE de l’app)', () => {
  it('remise à usage unique, inutilisable sans le vérificateur de l’app', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const start = await call(`/auth/oidc/start?client=android&challenge=${sha(verifier)}`);
    expect(cookieOf(start, 'od_oidc')).toBeUndefined();
    const grant = authorize(start.headers.get('location')!);
    const back = await call(`/auth/oidc/callback?state=${grant.state}&code=${grant.code}`);
    const location = new URL(back.headers.get('location')!);
    expect(`${location.protocol}//${location.host}${location.pathname}`).toBe('botcircle://auth/callback');
    const code = location.searchParams.get('code')!;
    expect((await call('/auth/oidc/exchange', 'POST', { code, verifier: randomBytes(32).toString('base64url') })).status).toBe(400);
    // The failed attempt burned the code: an intercepted code is single-use too.
    expect((await call('/auth/oidc/exchange', 'POST', { code, verifier })).status).toBe(400);
    const verifier2 = randomBytes(32).toString('base64url');
    const start2 = await call(`/auth/oidc/start?client=android&challenge=${sha(verifier2)}`);
    const grant2 = authorize(start2.headers.get('location')!);
    const code2 = new URL((await call(`/auth/oidc/callback?state=${grant2.state}&code=${grant2.code}`)).headers.get('location')!).searchParams.get('code')!;
    const ok = await call('/auth/oidc/exchange', 'POST', { code: code2, verifier: verifier2 });
    expect(ok.status).toBe(200);
    const session = cookieOf(ok, 'opendots_session')!;
    expect((await (await call('/auth/me', 'GET', undefined, session)).json()).account.email).toBe(idp.user.email);
  });
  it('erreurs renvoyées à l’app par son schéma', async () => {
    const res = await call('/auth/oidc/start?client=android&challenge=short');
    expect(res.headers.get('location')).toBe('botcircle://auth/callback?error=sso_invalid');
  });
});
