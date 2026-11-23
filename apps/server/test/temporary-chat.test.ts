import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import sharp from 'sharp';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import { requireAccount } from '../src/auth/routes.ts';
import { authStore, closeAuthStore, createSession, registerUser, revokeSession } from '../src/auth/store.ts';
import { temporaryRoutes } from '../src/temporary/routes.ts';
import { IDLE_MS, LIFETIME_MS, TemporaryStore } from '../src/temporary/store.ts';
import { withAccount, type AccountContext } from '../src/auth/context.ts';
import { closeAllDatabases, db, openDatabase, schema } from '../src/db/client.ts';
import { createAgent, mainConversationId } from '../src/agents/repo.ts';
import { loadMessages, saveMessage } from '../src/conversations/repo.ts';

describe('RAM lifecycle', () => {
  it('isolates owners, bounds sessions, expires idle data and aborts inference', () => {
    let now = 0;
    const store = new TemporaryStore(() => now);
    const session = store.create('user:login');
    expect(() => store.get(session.id, 'other:login')).toThrow(/expiré/);
    expect(() => store.get(session.id, 'user:other-login')).toThrow(/expiré/);
    const abort = store.begin(session, 'secret');
    expect(() => store.begin(session, 'other')).toThrow(/cours/);
    session.messages.push({ role: 'user', content: 'secret' });
    const cleanup = vi.fn(); session.cleanup = cleanup;
    now = IDLE_MS;
    store.sweep();
    expect(abort.signal.aborted).toBe(true);
    expect(session.messages).toEqual([]);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(() => store.get(session.id, 'user:login')).toThrow();
    store.create('user'); store.create('user'); store.create('user');
    expect(() => store.create('user')).toThrow(/Trop/);
    store.close();
  });

  it('renews idle retention on every authenticated access (GET keepalive included) but never past the safety cap', () => {
    let now = 0;
    const store = new TemporaryStore(() => now);
    const idle = store.create('user');
    now = IDLE_MS - 1;
    store.get(idle.id, 'user'); // keepalive renews
    now += IDLE_MS - 1;
    expect(store.get(idle.id, 'user').id).toBe(idle.id);
    now += IDLE_MS; // a whole idle window without keepalive
    expect(() => store.get(idle.id, 'user')).toThrow();
    expect(LIFETIME_MS).toBe(12 * 60 * 60_000);
    now = 0;
    const kept = store.create('user');
    for (now = 0; now < LIFETIME_MS - IDLE_MS; now += IDLE_MS - 1) store.get(kept.id, 'user');
    expect(store.get(kept.id, 'user').id).toBe(kept.id); // alive well beyond the old 30 min cap
    now = LIFETIME_MS;
    expect(() => store.get(kept.id, 'user')).toThrow();
  });

  it('caps context without silently truncating or converting it to a summary', () => {
    const store = new TemporaryStore();
    const session = store.create('user');
    session.messages.push({ role: 'user', content: 'x'.repeat(100_000) });
    expect(() => store.begin(session, 'extra')).toThrow(/Limite/);
    store.discard(session);
  });
});

describe('authenticated temporary API', () => {
  let account: AccountContext, token: string, secondToken: string, otherToken: string;
  let store: TemporaryStore, app: Hono, model: MockLanguageModelV4;
  let options: any;
  let mode: 'success' | 'failure' | 'slow';
  let now = Date.now();
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  const modelConfig = { provider: 'ollama', model: 'fixture' };
  const headers = (t = token) => ({ cookie: `opendots_session=${t}`, origin: 'http://localhost', 'x-opendots-client': '1', 'content-type': 'application/json' });
  const call = (path = '', method = 'GET', body?: unknown, t = token, signal?: AbortSignal) =>
    app.request(`http://localhost/api/temporary-chats${path}`, { method, headers: headers(t), body: body === undefined ? undefined : JSON.stringify(body), signal });
  const create = async () => {
    const res = await call('', 'POST');
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string };
  };
  const turn = (id: string, text = 'sensitive prompt', signal?: AbortSignal) => call(`/${id}/turn`, 'POST', { text, model: modelConfig }, token, signal);

  beforeAll(async () => {
    await authStore(true);
    account = await registerUser('temporary@test.example', 'temporary test password');
    token = await createSession(account.id); secondToken = await createSession(account.id);
    const other = await registerUser('other-temp@test.example', 'other temporary password');
    otherToken = await createSession(other.id);
    await withAccount(account, () => openDatabase({ memory: true }));
  });
  afterAll(async () => { store.close(); await closeAllDatabases(); await closeAuthStore(); });
  beforeEach(() => {
    store?.close();
    now = Date.now(); mode = 'success'; options = undefined;
    store = new TemporaryStore(() => now);
    model = new MockLanguageModelV4({ doStream: async (input: any) => {
      options = input;
      return { stream: new ReadableStream({ start(controller) {
        if (mode === 'failure') { controller.error(new Error('sensitive prompt + provider secret')); return; }
        controller.enqueue({ type: 'stream-start', warnings: [] });
        controller.enqueue({ type: 'text-start', id: 'reply' });
        controller.enqueue({ type: 'text-delta', id: 'reply', delta: 'Réponse éphémère' });
        if (mode === 'slow') input.abortSignal.addEventListener('abort', () => controller.error(new Error('sensitive cancellation')), { once: true });
        else {
          controller.enqueue({ type: 'text-end', id: 'reply' });
          controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage });
          controller.close();
        }
      } }), warnings: [] } as any;
    } });
    app = new Hono();
    app.use('/api/*', requireAccount(async () => {}));
    app.route('/api/temporary-chats', temporaryRoutes(store, async () => ({ model, label: 'fixture', providerOptions: {} })));
  });

  it('requires authentication and standard origin protection', async () => {
    expect((await app.request('http://localhost/api/temporary-chats', { method: 'POST' })).status).toBe(401);
    expect((await app.request('http://localhost/api/temporary-chats', { method: 'POST', headers: { ...headers(), origin: 'https://evil.example' } })).status).toBe(403);
  });

  it('scopes read, write, stop and delete to both user AND authenticated session', async () => {
    const { id } = await create();
    for (const t of [otherToken, secondToken])
      for (const [path, method, body] of [
        [`/${id}`, 'GET', undefined], [`/${id}`, 'DELETE', undefined],
        [`/${id}/stop`, 'POST', undefined], [`/${id}/turn`, 'POST', { text: 'steal', model: modelConfig }],
      ] as const) expect((await call(path, method, body, t)).status).toBe(404);
    expect((await call(`/${id}`)).status).toBe(200);
  });

  it('streams, reconnects to completed context, changes model per turn without durable writes', async () => {
    await withAccount(account, async () => {
      const agent = await createAgent({ name: 'Normal control' });
      const conversation = await mainConversationId(agent.id);
      await saveMessage(conversation, { id: 'normal-control', role: 'user', parts: [{ type: 'text', text: 'keep normal history' }] }, { author: 'user' });
      const counts = async () => Promise.all([
        db().select().from(schema.messages), db().select().from(schema.conversations),
        db().select().from(schema.memories), db().select().from(schema.jobs),
        db().select().from(schema.agents), db().select().from(schema.journal),
      ]);
      const before = await counts();
      const { id } = await create();
      const first = await turn(id);
      expect(first.headers.get('cache-control')).toBe('no-store');
      expect(await first.text()).toContain('event: done');
      const snapshot = await (await call(`/${id}`)).json() as any;
      expect(snapshot.messages.map((m: any) => m.content)).toEqual(['sensitive prompt', 'Réponse éphémère']);
      const second = await call(`/${id}/turn`, 'POST', { text: 'continue', model: { provider: 'openrouter', model: 'new-model' } });
      expect(await second.text()).toContain('event: done');
      expect(options.prompt.filter((m: any) => m.role !== 'system')).toHaveLength(3);
      expect(options.tools ?? []).toHaveLength(0);
      expect(options.toolChoice).toEqual({ type: 'none' });
      expect((await (await call(`/${id}`)).json() as any).messages[3].model.model).toBe('new-model');
      expect((await call(`/${id}`, 'DELETE')).status).toBe(200);
      expect((await call(`/${id}`)).status).toBe(404);
      expect(await counts()).toEqual(before);
      expect((await loadMessages(conversation)).messages[0].id).toBe('normal-control');
      expect((await create()).id).not.toBe(id);
    });
  });

  it('rejects uploads, tool/worker flags, foreign IDs and Codex rather than trusting client controls', async () => {
    const { id } = await create();
    for (const extra of [{ attachments: ['secret'] }, { tools: ['remember'] }, { delegate: 'agent' }, { conversationId: 'normal' }]) {
      expect((await call(`/${id}/turn`, 'POST', { text: 'secret', model: modelConfig, ...extra })).status).toBe(400);
    }
    expect((await call(`/${id}/turn`, 'POST', { text: 'secret', model: { provider: 'codex', model: 'x' } })).status).toBe(400);
    expect((await call(`/${id}/turn`, 'POST', { text: 'x'.repeat(16001), model: modelConfig })).status).toBe(400);
    expect(options).toBeUndefined();
  });

  it('redacts provider failures from logs and responses, rolls back incomplete turns', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mode = 'failure';
      const { id } = await create();
      const output = await (await turn(id)).text();
      expect(output).toContain('event: failure');
      expect(output).not.toMatch(/sensitive|secret/);
      expect(log).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled();
      expect((await (await call(`/${id}`)).json() as any).messages).toEqual([]);
      mode = 'success'; expect(await (await turn(id)).text()).toContain('event: done');
    } finally { log.mockRestore(); warn.mockRestore(); }
  });

  it('redacts model-resolution diagnostics before any stream exists', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      app = new Hono();
      app.use('/api/*', requireAccount(async () => {}));
      app.route('/api/temporary-chats', temporaryRoutes(store, async () => { throw new Error('sensitive prompt + credentials'); }));
      const { id } = await create();
      const res = await turn(id);
      expect(res.status).toBe(400);
      expect(await res.text()).not.toMatch(/sensitive|credentials/);
      expect(log).not.toHaveBeenCalled();
      expect((await (await call(`/${id}`)).json() as any)).toMatchObject({ busy: false, messages: [] });
    } finally { log.mockRestore(); }
  });

  for (const action of ['stop', 'delete', 'expiry', 'disconnect', 'logout', 'timeout'] as const)
    it(`cancels inference on ${action}, without orphaned activity or partial history`, async () => {
      mode = 'slow';
      // Use a separate login so logout doesn't invalidate the fixture.
      if (action === 'logout') token = await createSession(account.id);
      const { id } = await create();
      if (action === 'timeout') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const abort = new AbortController();
        const res = await turn(id, 'sensitive prompt', abort.signal);
        const reader = res.body!.getReader();
        await reader.read(); // inference has emitted a delta and is still running
        expect((await turn(id, 'concurrent')).status).toBe(409);
        if (action === 'stop') await call(`/${id}/stop`, 'POST');
        if (action === 'delete') await call(`/${id}`, 'DELETE');
        if (action === 'expiry') { now += IDLE_MS; store.sweep(); }
        if (action === 'disconnect') abort.abort();
        if (action === 'logout') await revokeSession(token);
        if (action === 'timeout') await vi.advanceTimersByTimeAsync(120_000);
        while (!(await reader.read()).done) { /* drain the redacted stop/failure event */ }
        expect(options.abortSignal.aborted).toBe(true);
        if (action === 'logout') token = await createSession(account.id);
        const next = await call(`/${id}`);
        if (action === 'stop' || action === 'disconnect' || action === 'timeout') {
          expect((await next.json() as any).messages).toEqual([]);
          mode = 'success'; expect(await (await turn(id)).text()).toContain('event: done');
        } else expect(next.status).toBe(404);
      } finally { if (action === 'timeout') vi.useRealTimers(); }
    });

  describe('attachments (RAM only)', () => {
    const b64 = (data: Buffer | string) => Buffer.from(data).toString('base64');
    const attach = (id: string, text: string, attachments: unknown[]) => call(`/${id}/turn`, 'POST', { text, model: modelConfig, attachments });
    const png = () => sharp({ create: { width: 16, height: 16, channels: 3, background: '#cc2200' } }).png().toBuffer();
    const listing = async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      const walk = async (d: string) => {
        for (const entry of await readdir(d, { withFileTypes: true }).catch(() => [])) {
          const path = join(d, entry.name);
          if (entry.isDirectory()) await walk(path); else out.push(`${path}:${(await stat(path)).size}`);
        }
      };
      await walk(dir);
      return out.sort();
    };

    it('feeds images and text files to the model, keeps them for later turns, and returns metadata only', async () => {
      const { id } = await create();
      const image = await png();
      const res = await attach(id, 'regarde', [
        { name: 'rouge.png', mediaType: 'image/png', data: b64(image) },
        { name: 'notes.txt', mediaType: 'text/plain', data: b64('secret-file-content') },
      ]);
      expect(await res.text()).toContain('event: done');
      const user = options.prompt.filter((m: any) => m.role === 'user').at(-1).content;
      expect(user.some((p: any) => p.type === 'file' && p.mediaType === 'image/jpeg')).toBe(true);
      expect(JSON.stringify(user)).toContain('secret-file-content');
      const snapshot = await (await call(`/${id}`)).json() as any;
      expect(snapshot.messages[0].attachments).toEqual([
        { name: 'rouge.png', mediaType: 'image/png', size: image.length },
        { name: 'notes.txt', mediaType: 'text/plain', size: 'secret-file-content'.length },
      ]);
      expect(JSON.stringify(snapshot)).not.toContain(b64('secret-file-content'));
      expect(JSON.stringify(snapshot)).not.toContain('files');
      // A later turn still sees both files.
      expect(await (await turn(id, 'et ensuite ?')).text()).toContain('event: done');
      const earlier = options.prompt.filter((m: any) => m.role === 'user')[0].content;
      expect(earlier.some((p: any) => p.type === 'file' && p.mediaType === 'image/jpeg')).toBe(true);
      expect(JSON.stringify(earlier)).toContain('secret-file-content');
    });

    it('accepts attachments without text, rejects an empty message', async () => {
      const { id } = await create();
      expect((await call(`/${id}/turn`, 'POST', { text: '', model: modelConfig })).status).toBe(400);
      const res = await attach(id, '', [{ name: 'a.txt', mediaType: 'text/plain', data: b64('hello') }]);
      expect(await res.text()).toContain('event: done');
    });

    it('enforces count, per-file, per-turn and per-session limits with fixed messages', async () => {
      const { id } = await create();
      const small = { name: 'a.txt', mediaType: 'text/plain', data: b64('x') };
      const tooMany = await attach(id, 'x', Array(6).fill(small));
      expect(tooMany.status).toBe(400);
      expect((await tooMany.json() as any).error).toMatch(/5 pièces jointes/);
      const big = (n: number) => ({ name: 'big.bin', mediaType: 'application/octet-stream', data: b64(Buffer.alloc(Math.floor(n), 1)) });
      const file = await attach(id, 'x', [big(10 * 1024 * 1024 + 1)]);
      expect(file.status).toBe(413);
      expect((await file.json() as any).error).toMatch(/10 Mo/);
      const turnLimit = await attach(id, 'x', [big(6.9 * 1024 * 1024), big(6.9 * 1024 * 1024), big(6.9 * 1024 * 1024)]);
      expect(turnLimit.status).toBe(413);
      expect((await turnLimit.json() as any).error).toMatch(/20 Mo/);
      expect((await attach(id, 'x', [{ name: 'x', mediaType: 'text/plain', data: '***' }])).status).toBe(400);
      expect((await attach(id, 'x', [{ name: 'x.png', mediaType: 'image/png', data: b64('not an image') }])).status).toBe(400);
      expect(options).toBeUndefined();
      // 50 MB per session: five turns of 10 MB fit, the next does not.
      for (let i = 0; i < 5; i++) expect(await (await attach(id, 'ok', [big(10 * 1024 * 1024)])).text()).toContain('event: done');
      const session = await attach(id, 'one more', [big(1024)]);
      expect(session.status).toBe(413);
      expect((await session.json() as any).error).toMatch(/50 Mo/);
    }, 60_000);

    it('keeps bytes in RAM only: nothing written to disk or the database, purged on delete', async () => {
      await withAccount(account, async () => {
        const dir = account.dataDir;
        const tables = async () => Promise.all([db().select().from(schema.artifacts), db().select().from(schema.messages), db().select().from(schema.conversations), db().select().from(schema.journal), db().select().from(schema.jobs)]);
        const [files, rows] = [await listing(dir), await tables()];
        const log = vi.spyOn(console, 'log').mockImplementation(() => {}), err = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          const { id } = await create();
          expect(await (await attach(id, 'x', [{ name: 'r.png', mediaType: 'image/png', data: b64(await png()) }, { name: 'n.txt', mediaType: 'text/plain', data: b64('private') }])).text()).toContain('event: done');
          expect(await listing(dir)).toEqual(files);
          expect(await tables()).toEqual(rows);
          expect([...log.mock.calls, ...err.mock.calls].flat().join(' ')).not.toMatch(/private|r\.png/);
          expect((await call(`/${id}`, 'DELETE')).status).toBe(200);
          expect((await call(`/${id}`)).status).toBe(404);
          const fresh = await create();
          expect((await (await call(`/${fresh.id}`)).json() as any).messages).toEqual([]);
        } finally { log.mockRestore(); err.mockRestore(); }
        expect(await listing(dir)).toEqual(files);
      });
    });

    it('purges attachment bytes on expiry', async () => {
      const { id } = await create();
      await (await attach(id, 'x', [{ name: 'n.txt', mediaType: 'text/plain', data: b64('private') }])).text();
      now += IDLE_MS + 1; store.sweep();
      expect((await call(`/${id}`)).status).toBe(404);
    });
  });

  it('does not resurrect expired state or state lost to a server restart', async () => {
    const { id } = await create();
    await (await turn(id)).text();
    store.close();
    expect((await call(`/${id}`)).status).toBe(404);
    const replacement = await create();
    expect((await (await call(`/${replacement.id}`)).json() as any).messages).toEqual([]);
  });
});
