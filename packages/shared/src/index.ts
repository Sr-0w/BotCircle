// Contrats partagés entre le backend et le frontend d'OpenDots.

export type AgentState =
  | 'available'
  | 'sleeping'
  | 'awake'
  | 'thinking'
  | 'working'
  | 'collaborating'
  | 'waiting'
  | 'done'
  | 'error';

export const AGENT_STATE_LABELS: Record<AgentState, string> = {
  available: 'Disponible',
  sleeping: 'En veille',
  awake: 'Réveillé',
  thinking: 'En réflexion',
  working: 'Au travail',
  collaborating: 'En collaboration',
  waiting: 'En attente',
  done: 'Terminé',
  error: 'En erreur',
};

export type ModelProvider = 'openrouter' | 'ollama' | 'codex';
export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface ModelConfig {
  provider: ModelProvider;
  model: string;
  reasoning?: ReasoningEffort | null;
  /** Fournisseurs OpenRouter préférés, dans l'ordre (ex. ["Cerebras"]). */
  providerOrder?: string[] | null;
}

export type CreateAgentsPolicy = 'allow' | 'ask' | 'deny';

export const COMPUTER_ACTION_TYPES = ['click', 'type', 'key', 'scroll', 'move'] as const;
export type ComputerActionType = typeof COMPUTER_ACTION_TYPES[number];
export interface DesktopPermissions {
  mode: 'auto' | 'ask' | 'custom';
  /** In custom mode, these actions execute directly; the others ask for approval. */
  actions: ComputerActionType[];
}

export interface AgentPermissions {
  /** Lire des pages web publiques. */
  web: boolean;
  /** Créer / modifier ses propres activités (planifications, surveillances). */
  manageActivities: boolean;
  /** Échanger avec les autres compagnons. */
  messageAgents: boolean;
  /** Créer de nouveaux compagnons. */
  createAgents: CreateAgentsPolicy;
  /** Gérer sa mémoire. */
  manageMemory: boolean;
  /** Lire les e-mails des comptes connectés (l'envoi demande toujours une validation). */
  mail: boolean;
  /** Utiliser les connecteurs MCP. */
  connectors: boolean;
  /** Exécuter des commandes sur l'ordinateur des compagnons. */
  shell: boolean;
  /** Voir le bureau et préparer des actions graphiques avec validation. */
  computer: boolean;
  /** Déléguer du développement à une instance OpenCode connectée par l'utilisateur. */
  code: boolean;
}

export const DEFAULT_PERMISSIONS: AgentPermissions = {
  web: true,
  manageActivities: true,
  messageAgents: true,
  createAgents: 'ask',
  manageMemory: true,
  mail: true,
  connectors: true,
  shell: true,
  computer: false,
  code: false,
};

export interface AgentDTO {
  id: string;
  name: string;
  named: boolean;
  color: string;
  description: string;
  personality: string;
  instructions: string;
  model: ModelConfig | null;
  effectiveModel: ModelConfig;
  permissions: AgentPermissions;
  state: AgentState;
  stateDetail: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unread: number;
  mainConversationId: string;
  archived: boolean;
}

export type ActivityKind = 'schedule' | 'watch' | 'webhook' | 'mail';

/** Filtre d'une activité déclenchée par la réception d'un e-mail. */
export interface ActivityMailFilter {
  connectorId?: string | null;
  from?: string | null;
  subject?: string | null;
}

export type ActivitySchedule =
  | { type: 'once'; at: string }
  | { type: 'interval'; minutes: number }
  | { type: 'cron'; expr: string; tz?: string };

export type WatchMode = 'changed' | 'contains' | 'not_contains' | 'regex';

export interface ActivityWatch {
  url: string;
  mode: WatchMode;
  value?: string | null;
}

export interface ActivityDTO {
  id: string;
  agentId: string;
  title: string;
  kind: ActivityKind;
  instructions: string;
  schedule: ActivitySchedule | null;
  watch: ActivityWatch | null;
  filter: ActivityMailFilter | null;
  webhookUrl: string | null;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastResult: string | null;
  runCount: number;
  createdAt: string;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'failed' | 'expired';

export interface ApprovalDTO {
  id: string;
  agentId: string;
  conversationId: string;
  action: string;
  summary: string;
  input: unknown;
  status: ApprovalStatus;
  result: unknown;
  error: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface MemoryDTO {
  id: string;
  agentId: string | null;
  content: string;
  kind: string;
  createdAt: string;
  updatedAt: string;
}

export interface JournalEntryDTO {
  id: string;
  agentId: string | null;
  kind: string;
  summary: string;
  data: unknown;
  createdAt: string;
}

export interface TeamThreadDTO {
  conversationId: string;
  agentIds: [string, string];
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  messageCount: number;
}

/** Métadonnées attachées à chaque UIMessage. */
export interface MessageMetadata {
  /** Persistent, actionable setup cards attached to the first welcome. */
  setup?: boolean;
  kind?: 'chat' | 'event' | 'team';
  /** Compagnon auteur (messages d'agent ou messages inter-agents). */
  agentId?: string;
  /** Type d'événement pour les messages "event". */
  event?: {
    type: 'schedule' | 'watch' | 'webhook' | 'mail' | 'agent_reply' | 'agent_message' | 'approval' | 'system' | 'reaction' | 'task';
    title: string;
    activityId?: string;
    approvalId?: string;
    fromAgentId?: string;
  };
  model?: string;
  /** Actual response routing per completed step; null means not reported. */
  modelSteps?: Array<{ step: number; model: string; provider: string | null; responseId: string | null }>;
  createdAt?: string;
  autonomous?: boolean;
  hidden?: boolean;
  /** Réponse de l'utilisateur à une demande d'information (ask_user). */
  answer?: { requestId: string; answers: Record<string, unknown> };
  /** Message auquel celui-ci répond. */
  replyTo?: MessageReplyRef;
  /** Réactions (tapbacks), jointes à la lecture. */
  reactions?: MessageReaction[];
  /** Durée du tour, une fois terminé, pour le panneau « A travaillé ». */
  workedMs?: number;
  /** Message produit par une tâche (résultat, blocage) : la tâche d'origine. */
  taskId?: string;
}

/** Un emoji ajouté par l'utilisateur (`actor: 'user'`) ou un compagnon (id). */
export interface MessageReaction {
  emoji: string;
  actor: string;
}

export interface MessageReplyRef {
  messageId: string;
  preview: string;
  role: 'user' | 'assistant';
}

export interface AccountProfileDTO {
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  source: 'gravatar' | null;
}

export interface BootstrapDTO {
  onboarded: boolean;
  openrouterConfigured: boolean;
  defaultModel: ModelConfig | null;
  ollamaUrl: string | null;
  paused: boolean;
}

export type ServerEvent =
  | { type: 'agent.updated'; agent: AgentDTO }
  | { type: 'agent.created'; agent: AgentDTO }
  | { type: 'agent.state'; agentId: string; state: AgentState; detail: string | null }
  | { type: 'turn.started'; agentId: string; conversationId: string; autonomous: boolean }
  | { type: 'turn.finished'; agentId: string; conversationId: string }
  | {
      type: 'message.created';
      conversationId: string;
      agentId: string | null;
      messageId: string;
      hidden: boolean;
      author: 'user' | 'agent' | 'event';
      preview: string;
    }
  | { type: 'message.reaction'; conversationId: string; messageId: string; reactions: MessageReaction[] }
  | { type: 'activity.changed'; agentId: string }
  | { type: 'approval.changed'; approval: ApprovalDTO }
  | { type: 'memory.changed'; agentId: string | null }
  | { type: 'journal.created'; entry: JournalEntryDTO }
  | { type: 'team.changed'; conversationId: string }
  | { type: 'settings.changed' }
  | { type: 'skills.changed' }
  | { type: 'connectors.changed' }
  | { type: 'request.changed'; request: UserRequestDTO }
  | { type: 'draft.changed'; draft: MailDraftDTO }
  | { type: 'task.changed'; task: TaskDTO }
  | { type: 'chat.changed'; chatId: string; deleted?: boolean }
  | { type: 'artifact.changed'; artifactId: string }
  | { type: 'secure_login.changed'; login: SecureLoginDTO }
  | { type: 'opencode.changed' };

// --- Connexion sécurisée ----------------------------------------------------------

/** `pending` : l'utilisateur a la main ; les autres états sont définitifs. */
export type SecureLoginStatus = 'pending' | 'authenticated' | 'cancelled' | 'failed' | 'expired';

/** Une demande de connexion : l'origine exacte visée et son issue. Jamais d'identifiant, de mot de passe ni de code. */
export interface SecureLoginDTO {
  id: string;
  agentId: string;
  conversationId: string;
  taskId: string | null;
  /** Schéma + hôte (+ port), tel que vérifié par le serveur. */
  origin: string;
  url: string;
  reason: string;
  status: SecureLoginStatus;
  createdAt: string;
  resolvedAt: string | null;
}

// --- Artefacts (fichiers) -----------------------------------------------------

export interface ArtifactDTO {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  sha256: string;
  /** Qui a créé le fichier : l'utilisateur, un compagnon ou un worker (tâche). */
  authorKind: 'user' | 'agent' | 'worker';
  authorId: string | null;
  source: 'upload' | 'agent' | 'screenshot';
  conversationId: string | null;
  taskId: string | null;
  /** Version révisée de cet artefact, le cas échéant. */
  parentId: string | null;
  createdAt: string;
  /** Lien privé (session requise) vers le contenu inchangé. */
  url: string;
}

export interface ArtifactGrantDTO {
  agentId: string;
  grantedBy: string;
  via: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface ArtifactAccessDTO {
  actor: string;
  action: string;
  detail: string | null;
  createdAt: string;
}

/** Limite par fichier, côté client et serveur. */
export const ARTIFACT_MAX_BYTES = 50 * 1024 * 1024;

export const artifactUrl = (id: string) => `/api/artifacts/${id}/content`;
const ARTIFACT_URL = /^\/api\/artifacts\/(art_[a-z0-9]+)\/content$/;
export const artifactIdFromUrl = (url: unknown): string | null => (typeof url === 'string' ? ARTIFACT_URL.exec(url)?.[1] ?? null : null);

// --- Tâches (workers en arrière-plan) --------------------------------------------

export type TaskStatus = 'queued' | 'running' | 'waiting_for_user' | 'paused' | 'completed' | 'failed' | 'cancelled';
export const ACTIVE_TASK_STATUSES: TaskStatus[] = ['queued', 'running', 'waiting_for_user', 'paused'];

export type TaskProviderName = 'worker' | 'opencode';
/** Référence stable d'une exécution externe : une consigne ne peut pas atterrir dans une autre session. */
export interface TaskExternalRef {
  instanceId: string;
  sessionId: string;
  directory: string | null;
  /** Dernier message assistant déjà pris en compte, pour ne rien rapporter deux fois. */
  seenMessageId?: string | null;
  promptedAt?: number;
  /** `true` tant que l'instance ne répond pas : l'état affiché est le dernier connu, pas un échec. */
  unreachable?: boolean;
}

export interface TaskDTO {
  id: string;
  agentId: string;
  conversationId: string;
  title: string;
  instruction: string;
  status: TaskStatus;
  /** Progression observée, jamais estimée. */
  phase: string | null;
  currentActionSummary: string | null;
  completedSteps: number;
  totalSteps: number | null;
  blocker: string | null;
  requiresUserInput: boolean;
  result: string | null;
  error: string | null;
  artifacts: ArtifactDTO[];
  /** `opencode` : le travail se fait dans une session OpenCode distante, ouvrable dans l'espace de code. */
  provider: TaskProviderName;
  external: (TaskExternalRef & { instanceName: string }) | null;
  requestedBy: string;
  lastHeartbeat: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface TaskEventDTO {
  seq: number;
  kind: 'status' | 'step' | 'note' | 'error' | 'instruction' | 'artifact';
  summary: string;
  createdAt: string;
}

// --- OpenCode ---------------------------------------------------------------------

export interface OpencodeInstanceDTO {
  id: string;
  name: string;
  baseUrl: string;
  username: string;
  /** Un mot de passe est enregistré (jamais renvoyé). */
  hasPassword: boolean;
  defaultDirectory: string | null;
  version: string | null;
  /** `online` : a répondu au dernier contrôle ; `offline` : injoignable ; `unknown` : jamais contrôlée. */
  state: 'online' | 'offline' | 'unknown';
  lastSeenAt: string | null;
  lastError: string | null;
  activeTasks: number;
}

export interface OpencodeProjectDTO { id: string; worktree: string; name: string | null }
export interface OpencodeSessionDTO { id: string; title: string; directory: string; updatedAt: number; busy: boolean; additions: number; deletions: number; files: number }

/** Une partie de message OpenCode, réduite à ce que l'espace de code affiche. */
export type OpencodePartDTO =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool'; tool: string; status: 'pending' | 'running' | 'completed' | 'error'; title: string | null; input: string; output: string | null }
  | { type: 'patch'; files: string[] }
  | { type: 'file'; filename: string | null; mime: string };
export interface OpencodeMessageDTO { id: string; role: 'user' | 'assistant'; createdAt: number; completedAt: number | null; model: string | null; error: string | null; parts: OpencodePartDTO[] }
export interface OpencodeDiffDTO { path: string; status: 'added' | 'modified' | 'deleted'; additions: number; deletions: number; patch: string }
export interface OpencodePermissionDTO { id: string; permission: string; patterns: string[] }
export interface OpencodeQuestionDTO { id: string; questions: { question: string; header: string; options: string[]; multiple: boolean }[] }
export interface OpencodeExchangeDTO { seq: number; taskId: string; author: 'user' | 'companion' | 'opencode'; agentId: string | null; kind: string; text: string; original: string | null; createdAt: string }
export interface OpencodeFileNodeDTO { name: string; path: string; type: 'file' | 'directory' }

/** L'espace de code d'une tâche : la session exacte, son état réel, ce qui attend l'utilisateur. */
export interface OpencodeWorkspaceDTO {
  task: TaskDTO;
  /** `false` : l'instance ne répond pas ; les listes sont alors vides et l'état de la tâche est le dernier connu. */
  reachable: boolean;
  error: string | null;
  session: OpencodeSessionDTO | null;
  /** `busy`, `idle`, `retry` selon OpenCode ; `unknown` si l'instance est injoignable. */
  sessionStatus: 'busy' | 'idle' | 'retry' | 'unknown';
  messages: OpencodeMessageDTO[];
  permissions: OpencodePermissionDTO[];
  questions: OpencodeQuestionDTO[];
  diffs: OpencodeDiffDTO[];
  exchanges: OpencodeExchangeDTO[];
}

// --- Chats généraux (sans compagnon propriétaire) ---------------------------------

export interface ChatDTO {
  id: string;
  title: string;
  /** Modèle propre au chat ; null = modèle par défaut. */
  model: ModelConfig | null;
  effectiveModel: ModelConfig;
  createdAt: string;
  updatedAt: string;
  lastMessagePreview: string | null;
}

/** Mentions `@Nom` d'un message, résolues sur les compagnons existants (insensible à la casse, sans doublon). */
export function findMentions(text: string, agents: { id: string; name: string }[]): string[] {
  const found: string[] = [];
  const sorted = [...agents].sort((a, b) => b.name.length - a.name.length);
  const lower = text.toLowerCase();
  for (const agent of sorted) {
    const name = agent.name.trim().toLowerCase();
    if (!name) continue;
    let from = 0;
    while (true) {
      const at = lower.indexOf(`@${name}`, from);
      if (at < 0) break;
      const next = lower[at + name.length + 1];
      if ((next === undefined || !/[\p{L}\p{N}_]/u.test(next)) && !found.includes(agent.id)) found.push(agent.id);
      from = at + 1;
    }
  }
  return found;
}

// --- Skills, connecteurs, plugins -------------------------------------------

export interface SkillDTO {
  id: string;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  pluginId: string | null;
  createdBy: string;
  updatedAt: string;
}

export type ConnectorKind = 'mcp' | 'mail' | 'integration';
export type IntegrationProvider = 'google-drive' | 'google-calendar' | 'gmail' | 'outlook' | 'github';
export type OAuthProvider = 'google' | 'microsoft' | 'github';

export interface IntegrationConfig {
  provider: IntegrationProvider;
  account: { id: string; label: string; email?: string };
  permissions: string[];
  grantedScopes: string[];
}

export interface IntegrationCatalogEntry {
  id: IntegrationProvider | 'imap-smtp';
  name: string;
  description: string;
  category: 'files' | 'calendar' | 'mail' | 'development';
  oauth: OAuthProvider | null;
  permissions: { id: string; label: string; description: string; scopes: string[]; default: boolean }[];
}

export interface OAuthAppDTO {
  provider: OAuthProvider;
  configured: boolean;
  clientId: string;
  hasSecret: boolean;
  source: 'environment' | 'local';
  callbackUrl: string;
}

export interface McpConfig {
  transport: 'http' | 'sse' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
}

export interface MailConfig {
  email: string;
  displayName?: string;
  username: string;
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
  /** Fréquence de relève, en minutes. */
  pollMinutes?: number;
}

export interface ConnectorDTO {
  id: string;
  name: string;
  kind: ConnectorKind;
  config: McpConfig | MailConfig | IntegrationConfig;
  /** Noms des secrets enregistrés (valeurs jamais renvoyées). */
  secretKeys: string[];
  enabled: boolean;
  approval: 'ask' | 'auto';
  status: 'unknown' | 'ok' | 'error';
  lastError: string | null;
  tools: { name: string; description: string }[];
  pluginId: string | null;
  createdAt: string;
}

export interface PluginManifest {
  name: string;
  description?: string;
  version?: string;
  skills?: { name: string; description: string; instructions: string }[];
  connectors?: { name: string; config: McpConfig; approval?: 'ask' | 'auto'; secrets?: string[] }[];
}

export interface PluginDTO {
  id: string;
  name: string;
  description: string;
  version: string;
  skills: number;
  connectors: number;
  installedAt: string;
}

// --- Demandes à l'utilisateur ----------------------------------------------

export interface AskQuestion {
  id: string;
  label: string;
  type: 'text' | 'textarea' | 'single_choice' | 'multi_choice' | 'confirm' | 'number' | 'date';
  options?: string[];
  required?: boolean;
  placeholder?: string;
  allowOther?: boolean;
}

export interface UserRequestDTO {
  id: string;
  agentId: string;
  conversationId: string;
  title: string;
  questions: AskQuestion[];
  status: 'pending' | 'answered' | 'cancelled';
  answers: Record<string, unknown> | null;
  createdAt: string;
}

export interface MailDraftDTO {
  id: string;
  agentId: string;
  connectorId: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  status: 'pending' | 'sent' | 'discarded' | 'failed';
  approvalId: string | null;
  error: string | null;
  sentAt: string | null;
}

/**
 * Certains modèles (gpt-oss) laissent parfois fuiter des appels d'outils au
 * format brut dans leur texte (« to=functions.x {…} », jetons <|…|>). On les
 * retire avant affichage et persistance.
 */
export function cleanModelText(text: string): string {
  return text
    .replace(/(?:\{[^{}]*\}\s*)?(?:<\|[a-z_]+\|>\s*)*to=functions\.[\w.-]+(?:\s*<\|[a-z_]+\|>[\w ]*)*\s*(?:\{[^{}]*\})?/gi, ' ')
    .replace(/<\|(?:start|end|message|channel|constrain|call|return)\|>/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,])/g, '$1')
    .trim();
}

const SILENCE_TEXT = /^\s*<(silence|no[_-]?reply)\s*\/?>\s*$/i;
const ACTION_TOOL_TYPES = new Set([
  'tool-ask_user',
  'tool-connection_request_setup',
  'tool-computer_request_setup',
  'tool-mail_prepare',
]);

/** Un seul emoji (y compris les séquences ZWJ), pas du texte libre. */
export function isSingleEmoji(value: string): boolean {
  const s = value.trim();
  if (!s || [...s].length > 16) return false;
  if (/\p{Letter}|\p{Number}/u.test(s)) return false;
  if (!/\p{Extended_Pictographic}|\p{Emoji_Presentation}/u.test(s)) return false;
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (!Segmenter) return true;
  return [...new Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].length === 1;
}

type Presentable = {
  type: string;
  text?: string;
  input?: unknown;
  state?: string;
  output?: unknown;
  mediaType?: string;
  toolName?: string;
  toolCallId?: string;
  url?: string;
  filename?: string;
};

function toolOutput(part: Presentable): { ok?: boolean; status?: string } | null {
  if (!part.output || typeof part.output !== 'object') return null;
  return part.output as { ok?: boolean; status?: string };
}

function textFromInput(part: Presentable): string {
  const input = part.input;
  if (!input || typeof input !== 'object' || !('text' in input)) return '';
  return typeof input.text === 'string' ? input.text : '';
}

/** Carte sur laquelle l'utilisateur doit agir : elle reste dans le fil. */
export function isActionToolPart(part: Presentable): boolean {
  if (part.state !== 'output-available') return false;
  const out = toolOutput(part);
  if (!out || out.ok === false) return false;
  if (part.type === 'tool-team_send_message' && out.status === 'sent') return true;
  // Une tâche déléguée laisse sa carte dans le fil (mise à jour en place).
  if (part.type === 'tool-request_secure_login' && typeof (out as { loginId?: unknown }).loginId === 'string') return true;
  if ((part.type === 'tool-task_start' || part.type === 'tool-invoke_agent' || part.type === 'tool-opencode_start') && typeof (out as { taskId?: unknown }).taskId === 'string') return true;
  if (ACTION_TOOL_TYPES.has(part.type)) return true;
  return out.status === 'pending_approval';
}

export type PresentedBubble<T> = { key: string; text: string } | { key: string; image: T } | { key: string; file: PresentedFile };

/** Pièce jointe non image d'un message : un fichier réel, téléchargeable. */
export interface PresentedFile { url: string; filename: string; mediaType: string; size?: number; caption?: string | null; artifactId?: string | null }

/**
 * Un tour assistant est un seul message stocké. Les phrases visibles
 * (`text_user` et le texte du modèle, y compris la réponse finale) deviennent
 * des bulles. Le raisonnement, les outils et leurs résultats vont dans un
 * seul panneau. Les cartes d'action restent à part.
 */
export function presentAssistantTurn<T extends Presentable>(parts: T[]): { bubbles: PresentedBubble<T>[]; work: T[]; actions: T[] } {
  const bubbles: PresentedBubble<T>[] = [];
  const work: T[] = [];
  const actions: T[] = [];
  parts.forEach((part, index) => {
    if (part.type === 'text' || part.type === 'tool-text_user') {
      const raw = part.type === 'text' ? (part.text ?? '') : textFromInput(part);
      const text = cleanModelText(raw);
      if (text && !SILENCE_TEXT.test(text)) bubbles.push({ key: `text-${index}`, text });
      return;
    }
    if (part.type === 'file' && part.mediaType?.startsWith('image/')) {
      bubbles.push({ key: `image-${index}`, image: part });
      return;
    }
    // Un fichier joint (artefact) est une pièce jointe du fil, pas une trace de travail.
    if (part.type === 'file' && part.url && artifactIdFromUrl(part.url)) {
      bubbles.push({ key: `file-${index}`, file: { url: part.url, filename: part.filename ?? 'fichier', mediaType: part.mediaType ?? 'application/octet-stream', artifactId: artifactIdFromUrl(part.url) } });
      return;
    }
    // Un fichier n'est « remis » que si l'outil de publication l'a confirmé.
    if (part.type === 'tool-artifact_publish_to_chat') {
      const out = part.output as { ok?: boolean; status?: string; caption?: string | null; artifact?: { id: string; url: string; name: string; mediaType: string; size: number } } | undefined;
      if (part.state === 'output-available' && out?.ok && out.status === 'published' && out.artifact) {
        const a = out.artifact;
        if (a.mediaType.startsWith('image/')) bubbles.push({ key: `image-${index}`, image: { type: 'file', url: a.url, filename: a.name, mediaType: a.mediaType } as unknown as T });
        else bubbles.push({ key: `file-${index}`, file: { url: a.url, filename: a.name, mediaType: a.mediaType, size: a.size, caption: out.caption ?? null, artifactId: a.id } });
        return;
      }
    }
    // Une capture partagée par le compagnon est une image du fil, pas une trace d'outil.
    if (part.type === 'tool-share_screenshot') {
      const out = part.output as { ok?: boolean; status?: string; url?: string; filename?: string; mediaType?: string } | undefined;
      if (part.state === 'output-available' && out?.ok && out.status === 'attached' && out.url) {
        bubbles.push({ key: `image-${index}`, image: { type: 'file', url: out.url, filename: out.filename, mediaType: out.mediaType ?? 'image/jpeg' } as unknown as T });
        return;
      }
    }
    if (part.type === 'step-start') return;
    if (isActionToolPart(part)) {
      actions.push(part);
      return;
    }
    if (part.type === 'reasoning' || part.type === 'dynamic-tool' || part.type.startsWith('tool-') || part.type === 'file') work.push(part);
  });
  return { bubbles, work, actions };
}

/** Découpe historique : le texte avant ou entre les outils, puis le travail. L'affichage du chat utilise `presentAssistantTurn`. */
export function partitionToolNarrative<T extends { type: string }>(parts: T[]): { lead: T[]; around: T[]; work: T[] } {
  const lead: T[] = [];
  const around: T[] = [];
  const work: T[] = [];
  let seenTool = false;
  for (const part of parts) {
    if (part.type === 'text' || part.type === 'file') (seenTool ? around : lead).push(part);
    else {
      if (part.type.startsWith('tool-')) seenTool = true;
      work.push(part);
    }
  }
  return { lead, around, work };
}

/** Limites communes aux images jointes au chat. */
export const IMAGE_MAX_COUNT = 6;
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
