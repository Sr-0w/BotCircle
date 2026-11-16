import type {
  DesktopPermissions,
  AccountProfileDTO,
  ActivityDTO,
  ActivityMailFilter,
  ActivitySchedule,
  ActivityWatch,
  ConnectorDTO,
  MailConfig,
  MailDraftDTO,
  McpConfig,
  PluginDTO,
  PluginManifest,
  IntegrationCatalogEntry,
  IntegrationProvider,
  OAuthAppDTO,
  OAuthProvider,
  SkillDTO,
  UserRequestDTO,
  AgentDTO,
  ApprovalDTO,
  BootstrapDTO,
  ArtifactDTO,
  ArtifactGrantDTO,
  ArtifactAccessDTO,
  TaskDTO,
  TaskEventDTO,
  ChatDTO,
  SecureLoginDTO,
  OpencodeInstanceDTO,
  OpencodeProjectDTO,
  OpencodeSessionDTO,
  OpencodeWorkspaceDTO,
  OpencodeExchangeDTO,
  OpencodeFileNodeDTO,
  JournalEntryDTO,
  MemoryDTO,
  ModelConfig,
  TeamThreadDTO,
  OpencodeModelsDTO, OpencodeModelRef, OpencodeCurrentModelDTO,
} from "@opendots/shared";
import type { UIMessage } from "ai";
import type { MessageMetadata } from "@opendots/shared";
import type { Account } from './account';

export type ODMessage = UIMessage<MessageMetadata>;

export interface SearchHit { messageId: string; conversationId: string; seq: number; role: 'user' | 'assistant'; kind: 'chat' | 'circle'; agentId: string | null; title: string; archived: boolean; current: boolean; snippet: string; highlights: [number, number][]; createdAt: string; score: number }

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly data: any = null) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { "content-type": "application/json", "x-opendots-client": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('opendots:unauthorized'));
    throw new ApiError(data?.error ?? `Erreur ${res.status}`, res.status, data);
  }
  return data as T;
}

export interface ActivityInput {
  title: string;
  kind: ActivityDTO["kind"];
  instructions: string;
  schedule?: ActivitySchedule | null;
  watch?: ActivityWatch | null;
  filter?: ActivityMailFilter | null;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: "openrouter" | "ollama" | "codex";
  contextLength: number | null;
  tools: boolean;
  reasoning: boolean;
  vision?: boolean;
  promptPrice: number | null;
  completionPrice: number | null;
}

export interface ShellSettingsDTO {
  mode: "auto" | "docker" | "host" | "off";
  approval: "ask" | "auto" | "default";
  image: string;
  network: boolean;
  sudo: boolean;
}

export interface SettingsDTO {
  openrouterKey: string | null;
  defaultModel: ModelConfig;
  ollamaUrl: string | null;
  timezone: string;
  paused: boolean;
  turnStepLimit: number | null;
  search: { provider: "auto" | "mwmbl" | "searxng"; url: string | null };
  shell: ShellSettingsDTO;
}

export interface ComputerStatus {
  settings: ShellSettingsDTO;
  dockerAvailable: boolean;
  backend: "docker" | "host" | null;
  container: { name: string; running: boolean; image: string; network: boolean } | null;
  approvalRequired: boolean;
  workspaces: string;
}

export interface DesktopStatus { agentId: string; suspended: boolean; restartRequired?: boolean; vncPassword?: string; enabled: boolean; manualControl: boolean; available: boolean; running: boolean; width: number; height: number }

/** #39: a Home Assistant instance and who may use it. */
export interface HaInstance { id: string; name: string; base: string; mode: 'assist' | 'full'; auth: 'oauth' | 'token'; status: string; lastError: string | null; tools: string[]; policy: { agents: Record<string, 'none' | 'read' | 'control'>; chats: 'none' | 'read' | 'control'; sensitive: string[]; areas: string[]; domains: string[] } }

/** #52: a machine reachable over SSH (secrets never returned). */
export interface SshConnection { id: string; name: string; description: string; host: string; port: number; username: string; auth: 'key' | 'password'; hasSecret: boolean; hostKey: string | null; agents: string[]; approval: 'ask' | 'auto'; enabled: boolean; status: 'unknown' | 'ok' | 'error'; lastError: string | null; lastOkAt: string | null; publicKey: string | null; installCommand: string | null; generatedKey: boolean }

export const api = {
  uploadImage: async (file: File) => {
    const body = new FormData(); body.set('file', file);
    const response = await fetch('/api/attachments', { method: 'POST', headers: { 'x-opendots-client': '1' }, body });
    const value = await response.json();
    if (!response.ok) { if (response.status === 401) window.dispatchEvent(new Event('opendots:unauthorized')); throw new ApiError(value.error ?? 'Impossible de joindre cette image.', response.status); }
    return value as { id: string; url: string; filename: string; mediaType: 'image/jpeg'; width: number; height: number; size: number };
  },
  /** Tout fichier non image : stocké inchangé comme artefact du compte. `agentId` donne à ce compagnon le droit de le lire. */
  uploadArtifact: async (file: File, scope: { agentId?: string; conversationId?: string }) => {
    const body = new FormData(); body.set('file', file);
    if (scope.agentId) body.set('agentId', scope.agentId);
    if (scope.conversationId) body.set('conversationId', scope.conversationId);
    const response = await fetch('/api/artifacts', { method: 'POST', headers: { 'x-opendots-client': '1' }, body });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) { if (response.status === 401) window.dispatchEvent(new Event('opendots:unauthorized')); throw new ApiError(value.error ?? 'Impossible de joindre ce fichier.', response.status); }
    return value as ArtifactDTO;
  },
  artifacts: (filter: { agentId?: string; conversationId?: string; taskId?: string } = {}) => request<ArtifactDTO[]>('GET', `/artifacts?${new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as [string, string][])}`),
  artifact: (id: string) => request<ArtifactDTO & { grants: ArtifactGrantDTO[]; access: ArtifactAccessDTO[] }>('GET', `/artifacts/${id}`),
  grantArtifact: (id: string, agentId: string) => request<{ grants: ArtifactGrantDTO[]; access: ArtifactAccessDTO[] }>('POST', `/artifacts/${id}/grants`, { agentId }),
  revokeArtifact: (id: string, agentId: string) => request<{ grants: ArtifactGrantDTO[]; access: ArtifactAccessDTO[] }>('DELETE', `/artifacts/${id}/grants/${agentId}`),
  deleteArtifact: (id: string) => request<{ ok: boolean }>('DELETE', `/artifacts/${id}`),

  tasks: (filter: { agentId?: string; conversationId?: string; active?: boolean } = {}) => request<TaskDTO[]>('GET', `/tasks?${new URLSearchParams({ ...(filter.agentId ? { agentId: filter.agentId } : {}), ...(filter.conversationId ? { conversationId: filter.conversationId } : {}), ...(filter.active ? { active: '1' } : {}) })}`),
  task: (id: string) => request<TaskDTO & { events: TaskEventDTO[] }>('GET', `/tasks/${id}`),
  taskAction: (id: string, action: 'cancel' | 'pause' | 'resume') => request<TaskDTO>('POST', `/tasks/${id}/${action}`),
  taskInstruction: (id: string, instruction: string) => request<TaskDTO>('POST', `/tasks/${id}/instruction`, { instruction }),

  secureLogins: (pending = false) => request<SecureLoginDTO[]>('GET', `/secure-logins${pending ? '?pending=1' : ''}`),
  secureLogin: (id: string) => request<SecureLoginDTO>('GET', `/secure-logins/${id}`),
  resolveSecureLogin: (id: string, outcome: 'authenticated' | 'cancelled' | 'failed') => request<SecureLoginDTO>('POST', `/secure-logins/${id}/resolve`, { outcome }),

  codeSessions: () => request<{ instanceId: string; instanceName: string; reachable: boolean; sessions: { id: string; title: string; directory: string; updatedAt: number; busy: boolean; taskId: string | null }[] }[]>('GET', '/opencode/sessions'),
  startCodeSession: (body: { instanceId: string; directory: string | null; instruction: string }) => request<TaskDTO>('POST', '/opencode/sessions', body),
  attachCodeSession: (body: { instanceId: string; sessionId: string; directory: string | null }) => request<TaskDTO>('POST', '/opencode/sessions/attach', body),
  opencodeInstances: () => request<OpencodeInstanceDTO[]>('GET', '/opencode/instances'),
  saveOpencodeInstance: (input: { id?: string; name: string; baseUrl: string; username?: string; password?: string | null; defaultDirectory?: string | null }) => {
    const { id, ...body } = input;
    return request<OpencodeInstanceDTO>(id ? 'PUT' : 'POST', id ? `/opencode/instances/${id}` : '/opencode/instances', body);
  },
  pairOpencode: (link: string, defaultDirectory?: string | null) => request<OpencodeInstanceDTO>('POST', '/opencode/instances/pair', { link, defaultDirectory: defaultDirectory || null }),
  checkOpencodeInstance: (id: string) => request<OpencodeInstanceDTO>('POST', `/opencode/instances/${id}/check`),
  deleteOpencodeInstance: (id: string) => request<{ ok: boolean }>('DELETE', `/opencode/instances/${id}`),
  opencodeProjects: (id: string) => request<OpencodeProjectDTO[]>('GET', `/opencode/instances/${id}/projects`),
  opencodeSessions: (id: string, directory?: string) => request<OpencodeSessionDTO[]>('GET', `/opencode/instances/${id}/sessions${directory ? `?directory=${encodeURIComponent(directory)}` : ''}`),
  opencodeExchanges: () => request<OpencodeExchangeDTO[]>('GET', '/opencode/exchanges'),
  codeWorkspace: (taskId: string) => request<OpencodeWorkspaceDTO>('GET', `/opencode/tasks/${taskId}`),
  /** With files, sent as multipart: they go to OpenCode on the development machine and are not kept by BotCircle. */
  codePrompt: async (taskId: string, text: string, delivery?: 'steer' | 'queue', files: File[] = []) => {
    if (!files.length) return request<{ queued: boolean; delivery: 'steer' | 'queue' | null }>('POST', `/opencode/tasks/${taskId}/prompt`, { text, ...(delivery ? { delivery } : {}) });
    const body = new FormData(); body.set('text', text); if (delivery) body.set('delivery', delivery);
    for (const file of files) body.append('file', file, file.name);
    const response = await fetch(`/api/opencode/tasks/${taskId}/prompt`, { method: 'POST', headers: { 'x-opendots-client': '1' }, body });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) { if (response.status === 401) window.dispatchEvent(new Event('opendots:unauthorized')); throw new ApiError(value.error ?? 'Envoi impossible.', response.status); }
    return value as { queued: boolean; delivery: 'steer' | 'queue' | null };
  },
  codeAutoResume: (taskId: string, enabled: boolean) => request<{ ok: boolean }>('POST', `/opencode/tasks/${taskId}/auto-resume`, { enabled }),
  codeModels: (taskId: string) => request<OpencodeModelsDTO>('GET', `/opencode/tasks/${taskId}/models`),
  codeSetModel: (taskId: string, model: OpencodeModelRef) => request<OpencodeCurrentModelDTO>('POST', `/opencode/tasks/${taskId}/model`, model),
  codePermission: (taskId: string, requestId: string, reply: 'once' | 'always' | 'reject') => request<{ ok: boolean }>('POST', `/opencode/tasks/${taskId}/permissions/${requestId}`, { reply }),
  codeQuestion: (taskId: string, requestId: string, answers: string[][]) => request<{ ok: boolean }>('POST', `/opencode/tasks/${taskId}/questions/${requestId}`, { answers }),
  codeFiles: (taskId: string, path: string) => request<OpencodeFileNodeDTO[]>('GET', `/opencode/tasks/${taskId}/files?path=${encodeURIComponent(path)}`),
  codeFile: (taskId: string, path: string) => request<{ path: string; binary: boolean; content: string }>('GET', `/opencode/tasks/${taskId}/file?path=${encodeURIComponent(path)}`),

  chats: (q?: string) => request<ChatDTO[]>('GET', `/chats${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  createChat: (input: { title?: string; model?: ModelConfig | null } = {}) => request<ChatDTO>('POST', '/chats', input),
  updateChat: (id: string, patch: { title?: string; model?: ModelConfig | null; webSearch?: boolean; pinned?: boolean }) => request<ChatDTO>('PATCH', `/chats/${id}`, patch),
  archivedChats: () => request<ChatDTO[]>('GET', '/chats?archived=1'),
  chat: (id: string) => request<ChatDTO>('GET', `/chats/${id}`),
  archiveChat: (id: string) => request<{ ok: boolean }>('POST', `/chats/${id}/archive`),
  restoreChat: (id: string) => request<{ ok: boolean }>('POST', `/chats/${id}/restore`),
  deleteChat: (id: string, opts: { stopActive?: boolean; confirmTasks?: boolean } = {}) => request<{ ok: boolean }>('DELETE', `/chats/${id}`, opts),
  chatMessages: (id: string, around?: string) => request<{ conversationId: string; messages: ODMessage[]; cursor: number | null; active: boolean; tasks: TaskDTO[] }>('GET', `/chats/${id}/messages${around ? `?around=${encodeURIComponent(around)}` : ''}`),
  // #58: search every conversation, or inside one.
  search: (params: { q: string; scope?: 'all' | 'chats' | 'circles'; agentId?: string | null; archived?: boolean; sort?: 'relevance' | 'recent'; days?: number; offset?: number }) => {
    const qs = new URLSearchParams({ q: params.q, scope: params.scope ?? 'all', sort: params.sort ?? 'relevance', offset: String(params.offset ?? 0) });
    if (params.agentId) qs.set('agentId', params.agentId); if (params.archived) qs.set('archived', '1'); if (params.days) qs.set('days', String(params.days));
    return request<{ hits: SearchHit[]; more: boolean }>('GET', `/search?${qs}`);
  },
  searchThread: (conversationId: string, q: string) => request<{ messageId: string; seq: number; count: number }[]>('GET', `/conversations/${conversationId}/search?q=${encodeURIComponent(q)}`),
  stopChat: (id: string) => request<{ ok: boolean }>('POST', `/chats/${id}/stop`),

  desktop: (agentId: string) => request<DesktopStatus>('GET', `/computer/desktop?agentId=${agentId}`),
  desktopPermissions: () => request<Record<string, DesktopPermissions>>('GET', '/computer/desktop/permissions'),
  setDesktopPermissions: (agentId: string, permissions: DesktopPermissions) => request<DesktopPermissions>('PUT', `/computer/desktop/permissions/${agentId}`, permissions),
  startDesktop: (agentId: string, notify = false) => request<DesktopStatus>('POST', `/computer/desktop/start?agentId=${agentId}`, { notify }),
  stopDesktop: (agentId: string) => request<DesktopStatus>('POST', `/computer/desktop/stop?agentId=${agentId}`),
  desktopControl: (agentId: string, enabled: boolean) => request<{ok: boolean}>('POST', `/computer/desktop/control?agentId=${agentId}`, { enabled }),
  integrationCatalog: () => request<{ entries: IntegrationCatalogEntry[]; apps: OAuthAppDTO[] }>('GET', '/integrations/catalog'),
  saveOAuthApp: (provider: OAuthProvider, clientId: string, clientSecret?: string) => request<{ apps: OAuthAppDTO[] }>('PUT', `/integrations/oauth/apps/${provider}`, { clientId, clientSecret }),
  startOAuth: (provider: IntegrationProvider, permissions: string[], connectorId?: string, requestedBy?: string) => request<{ url: string; expiresAt: number }>('POST', '/integrations/oauth/start', { provider, permissions, connectorId, requestedBy }),
  testIntegration: (id: string) => request<{ ok: boolean; connector: ConnectorDTO }>('POST', `/integrations/${id}/test`),
  disconnectIntegration: (id: string, revoke = false) => request<{ ok: boolean; warning?: string }>('POST', `/integrations/${id}/disconnect`, { revoke }),
  me: () => request<{ account: Account | null; registrationOpen: boolean }>('GET', '/auth/me'),
  accountProfile: () => request<AccountProfileDTO>('GET', '/account/profile'),
  login: (email: string, password: string) => request<{ account: Account }>('POST', '/auth/login', { email, password }),
  register: (email: string, password: string) => request<{ account: Account }>('POST', '/auth/register', { email, password }),
  logout: () => request<{ ok: boolean }>('POST', '/auth/logout'),
  bootstrap: () => request<BootstrapDTO>("GET", "/bootstrap"),
  saveKey: (key: string) => request<{ ok: boolean }>("POST", "/onboarding/key", { key }),
  completeOnboarding: (model: ModelConfig, timezone: string) =>
    request<{ ok: boolean; warning?: string }>("POST", "/onboarding/complete", { model, timezone }),

  codexAccount: () => request<{ error?: string | null; account: { email?: string; planType?: string } | null }>("GET", "/codex/account"),
  codexLogin: () => request<{ verificationUrl: string; userCode: string }>("POST", "/codex/login"),
  codexLogout: () => request("POST", "/codex/logout"),
  codexModels: () => request<ModelInfo[]>("GET", "/models/codex"),
  /** Every model of the configured providers, and the favourites (shown first in the pickers). */
  availableModels: () => request<{ providers: { provider: ModelInfo['provider']; name: string; count: number; error: string | null }[]; models: ModelInfo[]; favorites: { provider: ModelInfo['provider']; model: string }[] }>("GET", "/models/available"),
  setFavoriteModels: (favorites: { provider: ModelInfo['provider']; model: string }[]) => request<{ favorites: typeof favorites }>("PUT", "/models/favorites", { favorites }),
  openrouterModels: () => request<ModelInfo[]>("GET", "/models/openrouter"),
  openrouterEndpoints: (id: string) => request<string[]>("GET", `/models/openrouter/endpoints?id=${encodeURIComponent(id)}`),
  ollamaModels: (url?: string) => request<ModelInfo[]>("GET", `/models/ollama${url ? `?url=${encodeURIComponent(url)}` : ""}`),

  settings: () => request<SettingsDTO>("GET", "/settings"),
  updateSettings: (
    patch: Partial<Omit<SettingsDTO, "openrouterKey" | "search" | "shell">> & {
      openrouterKey?: string;
      search?: { provider: SettingsDTO["search"]["provider"]; url?: string | null };
      shell?: Partial<ShellSettingsDTO>;
    },
  ) => request<{ ok: boolean }>("PUT", "/settings", patch),
  computer: () => request<ComputerStatus>("GET", "/computer"),
  resetComputer: () => request<ComputerStatus>("POST", "/computer/reset"),

  agents: () => request<AgentDTO[]>("GET", "/agents"),
  agent: (id: string) => request<AgentDTO>("GET", `/agents/${id}`),
  updateAgent: (id: string, patch: Partial<Pick<AgentDTO, "name" | "description" | "personality" | "instructions" | "color" | "model" | "permissions">>) =>
    request<AgentDTO>("PATCH", `/agents/${id}`, patch),
  archiveAgent: (id: string) => request<{ ok: boolean }>("DELETE", `/agents/${id}`),
  /** /clear, after the user's confirmation: the current thread is set aside (kept) and a blank one starts. */
  profile: () => request<{ firstName: string | null; lastName: string | null }>('GET', '/profile'),
  setProfile: (body: { firstName: string | null; lastName: string | null }) => request<{ firstName: string | null; lastName: string | null }>('PUT', '/profile', body),
  haInstances: () => request<HaInstance[]>('GET', '/homeassistant/instances'),
  haToken: (body: { url: string; mode: 'assist' | 'full'; token: string; name?: string }) => request<HaInstance>('POST', '/homeassistant/token', body),
  haOAuth: (body: { url: string; mode: 'assist' | 'full'; name?: string }) => request<{ authorizeUrl: string }>('POST', '/homeassistant/oauth/start', body),
  haPolicy: (id: string, policy: Partial<HaInstance['policy']>) => request<HaInstance>('PUT', `/homeassistant/instances/${id}/policy`, policy),
  haDelete: (id: string) => request<{ ok: boolean }>('DELETE', `/homeassistant/instances/${id}`),
  sshConnections: () => request<SshConnection[]>('GET', '/ssh/connections'),
  saveSsh: (id: string | null, body: Record<string, unknown>) => request<SshConnection>(id ? 'PUT' : 'POST', id ? `/ssh/connections/${id}` : '/ssh/connections', body),
  deleteSsh: (id: string) => request<{ ok: boolean }>('DELETE', `/ssh/connections/${id}`),
  testSsh: (id: string, trust = false) => request<{ ok: boolean; hostKey: string | null; trusted: boolean; error: string | null }>('POST', `/ssh/connections/${id}/test`, { trust }),
  avatarPresets: () => request<{ id: string; label: string; points: [number, number][]; roundness: number }[]>('GET', '/avatars/presets'),
  setAvatar: (id: string, body: { preset: string | null }) => request<AgentDTO>('PUT', `/agents/${id}/avatar`, body),
  restoreAvatar: (id: string) => request<AgentDTO>('POST', `/agents/${id}/avatar/restore`),
  setPrimaryAgent: (id: string) => request<{ ok: boolean }>('PUT', `/agents/${id}/primary`),
  mentionables: (id: string) => request<{ kind: 'connector'; id: string; name: string; provider: string | null; status: 'connected' | 'not_connected' | 'permission_missing' }[]>('GET', `/agents/${id}/mentionables`),
  archives: (id: string) => request<{ id: string; createdAt: string; archivedAt: string; messageCount?: number }[]>("GET", `/agents/${id}/archives`),
  archiveThread: (id: string, conversationId: string) => request<{ conversationId: string }>("POST", `/agents/${id}/conversations/${conversationId}/archive`),
  restoreThread: (id: string, conversationId: string) => request<{ conversationId: string; archivedId: string | null }>("POST", `/agents/${id}/conversations/${conversationId}/restore`),
  deleteThread: (id: string, conversationId: string, opts: { stopActive?: boolean; confirmTasks?: boolean } = {}) => request<{ conversationId: string }>("DELETE", `/agents/${id}/conversations/${conversationId}`, opts),
  clearConversation: (id: string, conversationId: string) => request<{ conversationId: string; archivedId: string | null }>("POST", `/agents/${id}/clear`, { conversationId }),
  markRead: (id: string) => request<{ ok: boolean }>("POST", `/agents/${id}/read`),
  messages: (id: string, before?: number, around?: string) =>
    request<{ conversationId: string; messages: ODMessage[]; cursor: number | null; active: boolean }>(
      "GET",
      `/agents/${id}/messages${before ? `?before=${before}` : around ? `?around=${encodeURIComponent(around)}` : ""}`,
    ),
  stop: (id: string) => request<{ ok: boolean }>("POST", `/agents/${id}/stop`),
  react: (messageId: string, emoji: string) => request<{ added: boolean; reactions: { emoji: string; actor: string }[] }>("POST", `/messages/${messageId}/reactions`, { emoji }),
  conversation: (id: string, around?: string) =>
    request<{ conversation: { id: string; agentA: string; agentB: string }; messages: ODMessage[]; active: boolean }>(
      "GET",
      `/conversations/${id}/messages${around ? `?around=${encodeURIComponent(around)}` : ""}`,
    ),
  teamPair: (a: string, b: string) => request<{ conversationId: string }>("GET", `/team/pair/${a}/${b}`),
  teamThreads: () => request<TeamThreadDTO[]>("GET", "/team/threads"),

  activities: (agentId?: string) => request<ActivityDTO[]>("GET", `/activities${agentId ? `?agentId=${agentId}` : ""}`),
  createActivity: (input: ActivityInput & { agentId: string }) => request<ActivityDTO>("POST", "/activities", input),
  updateActivity: (id: string, patch: Partial<ActivityInput> & { enabled?: boolean }) => request<ActivityDTO>("PATCH", `/activities/${id}`, patch),
  deleteActivity: (id: string) => request<{ ok: boolean }>("DELETE", `/activities/${id}`),
  runActivity: (id: string) => request<unknown>("POST", `/activities/${id}/run`),

  approvals: (status?: string) => request<ApprovalDTO[]>("GET", `/approvals${status ? `?status=${status}` : ""}`),
  decide: (id: string, decision: "approve" | "reject") =>
    request<{ ok: boolean; status: string; error: string | null }>("POST", `/approvals/${id}`, { decision }),

  memories: (agentId: string) => request<MemoryDTO[]>("GET", `/agents/${agentId}/memories`),
  sharedMemories: () => request<MemoryDTO[]>("GET", "/memories/shared"),
  deleteMemory: (id: string) => request<{ ok: boolean }>("DELETE", `/memories/${id}`),

  skills: () => request<SkillDTO[]>("GET", "/skills"),
  createSkill: (input: { name: string; description: string; instructions: string }) => request<SkillDTO>("POST", "/skills", input),
  updateSkill: (id: string, patch: Partial<{ name: string; description: string; instructions: string; enabled: boolean }>) =>
    request<SkillDTO>("PATCH", `/skills/${id}`, patch),
  deleteSkill: (id: string) => request<{ ok: boolean }>("DELETE", `/skills/${id}`),

  connectors: () => request<ConnectorDTO[]>("GET", "/connectors"),
  testMail: (config: MailConfig, password: string, connectorId?: string) =>
    request<{ ok: boolean; imap: string; smtp: string }>("POST", "/connectors/mail/test", { config, password, connectorId }),
  createConnector: (input: {
    name: string;
    kind: "mcp" | "mail";
    config: McpConfig | MailConfig;
    secrets?: Record<string, string>;
    approval?: "ask" | "auto";
    requestedBy?: string;
  }) => request<ConnectorDTO>("POST", "/connectors", input),
  updateConnector: (
    id: string,
    patch: Partial<{ name: string; enabled: boolean; approval: "ask" | "auto"; config: McpConfig | MailConfig; secrets: Record<string, string> }>,
  ) => request<ConnectorDTO>("PATCH", `/connectors/${id}`, patch),
  refreshConnector: (id: string) => request<ConnectorDTO & { newMessages?: number }>("POST", `/connectors/${id}/refresh`),
  deleteConnector: (id: string) => request<{ ok: boolean }>("DELETE", `/connectors/${id}`),

  plugins: () => request<PluginDTO[]>("GET", "/plugins"),
  previewPlugin: (source: { manifest?: unknown; url?: string }) => request<PluginManifest>("POST", "/plugins/preview", source),
  installPlugin: (source: { manifest?: unknown; url?: string; secrets?: Record<string, Record<string, string>> }) =>
    request<{ ok: boolean; id: string }>("POST", "/plugins", source),
  uninstallPlugin: (id: string) => request<{ ok: boolean }>("DELETE", `/plugins/${id}`),

  draft: (id: string) => request<MailDraftDTO>("GET", `/mail/drafts/${id}`),
  updateDraft: (id: string, patch: { to?: string[]; cc?: string[]; subject?: string; body?: string }) =>
    request<MailDraftDTO>("PATCH", `/mail/drafts/${id}`, patch),
  userRequest: (id: string) => request<UserRequestDTO>("GET", `/requests/${id}`),

  journal: (agentId?: string) => request<JournalEntryDTO[]>("GET", `/journal${agentId ? `?agentId=${agentId}` : ""}`),
};
