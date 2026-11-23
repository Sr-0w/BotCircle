package app.dot.opendots

import app.dot.opendots.chat.mergeHistory
import app.dot.opendots.data.ChatMessage
import app.dot.opendots.data.MessageMeta
import app.dot.opendots.data.Part
import org.junit.Assert.assertEquals
import org.junit.Test

/** #65: a re-read while a turn runs must not re-append an old persisted message (a day-old team card) at the end. */
class MergeHistoryTest {
    private fun m(id: String, role: String = "user") = ChatMessage(id, role, listOf(Part.Text(id)), MessageMeta(kind = "chat"))

    @Test fun oldPersistedMessageAbsentFromWindowIsNotReappended() {
        val old = m("msg_rcv_tm_1biovifwia4smw")
        val current = listOf(old, m("u1"), m("a1", "assistant"))
        val remote = listOf(m("u1"), m("a1", "assistant"), m("u2"))
        val out = mergeHistory(current, remote, busy = true, liveId = null, olderLoaded = false, localIds = setOf("u2"))
        assertEquals(listOf("u1", "a1", "u2"), out.messages.map { it.id })
    }

    @Test fun unsentLocalMessageStaysOnTopWhileBusy() {
        val current = listOf(m("u1"), m("local1"))
        val remote = listOf(m("u1"))
        val out = mergeHistory(current, remote, busy = true, liveId = null, olderLoaded = false, localIds = setOf("local1"))
        assertEquals(listOf("u1", "local1"), out.messages.map { it.id })
    }

    @Test fun scrolledBackPagesStayAbove() {
        val current = listOf(m("o1"), m("o2"), m("u1"))
        val remote = listOf(m("u1"), m("u2"))
        val out = mergeHistory(current, remote, busy = false, liveId = null, olderLoaded = true, localIds = emptySet())
        assertEquals(listOf("o1", "o2", "u1", "u2"), out.messages.map { it.id })
    }
}
