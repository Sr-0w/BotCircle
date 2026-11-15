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

export interface RawSession { id: string; title: string; directory: string; projectID?: string; parentID?: string; summary?: { additions: number; deletions: number; files: number }; time: { created: number; updated: number } }
export type RawStatus = { type: 'idle' } | { type: 'busy' } | { type: 'retry'; attempt: number; message: string; next: number };
export interface RawPart { id: string; type: string; text?: string; tool?: string; files?: string[]; filename?: string; mime?: string; state?: { status: 'pending' | 'running' | 'completed' | 'error'; input?: unknown; output?: string; title?: string; error?: string } }
export interface RawMessage { info: { id: string; role: 'user' | 'assistant'; time: { created: number; completed?: number }; modelID?: string; providerID?: string; error?: { name?: string; data?: { message?: string } } }; parts: RawPart[] }
export interface RawPermission { id: string; sessionID: string; permission: string; patterns: string[] }
export interface RawQuestion { id: string; sessionID: string; questions: { question: string; header: string; options: { label: string }[]; multiple?: boolean }[] }
export interface RawDiff { path?: string; file?: string; status?: 'added' | 'modified' | 'deleted'; additions: number; deletions: number; patch?: string }
export interface RawProject { id: string; worktree: string; name?: string }
export interface RawFileNode { name: string; path: string; type: 'file' | 'directory'; ignored?: boolean }
export interface RawFileContent { type: 'text' | 'binary'; content: string; encoding?: 'base64'; mimeType?: string }

export class OpencodeClient {
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
  prompt = (id: string, text: string, directory?: string | null) => this.call<void>('POST', `/session/${encodeURIComponent(id)}/prompt_async`, { directory, body: { parts: [{ type: 'text', text }] } });
  abort = (id: string, directory?: string | null) => this.call<boolean>('POST', `/session/${encodeURIComponent(id)}/abort`, { directory });
  diff = (id: string, directory?: string | null) => this.call<RawDiff[]>('GET', `/session/${encodeURIComponent(id)}/diff`, { directory });
  permissions = (directory?: string | null) => this.call<RawPermission[]>('GET', '/permission', { directory });
  replyPermission = (requestId: string, reply: 'once' | 'always' | 'reject', directory?: string | null) => this.call<boolean>('POST', `/permission/${encodeURIComponent(requestId)}/reply`, { directory, body: { reply } });
  questions = (directory?: string | null) => this.call<RawQuestion[]>('GET', '/question', { directory });
  replyQuestion = (requestId: string, answers: string[][], directory?: string | null) => this.call<boolean>('POST', `/question/${encodeURIComponent(requestId)}/reply`, { directory, body: { answers } });
  files = (path: string, directory?: string | null) => this.call<RawFileNode[]>('GET', '/file', { directory, query: { path } });
  file = (path: string, directory?: string | null) => this.call<RawFileContent>('GET', '/file/content', { directory, query: { path } });
}
