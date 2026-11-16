/*
 * Client de l'API HTTP d'OpenCode (`opencode serve`), telle que publiée par sa spécification OpenAPI
 * (vérifiée sur le SDK @opencode-ai/sdk 1.19.x, API v2). Authentification : HTTP Basic
 * (OPENCODE_SERVER_PASSWORD, utilisateur `opencode` par défaut). Chaque appel porte le dossier du projet
 * (`directory`) : une instance peut servir plusieurs projets.
 */

/** L'instance ne répond pas (réseau, délai, erreur serveur) : l'état distant est INCONNU, pas un échec de la tâche. */
export class OpencodeUnreachable extends Error {}
/** L'instance a répondu par un refus : identifiants, session supprimée, requête invalide. */
export class OpencodeHttpError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export interface OpencodeTarget { baseUrl: string; username: string; password: string | null }

export interface ModelRef { providerID: string; id: string; variant?: string | null }
export interface RawModel { providerID: string; providerName: string; id: string; name: string; variants: string[]; input: string[] }
/** A file sent with a prompt, inline. */
export interface PromptFile { name: string; mime: string; data: Buffer }
export interface PromptOptions { files?: PromptFile[]; model?: ModelRef | null }
export interface RawSession { model?: ModelRef | null; id: string; title: string; directory: string; projectID?: string; parentID?: string; summary?: { additions: number; deletions: number; files: number }; time: { created: number; updated: number } }
export type RawStatus = { type: 'idle' } | { type: 'busy' } | { type: 'retry'; attempt: number; message: string; next: number };
export interface RawPart { id: string; type: string; text?: string; tool?: string; files?: string[]; filename?: string; mime?: string; state?: { status: 'pending' | 'running' | 'completed' | 'error'; input?: unknown; output?: string; title?: string; error?: string } }
export interface RawMessage { info: { id: string; role: 'user' | 'assistant'; time: { created: number; completed?: number }; modelID?: string; providerID?: string; error?: { name?: string; data?: { message?: string; statusCode?: number; responseHeaders?: Record<string, string>; responseBody?: string } } }; parts: RawPart[] }
export interface RawPermission { id: string; sessionID: string; permission: string; patterns: string[] }
export interface RawQuestion { id: string; sessionID: string; questions: { question: string; header: string; options: { label: string }[]; multiple?: boolean; key?: string; free?: boolean }[] }
export interface RawDiff { path?: string; file?: string; status?: 'added' | 'modified' | 'deleted'; additions: number; deletions: number; patch?: string }
export interface RawProject { id: string; worktree: string; name?: string }
export interface RawFileNode { name: string; path: string; type: 'file' | 'directory'; ignored?: boolean }
export interface RawFileContent { type: 'text' | 'binary'; content: string; encoding?: 'base64'; mimeType?: string }

/** OpenCode 1.x (`opencode serve` of the 1.x line, SDK `@opencode-ai/sdk`). */
export class OpencodeV1Client {
  constructor(private readonly target: OpencodeTarget, private readonly fetcher: typeof fetch = fetch) {}

  private async call<T>(method: string, path: string, options: { directory?: string | null; query?: Record<string, string | number | undefined>; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
    const url = new URL(path.replace(/^\//, ''), this.target.baseUrl.endsWith('/') ? this.target.baseUrl : `${this.target.baseUrl}/`);
    if (options.directory) url.searchParams.set('directory', options.directory);
    for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.target.password) headers.authorization = `Basic ${Buffer.from(`${this.target.username}:${this.target.password}`).toString('base64')}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await this.fetcher(url, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: AbortSignal.timeout(options.timeoutMs ?? 15_000), redirect: 'error' });
    } catch (error) {
      throw new OpencodeUnreachable(`Instance OpenCode injoignable (${(error as Error).name === 'TimeoutError' ? 'délai dépassé' : 'connexion impossible'}).`);
    }
    if (response.status >= 500) throw new OpencodeUnreachable(`L’instance OpenCode a répondu par une erreur ${response.status}.`);
    if (response.status === 401 || response.status === 403) throw new OpencodeHttpError('L’instance OpenCode refuse ces identifiants.', response.status);
    if (response.status === 404) throw new OpencodeHttpError('Introuvable sur l’instance OpenCode (session ou fichier supprimé ?).', 404);
    if (!response.ok) throw new OpencodeHttpError(`Requête refusée par OpenCode (${response.status}).`, response.status);
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    try { return (text ? JSON.parse(text) : undefined) as T; } catch { throw new OpencodeUnreachable('Réponse illisible : cette adresse n’est pas une API OpenCode.'); }
  }

  health = () => this.call<{ healthy: boolean; version: string }>('GET', '/global/health', { timeoutMs: 8_000 });
  projects = () => this.call<RawProject[]>('GET', '/project');
  sessions = (directory?: string | null, limit = 30) => this.call<RawSession[]>('GET', '/session', { directory, query: { limit, roots: 'true' } });
  session = (id: string, directory?: string | null) => this.call<RawSession>('GET', `/session/${encodeURIComponent(id)}`, { directory });
  createSession = (title: string, directory?: string | null) => this.call<RawSession>('POST', '/session', { directory, body: { title } });
  statuses = (directory?: string | null) => this.call<Record<string, RawStatus>>('GET', '/session/status', { directory });
  messages = (id: string, directory?: string | null, limit = 60) => this.call<RawMessage[]>('GET', `/session/${encodeURIComponent(id)}/message`, { directory, query: { limit } });
  /** Envoi sans attente : si la session travaille déjà, OpenCode place le message à la suite (il n'interrompt pas l'étape en cours). */
  prompt = (id: string, text: string, directory?: string | null, options: PromptOptions = {}) => this.call<void>('POST', `/session/${encodeURIComponent(id)}/prompt_async`, {
    directory, timeoutMs: 60_000,
    body: {
      parts: [{ type: 'text', text }, ...(options.files ?? []).map((f) => ({ type: 'file', mime: f.mime, filename: f.name, url: `data:${f.mime};base64,${f.data.toString('base64')}` }))],
      ...(options.model ? { model: { providerID: options.model.providerID, modelID: options.model.id } } : {}),
    },
  });
  providers = () => this.call<{ providers: { id: string; name?: string; models: Record<string, { id?: string; name?: string; attachment?: boolean; modalities?: { input?: string[] } }> }[]; default?: Record<string, string> }>('GET', '/config/providers');
  abort = (id: string, directory?: string | null) => this.call<boolean>('POST', `/session/${encodeURIComponent(id)}/abort`, { directory });
  diff = (id: string, directory?: string | null) => this.call<RawDiff[]>('GET', `/session/${encodeURIComponent(id)}/diff`, { directory });
  permissions = (directory?: string | null) => this.call<RawPermission[]>('GET', '/permission', { directory });
  replyPermission = (requestId: string, reply: 'once' | 'always' | 'reject', directory?: string | null) => this.call<boolean>('POST', `/permission/${encodeURIComponent(requestId)}/reply`, { directory, body: { reply } });
  questions = (directory?: string | null) => this.call<RawQuestion[]>('GET', '/question', { directory });
  replyQuestion = (requestId: string, answers: string[][], directory?: string | null) => this.call<boolean>('POST', `/question/${encodeURIComponent(requestId)}/reply`, { directory, body: { answers } });
  files = (path: string, directory?: string | null) => this.call<RawFileNode[]>('GET', '/file', { directory, query: { path } });
  file = (path: string, directory?: string | null) => this.call<RawFileContent>('GET', '/file/content', { directory, query: { path } });
}

export type Delivery = 'steer' | 'queue';

/**
 * What the integration needs from an OpenCode server, whatever its version. Every call is scoped to a session or a
 * project directory, so an instruction can never land in another session.
 */
export interface OpencodeApi {
  readonly version: 'v1' | 'v2';
  health(): Promise<{ healthy: boolean; version: string; hostname?: string | null }>;
  projects(): Promise<RawProject[]>;
  sessions(directory?: string | null, limit?: number): Promise<RawSession[]>;
  session(id: string, directory?: string | null): Promise<RawSession>;
  createSession(title: string, directory?: string | null): Promise<RawSession>;
  /** Sessions currently working; absent means idle. */
  statuses(directory?: string | null): Promise<Record<string, RawStatus>>;
  messages(id: string, directory?: string | null, limit?: number): Promise<RawMessage[]>;
  /** Returns how the message was delivered: folded into the work in progress, or queued after it. */
  prompt(id: string, text: string, directory?: string | null, delivery?: Delivery, options?: PromptOptions): Promise<Delivery | null>;
  /** Models the instance offers (its configured providers). */
  models(directory?: string | null): Promise<RawModel[]>;
  /** Switches the session's model where the server keeps one (2.x); 1.x takes the model with each prompt. */
  setModel(sessionId: string, model: ModelRef, directory?: string | null): Promise<void>;
  abort(id: string, directory?: string | null): Promise<unknown>;
  diff(id: string, directory?: string | null): Promise<RawDiff[]>;
  permissions(sessionId: string, directory?: string | null): Promise<RawPermission[]>;
  replyPermission(sessionId: string, requestId: string, reply: 'once' | 'always' | 'reject', directory?: string | null): Promise<unknown>;
  questions(sessionId: string, directory?: string | null): Promise<RawQuestion[]>;
  replyQuestion(sessionId: string, requestId: string, answers: string[][], directory?: string | null): Promise<unknown>;
  files(path: string, directory?: string | null): Promise<RawFileNode[]>;
  file(path: string, directory?: string | null): Promise<RawFileContent>;
}

/** Adapts the 1.x client to the shared interface. */
export class V1Api implements OpencodeApi {
  readonly version = 'v1' as const;
  constructor(private readonly c: OpencodeV1Client) {}
  health = () => this.c.health();
  projects = () => this.c.projects();
  sessions = (directory?: string | null, limit?: number) => this.c.sessions(directory, limit);
  session = (id: string, directory?: string | null) => this.c.session(id, directory);
  createSession = (title: string, directory?: string | null) => this.c.createSession(title, directory);
  statuses = async (directory?: string | null) => Object.fromEntries(Object.entries(await this.c.statuses(directory)).filter(([, s]) => s.type !== 'idle'));
  messages = (id: string, directory?: string | null, limit?: number) => this.c.messages(id, directory, limit);
  // 1.x has a single mode: a message sent while the session works is handled after it.
  prompt = async (id: string, text: string, directory?: string | null, _delivery?: Delivery, options?: PromptOptions) => { await this.c.prompt(id, text, directory, options); return null; };
  models = async () => {
    const { providers } = await this.c.providers();
    return providers.flatMap((p) => Object.entries(p.models ?? {}).map(([key, m]) => ({
      providerID: p.id, providerName: p.name ?? p.id, id: m.id ?? key, name: m.name ?? key, variants: [],
      input: m.modalities?.input ?? (m.attachment ? ['text', 'image', 'pdf'] : ['text']),
    })));
  };
  setModel = async () => {};
  abort = (id: string, directory?: string | null) => this.c.abort(id, directory);
  diff = (id: string, directory?: string | null) => this.c.diff(id, directory);
  permissions = async (sessionId: string, directory?: string | null) => (await this.c.permissions(directory)).filter((p) => p.sessionID === sessionId);
  replyPermission = (_sessionId: string, requestId: string, reply: 'once' | 'always' | 'reject', directory?: string | null) => this.c.replyPermission(requestId, reply, directory);
  questions = async (sessionId: string, directory?: string | null) => (await this.c.questions(directory)).filter((q) => q.sessionID === sessionId);
  replyQuestion = (_sessionId: string, requestId: string, answers: string[][], directory?: string | null) => this.c.replyQuestion(requestId, answers, directory);
  files = (path: string, directory?: string | null) => this.c.files(path, directory);
  file = (path: string, directory?: string | null) => this.c.file(path, directory);
}

// --- OpenCode 2.x ---------------------------------------------------------------------------------------------------
// Checked against a real `opencode serve` 2.3.0 and the OpenAPI spec generated from @opencode/protocol 2.3.0.

type V2ToolState = { status: 'streaming'; input: string } | { status: 'running'; input: Record<string, unknown> } | { status: 'completed'; input: Record<string, unknown>; content?: { type: string; text?: string; uri?: string }[] } | { status: 'error'; input: Record<string, unknown>; error: { type: string; message: string }; content?: { type: string; text?: string }[] };
type V2Content = { type: 'text'; text: string } | { type: 'reasoning'; text: string } | { type: 'tool'; id: string; name: string; state: V2ToolState };
type V2Message =
  | { id: string; type: 'user'; time: { created: number }; text: string; files?: { name?: string; mime?: string }[] }
  | { id: string; type: 'assistant'; time: { created: number; completed?: number }; model?: { id: string; providerID: string }; content: V2Content[]; error?: { type: string; message: string } }
  | { id: string; type: 'idle'; time: { created: number }; outcome?: 'succeeded' | 'failed' | 'interrupted' }
  | { id: string; type: string; time: { created: number } };
type V2Session = { model?: ModelRef | null; id: string; title?: string; parentID?: string; location: { directory: string }; time: { created: number; updated: number }; outcome?: string };
type V2Field = { key: string; title?: string; description?: string; type: string; options?: { value: string; label: string }[]; required?: boolean; hidden?: boolean };

const v2Title = (name: string, input: unknown) => {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const pick = i.description ?? i.command ?? i.path ?? i.filePath ?? i.pattern ?? i.url ?? i.query;
  return typeof pick === 'string' && pick.trim() ? pick.trim().slice(0, 140) : name;
};
const toolText = (content?: { type: string; text?: string; uri?: string }[]) => (content ?? []).map((c) => c.text ?? c.uri ?? '').filter(Boolean).join('\n');

/** Turns the 2.x transcript into the 1.x shape the integration reads (one assistant message per step, as in 2.x). */
export function normalizeV2Messages(messages: V2Message[]): RawMessage[] {
  const out: RawMessage[] = [];
  for (const m of messages) {
    if (m.type === 'user') {
      const u = m as Extract<V2Message, { type: 'user' }>;
      // Only the name and type of an attached file: its bytes stay on the development machine.
      out.push({ info: { id: u.id, role: 'user', time: { created: u.time.created } }, parts: [{ id: `${u.id}-t`, type: 'text', text: u.text }, ...(u.files ?? []).map((f, index) => ({ id: `${u.id}-f${index}`, type: 'file', filename: f.name, mime: f.mime }))] });
    }
    else if (m.type === 'assistant') {
      const a = m as Extract<V2Message, { type: 'assistant' }>;
      const parts: RawPart[] = a.content.map((c, index): RawPart => {
        if (c.type === 'tool') {
          const st = c.state;
          return {
            id: c.id || `${a.id}-${index}`, type: 'tool', tool: c.name,
            state: {
              status: st.status === 'streaming' ? 'pending' : st.status,
              input: st.status === 'streaming' ? st.input : st.input,
              title: v2Title(c.name, st.status === 'streaming' ? {} : st.input),
              output: st.status === 'completed' ? toolText(st.content) : undefined,
              error: st.status === 'error' ? st.error.message : undefined,
            },
          };
        }
        return { id: `${a.id}-${index}`, type: c.type, text: c.text };
      });
      // A step stopped because a tool was refused carries the reason on the tool; that is what the user should read.
      const refused = a.content.find((c): c is Extract<V2Content, { type: 'tool' }> => c.type === 'tool' && c.state.status === 'error');
      const error = a.error ? { name: a.error.type, data: { message: refused && refused.state.status === 'error' ? refused.state.error.message : a.error.message } } : undefined;
      out.push({ info: { id: a.id, role: 'assistant', time: { created: a.time.created, completed: a.time.completed }, modelID: a.model?.id, providerID: a.model?.providerID, error }, parts });
    }
  }
  return out;
}

const locationQuery = (directory?: string | null) => (directory ? { 'location[directory]': directory } : {});

/** OpenCode 2.x: everything under /api, Basic auth with the server password or a paired session token. */
export class OpencodeV2Client implements OpencodeApi {
  readonly version = 'v2' as const;
  constructor(private readonly target: OpencodeTarget, private readonly fetcher: typeof fetch = fetch) {}

  private async send(method: string, path: string, options: { query?: Record<string, string | number | undefined>; body?: unknown; timeoutMs?: number; raw?: boolean } = {}): Promise<Response> {
    const url = new URL(path.replace(/^\//, ''), this.target.baseUrl.endsWith('/') ? this.target.baseUrl : `${this.target.baseUrl}/`);
    for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
    const headers: Record<string, string> = { accept: options.raw ? '*/*' : 'application/json' };
    if (this.target.password) headers.authorization = `Basic ${Buffer.from(`${this.target.username}:${this.target.password}`).toString('base64')}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await this.fetcher(url, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: AbortSignal.timeout(options.timeoutMs ?? 15_000), redirect: 'error' });
    } catch (error) {
      throw new OpencodeUnreachable(`Instance OpenCode injoignable (${(error as Error).name === 'TimeoutError' ? 'délai dépassé' : 'connexion impossible'}).`);
    }
    if (response.status >= 500) throw new OpencodeUnreachable(`L’instance OpenCode a répondu par une erreur ${response.status}.`);
    if (response.status === 401 || response.status === 403) throw new OpencodeHttpError('L’instance OpenCode refuse ces identifiants (jeton d’appairage expiré ou révoqué ?).', response.status);
    if (response.status === 404) throw new OpencodeHttpError('Introuvable sur l’instance OpenCode (session ou fichier supprimé ?).', 404);
    if (!response.ok) throw new OpencodeHttpError(`Requête refusée par OpenCode (${response.status}).`, response.status);
    return response;
  }
  private async call<T>(method: string, path: string, options: { query?: Record<string, string | number | undefined>; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
    const response = await this.send(method, path, options);
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    try { return (text ? JSON.parse(text) : undefined) as T; } catch { throw new OpencodeUnreachable('Réponse illisible : cette adresse n’est pas une API OpenCode.'); }
  }

  health = async () => { const info = await this.call<{ version: string; hostname?: string | null }>('GET', '/api/info', { timeoutMs: 8_000 }); return { healthy: true, version: info.version, hostname: info.hostname ?? null }; };
  projects = async () => (await this.call<{ id: string; canonical?: string; worktree?: string; name?: string }[]>('GET', '/api/project')).map((p) => ({ id: p.id, worktree: p.canonical ?? p.worktree ?? '', name: p.name }));
  private toSession = (s: V2Session): RawSession => ({ model: s.model ?? null, id: s.id, title: s.title ?? '', directory: s.location?.directory ?? '', parentID: s.parentID, time: s.time });
  sessions = async (directory?: string | null, limit = 30) => (await this.call<{ data: V2Session[] }>('GET', '/api/session', { query: { limit: Math.min(limit, 200), parentID: 'null', ...(directory ? { directory } : {}) } })).data.map(this.toSession);
  session = async (id: string) => this.toSession((await this.call<{ data: V2Session }>('GET', `/api/session/${encodeURIComponent(id)}`)).data);
  createSession = async (title: string, directory?: string | null) => this.toSession((await this.call<{ data: V2Session }>('POST', '/api/session', { body: { title, ...(directory ? { location: { directory } } : {}) } })).data);
  statuses = async () => Object.fromEntries(Object.keys((await this.call<{ data: Record<string, { type: string }> }>('GET', '/api/session/active')).data).map((id) => [id, { type: 'busy' } as RawStatus]));
  // The server caps every page at 200 items.
  messages = async (id: string, _directory?: string | null, limit = 60) => normalizeV2Messages((await this.call<{ data: V2Message[] }>('GET', `/api/session/${encodeURIComponent(id)}/message`, { query: { order: 'desc', limit: Math.min(limit, 200) } })).data.reverse());
  prompt = async (id: string, text: string, _directory?: string | null, delivery?: Delivery, options: PromptOptions = {}) => {
    if (options.model) await this.setModel(id, options.model);
    const files = (options.files ?? []).map((f) => ({ uri: `data:${f.mime};base64,${f.data.toString('base64')}`, name: f.name }));
    const result = await this.call<{ data?: { delivery?: Delivery } }>('POST', `/api/session/${encodeURIComponent(id)}/prompt`, { body: { text, ...(files.length ? { files } : {}), ...(delivery ? { delivery } : {}) }, timeoutMs: files.length ? 60_000 : 15_000 });
    return result?.data?.delivery ?? delivery ?? null;
  };
  models = async (directory?: string | null) => {
    const [models, providers] = await Promise.all([
      this.call<{ data: { id: string; providerID: string; name?: string; enabled?: boolean; status?: string; variants?: { id: string }[]; capabilities?: { input?: string[] } }[] }>('GET', '/api/model', { query: locationQuery(directory) }),
      this.call<{ data: { id: string; name?: string }[] }>('GET', '/api/provider', { query: locationQuery(directory) }).catch(() => ({ data: [] })),
    ]);
    const names = new Map(providers.data.map((p) => [p.id, p.name ?? p.id]));
    return models.data.filter((m) => m.enabled !== false && m.status !== 'deprecated')
      .map((m) => ({ providerID: m.providerID, providerName: names.get(m.providerID) ?? m.providerID, id: m.id, name: m.name ?? m.id, variants: (m.variants ?? []).map((v) => v.id), input: m.capabilities?.input ?? ['text'] }));
  };
  setModel = async (sessionId: string, model: ModelRef) => { await this.call<void>('POST', `/api/session/${encodeURIComponent(sessionId)}/model`, { body: { model: { id: model.id, providerID: model.providerID, ...(model.variant ? { variant: model.variant } : {}) } } }); };
  abort = (id: string) => this.call<{ interrupted: boolean }>('POST', `/api/session/${encodeURIComponent(id)}/interrupt`);
  /** The whole session, from its first request to its latest one (2.x diffs one turn by default). */
  diff = async (id: string) => {
    const users = (await this.call<{ data: { id: string }[] }>('GET', `/api/session/${encodeURIComponent(id)}/message`, { query: { type: 'user', order: 'asc', limit: 200 } })).data;
    if (!users.length) return [];
    const query = users.length > 1 ? { from: users[0].id, to: users[users.length - 1].id } : { from: users[0].id };
    return (await this.call<{ data: { file: string; patch: string; additions: number; deletions: number; status: 'added' | 'modified' | 'deleted' }[] }>('GET', `/api/session/${encodeURIComponent(id)}/diff`, { query })).data.map((d) => ({ ...d, path: d.file }));
  };
  permissions = async (sessionId: string) => (await this.call<{ data: { id: string; sessionID: string; action: string; resources?: string[] }[] }>('GET', `/api/session/${encodeURIComponent(sessionId)}/permission`)).data.map((p) => ({ id: p.id, sessionID: p.sessionID, permission: p.action, patterns: p.resources ?? [] }));
  replyPermission = (sessionId: string, requestId: string, reply: 'once' | 'always' | 'reject') => this.call<void>('POST', `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`, { body: { decision: reply } });
  private formFields = new Map<string, V2Field[]>();
  questions = async (sessionId: string) => (await this.call<{ data: { id: string; sessionID: string; title: string; fields: V2Field[] }[] }>('GET', `/api/session/${encodeURIComponent(sessionId)}/form`)).data.map((form) => {
    const fields = form.fields.filter((f) => !f.hidden && f.type !== 'external');
    this.formFields.set(form.id, fields);
    return {
      id: form.id, sessionID: form.sessionID,
      questions: fields.map((f) => ({
        key: f.key, header: form.title, question: f.title ?? f.description ?? f.key,
        options: f.type === 'boolean' ? [{ label: 'Oui' }, { label: 'Non' }] : (f.options ?? []).map((o) => ({ label: o.label })),
        multiple: f.type === 'multiselect', free: f.type !== 'boolean' && !(f.options?.length),
      })),
    };
  });
  /** Answers come back as labels (or free text); the form wants each field's value, typed. */
  replyQuestion = async (sessionId: string, requestId: string, answers: string[][]) => {
    let fields = this.formFields.get(requestId);
    if (!fields) { await this.questions(sessionId); fields = this.formFields.get(requestId) ?? []; }
    const answer: Record<string, unknown> = {};
    fields.forEach((f, index) => {
      const given = answers[index] ?? [];
      const value = (label: string) => f.options?.find((o) => o.label === label)?.value ?? label;
      if (f.type === 'multiselect') answer[f.key] = given.map(value);
      else if (f.type === 'boolean') answer[f.key] = given[0] === 'Oui';
      else if (f.type === 'number' || f.type === 'integer') answer[f.key] = Number(given[0]);
      else if (given.length) answer[f.key] = value(given[0]);
    });
    return this.call<void>('POST', `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(requestId)}/reply`, { body: { answer } });
  };
  files = async (path: string, directory?: string | null) => (await this.call<{ data: { path: string; type: 'file' | 'directory' }[] }>('GET', '/api/fs/list', { query: { ...locationQuery(directory), ...(path && path !== '.' ? { path } : {}) } })).data.map((e) => {
    const clean = e.path.replace(/\/+$/, '');
    return { name: clean.split('/').pop() ?? clean, path: clean, type: e.type, ignored: clean === '.git' };
  });
  file = async (path: string, directory?: string | null) => {
    const response = await this.send('GET', `/api/fs/read/${path.split('/').map(encodeURIComponent).join('/')}`, { query: locationQuery(directory), raw: true });
    const bytes = new Uint8Array(await response.arrayBuffer());
    // The server's content type is guessed from the extension (.ts comes back as video/mp2t): look at the bytes.
    const binary = bytes.subarray(0, 8000).includes(0);
    let content = '';
    if (!binary) { try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return { type: 'binary' as const, content: '' }; } }
    return { type: binary ? 'binary' as const : 'text' as const, content };
  };
}

/**
 * Which API an instance speaks. 2.x answers /api/info; 1.x answers /global/health. Credentials are checked by the
 * same call, so a refused password is reported as such rather than as "not OpenCode".
 */
export async function detectApi(target: OpencodeTarget, fetcher: typeof fetch = fetch): Promise<OpencodeApi> {
  const v2 = new OpencodeV2Client(target, fetcher);
  try { await v2.health(); return v2; } catch (error) {
    if (!(error instanceof OpencodeHttpError) || error.status !== 404) throw error;
  }
  const v1 = new V1Api(new OpencodeV1Client(target, fetcher));
  await v1.health();
  return v1;
}

/** One-time pairing link printed by `opencode pair` / `opencode pair --remote` (also the content of its QR code). */
export function parsePairingLink(raw: string): { baseUrl: string; code: string } {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new OpencodeHttpError('Lien d’appairage invalide : colle le lien complet affiché par `opencode pair`.', 400); }
  const match = /^\/auth\/connect\/([A-Za-z0-9_-]{8,128})\/?$/.exec(url.pathname);
  if (!match || (url.protocol !== 'https:' && url.protocol !== 'http:')) throw new OpencodeHttpError('Ce n’est pas un lien d’appairage OpenCode (…/auth/connect/…).', 400);
  if (url.username || url.password) throw new OpencodeHttpError('Le lien ne doit pas contenir d’identifiants.', 400);
  return { baseUrl: url.origin, code: match[1] };
}

/** Redeems a pairing code for a session token (signed by the server, valid 30 days). The code works only once. */
export async function redeemPairingCode(baseUrl: string, code: string, fetcher: typeof fetch = fetch): Promise<{ token: string; expiresAt: Date | null }> {
  let response: Response;
  try {
    response = await fetcher(new URL(`/auth/connect/${encodeURIComponent(code)}`, baseUrl), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000), redirect: 'error' });
  } catch (error) {
    throw new OpencodeUnreachable(`La machine n’est pas joignable à cette adresse (${(error as Error).name === 'TimeoutError' ? 'délai dépassé' : 'connexion impossible'}).`);
  }
  if (response.status === 401 || response.status === 404) throw new OpencodeHttpError('Ce lien d’appairage a expiré ou a déjà servi : relance `opencode pair --remote` et colle le nouveau lien (il vaut 5 minutes, une seule fois).', 401);
  if (!response.ok) throw new OpencodeHttpError(`Appairage refusé par OpenCode (${response.status}).`, response.status);
  const body = await response.json().catch(() => null) as { token?: unknown } | null;
  if (!body || typeof body.token !== 'string') throw new OpencodeHttpError('Réponse d’appairage inattendue : cette adresse n’est pas une instance OpenCode 2.', 400);
  const seconds = Number(body.token.split('.')[0]);
  return { token: body.token, expiresAt: Number.isSafeInteger(seconds) && seconds > 0 ? new Date(seconds * 1000) : null };
}
