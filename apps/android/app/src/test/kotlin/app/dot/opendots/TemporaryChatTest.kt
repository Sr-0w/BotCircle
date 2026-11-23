package app.dot.opendots

import app.dot.opendots.chat.TemporaryChatSession
import app.dot.opendots.chat.TemporaryProblem
import app.dot.opendots.data.ApiException
import app.dot.opendots.data.MemorySessionStore
import app.dot.opendots.data.ModelConfig
import app.dot.opendots.data.OdJson
import app.dot.opendots.data.OpenDotsClient
import app.dot.opendots.data.TemporaryChatApi
import app.dot.opendots.data.TemporaryEvent
import app.dot.opendots.data.TemporaryMessage
import app.dot.opendots.data.TemporarySnapshot
import app.dot.opendots.data.readTemporaryEvents
import app.dot.opendots.ui.ephemeralMessages
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.jsonObject
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okio.Buffer
import org.junit.Assert.*
import org.junit.Test

/** Run with :app:testDebugUnitTest; these are not claimed executed without a JDK/SDK. */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class TemporaryChatTest {
    private val id = "tmp_" + "a".repeat(48)
    private val model = ModelConfig(provider = "ollama", model = "fixture")
    private val wireSnapshot = """{"id":"$id","expiresAt":100000,"messages":[],"busy":false}"""

    @Test fun namedSseDecodesUnicodeAndRedactsFailurePayloads() {
        val events = mutableListOf<TemporaryEvent>()
        readTemporaryEvents(Buffer().writeUtf8(
            ": heartbeat\r\nevent: delta\r\ndata: \"Bonjour 🌙\\nligne\"\r\n\r\n" +
                "event: failure\ndata: \"sensitive diagnostic\"\n\n" +
                "event: stopped\ndata: {}\n\nevent: done\ndata: {}\n\n",
        ), events::add)
        assertEquals(listOf(TemporaryEvent.Delta("Bonjour 🌙\nligne"), TemporaryEvent.Failure, TemporaryEvent.Stopped, TemporaryEvent.Done), events)
        assertFalse(events.toString().contains("sensitive diagnostic"))
    }

    @Test(expected = IOException::class) fun rejectsTruncatedFrames() {
        readTemporaryEvents(Buffer().writeUtf8("event: delta\ndata: \"text\"\n")) {}
    }

    @Test(expected = IOException::class) fun rejectsNonStringDeltas() {
        readTemporaryEvents(Buffer().writeUtf8("event: delta\ndata: {\"secret\":\"not text\"}\n\n")) {}
    }

    @Test fun usesOnlyTemporaryEndpointsAndTheAuthenticatedCookie() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            val store = MemorySessionStore(serverUrl = server.url("/").toString(), sessionCookie = "fixture-cookie", lastAgentId = "normal-agent")
            val client = OpenDotsClient(store)
            server.enqueue(MockResponse.Builder().body(wireSnapshot).build())
            server.enqueue(MockResponse.Builder().addHeader("Content-Type", "text/event-stream")
                .body("event: delta\ndata: \"answer\"\n\nevent: done\ndata: {}\n\n").build())
            server.enqueue(MockResponse.Builder().body("{}").build())
            server.enqueue(MockResponse.Builder().body("{}").build())
            server.enqueue(MockResponse.Builder().body(wireSnapshot).build())
            assertEquals(id, client.createTemporaryChat().id)
            assertEquals(listOf(TemporaryEvent.Delta("answer"), TemporaryEvent.Done),
                client.temporaryTurn(id, "sensitive prompt", model.copy(providerOrder = listOf("must not be sent"))).toList())
            client.stopTemporaryChat(id)
            client.deleteTemporaryChat(id)
            client.temporaryChat(id)
            val paths = listOf("/api/temporary-chats", "/api/temporary-chats/$id/turn", "/api/temporary-chats/$id/stop", "/api/temporary-chats/$id", "/api/temporary-chats/$id")
            val methods = listOf("POST", "POST", "POST", "DELETE", "GET")
            paths.forEachIndexed { index, path ->
                val request = server.takeRequest()
                assertEquals(path, request.url.encodedPath); assertEquals(methods[index], request.method)
                assertEquals("1", request.headers["x-opendots-client"])
                assertEquals("opendots_session=fixture-cookie", request.headers["Cookie"])
                if (index == 1) {
                    val body = OdJson.parseToJsonElement(request.body!!.utf8()).jsonObject
                    assertEquals(setOf("text", "model"), body.keys)
                    assertEquals(setOf("provider", "model"), body.getValue("model").jsonObject.keys)
                }
            }
            assertEquals("normal-agent", store.lastAgentId)
            assertEquals("fixture-cookie", store.sessionCookie)
        }
    }

    @Test fun codexIsRejectedBeforeAnyNetworkRequest() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            val client = OpenDotsClient(MemorySessionStore(serverUrl = server.url("/").toString()))
            try {
                client.temporaryTurn(id, "prompt", model.copy(provider = "codex")).toList()
                fail("Codex should be disabled")
            } catch (_: IllegalArgumentException) {}
            assertEquals(0, server.requestCount)
        }
    }

    private inner class FakeApi : TemporaryChatApi {
        var snapshot = TemporarySnapshot(id, 100_000)
        var slow = false
        var failReads = false
        var missing = false
        var unauthorized = false
        var sends = 0
        var stopped = 0
        var reads = 0
        var createGate: CompletableDeferred<Unit>? = null
        val deleted = CompletableDeferred<String>()
        val aborted = CompletableDeferred<Unit>()
        override suspend fun createTemporaryChat(): TemporarySnapshot { createGate?.await(); return snapshot }
        override suspend fun temporaryChat(id: String): TemporarySnapshot {
            reads++
            if (unauthorized) throw ApiException("sensitive unauthorized diagnostic", 401)
            if (missing) throw ApiException("content-bearing error must not be shown", 404)
            if (failReads) throw IOException("sensitive diagnostic")
            return snapshot
        }
        override suspend fun deleteTemporaryChat(id: String) { deleted.complete(id) }
        override suspend fun stopTemporaryChat(id: String) { stopped++ }
        override fun temporaryTurn(id: String, text: String, model: ModelConfig): Flow<TemporaryEvent> = flow {
            sends++
            emit(TemporaryEvent.Delta("partial"))
            if (slow) {
                try { awaitCancellation() } finally { aborted.complete(Unit) }
            } else {
                snapshot = snapshot.copy(messages = snapshot.messages + listOf(TemporaryMessage("user", text), TemporaryMessage("assistant", "answer", model)))
                emit(TemporaryEvent.Done)
            }
        }
    }

    @Test fun completedContextReconnectsWithoutReplayingAndANewSessionStartsEmpty() = runTest {
        val api = FakeApi()
        val session = TemporaryChatSession(api, backgroundScope, now = { 0 })
        session.start(); runCurrent()
        session.model(model); session.draft("private"); session.send(); runCurrent()
        assertEquals(2, session.state.value.snapshot?.messages?.size)
        assertEquals("", session.state.value.draft)
        api.failReads = true
        session.foreground(false); session.foreground(true); runCurrent()
        assertEquals(2, session.state.value.snapshot?.messages?.size)
        assertEquals(TemporaryProblem.Connection, session.state.value.problem)
        api.failReads = false
        advanceTimeBy(30_001); runCurrent()
        assertEquals(1, api.sends) // snapshot reconnect, never an automatic POST replay
        session.discard()
        assertNull(session.state.value.snapshot); assertEquals("", session.state.value.draft)
        api.snapshot = TemporarySnapshot(id, 100_000)
        session.start(); runCurrent()
        assertTrue(session.state.value.snapshot!!.messages.isEmpty())
        session.dispose()
    }

    @Test fun heartbeatReadsEveryThirtySecondsWhileOpenAndVisibleOnly() = runTest {
        val api = FakeApi()
        val session = TemporaryChatSession(api, backgroundScope, now = { 0 })
        session.start(); runCurrent()
        val before = api.reads
        advanceTimeBy(29_000); runCurrent()
        assertEquals(before, api.reads)
        advanceTimeBy(2_000); runCurrent()
        assertEquals(before + 1, api.reads) // any authenticated read renews the server idle timeout
        advanceTimeBy(30_000); runCurrent()
        assertEquals(before + 2, api.reads)
        session.foreground(false); runCurrent()
        val background = api.reads
        advanceTimeBy(120_000); runCurrent()
        assertEquals(background, api.reads) // briefly in the background: kept, but no heartbeat
        assertNotNull(session.state.value.snapshot)
        session.dispose()
        val closed = api.reads
        advanceTimeBy(120_000); runCurrent()
        assertEquals(closed, api.reads)
    }

    @Test fun discardingWhileTheChatIsBeingCreatedDeletesItAnyway() = runTest {
        val api = FakeApi().apply { createGate = CompletableDeferred() }
        val session = TemporaryChatSession(api, backgroundScope, now = { 0 })
        session.start(); runCurrent()
        assertTrue(session.state.value.sending)
        session.discard() // the user switched back to a normal chat before the server answered
        api.createGate!!.complete(Unit); runCurrent()
        assertNull(session.state.value.snapshot)
        assertEquals(id, withContext(Dispatchers.Default) { withTimeout(5_000) { api.deleted.await() } })
        session.dispose()
    }

    @Test fun theMessageBeingSentIsShownAsSentAndTheReplyStreamsAsAnAssistantMessage() = runTest {
        val api = FakeApi().apply { slow = true }
        val session = TemporaryChatSession(api, backgroundScope, now = { 0 })
        session.start(); runCurrent()
        assertFalse(session.hasContent)
        session.model(model); session.draft("private"); session.send(); runCurrent()
        assertTrue(session.hasContent)
        val live = ephemeralMessages(session.state.value)
        assertEquals(listOf("user" to "private", "assistant" to "partial"), live.map { it.role to (it.parts.single() as app.dot.opendots.data.Part.Text).text })
        assertEquals("fixture", live.last().meta.model)
        session.foreground(false); runCurrent()
        assertNull(session.state.value.pending)
        assertTrue(ephemeralMessages(session.state.value).isEmpty())
        session.discard()
        assertFalse(session.hasContent)
        session.dispose()
    }

    @Test fun aCompletedTurnIsListedOnceAndAProblemCanBeDismissed() = runTest {
        val api = FakeApi()
        val session = TemporaryChatSession(api, backgroundScope, now = { 0 })
        session.start(); runCurrent()
        session.model(model); session.draft("private"); session.send(); runCurrent()
        assertNull(session.state.value.pending)
        assertEquals(listOf("e0", "e1"), ephemeralMessages(session.state.value).map { it.id })
        api.failReads = true
        session.foreground(false); session.foreground(true); runCurrent()
        assertEquals(TemporaryProblem.Connection, session.state.value.problem)
        session.dismissProblem()
        assertNull(session.state.value.problem)
        session.dispose()
    }

    @Test fun backgroundAbortsOnlyTheTemporaryTurnAndKeepsCompletedContext() = runTest {
        val api = FakeApi().apply { slow = true }
        val session = TemporaryChatSession(api, backgroundScope, now = { 0 })
        session.start(); runCurrent()
        session.model(model); session.draft("private"); session.send(); runCurrent()
        assertEquals("partial", session.state.value.partial)
        session.foreground(false); runCurrent()
        assertTrue(api.aborted.isCompleted); assertEquals(1, api.stopped)
        assertEquals("", session.state.value.partial)
        assertEquals("private", session.state.value.draft)
        assertTrue(session.state.value.snapshot!!.messages.isEmpty())
        session.dispose()
    }

    @Test fun expiryDiscardsContentsRatherThanCreatingNormalHistory() = runTest {
        var now = 0L
        var unauthorized = false
        val api = FakeApi()
        val session = TemporaryChatSession(api, backgroundScope, now = { now }, onUnauthorized = { unauthorized = true })
        session.start(); runCurrent()
        session.draft("private")
        now = 100_000
        session.foreground(true); runCurrent()
        assertNull(session.state.value.snapshot); assertEquals("", session.state.value.draft)
        assertEquals(TemporaryProblem.Expired, session.state.value.problem)
        assertEquals(id, withTimeout(5_000) { api.deleted.await() })
        assertFalse(unauthorized)
        session.dispose()
    }

    @Test fun server404ClearsTheLocalTranscript() = runTest {
        val api = FakeApi()
        val session = TemporaryChatSession(api, backgroundScope, now = { 0 })
        session.start(); runCurrent(); session.draft("private")
        api.missing = true
        session.foreground(true); runCurrent()
        assertNull(session.state.value.snapshot)
        assertEquals("", session.state.value.draft)
        assertEquals(TemporaryProblem.Expired, session.state.value.problem)
        session.dispose()
    }

    @Test fun server401DiscardsAndUsesTheStandardUnauthorizedHandler() = runTest {
        var notified = false
        val api = FakeApi()
        val session = TemporaryChatSession(api, backgroundScope, now = { 0 }, onUnauthorized = { notified = true })
        session.start(); runCurrent(); session.draft("private")
        api.unauthorized = true
        session.foreground(true); runCurrent()
        assertTrue(notified)
        assertNull(session.state.value.snapshot)
        assertEquals("", session.state.value.draft)
        session.dispose()
    }
}
