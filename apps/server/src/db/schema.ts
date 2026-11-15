import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { SecureLoginStatus, TaskProviderName, TaskExternalRef,
  ActivityKind,
  ActivitySchedule,
  ActivityMailFilter,
  ActivityWatch,
  AgentPermissions,
  AskQuestion,
  ConnectorKind,
  AgentState,
  ApprovalStatus,
  ModelConfig,
} from '@opendots/shared';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const agents = pgTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  named: boolean('named').notNull().default(false),
  color: text('color').notNull(),
  description: text('description').notNull().default(''),
  personality: text('personality').notNull().default(''),
  instructions: text('instructions').notNull().default(''),
  model: jsonb('model').$type<ModelConfig | null>(),
  permissions: jsonb('permissions').$type<AgentPermissions>().notNull(),
  state: text('state').$type<AgentState>().notNull().default('available'),
  stateDetail: text('state_detail'),
  createdBy: text('created_by').notNull().default('user'),
  archived: boolean('archived').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  lastReadAt: ts('last_read_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const conversations = pgTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    /** main : fil d'un compagnon ; pair : fil entre deux compagnons ; chat : chat général sans compagnon ; task : journal de travail d'une tâche. */
    kind: text('kind').$type<'main' | 'pair' | 'chat' | 'task'>().notNull(),
    /** Compagnon propriétaire pour une conversation principale. */
    agentId: text('agent_id'),
    /** Participants d'une conversation entre compagnons (triés). */
    agentA: text('agent_a'),
    agentB: text('agent_b'),
    /** Titre d'un chat général. */
    title: text('title'),
    /** Modèle propre à un chat général (sinon le modèle par défaut). */
    model: jsonb('model').$type<ModelConfig | null>(),
    archived: boolean('archived').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('conversations_main_idx').on(t.agentId).where(sql`kind = 'main'`),
    uniqueIndex('conversations_pair_idx').on(t.agentA, t.agentB).where(sql`kind = 'pair'`),
    index('conversations_kind_idx').on(t.kind, t.updatedAt),
  ],
);

export const messages = pgTable(
  'messages',
  {
    seq: serial('seq').primaryKey(),
    id: text('id').notNull().unique(),
    conversationId: text('conversation_id').notNull(),
    role: text('role').$type<'user' | 'assistant'>().notNull(),
    /** user | agent | event */
    author: text('author').$type<'user' | 'agent' | 'event'>().notNull(),
    agentId: text('agent_id'),
    parts: jsonb('parts').$type<unknown[]>().notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    hidden: boolean('hidden').notNull().default(false),
    textContent: text('text_content').notNull().default(''),
    replyToId: text('reply_to_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('messages_conv_idx').on(t.conversationId, t.seq), index('messages_reply_idx').on(t.replyToId)],
);

/** Tapback : un emoji par acteur (`user` ou id de compagnon) et par message. */
export const messageReactions = pgTable(
  'message_reactions',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    emoji: text('emoji').notNull(),
    actor: text('actor').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('message_reactions_unique').on(t.messageId, t.emoji, t.actor),
    index('message_reactions_message_idx').on(t.messageId),
  ],
);

export const memories = pgTable(
  'memories',
  {
    id: text('id').primaryKey(),
    /** null = connaissance partagée entre compagnons. */
    agentId: text('agent_id'),
    content: text('content').notNull(),
    kind: text('kind').notNull().default('fact'),
    source: text('source').notNull().default('conversation'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('memories_agent_idx').on(t.agentId)],
);

export const activities = pgTable(
  'activities',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    title: text('title').notNull(),
    kind: text('kind').$type<ActivityKind>().notNull(),
    instructions: text('instructions').notNull(),
    schedule: jsonb('schedule').$type<ActivitySchedule | null>(),
    watch: jsonb('watch').$type<ActivityWatch | null>(),
    /** Filtre d'un déclencheur mail : compte, expéditeur, sujet. */
    filter: jsonb('filter').$type<ActivityMailFilter | null>(),
    watchState: jsonb('watch_state').$type<{ hash?: string; excerpt?: string; matched?: boolean } | null>(),
    webhookToken: text('webhook_token'),
    enabled: boolean('enabled').notNull().default(true),
    nextRunAt: ts('next_run_at'),
    lastRunAt: ts('last_run_at'),
    lastStatus: text('last_status'),
    lastResult: text('last_result'),
    runCount: integer('run_count').notNull().default(0),
    createdBy: text('created_by').notNull().default('agent'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('activities_due_idx').on(t.enabled, t.nextRunAt),
    uniqueIndex('activities_webhook_idx').on(t.webhookToken),
  ],
);

export const events = pgTable(
  'events',
  {
    id: text('id').primaryKey(),
    source: text('source').notNull(),
    agentId: text('agent_id'),
    activityId: text('activity_id'),
    payload: jsonb('payload').notNull(),
    dedupeKey: text('dedupe_key'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('events_dedupe_idx').on(t.dedupeKey)],
);

export const approvals = pgTable('approvals', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  conversationId: text('conversation_id').notNull(),
  toolCallId: text('tool_call_id'),
  action: text('action').notNull(),
  summary: text('summary').notNull(),
  input: jsonb('input').notNull(),
  status: text('status').$type<ApprovalStatus>().notNull().default('pending'),
  result: jsonb('result'),
  error: text('error'),
  resolvedBy: text('resolved_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  resolvedAt: ts('resolved_at'),
});

export const teamMessages = pgTable('team_messages', {
  id: text('id').primaryKey(),
  fromAgentId: text('from_agent_id').notNull(),
  toAgentId: text('to_agent_id').notNull(),
  conversationId: text('conversation_id').notNull(),
  content: text('content').notNull(),
  expectsReply: boolean('expects_reply').notNull().default(true),
  /** Conversation d'origine de l'expéditeur, où la réponse sera rapportée. */
  replyToConversationId: text('reply_to_conversation_id'),
  depth: integer('depth').notNull().default(0),
  status: text('status').$type<'pending' | 'processing' | 'answered' | 'done' | 'failed'>().notNull().default('pending'),
  reply: text('reply'),
  createdAt: ts('created_at').notNull().defaultNow(),
  answeredAt: ts('answered_at'),
});

export const jobs = pgTable(
  'jobs',
  {
    id: serial('id').primaryKey(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    agentId: text('agent_id'),
    status: text('status').$type<'queued' | 'running' | 'done' | 'failed'>().notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    runAt: ts('run_at').notNull().defaultNow(),
    lockedAt: ts('locked_at'),
    lastError: text('last_error'),
    dedupeKey: text('dedupe_key'),
    createdAt: ts('created_at').notNull().defaultNow(),
    finishedAt: ts('finished_at'),
  },
  (t) => [index('jobs_queue_idx').on(t.status, t.runAt), uniqueIndex('jobs_dedupe_idx').on(t.dedupeKey)],
);

export const journal = pgTable(
  'journal',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id'),
    kind: text('kind').notNull(),
    summary: text('summary').notNull(),
    data: jsonb('data'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('journal_agent_idx').on(t.agentId, t.createdAt)],
);

/** Skills : instructions réutilisables, au niveau du compte. */
export const skills = pgTable('skills', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  description: text('description').notNull(),
  instructions: text('instructions').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  pluginId: text('plugin_id'),
  createdBy: text('created_by').notNull().default('user'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** Connecteurs : serveurs MCP et comptes mail, au niveau du compte. */
export const connectors = pgTable('connectors', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind').$type<ConnectorKind>().notNull(),
  config: jsonb('config').$type<Record<string, any>>().notNull(),
  /** Secrets chiffrés (JSON), jamais exposés au frontend ni aux modèles. */
  secret: text('secret'),
  enabled: boolean('enabled').notNull().default(true),
  approval: text('approval').$type<'ask' | 'auto'>().notNull().default('ask'),
  status: text('status').$type<'unknown' | 'ok' | 'error'>().notNull().default('unknown'),
  lastError: text('last_error'),
  tools: jsonb('tools').$type<{ name: string; description: string }[]>(),
  state: jsonb('state').$type<Record<string, any>>(),
  pluginId: text('plugin_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const plugins = pgTable('plugins', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  version: text('version').notNull().default('0.0.0'),
  manifest: jsonb('manifest').notNull(),
  source: text('source').notNull().default('manual'),
  installedAt: ts('installed_at').notNull().defaultNow(),
});

export const mailDrafts = pgTable('mail_drafts', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  connectorId: text('connector_id').notNull(),
  to: jsonb('to').$type<string[]>().notNull(),
  cc: jsonb('cc').$type<string[]>().notNull().default([]),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  inReplyTo: text('in_reply_to'),
  references: text('references'),
  status: text('status').$type<'pending' | 'sent' | 'discarded' | 'failed'>().notNull().default('pending'),
  approvalId: text('approval_id'),
  messageId: text('message_id'),
  error: text('error'),
  createdAt: ts('created_at').notNull().defaultNow(),
  sentAt: ts('sent_at'),
});

/** Demandes d'information ou de choix adressées à l'utilisateur. */
export const userRequests = pgTable('user_requests', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  conversationId: text('conversation_id').notNull(),
  title: text('title').notNull(),
  questions: jsonb('questions').$type<AskQuestion[]>().notNull(),
  status: text('status').$type<'pending' | 'answered' | 'cancelled'>().notNull().default('pending'),
  answers: jsonb('answers').$type<Record<string, unknown>>(),
  createdAt: ts('created_at').notNull().defaultNow(),
  answeredAt: ts('answered_at'),
});

// --- Artefacts : fichiers privés du compte, partagés par autorisation explicite ----------

export const artifacts = pgTable(
  'artifacts',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    mediaType: text('media_type').notNull(),
    size: integer('size').notNull(),
    /** Les octets sont stockés une seule fois par empreinte. */
    sha256: text('sha256').notNull(),
    authorKind: text('author_kind').$type<'user' | 'agent' | 'worker'>().notNull(),
    authorId: text('author_id'),
    source: text('source').$type<'upload' | 'agent' | 'screenshot'>().notNull(),
    conversationId: text('conversation_id'),
    taskId: text('task_id'),
    /** Artefact dont celui-ci est une version révisée. */
    parentId: text('parent_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [index('artifacts_conversation_idx').on(t.conversationId), index('artifacts_sha_idx').on(t.sha256)],
);

/** Droit de lecture d'un compagnon sur un artefact. Sans ligne active, pas d'accès. */
export const artifactGrants = pgTable(
  'artifact_grants',
  {
    id: text('id').primaryKey(),
    artifactId: text('artifact_id').notNull(),
    agentId: text('agent_id').notNull(),
    /** `user` ou id du compagnon qui a partagé. */
    grantedBy: text('granted_by').notNull(),
    via: text('via').$type<'upload' | 'share' | 'create' | 'task' | 'user'>().notNull(),
    conversationId: text('conversation_id'),
    taskId: text('task_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
    revokedAt: ts('revoked_at'),
  },
  (t) => [index('artifact_grants_artifact_idx').on(t.artifactId), index('artifact_grants_agent_idx').on(t.agentId)],
);

/** Journal des accès : qui a lu, partagé ou publié quoi. Jamais le contenu. */
export const artifactAccess = pgTable(
  'artifact_access',
  {
    id: text('id').primaryKey(),
    artifactId: text('artifact_id').notNull(),
    actor: text('actor').notNull(),
    action: text('action').$type<'create' | 'read' | 'download' | 'share' | 'publish' | 'revoke' | 'delete' | 'denied'>().notNull(),
    detail: text('detail'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('artifact_access_artifact_idx').on(t.artifactId, t.createdAt)],
);

// --- Tâches : travail long exécuté par un worker, hors du tour de chat --------------------

export type TaskStatus = 'queued' | 'running' | 'waiting_for_user' | 'paused' | 'completed' | 'failed' | 'cancelled';

export const tasks = pgTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    /** Conversation d'origine : la carte et le résultat y apparaissent. */
    conversationId: text('conversation_id').notNull(),
    /** Conversation privée du worker : son journal technique. */
    workConversationId: text('work_conversation_id').notNull(),
    title: text('title').notNull(),
    instruction: text('instruction').notNull(),
    status: text('status').$type<TaskStatus>().notNull().default('queued'),
    phase: text('phase'),
    currentAction: text('current_action'),
    completedSteps: integer('completed_steps').notNull().default(0),
    totalSteps: integer('total_steps'),
    blocker: text('blocker'),
    requiresUserInput: boolean('requires_user_input').notNull().default(false),
    result: text('result'),
    error: text('error'),
    artifacts: jsonb('artifacts').$type<string[]>().notNull().default([]),
    /** Consignes ajoutées pendant l'exécution, appliquées à l'étape suivante. */
    pendingInstructions: jsonb('pending_instructions').$type<string[]>().notNull().default([]),
    /** Qui exécute : un worker BotCircle (`worker`) ou une session OpenCode distante (`opencode`). */
    provider: text('provider').$type<TaskProviderName>().notNull().default('worker'),
    /** Pour une exécution externe : l'instance, la session et le dossier exacts. */
    external: jsonb('external').$type<TaskExternalRef | null>(),
    /** `agent` (délégation par le compagnon), `user` (mention depuis un chat) ou `assistant` (chat général). */
    requestedBy: text('requested_by').notNull().default('agent'),
    lastHeartbeat: ts('last_heartbeat'),
    createdAt: ts('created_at').notNull().defaultNow(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
  },
  (t) => [index('tasks_agent_idx').on(t.agentId, t.status), index('tasks_conversation_idx').on(t.conversationId, t.createdAt)],
);

/** Journal technique d'une tâche (outils, notes, erreurs), consultable dans « Détails ». */
export const taskEvents = pgTable(
  'task_events',
  {
    seq: serial('seq').primaryKey(),
    taskId: text('task_id').notNull(),
    kind: text('kind').$type<'status' | 'step' | 'note' | 'error' | 'instruction' | 'artifact'>().notNull(),
    summary: text('summary').notNull(),
    data: jsonb('data'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('task_events_task_idx').on(t.taskId, t.seq)],
);

/**
 * Connexion sécurisée : un compagnon a besoin que l'utilisateur s'authentifie sur un site. Rien de secret n'est
 * stocké ici — seulement l'origine visée, la raison et l'issue. Tant que `status` vaut `pending`, les outils
 * d'ordinateur de ce compagnon sont suspendus.
 */
export const secureLogins = pgTable(
  'secure_logins',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    taskId: text('task_id'),
    origin: text('origin').notNull(),
    url: text('url').notNull(),
    reason: text('reason').notNull().default(''),
    status: text('status').$type<SecureLoginStatus>().notNull().default('pending'),
    createdAt: ts('created_at').notNull().defaultNow(),
    resolvedAt: ts('resolved_at'),
  },
  (t) => [index('secure_logins_agent_idx').on(t.agentId, t.status)],
);

/** Instances OpenCode du compte (`opencode serve`), jointes par leur API HTTP. Le mot de passe est chiffré. */
export const opencodeInstances = pgTable('opencode_instances', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(),
  username: text('username').notNull().default('opencode'),
  password: text('password'),
  defaultDirectory: text('default_directory'),
  version: text('version'),
  lastSeenAt: ts('last_seen_at'),
  lastError: text('last_error'),
  /** `v2` (OpenCode 2.x, /api/…) or `v1`; detected on each check. */
  apiVersion: text('api_version').$type<'v1' | 'v2'>(),
  /** `pairing`: the secret is a session token from `opencode pair`, which expires; `password`: the server password. */
  authKind: text('auth_kind').$type<'password' | 'pairing'>().notNull().default('password'),
  tokenExpiresAt: ts('token_expires_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/**
 * Ce qui a été dit à OpenCode et ce qu'il a répondu, pour les « Échanges de l'équipe » : consignes réellement
 * envoyées (avec la demande d'origine de l'utilisateur si le compagnon l'a reformulée), réponses et issues. Les
 * appels d'outils et la sortie du terminal n'y figurent pas : ils restent dans l'espace de code.
 */
export const opencodeExchanges = pgTable(
  'opencode_exchanges',
  {
    seq: serial('seq').primaryKey(),
    taskId: text('task_id').notNull(),
    instanceId: text('instance_id').notNull(),
    sessionId: text('session_id').notNull(),
    /** `user` (saisi dans l'espace de code), `companion` ou `opencode`. */
    author: text('author').$type<'user' | 'companion' | 'opencode'>().notNull(),
    agentId: text('agent_id'),
    kind: text('kind').$type<'delegation' | 'instruction' | 'response' | 'question' | 'permission' | 'result' | 'failure' | 'stop'>().notNull(),
    text: text('text').notNull(),
    original: text('original'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('opencode_exchanges_task_idx').on(t.taskId, t.seq)],
);
