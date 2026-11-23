package app.dot.opendots

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import app.dot.opendots.chat.ChatSession
import app.dot.opendots.chat.TemporaryChatSession
import app.dot.opendots.data.Account
import app.dot.opendots.data.Activity
import app.dot.opendots.data.Agent
import app.dot.opendots.data.AvatarPreset
import app.dot.opendots.data.ApiException
import app.dot.opendots.data.Approval
import app.dot.opendots.data.BgTask
import app.dot.opendots.data.ChatTarget
import app.dot.opendots.data.GeneralChat
import app.dot.opendots.data.MailDraft
import app.dot.opendots.data.SecureLogin
import app.dot.opendots.data.ModelInfo
import app.dot.opendots.data.OpenDotsClient
import app.dot.opendots.data.ServerEvent
import app.dot.opendots.data.SessionStore
import app.dot.opendots.data.UserRequest
import app.dot.opendots.data.normalizeServerUrl
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import app.dot.opendots.data.ModelConfig
import app.dot.opendots.data.OdJson
import app.dot.opendots.data.arr
import app.dot.opendots.data.str
import app.dot.opendots.data.ArchivedThread
import java.util.TimeZone
import kotlin.coroutines.cancellation.CancellationException

/** Where the app is in its journey from "no server" to "talking to a companion". */
sealed interface Stage {
    data object Starting : Stage
    /** No server chosen yet, or the chosen one must be changed. */
    data object Server : Stage
    /** The chosen server did not answer. */
    data class Unreachable(val message: String) : Stage
    data class SignIn(val registrationOpen: Boolean) : Stage
    data class Onboarding(val keyConfigured: Boolean) : Stage
    data object Main : Stage
}

data class AppUiState(
    val stage: Stage = Stage.Starting,
    val serverUrl: String = "",
    val account: Account? = null,
    /** #54: the user's name as their Circles use it (null until loaded). */
    val profile: app.dot.opendots.data.UserProfile? = null,
    val agents: List<Agent> = emptyList(),
    val currentAgentId: String? = null,
    val approvals: Map<String, Approval> = emptyMap(),
    val requests: Map<String, UserRequest> = emptyMap(),
    val drafts: Map<String, MailDraft> = emptyMap(),
    val activities: List<Activity>? = null,
    /** Background tasks known to the app, kept current by server events. */
    val tasks: Map<String, BgTask> = emptyMap(),
    /** General chats, most recent first. */
    val chats: List<GeneralChat> = emptyList(),
    /** Secure sign-in requests seen by the app, by id. */
    val secureLogins: Map<String, SecureLogin> = emptyMap(),
    val currentChatId: String? = null,
    /**
     * New chat created on first message: "New chat" opens this local draft ([AppState.DRAFT_CHAT_ID]); it is in no list
     * and nothing exists on the server until its first message creates the chat (with the draft's model and web search).
     */
    val draftChat: GeneralChat? = null,
    /** Each draft's screen state slot; the chat a draft became ([draftBornId]) keeps it, so its screen is not rebuilt. */
    val draftSlot: Int = 0,
    val draftBornId: String? = null,
    /** #57: the new chat on screen is ephemeral (see [AppState.temporaryChat]): in no list, never saved. */
    val ephemeral: Boolean = false,
    /** #58: a conversation to open at a message (from search): its agent or chat id, and the message. */
    val focus: Pair<String, String>? = null,
    /** #56: archived chats (hidden from the list, restorable). */
    val archivedChats: List<GeneralChat> = emptyList(),
    val connected: Boolean = true,
    val tasksReady: Boolean = false,
    val paused: Boolean = false,
    val busy: Boolean = false,
    val formError: String? = null,
    val themeMode: String = "SYSTEM",
    val reduceTransparency: Boolean = false,
) {
    val currentAgent: Agent? get() = agents.firstOrNull { it.id == currentAgentId } ?: agents.firstOrNull()
    val currentChat: GeneralChat? get() = draftChat?.takeIf { it.id == currentChatId } ?: chats.firstOrNull { it.id == currentChatId } ?: archivedChats.firstOrNull { it.id == currentChatId }
    val activeTasks: List<BgTask> get() = tasks.values.filter { it.active }.sortedByDescending { it.createdAt }
    val pendingApprovals: List<Approval> get() = approvals.values.filter { it.status == "pending" }.sortedByDescending { it.createdAt }
}

/**
 * The single source of truth of the app: session, companions, and everything the server pushes. Screens render
 * [state] and call methods; nothing else talks to [client].
 */
class AppState(private val store: SessionStore, val client: OpenDotsClient) : ViewModel() {

    private val _state = MutableStateFlow(AppUiState(serverUrl = store.serverUrl.orEmpty(), themeMode = store.themeMode, reduceTransparency = store.reduceTransparency, currentAgentId = store.lastAgentId))
    val state: StateFlow<AppUiState> = _state.asStateFlow()

    /** One-line messages for the snackbar (failures of actions the user just took). */
    private val _notices = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val notices: SharedFlow<String> = _notices.asSharedFlow()

    private val sessions = HashMap<String, ChatSession>()
    /** Separate RAM-only state (#57: the ephemeral mode of a new chat). Never inserted into chats, archives or SessionStore. */
    val temporaryChat = TemporaryChatSession(client, viewModelScope, onUnauthorized = ::unauthorized)
    private var eventsJob: Job? = null
    private var taskSnapshot = 0L
    private var foreground = true

    init { start() }

    // --- Journey ------------------------------------------------------------------------

    fun start() {
        if (store.serverUrl == null) { setStage(Stage.Server); return }
        setStage(Stage.Starting)
        viewModelScope.launch {
            try {
                val me = client.me()
                if (me.account == null) { client.forgetSession(); setStage(Stage.SignIn(me.registrationOpen)) } else enter(me.account)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                setStage(Stage.Unreachable(e.message.orEmpty()))
            }
        }
    }

    private suspend fun enter(account: Account) {
        _state.update { it.copy(account = account) }
        val boot = client.bootstrap()
        defaultModel = boot.defaultModel
        if (!boot.onboarded) { setStage(Stage.Onboarding(boot.openrouterConfigured)); return }
        val agents = client.agents().filterNot { it.archived }
        _state.update { s ->
            s.copy(
                stage = Stage.Main, agents = agents, paused = boot.paused, formError = null, busy = false,
                currentAgentId = s.currentAgentId?.takeIf { id -> agents.any { it.id == id } } ?: agents.firstOrNull()?.id,
            )
        }
        runCatching { client.approvals() }.onSuccess { list -> _state.update { s -> s.copy(approvals = list.associateBy { it.id }) } }
        loadWork()
        listen()
    }

    fun chooseServer(input: String) = form {
        val url = normalizeServerUrl(input) ?: throw IllegalArgumentException(INVALID_URL)
        val me = client.connect(url)
        _state.update { it.copy(serverUrl = url.toString()) }
        if (me.account == null) setStage(Stage.SignIn(me.registrationOpen)) else enter(me.account)
    }

    fun changeServer() {
        dropEphemeral()
        stopListening()
        setStage(Stage.Server)
    }

    fun signIn(email: String, password: String, register: Boolean) = form { enter(client.signIn(email, password, register)) }

    fun signOut() {
        dropEphemeral()
        stopListening()
        sessions.clear()
        viewModelScope.launch {
            client.signOut()
            _state.update { it.copy(account = null, agents = emptyList(), approvals = emptyMap(), requests = emptyMap(), drafts = emptyMap(), activities = null) }
            start()
        }
    }

    fun saveKey(key: String) = form {
        client.saveOpenRouterKey(key)
        setStage(Stage.Onboarding(keyConfigured = true))
    }

    suspend fun models(): List<ModelInfo> = client.openRouterModels()

    fun finishOnboarding(model: String) = form {
        client.completeOnboarding(model, TimeZone.getDefault().id)
        enter(_state.value.account ?: client.me().account ?: throw ApiException("Session expired", 401))
    }

    private fun form(block: suspend () -> Unit) {
        if (_state.value.busy) return
        _state.update { it.copy(busy = true, formError = null) }
        viewModelScope.launch {
            try { block() } catch (e: Exception) {
                if (e is CancellationException) throw e
                _state.update { it.copy(formError = e.message ?: e.javaClass.simpleName) }
            } finally { _state.update { it.copy(busy = false) } }
        }
    }

    private fun setStage(stage: Stage) = _state.update { it.copy(stage = stage, formError = null) }

    private fun unauthorized() {
        if (_state.value.stage !is Stage.Main) return
        dropEphemeral()
        stopListening()
        sessions.clear()
        client.forgetSession()
        start()
    }

    // --- Realtime -----------------------------------------------------------------------

    /** The event stream only runs while the app is visible: companions keep working on the server either way. */
    fun setForeground(visible: Boolean, configurationChange: Boolean = false) {
        if (!configurationChange) temporaryChat.foreground(visible)
        foreground = visible
        if (_state.value.stage !is Stage.Main) return
        taskSnapshot++
        _state.update { it.copy(tasksReady = false) }
        if (visible) { listen(); refresh() } else stopListening()
    }

    private fun stopListening() { eventsJob?.cancel(); eventsJob = null }

    override fun onCleared() {
        temporaryChat.dispose()
        super.onCleared()
    }

    private fun listen() {
        if (eventsJob?.isActive == true || !foreground) return
        eventsJob = viewModelScope.launch {
            var backoff = 1_000L
            while (true) {
                try {
                    client.events().collect { event ->
                        if (event is ServerEvent.Hello) {
                            if (!_state.value.connected) refresh()
                            _state.update { it.copy(connected = true) }
                            backoff = 1_000L
                        }
                        onEvent(event)
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    if (e is ApiException && e.status == 401) { unauthorized(); return@launch }
                }
                taskSnapshot++
                _state.update { it.copy(connected = false, tasksReady = false) }
                delay(backoff)
                backoff = (backoff * 2).coerceAtMost(15_000L)
            }
        }
    }

    private fun onEvent(event: ServerEvent) {
        when (event) {
            is ServerEvent.AgentChanged -> _state.update { s ->
                val rest = s.agents.filterNot { it.id == event.agent.id }
                val agents = if (event.agent.archived) rest else if (rest.size == s.agents.size) s.agents + event.agent else s.agents.map { if (it.id == event.agent.id) event.agent else it }
                s.copy(agents = agents, currentAgentId = s.currentAgentId?.takeIf { id -> agents.any { it.id == id } } ?: agents.firstOrNull()?.id)
            }
            is ServerEvent.AgentState -> _state.update { s -> s.copy(agents = s.agents.map { if (it.id == event.agentId) it.copy(state = event.state, stateDetail = event.detail) else it }) }
            is ServerEvent.MessageCreated -> if (!event.hidden && event.agentId != null) _state.update { s ->
                s.copy(agents = s.agents.map { a ->
                    if (a.id != event.agentId) a else a.copy(
                        lastMessagePreview = event.preview.ifBlank { a.lastMessagePreview },
                        unread = if (event.author != "user" && a.id != s.currentAgentId) a.unread + 1 else a.unread,
                    )
                })
            }
            is ServerEvent.ApprovalChanged -> _state.update { it.copy(approvals = it.approvals + (event.approval.id to event.approval)) }
            is ServerEvent.RequestChanged -> _state.update { it.copy(requests = it.requests + (event.request.id to event.request)) }
            is ServerEvent.DraftChanged -> _state.update { it.copy(drafts = it.drafts + (event.draft.id to event.draft)) }
            is ServerEvent.ActivityChanged -> if (_state.value.activities != null) loadActivities()
            is ServerEvent.TaskChanged -> _state.update { it.copy(tasks = it.tasks + (event.task.id to event.task.copy(events = it.tasks[event.task.id]?.events.orEmpty()))) }
            is ServerEvent.SecureLoginChanged -> _state.update { it.copy(secureLogins = it.secureLogins + (event.login.id to event.login)) }
            is ServerEvent.ConversationReset -> _state.update { s -> s.copy(agents = s.agents.map { if (it.id == event.agentId) it.copy(mainConversationId = event.conversationId) else it }) }
            is ServerEvent.ChatChanged -> {
                if (event.deleted) _state.update { s -> s.copy(chats = s.chats.filterNot { it.id == event.chatId }, archivedChats = s.archivedChats.filterNot { it.id == event.chatId }, currentChatId = s.currentChatId.takeIf { it != event.chatId }) }
                refreshChats()
            }
            ServerEvent.SettingsChanged -> viewModelScope.launch { runCatching { client.bootstrap() }.onSuccess { boot -> _state.update { it.copy(paused = boot.paused) } } }
            else -> Unit
        }
        sessions.values.forEach { it.onEvent(event) }
    }

    /** Catches up after the event stream was down (background, network loss). */
    fun refresh() {
        viewModelScope.launch {
            try {
                val agents = client.agents().filterNot { it.archived }
                val approvals = client.approvals()
                _state.update { it.copy(agents = agents, approvals = approvals.associateBy { a -> a.id }) }
                _state.value.currentAgentId?.let { sessions[it]?.resync() }
                _state.value.currentChatId?.let { sessions[it]?.resync() }
                loadWork()
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                if (e is ApiException && e.status == 401) unauthorized()
            }
        }
    }

    // --- Companions -----------------------------------------------------------------------

    fun session(agentId: String): ChatSession = session(ChatTarget.Companion(agentId))

    fun session(target: ChatTarget): ChatSession =
        sessions.getOrPut(target.id) {
            // The draft's session creates its chat on its first message, then goes on under the chat's id.
            if (target.id == DRAFT_CHAT_ID) ChatSession(target, client, viewModelScope, ::unauthorized, create = { createDraftChat() })
            else ChatSession(target, client, viewModelScope, ::unauthorized)
        }

    // --- Background tasks ---------------------------------------------------------------------

    /** Tasks and chats are read from the server: the app shows persisted state, also after a restart. */
    private fun loadWork() {
        viewModelScope.launch {
            val request = ++taskSnapshot
            val before = _state.value.tasks
            runCatching { client.tasks() }.onSuccess { list ->
                if (request == taskSnapshot) _state.update { s ->
                    val receivedDuringFetch = s.tasks.filter { (id, task) -> before[id] !== task }
                    val snapshot = list.associate { it.id to it.copy(events = s.tasks[it.id]?.events.orEmpty()) }
                    s.copy(tasks = snapshot + receivedDuringFetch, tasksReady = true)
                }
            }
            runCatching { client.chats() }.onSuccess { list -> _state.update { it.copy(chats = list) } }
            runCatching { client.archivedChats() }.onSuccess { list -> _state.update { it.copy(archivedChats = list) } }
            runCatching { client.secureLogins(pending = true) }.onSuccess { list -> _state.update { s -> s.copy(secureLogins = s.secureLogins.filterValues { !it.pending } + list.associateBy { it.id }) } }
        }
    }

    /** A card may reference a task this app has not seen yet; the details sheet also needs its journal. */
    fun loadTask(id: String) {
        viewModelScope.launch { runCatching { client.task(id) }.onSuccess { task -> _state.update { it.copy(tasks = it.tasks + (task.id to task)) } } }
    }

    fun startCodeSession(instanceId: String, directory: String?, instruction: String, onStarted: (String) -> Unit) = act {
        val task = client.startCodeSession(instanceId, directory, instruction)
        _state.update { it.copy(tasks = it.tasks + (task.id to task)) }
        onStarted(task.id)
    }

    /**
     * Code ＋: opens a new OpenCode session at once (no form). The machine online first; the project of the last session
     * on it, else its default folder. [onNoMachine] when nothing is connected yet.
     */
    fun newCodeSession(onNoMachine: () -> Unit, onReady: (String) -> Unit) = act {
        val instances = client.opencodeInstances()
        val instance = instances.firstOrNull { it.state == "online" } ?: instances.firstOrNull()
        if (instance == null) { onNoMachine(); return@act }
        val recent = _state.value.tasks.values.filter { it.provider == "opencode" && it.external?.instanceId == instance.id && !it.external.directory.isNullOrBlank() }
            .maxByOrNull { it.createdAt }?.external?.directory
        val task = client.startCodeSession(instance.id, recent, "")
        _state.update { it.copy(tasks = it.tasks + (task.id to task)) }
        onReady(task.id)
    }

    fun attachCodeSession(instanceId: String, sessionId: String, directory: String?, onReady: (String) -> Unit) = act {
        val task = client.attachCodeSession(instanceId, sessionId, directory)
        _state.update { it.copy(tasks = it.tasks + (task.id to task)) }
        onReady(task.id)
    }

    fun setCodeAutoResume(taskId: String, enabled: Boolean) = act { client.codeAutoResume(taskId, enabled); loadTask(taskId) }

    fun taskAction(id: String, action: String) = act { val task = client.taskAction(id, action); _state.update { it.copy(tasks = it.tasks + (task.id to task.copy(events = it.tasks[task.id]?.events.orEmpty()))) }; loadTask(id) }

    fun taskInstruction(id: String, instruction: String, onSent: () -> Unit) = act { client.taskInstruction(id, instruction); onSent(); loadTask(id) }

    // --- Secure sign-in ---------------------------------------------------------------------------

    fun ensureSecureLogin(id: String) {
        if (id in _state.value.secureLogins) return
        viewModelScope.launch { runCatching { client.secureLogin(id) }.onSuccess { login -> _state.update { it.copy(secureLogins = it.secureLogins + (login.id to login)) } } }
    }

    /** Ends a sign-in: the companion gets its tools back and is told the outcome, nothing else. */
    fun resolveSecureLogin(id: String, outcome: String, onDone: () -> Unit = {}) = act {
        val login = client.resolveSecureLogin(id, outcome)
        _state.update { it.copy(secureLogins = it.secureLogins + (login.id to login)) }
        onDone()
    }

    // --- General chats --------------------------------------------------------------------------

    fun selectChat(chatId: String) = _state.update { it.copy(currentChatId = chatId) }

    // --- New chat created on first message: the draft --------------------------------------------

    /** The account's default model (bootstrap), shown by a draft that has no model of its own. */
    private var defaultModel: ModelConfig? = null
    /** The creation of the current draft's chat, shared by every caller (session send, file upload): one chat only. */
    private var draftCreation: Deferred<GeneralChat>? = null

    private fun freshDraft(seed: GeneralChat?): GeneralChat {
        val model = seed?.model
        return GeneralChat(id = DRAFT_CHAT_ID, model = model, effectiveModel = model ?: defaultModel ?: ModelConfig(), webSearch = seed?.webSearch ?: true)
    }

    private fun resetDraft() {
        draftCreation = null
        sessions.remove(DRAFT_CHAT_ID)
    }

    /**
     * "New chat" (and `/new`, `/clear` with [seed]'s model and web search): a local draft on screen. Nothing is created
     * on the server and nothing is listed until its first message ([createDraftChat]).
     */
    fun newChat(seed: GeneralChat? = null) {
        resetDraft()
        _state.update { it.copy(draftChat = freshDraft(seed), currentChatId = DRAFT_CHAT_ID, draftSlot = it.draftSlot + 1) }
        if (defaultModel == null) viewModelScope.launch {
            val model = runCatching { client.bootstrap().defaultModel }.getOrNull() ?: return@launch
            defaultModel = model
            _state.update { s -> s.draftChat?.takeIf { it.model == null }?.let { s.copy(draftChat = it.copy(effectiveModel = model)) } ?: s }
        }
    }

    /** Leaving an untouched draft (back, another chat or tab): nothing to clean up anywhere, it just goes. */
    fun discardDraft() {
        if (_state.value.draftChat == null) return
        resetDraft()
        _state.update { s -> s.copy(draftChat = null, currentChatId = s.currentChatId.takeIf { it != DRAFT_CHAT_ID }) }
    }

    /**
     * The draft's first message: the chat is created now, with the draft's model and web search. It joins the list, the
     * screen goes on under its id (same session: the first answer streams on), and the draft is gone. Idempotent.
     */
    suspend fun createDraftChat(): GeneralChat {
        val running = draftCreation?.takeUnless { it.isCompleted && it.getCompletionExceptionOrNull() != null }
        val job = running ?: viewModelScope.async {
            val draft = _state.value.draftChat ?: throw IllegalStateException("No draft chat")
            var chat = client.createChat(draft.model)
            if (!draft.webSearch) chat = client.updateChat(chat.id, buildJsonObject { put("webSearch", false) })
            sessions.remove(DRAFT_CHAT_ID)?.let { session -> session.adopt(ChatTarget.General(chat.id)); sessions[chat.id] = session }
            _state.update { s -> s.copy(chats = listOf(chat) + s.chats.filterNot { it.id == chat.id }, draftChat = null, draftBornId = chat.id, currentChatId = if (s.currentChatId == DRAFT_CHAT_ID) chat.id else s.currentChatId) }
            chat
        }.also { draftCreation = it }
        return try { job.await() } catch (e: Exception) {
            if (e is CancellationException) throw e
            if (e is ApiException && e.status == 401) unauthorized()
            throw e
        }
    }

    // --- #57: ephemeral chat ------------------------------------------------------------------------

    /** Drops the ephemeral chat silently (sign-out, server change, expired session). */
    private fun dropEphemeral() {
        temporaryChat.discard()
        _state.update { if (it.ephemeral) it.copy(ephemeral = false) else it }
    }

    /**
     * The icon on a new chat (a draft, nothing on the server): it becomes ephemeral. There is nothing to delete; the
     * temporary conversation takes the draft's place on screen, with its model, and is never saved.
     */
    fun startEphemeral(chat: GeneralChat) {
        if (_state.value.ephemeral || chat.id != DRAFT_CHAT_ID) return
        resetDraft()
        _state.update { s -> s.copy(ephemeral = true, draftChat = null, currentChatId = s.currentChatId.takeIf { it != DRAFT_CHAT_ID }) }
        // Codex and a blank model stay unselected: the screen then asks for an OpenRouter or Ollama model.
        temporaryChat.model(chat.effectiveModel)
        temporaryChat.start()
    }

    /** The icon again, before any message: back to a normal new chat, a fresh draft (still nothing on the server). */
    fun stopEphemeral() {
        if (!_state.value.ephemeral) return
        temporaryChat.discard()
        resetDraft()
        _state.update { it.copy(ephemeral = false, draftChat = freshDraft(null), currentChatId = DRAFT_CHAT_ID, draftSlot = it.draftSlot + 1) }
    }

    /** Leaving the ephemeral chat (back, another chat or tab, settings...): gone, with a short word if it had content. */
    fun exitEphemeral() {
        if (!_state.value.ephemeral) return
        val had = temporaryChat.hasContent
        dropEphemeral()
        if (had) _notices.tryEmit(EPHEMERAL_ERASED)
    }

    /** #47: the Circle whose avatar stands for Circles in the dock. */
    fun setPrimaryAgent(agentId: String) = act { client.setPrimaryAgent(agentId) }
    suspend fun avatarPresets(): List<AvatarPreset> = runCatching { client.avatarPresets() }.getOrDefault(emptyList())
    fun setAvatar(agentId: String, preset: String?) = act { client.setAvatar(agentId, preset) }
    fun restoreAvatar(agentId: String) = act { client.restoreAvatar(agentId) }

    /** `/clear` in a general chat: a fresh draft with the same model and web search; the old one stays in the list. */
    fun restartChat(from: GeneralChat) = newChat(seed = from)

    fun updateChat(chatId: String, patch: JsonObject, onDone: () -> Unit = {}) = act {
        // A draft keeps its settings here until its first message creates the chat with them.
        if (chatId == DRAFT_CHAT_ID) {
            _state.update { s ->
                val draft = s.draftChat ?: return@update s
                var next = draft
                patch["model"]?.let { value ->
                    val model = if (value is JsonNull) null else OdJson.decodeFromJsonElement(ModelConfig.serializer(), value)
                    next = next.copy(model = model, effectiveModel = model ?: defaultModel ?: ModelConfig())
                }
                (patch["webSearch"] as? JsonPrimitive)?.booleanOrNull?.let { next = next.copy(webSearch = it) }
                s.copy(draftChat = next)
            }
            onDone()
            return@act
        }
        val chat = client.updateChat(chatId, patch)
        _state.update { s -> s.copy(chats = s.chats.map { if (it.id == chat.id) chat else it }) }
        onDone()
    }

    /** #64: where a tapped notification leads (consumed by the navigation). */
    data class OpenTarget(val kind: String, val id: String, val agentId: String?, val messageId: String?)
    private val _openTarget = kotlinx.coroutines.flow.MutableStateFlow<OpenTarget?>(null)
    val openTarget: kotlinx.coroutines.flow.StateFlow<OpenTarget?> = _openTarget
    fun openFromNotification(target: OpenTarget) { _openTarget.value = target }
    fun consumeOpenTarget() { _openTarget.value = null }

    fun focusOn(targetId: String, messageId: String) = _state.update { it.copy(focus = targetId to messageId) }
    fun clearFocus() = _state.update { it.copy(focus = null) }

    private fun refreshChats() = viewModelScope.launch {
        runCatching { client.chats() }.onSuccess { list -> _state.update { it.copy(chats = list) } }
        runCatching { client.archivedChats() }.onSuccess { list -> _state.update { it.copy(archivedChats = list) } }
    }

    // --- #56: archive / restore / delete --------------------------------------------------------

    fun archiveChat(chatId: String, onDone: () -> Unit = {}) = act { client.archiveChat(chatId); refreshChats().join(); onDone() }
    fun restoreChat(chatId: String, onDone: () -> Unit = {}) = act { client.restoreChat(chatId); refreshChats().join(); onDone() }
    fun archiveThread(agentId: String, conversationId: String, onDone: () -> Unit = {}) = act { client.archiveThread(agentId, conversationId); onDone() }
    fun restoreThread(agentId: String, conversationId: String, onDone: () -> Unit = {}) = act { client.restoreThread(agentId, conversationId); onDone() }

    /**
     * Deletes a chat or a Circle thread. The server refuses while a reply runs ("busy") or tasks started from it are
     * still active ("active_tasks"): the answer comes back as [DeleteOutcome] so the screen can ask the user first.
     */
    suspend fun deleteConversation(target: ConversationRef, stopActive: Boolean, confirmTasks: Boolean): DeleteOutcome = try {
        when (target) {
            is ConversationRef.Chat -> { client.deleteChat(target.id, stopActive, confirmTasks); sessions.remove(target.id); _state.update { s -> s.copy(chats = s.chats.filterNot { it.id == target.id }, archivedChats = s.archivedChats.filterNot { it.id == target.id }, currentChatId = s.currentChatId.takeIf { it != target.id }) } }
            is ConversationRef.Thread -> client.deleteThread(target.agentId, target.id, stopActive, confirmTasks)
        }
        DeleteOutcome.Done
    } catch (e: ApiException) {
        when (e.body?.str("status")) {
            "busy" -> DeleteOutcome.Busy
            "active_tasks" -> DeleteOutcome.ActiveTasks(e.body.arr("tasks").orEmpty().mapNotNull { (it as? JsonObject)?.str("title") })
            else -> DeleteOutcome.Failed(e.message ?: FAILED)
        }
    } catch (e: Exception) {
        if (e is CancellationException) throw e
        DeleteOutcome.Failed(e.message ?: FAILED)
    }
    suspend fun archivedThreads(agentId: String): List<ArchivedThread> = runCatching { client.archivedThreads(agentId) }.getOrDefault(emptyList())

    fun selectAgent(agentId: String) {
        store.lastAgentId = agentId
        _state.update { s -> s.copy(currentAgentId = agentId, agents = s.agents.map { if (it.id == agentId) it.copy(unread = 0) else it }) }
    }

    fun updateAgent(agentId: String, patch: JsonObject) = act {
        val updated = client.updateAgent(agentId, patch)
        _state.update { s -> s.copy(agents = s.agents.map { if (it.id == updated.id) updated else it }) }
    }

    // --- Approvals, forms, drafts -----------------------------------------------------------

    fun decide(approvalId: String, approve: Boolean, onDone: (ok: Boolean) -> Unit = {}) {
        viewModelScope.launch {
            try {
                val result = client.decide(approvalId, approve)
                if (result.status == "failed") _notices.tryEmit(result.error ?: FAILED)
                onDone(result.status != "failed")
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                _notices.tryEmit(e.message ?: FAILED)
                onDone(false)
            }
        }
    }

    fun ensureRequest(id: String) {
        if (id in _state.value.requests) return
        viewModelScope.launch { runCatching { client.userRequest(id) }.onSuccess { r -> _state.update { it.copy(requests = it.requests + (r.id to r)) } } }
    }

    fun ensureDraft(id: String) {
        if (id in _state.value.drafts) return
        viewModelScope.launch { runCatching { client.draft(id) }.onSuccess { d -> _state.update { it.copy(drafts = it.drafts + (d.id to d)) } } }
    }

    // --- Scheduled tasks ----------------------------------------------------------------------

    fun loadProfile() { viewModelScope.launch { runCatching { client.profile() }.onSuccess { p -> _state.update { it.copy(profile = p) } } } }

    fun saveProfile(firstName: String, lastName: String, onDone: () -> Unit = {}) = act {
        val p = client.setProfile(firstName.trim().ifBlank { null }, lastName.trim().ifBlank { null })
        _state.update { it.copy(profile = p) }
        onDone()
    }

    fun loadActivities() {
        viewModelScope.launch { runCatching { client.activities() }.onSuccess { list -> _state.update { it.copy(activities = list) } }.onFailure { _notices.tryEmit(it.message ?: FAILED) } }
    }

    fun setActivityEnabled(id: String, enabled: Boolean) {
        _state.update { s -> s.copy(activities = s.activities?.map { if (it.id == id) it.copy(enabled = enabled) else it }) }
        act(onFailure = ::loadActivities) {
            val updated = client.setActivityEnabled(id, enabled)
            _state.update { s -> s.copy(activities = s.activities?.map { if (it.id == id) updated else it }) }
        }
    }

    fun runActivity(id: String, onStarted: () -> Unit) = act { client.runActivity(id); onStarted() }

    fun deleteActivity(id: String) = act {
        client.deleteActivity(id)
        _state.update { s -> s.copy(activities = s.activities?.filterNot { it.id == id }) }
    }

    // --- Settings -------------------------------------------------------------------------------

    fun setThemeMode(mode: String) { store.themeMode = mode; _state.update { it.copy(themeMode = mode) } }

    fun setReduceTransparency(on: Boolean) { store.reduceTransparency = on; _state.update { it.copy(reduceTransparency = on) } }

    fun setPaused(paused: Boolean) {
        _state.update { it.copy(paused = paused) }
        act(onFailure = { _state.update { it.copy(paused = !paused) } }) { client.setPaused(paused) }
    }

    fun notify(message: String) { _notices.tryEmit(message) }

    /** Hands a companion's desktop back to it. Survives the screen that took control being closed. */
    fun releaseDesktopControl(agentId: String) { viewModelScope.launch { runCatching { client.setDesktopControl(agentId, false) } } }

    /** Runs a user action; a failure is said once, in the snackbar. */
    fun run(block: suspend () -> Unit) = act(block = block)

    private fun act(onFailure: () -> Unit = {}, block: suspend () -> Unit) {
        viewModelScope.launch {
            try { block() } catch (e: Exception) {
                if (e is CancellationException) throw e
                if (e is ApiException && e.status == 401) unauthorized() else { _notices.tryEmit(e.message ?: FAILED); onFailure() }
            }
        }
    }

    class Factory(private val store: SessionStore, private val client: OpenDotsClient) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T = AppState(store, client) as T
    }

    companion object {
        /** Sentinels the UI maps to localized text. */
        const val INVALID_URL = "invalid-url"
        const val FAILED = "failed"
        const val EPHEMERAL_ERASED = "ephemeral-erased"
        /** The id the draft new chat goes by until its first message creates it (never a server id). */
        const val DRAFT_CHAT_ID = "draft"
    }
}

/** #56: what can be archived, restored or deleted. */
sealed interface ConversationRef {
    data class Chat(val id: String, val title: String) : ConversationRef
    data class Thread(val agentId: String, val id: String, val agentName: String, val current: Boolean) : ConversationRef
}

sealed interface DeleteOutcome {
    data object Done : DeleteOutcome
    /** A reply is being written in it: stop it first, or confirm stopping. */
    data object Busy : DeleteOutcome
    /** Tasks started from it still run: they continue if the user confirms. */
    data class ActiveTasks(val titles: List<String>) : DeleteOutcome
    data class Failed(val message: String) : DeleteOutcome
}
