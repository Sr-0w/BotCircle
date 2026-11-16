package app.dot.opendots.data

import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive
import okio.BufferedSource
import java.io.IOException

/** Separate wire types: never converted to GeneralChat, ChatTarget or persisted messages. */
@Serializable
data class TemporaryMessage(val role: String, val content: String, val model: ModelConfig? = null)

@Serializable
data class TemporarySnapshot(
    val id: String,
    val expiresAt: Long,
    val messages: List<TemporaryMessage> = emptyList(),
    val busy: Boolean = false,
)

sealed interface TemporaryEvent {
    data class Delta(val text: String) : TemporaryEvent
    data object Done : TemporaryEvent
    data object Stopped : TemporaryEvent
    data object Failure : TemporaryEvent
}

interface TemporaryChatApi {
    suspend fun createTemporaryChat(): TemporarySnapshot
    suspend fun temporaryChat(id: String): TemporarySnapshot
    suspend fun deleteTemporaryChat(id: String)
    suspend fun stopTemporaryChat(id: String)
    fun temporaryTurn(id: String, text: String, model: ModelConfig): Flow<TemporaryEvent>
}

/** Named SSE events (not the normal AI SDK UI-message protocol). No diagnostic payload is exposed. */
internal fun readTemporaryEvents(source: BufferedSource, emit: (TemporaryEvent) -> Unit) {
    var event = ""
    val data = StringBuilder()
    while (!source.exhausted()) {
        val line = source.readUtf8LineStrict(limit = 1_000_000)
        when {
            line.isEmpty() -> {
                when (event) {
                    "delta" -> {
                        val value = OdJson.parseToJsonElement(data.toString())
                        if (value !is JsonPrimitive || !value.isString || value.content.length > 100_000)
                            throw IOException("Invalid temporary event")
                        emit(TemporaryEvent.Delta(value.content))
                    }
                    "done" -> emit(TemporaryEvent.Done)
                    "stopped" -> emit(TemporaryEvent.Stopped)
                    "failure" -> emit(TemporaryEvent.Failure)
                }
                data.setLength(0)
                event = ""
            }
            line.startsWith("event:") -> event = line.removePrefix("event:").trim()
            line.startsWith("data:") -> {
                if (data.isNotEmpty()) data.append('\n')
                data.append(line.removePrefix("data:").removePrefix(" "))
                if (data.length > 1_000_000) throw IOException("Oversized temporary event")
            }
        }
    }
    if (data.isNotEmpty() || event.isNotEmpty()) throw IOException("Incomplete temporary event")
}
