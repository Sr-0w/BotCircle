package app.dot.opendots.chat

import app.dot.opendots.data.ApiException
import app.dot.opendots.data.ModelConfig
import app.dot.opendots.data.TemporaryChatApi
import app.dot.opendots.data.TemporaryEvent
import app.dot.opendots.data.TemporarySnapshot
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.cancellation.CancellationException

enum class TemporaryProblem { Connection, Interrupted, Expired, Unavailable }

data class TemporaryChatState(
    val snapshot: TemporarySnapshot? = null,
    val draft: String = "",
    val model: ModelConfig? = null,
    val partial: String = "",
    val sending: Boolean = false,
    val problem: TemporaryProblem? = null,
) {
    val busy get() = sending || snapshot?.busy == true
}

/**
 * Owned by AppState's ViewModel, never SessionStore/SavedStateHandle/normal chats.
 * Configuration and in-app navigation retain it. Background stops inference and
 * polling, not completed context. Process death abandons it (server TTL safety net).
 */
class TemporaryChatSession(
    private val api: TemporaryChatApi,
    private val scope: CoroutineScope,
    private val now: () -> Long = System::currentTimeMillis,
    private val onUnauthorized: () -> Unit = {},
) {
    private val _state = MutableStateFlow(TemporaryChatState())
    val state = _state.asStateFlow()
    private var generation = 0
    private var foreground = true
    private var stopping = false
    private var lastRead = 0
    private var work: Job? = null
    private val poll = scope.launch {
        while (true) {
            delay(5_000)
            if (foreground && _state.value.snapshot != null) refresh()
        }
    }

    fun draft(text: String) { if (!_state.value.busy) _state.update { it.copy(draft = text.take(16_000)) } }
    fun model(config: ModelConfig) {
        if (!_state.value.busy && config.provider in setOf("openrouter", "ollama") && config.model.isNotBlank())
            _state.update { it.copy(model = config) }
    }

    fun start() {
        if (!foreground || _state.value.busy || _state.value.snapshot != null) return
        val version = generation
        _state.update { it.copy(sending = true, problem = null) }
        work = scope.launch {
            try {
                val snapshot = api.createTemporaryChat()
                if (version == generation) _state.update { it.copy(snapshot = snapshot) }
            } catch (e: Exception) { fail(e, version) }
            finally { if (version == generation) _state.update { it.copy(sending = false) } }
        }
    }

    /** A read never renews the server TTL. Network failures retain the in-memory ID for reconnect. */
    private suspend fun refresh() {
        val snapshot = _state.value.snapshot ?: return
        val version = generation
        val read = ++lastRead
        try {
            val next = api.temporaryChat(snapshot.id)
            if (version == generation && read == lastRead) _state.update { it.copy(snapshot = next) }
        } catch (e: Exception) { fail(e, version) }
    }

    fun send() {
        val current = _state.value
        val snapshot = current.snapshot ?: return
        val model = current.model ?: return
        if (current.busy || current.draft.isBlank() || !foreground) return
        val version = generation
        _state.update { it.copy(sending = true, partial = "", problem = null) }
        work = scope.launch {
            var completed = false
            try {
                api.temporaryTurn(snapshot.id, current.draft, model).collect { event ->
                    if (version != generation) return@collect
                    when (event) {
                        is TemporaryEvent.Delta -> _state.update {
                            if (it.partial.length + event.text.length > 100_000) throw ApiException("Temporary response limit", 413)
                            it.copy(partial = it.partial + event.text)
                        }
                        TemporaryEvent.Done -> completed = true
                        TemporaryEvent.Failure -> throw ApiException("Temporary reply failed", 0)
                        TemporaryEvent.Stopped -> completed = false
                    }
                }
                if (!completed && version == generation) _state.update { it.copy(problem = TemporaryProblem.Interrupted) }
            } catch (e: Exception) { fail(e, version) }
            finally {
                // Even if the completion event was lost, fetch the committed context.
                // Never replay a POST automatically; the user checks the snapshot first.
                if (version == generation) {
                    withContext(NonCancellable) { withTimeoutOrNull(5_000) { refresh() } }
                    if (version == generation) _state.update {
                        it.copy(sending = false, partial = "", draft = if (completed) "" else it.draft)
                    }
                }
            }
        }
    }

    fun stop() {
        val id = _state.value.snapshot?.id ?: return
        if (stopping) return
        generation++
        work?.cancel()
        stopping = true
        _state.update { it.copy(sending = true, partial = "", problem = TemporaryProblem.Interrupted) }
        val version = generation
        scope.launch {
            try {
                withTimeoutOrNull(5_000) {
                    try { api.stopTemporaryChat(id); if (version == generation) refresh() }
                    catch (e: Exception) { fail(e, version) }
                }
            } finally {
                if (version == generation) { stopping = false; _state.update { it.copy(sending = false) } }
            }
        }
    }

    fun foreground(visible: Boolean) {
        foreground = visible
        if (!visible) {
            if (_state.value.snapshot == null) {
                generation++; work?.cancel()
                _state.update { it.copy(sending = false) }
            } else if (_state.value.busy) stop()
        } else {
            if (_state.value.snapshot?.let { now() >= it.expiresAt } == true) expire()
            else scope.launch { refresh() }
        }
    }

    /** Only this RAM session is discarded. There is no normal-conversation delete/archive call. */
    fun discard() {
        val id = _state.value.snapshot?.id
        generation++
        stopping = false
        work?.cancel(); work = null
        _state.value = TemporaryChatState()
        if (id != null) {
            // Bounded best effort, independent of a ViewModel that may be clearing.
            // UNDISPATCHED builds the authenticated request before a server/logout switch.
            val cleanup = CoroutineScope(Dispatchers.IO)
            cleanup.launch(start = CoroutineStart.UNDISPATCHED) {
                try { withTimeoutOrNull(5_000) { api.deleteTemporaryChat(id) } }
                catch (_: Exception) { /* server expiry/revocation is the safety net */ }
                finally { cleanup.cancel() }
            }
        }
    }

    fun dispose() { poll.cancel(); discard() }

    private fun expire() {
        discard()
        _state.update { it.copy(problem = TemporaryProblem.Expired) }
    }

    private fun fail(error: Exception, version: Int) {
        if (error is CancellationException) throw error
        if (version != generation) return
        when {
            error is ApiException && error.status == 401 -> { discard(); onUnauthorized() }
            (error is ApiException && error.status == 404) || _state.value.snapshot?.let { now() >= it.expiresAt } == true -> expire()
            else -> _state.update {
                it.copy(problem = if (error is ApiException && error.status != 0) TemporaryProblem.Unavailable else TemporaryProblem.Connection)
            }
        }
    }
}
