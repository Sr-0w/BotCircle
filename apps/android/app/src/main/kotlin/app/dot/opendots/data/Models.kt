package app.dot.opendots.data

import androidx.compose.runtime.Immutable
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** Lenient on purpose: the server is the source of truth and grows fields between releases. */
val OdJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    coerceInputValues = true
    isLenient = true
}

@Serializable
data class Account(val id: String = "", val email: String = "", val role: String = "")

@Serializable
data class MeResponse(val account: Account? = null, val registrationOpen: Boolean = true)

@Serializable
data class AccountResponse(val account: Account)

@Serializable
data class ModelConfig(val provider: String = "openrouter", val model: String = "", val reasoning: String? = null, val providerOrder: List<String>? = null)

@Serializable
data class Bootstrap(
    val onboarded: Boolean = false,
    val openrouterConfigured: Boolean = false,
    val defaultModel: ModelConfig? = null,
    val paused: Boolean = false,
)

@Serializable
data class Permissions(
    val web: Boolean = true,
    val manageActivities: Boolean = true,
    val messageAgents: Boolean = true,
    val createAgents: String = "ask",
    val manageMemory: Boolean = true,
    val mail: Boolean = true,
    val connectors: Boolean = true,
    val shell: Boolean = true,
    val computer: Boolean = false,
    /** May delegate development to an OpenCode instance the user connected. */
    val code: Boolean = false,
)

@Immutable
@Serializable
data class Agent(
    val id: String,
    val name: String = "",
    val named: Boolean = false,
    val color: String = "#888888",
    val description: String = "",
    val personality: String = "",
    val instructions: String = "",
    val model: ModelConfig? = null,
    val effectiveModel: ModelConfig = ModelConfig(),
    val permissions: Permissions = Permissions(),
    val state: String = "available",
    val stateDetail: String? = null,
    val lastMessageAt: String? = null,
    val lastMessagePreview: String? = null,
    val unread: Int = 0,
    val mainConversationId: String = "",
    val archived: Boolean = false,
) {
    val busy: Boolean get() = state in BUSY_STATES
    companion object { val BUSY_STATES = setOf("awake", "thinking", "working", "collaborating") }
}

@Immutable
@Serializable
data class Approval(
    val id: String,
    val agentId: String = "",
    val conversationId: String = "",
    val action: String = "",
    val summary: String = "",
    val input: JsonElement? = null,
    val status: String = "pending",
    val error: String? = null,
    val createdAt: String = "",
)

@Serializable
data class DecisionResult(val ok: Boolean = false, val status: String = "", val error: String? = null)

@Serializable
data class Schedule(val type: String = "", val at: String? = null, val minutes: Double? = null, val expr: String? = null, val tz: String? = null)

@Serializable
data class Watch(val url: String = "", val mode: String = "changed", val value: String? = null)

@Immutable
@Serializable
data class Activity(
    val id: String,
    val agentId: String = "",
    val title: String = "",
    val kind: String = "schedule",
    val instructions: String = "",
    val schedule: Schedule? = null,
    val watch: Watch? = null,
    val enabled: Boolean = true,
    val nextRunAt: String? = null,
    val lastRunAt: String? = null,
    val lastStatus: String? = null,
    val runCount: Int = 0,
)

@Immutable
@Serializable
data class AskQuestion(
    val id: String,
    val label: String = "",
    val type: String = "text",
    val options: List<String>? = null,
    val required: Boolean = false,
    val placeholder: String? = null,
    val allowOther: Boolean = false,
)

@Immutable
@Serializable
data class UserRequest(
    val id: String,
    val agentId: String = "",
    val title: String = "",
    val questions: List<AskQuestion> = emptyList(),
    val status: String = "pending",
    val answers: JsonObject? = null,
)

@Immutable
@Serializable
data class MailDraft(
    val id: String,
    val from: String = "",
    val to: List<String> = emptyList(),
    val cc: List<String> = emptyList(),
    val subject: String = "",
    val body: String = "",
    val status: String = "pending",
    val approvalId: String? = null,
    val error: String? = null,
)

@Immutable
@Serializable
data class ModelInfo(
    val id: String,
    val name: String = "",
    val provider: String = "openrouter",
    val contextLength: Long? = null,
    val tools: Boolean = false,
    val reasoning: Boolean = false,
    val vision: Boolean = false,
)

@Serializable
data class ServerSettings(
    val openrouterKey: String? = null,
    val defaultModel: ModelConfig = ModelConfig(),
    val timezone: String = "",
    val paused: Boolean = false,
    val ollamaUrl: String? = null,
    /** Null means no limit. */
    val turnStepLimit: Int? = null,
)

@Serializable
data class CodexAccount(val email: String? = null, val planType: String? = null)

@Serializable
data class CodexStatus(val account: CodexAccount? = null, val error: String? = null)

@Serializable
data class CodexLogin(val verificationUrl: String = "", val userCode: String = "")

@Serializable
data class DesktopStatus(
    val enabled: Boolean = false,
    val available: Boolean = false,
    val running: Boolean = false,
    val suspended: Boolean = false,
    val manualControl: Boolean = false,
    val width: Int = 1280,
    val height: Int = 800,
    val vncPassword: String? = null,
)

@Serializable
data class Attachment(val id: String, val url: String, val filename: String = "image.jpg", val mediaType: String = "image/jpeg")

@Immutable
@Serializable
data class Reaction(val emoji: String, val actor: String = "user")

@Serializable
data class ReactionResult(val added: Boolean = false, val reactions: List<Reaction> = emptyList())

@Immutable
@Serializable
data class ReplyRef(val messageId: String, val preview: String = "", val role: String = "assistant")

@Immutable
@Serializable
data class EventMeta(val type: String = "system", val title: String = "", val fromAgentId: String? = null, val approvalId: String? = null)

/** Metadata attached to every message (see `MessageMetadata` in packages/shared). */
@Immutable
@Serializable
data class MessageMeta(
    val kind: String? = null,
    val agentId: String? = null,
    val event: EventMeta? = null,
    val createdAt: String? = null,
    val hidden: Boolean = false,
    val setup: Boolean = false,
    val answer: JsonObject? = null,
    val replyTo: ReplyRef? = null,
    val reactions: List<Reaction> = emptyList(),
    val workedMs: Long? = null,
    /** Model that answered (general chats sign the assistant with it). */
    val model: String? = null,
    /** Message produced by a background task (result, blocker). */
    val taskId: String? = null,
)

/** One part of a message, mirroring the AI SDK's UI message parts that BotCircle stores. */
@Immutable
sealed interface Part {
    data class Text(val text: String) : Part
    data class Reasoning(val text: String) : Part
    data class File(val url: String, val mediaType: String, val filename: String?) : Part

    /** [state] is one of input-streaming, input-available, output-available, output-error. */
    data class Tool(
        val callId: String,
        val name: String,
        val state: String,
        val input: JsonElement? = null,
        val output: JsonElement? = null,
        val errorText: String? = null,
    ) : Part {
        val outputObject: JsonObject? get() = output as? JsonObject
        val failed: Boolean get() = state == "output-error" || outputObject?.bool("ok") == false
    }
}

@Immutable
data class ChatMessage(val id: String, val role: String, val parts: List<Part>, val meta: MessageMeta = MessageMeta()) {
    val isUser: Boolean get() = role == "user"
}

/** What the server tells every connected client (see `ServerEvent` in packages/shared). */
sealed interface ServerEvent {
    data object Hello : ServerEvent
    data class AgentChanged(val agent: Agent) : ServerEvent
    data class AgentState(val agentId: String, val state: String, val detail: String?) : ServerEvent
    data class TurnStarted(val agentId: String, val conversationId: String, val autonomous: Boolean) : ServerEvent
    data class TurnFinished(val agentId: String, val conversationId: String) : ServerEvent
    data class MessageCreated(val conversationId: String, val agentId: String?, val author: String, val hidden: Boolean, val preview: String) : ServerEvent
    data class MessageReaction(val conversationId: String, val messageId: String, val reactions: List<Reaction>) : ServerEvent
    data class ApprovalChanged(val approval: Approval) : ServerEvent
    data class RequestChanged(val request: UserRequest) : ServerEvent
    data class DraftChanged(val draft: MailDraft) : ServerEvent
    data class ActivityChanged(val agentId: String) : ServerEvent
    data object SettingsChanged : ServerEvent
    data class TaskChanged(val task: BgTask) : ServerEvent
    data class ChatChanged(val chatId: String, val deleted: Boolean) : ServerEvent
    data class ArtifactChanged(val artifactId: String) : ServerEvent
    data class SecureLoginChanged(val login: SecureLogin) : ServerEvent
    data class Other(val type: String) : ServerEvent
}

// --- Files (artifacts), background tasks, general chats: see packages/shared -------------------------------------

/** Per-file limit shared with the server (`ARTIFACT_MAX_BYTES`). */
const val ARTIFACT_MAX_BYTES = 50L * 1024 * 1024
const val FILES_MAX_COUNT = 10

private val ARTIFACT_URL = Regex("^/api/artifacts/(art_[a-z0-9]+)/content$")
/** The artifact behind a message's file part, when it is one (`artifactIdFromUrl` in packages/shared). */
fun artifactIdFromUrl(url: String?): String? = url?.let { ARTIFACT_URL.find(it.substringBefore('?').let { u -> if (u.startsWith("http")) "/" + u.substringAfter("://").substringAfter('/') else u })?.groupValues?.get(1) }

@Immutable
@Serializable
data class Artifact(
    val id: String,
    val name: String = "",
    val mediaType: String = "application/octet-stream",
    val size: Long = 0,
    val authorKind: String = "user",
    val authorId: String? = null,
    val source: String = "upload",
    val conversationId: String? = null,
    val taskId: String? = null,
    val createdAt: String = "",
    val url: String = "",
)

@Immutable
@Serializable
data class ArtifactGrant(val agentId: String, val grantedBy: String = "user", val via: String = "", val createdAt: String = "", val revokedAt: String? = null)

@Immutable
@Serializable
data class ArtifactAccess(val actor: String = "user", val action: String = "", val detail: String? = null, val createdAt: String = "")

@Immutable
@Serializable
data class ArtifactDetails(
    val id: String,
    val name: String = "",
    val mediaType: String = "application/octet-stream",
    val size: Long = 0,
    val authorKind: String = "user",
    val authorId: String? = null,
    val createdAt: String = "",
    val url: String = "",
    val grants: List<ArtifactGrant> = emptyList(),
    val access: List<ArtifactAccess> = emptyList(),
)

@Serializable
data class ArtifactHistory(val grants: List<ArtifactGrant> = emptyList(), val access: List<ArtifactAccess> = emptyList())

@Immutable
@Serializable
data class BgTaskEvent(val seq: Long = 0, val kind: String = "status", val summary: String = "", val createdAt: String = "")

/** A background task (`TaskDTO`). Progress is what the server observed, never an estimate. */
@Immutable
@Serializable
data class BgTask(
    val id: String,
    val agentId: String = "",
    val conversationId: String = "",
    val title: String = "",
    val instruction: String = "",
    val status: String = "queued",
    val phase: String? = null,
    val currentActionSummary: String? = null,
    val completedSteps: Int = 0,
    val blocker: String? = null,
    val requiresUserInput: Boolean = false,
    val result: String? = null,
    val error: String? = null,
    val artifacts: List<Artifact> = emptyList(),
    val createdAt: String = "",
    val finishedAt: String? = null,
    val events: List<BgTaskEvent> = emptyList(),
    /** `opencode`: the work happens in a remote OpenCode session, opened in the code workspace. */
    val provider: String = "worker",
    val external: TaskExternal? = null,
) {
    val isCode: Boolean get() = provider == "opencode"
    val active: Boolean get() = status in ACTIVE
    /** The one line worth showing under the title right now. */
    val line: String? get() = when (status) { "completed" -> null; "failed" -> error; else -> blocker ?: currentActionSummary ?: phase }
    companion object { val ACTIVE = setOf("queued", "running", "waiting_for_user", "paused") }
}

/** A general chat (`ChatDTO`): a thread that belongs to no companion. */
@Immutable
@Serializable
data class GeneralChat(
    val id: String,
    val title: String = "",
    val model: ModelConfig? = null,
    val effectiveModel: ModelConfig = ModelConfig(),
    val createdAt: String = "",
    val updatedAt: String = "",
    val lastMessagePreview: String? = null,
)

/** Where a conversation lives on the server: a companion's main thread or a general chat. */
sealed interface ChatTarget {
    val id: String
    val path: String
    data class Companion(override val id: String) : ChatTarget { override val path get() = "/agents/$id" }
    data class General(override val id: String) : ChatTarget { override val path get() = "/chats/$id" }
}

/** `@Name` mentions of [text] resolved on existing companions (`findMentions` in packages/shared). */
fun findMentions(text: String, agents: List<Agent>): List<String> {
    val lower = text.lowercase()
    return agents.filter { it.named && it.name.isNotBlank() }.sortedByDescending { it.name.length }.filter { agent ->
        val name = "@" + agent.name.trim().lowercase()
        var from = 0
        var found = false
        while (!found) {
            val at = lower.indexOf(name, from)
            if (at < 0) break
            val before = if (at == 0) ' ' else lower[at - 1]
            val after = lower.getOrNull(at + name.length)
            if (!before.isLetterOrDigit() && (after == null || !(after.isLetterOrDigit() || after == '_'))) found = true
            from = at + 1
        }
        found
    }.map { it.id }
}

/**
 * A secure sign-in request (`SecureLoginDTO`): the exact origin the server verified, and the outcome. It never carries
 * a username, password or code - the user signs in themselves in the companion's browser.
 */
@Immutable
@Serializable
data class SecureLogin(
    val id: String,
    val agentId: String = "",
    val conversationId: String = "",
    val origin: String = "",
    val url: String = "",
    val reason: String = "",
    val status: String = "pending",
) {
    val pending: Boolean get() = status == "pending"
    val host: String get() = origin.substringAfter("://")
    val encrypted: Boolean get() = origin.startsWith("https://")
}

// --- OpenCode: see packages/shared -----------------------------------------------------------------------------

@Immutable
@Serializable
data class TaskExternal(val instanceId: String = "", val instanceName: String = "OpenCode", val sessionId: String = "", val directory: String? = null, val unreachable: Boolean = false) {
    /** Last path segment: enough to recognise the project on a card. */
    val project: String? get() = directory?.trimEnd('/')?.substringAfterLast('/')?.ifBlank { null }
}

@Immutable
@Serializable
data class OpencodeInstance(
    val id: String,
    val name: String = "",
    val baseUrl: String = "",
    val username: String = "opencode",
    val hasPassword: Boolean = false,
    val defaultDirectory: String? = null,
    val version: String? = null,
    /** online, offline or unknown (never checked). */
    val state: String = "unknown",
    val lastError: String? = null,
    val activeTasks: Int = 0,
    val apiVersion: String? = null,
    /** `pairing`: connected with the one-time link of `opencode pair`; the token expires at [tokenExpiresAt]. */
    val authKind: String = "password",
    val tokenExpiresAt: String? = null,
)

/** One part of an OpenCode message; which fields are set depends on [type] (text, reasoning, tool, patch, file). */
@Immutable
@Serializable
data class CodePart(
    val type: String = "text",
    val text: String = "",
    val tool: String = "",
    val status: String = "",
    val title: String? = null,
    val input: String = "",
    val output: String? = null,
    val files: List<String> = emptyList(),
    val filename: String? = null,
)

@Immutable
@Serializable
data class CodeMessage(val id: String, val role: String = "assistant", val completedAt: Long? = null, val model: String? = null, val error: String? = null, val parts: List<CodePart> = emptyList())

@Immutable
@Serializable
data class CodeDiff(val path: String = "", val status: String = "modified", val additions: Int = 0, val deletions: Int = 0, val patch: String = "")

@Immutable
@Serializable
data class CodePermission(val id: String, val permission: String = "", val patterns: List<String> = emptyList())

@Serializable
data class CodeQuestionItem(val question: String = "", val options: List<String> = emptyList(), val multiple: Boolean = false)

@Immutable
@Serializable
data class CodeQuestion(val id: String, val questions: List<CodeQuestionItem> = emptyList())

@Immutable
@Serializable
data class CodeExchange(val seq: Long = 0, val author: String = "companion", val agentId: String? = null, val kind: String = "", val text: String = "", val original: String? = null, val createdAt: String = "")

@Immutable
@Serializable
data class CodeFileNode(val name: String = "", val path: String = "", val type: String = "file")

@Serializable
data class CodeFile(val path: String = "", val binary: Boolean = false, val content: String = "")

/** The code workspace of one task: that exact session, its real state, and what waits for the user. */
@Immutable
@Serializable
data class CodeWorkspace(
    val task: BgTask,
    /** The model OpenCode will use for the next instruction; null when unknown. */
    val model: OpencodeCurrentModel? = null,
    /** busy, idle, retry, or unknown when the instance does not answer. */
    val sessionStatus: String = "unknown",
    /** False: the instance does not answer; lists are empty and the task shows its last known state. */
    val reachable: Boolean = true,
    val error: String? = null,
    val messages: List<CodeMessage> = emptyList(),
    val permissions: List<CodePermission> = emptyList(),
    val questions: List<CodeQuestion> = emptyList(),
    val diffs: List<CodeDiff> = emptyList(),
    val exchanges: List<CodeExchange> = emptyList(),
)

/** A model of an OpenCode instance; [variants] are its efforts (low, medium, high…). [input]: text, image, pdf… */
@Immutable
@Serializable
data class OpencodeModel(val providerID: String, val providerName: String = "", val id: String, val name: String = "", val variants: List<String> = emptyList(), val input: List<String> = emptyList())

@Immutable
@Serializable
data class OpencodeCurrentModel(val providerID: String, val id: String, val variant: String? = null, val name: String? = null, val input: List<String>? = null)

@Serializable
data class OpencodeModels(val current: OpencodeCurrentModel? = null, val models: List<OpencodeModel> = emptyList())

@Serializable
data class PromptResult(val queued: Boolean = false, val delivery: String? = null)

// --- Memory, journal, team exchanges ----------------------------------------------------------------------------

@Immutable
@Serializable
data class Memory(val id: String, val agentId: String? = null, val content: String = "", val createdAt: String = "")

@Immutable
@Serializable
data class JournalEntry(val id: String, val summary: String = "", val createdAt: String = "")

@Immutable
@Serializable
data class TeamThread(val conversationId: String, val agentIds: List<String> = emptyList(), val lastMessageAt: String? = null, val lastMessagePreview: String? = null, val messageCount: Int = 0)
