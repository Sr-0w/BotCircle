package app.dot.opendots.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material.icons.outlined.Psychology
import androidx.compose.material.icons.outlined.Subject
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.dot.design.Dot
import app.dot.design.DotSpacing
import app.dot.design.components.ButtonStyle
import app.dot.design.components.DotBottomSheet
import app.dot.design.components.DotButton
import app.dot.design.components.DotSpinner
import app.dot.design.components.EmptyState
import app.dot.design.components.Hairline
import app.dot.opendots.AppState
import app.dot.opendots.AppUiState
import app.dot.opendots.R
import app.dot.opendots.chat.cleanModelText
import app.dot.opendots.chat.isSilence
import app.dot.opendots.data.Agent
import app.dot.opendots.data.ChatMessage
import app.dot.opendots.data.JournalEntry
import app.dot.opendots.data.Memory
import app.dot.opendots.data.Part
import app.dot.opendots.data.TeamThread

/** What a companion remembers. Forgetting is immediate and only removes that one memory. */
@Composable
fun MemorySheet(app: AppState, agent: Agent, onDismiss: () -> Unit) {
    var items by remember { mutableStateOf<List<Memory>?>(null) }
    var revision by remember { mutableIntStateOf(0) }
    LaunchedEffect(agent.id, revision) { runCatching { app.client.memories(agent.id) }.onSuccess { items = it }.onFailure { items = emptyList() } }
    // Read here, not only inside the sheet: the sheet is its own window, and this page must recompose when data arrives.
    val list = items
    DotBottomSheet(onDismiss) {
        Text(stringResource(R.string.memory_title, agentDisplayName(agent)), style = Dot.type.title, color = Dot.colors.textPrimary, modifier = Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.s).semantics { heading() })
        when {
            list == null -> Box(Modifier.fillMaxWidth().padding(DotSpacing.xxxl), contentAlignment = Alignment.Center) { DotSpinner(size = 24.dp) }
            list.isEmpty() -> EmptyState(Icons.Outlined.Psychology, stringResource(R.string.memory_empty_title), stringResource(R.string.memory_empty_body))
            else -> LazyColumn(contentPadding = PaddingValues(bottom = DotSpacing.xxl)) {
                items(list, key = { it.id }) { memory ->
                    Row(Modifier.fillMaxWidth().padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.s).testTag("memory"), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(memory.content, style = Dot.type.callout, color = Dot.colors.textPrimary)
                            if (memory.agentId == null) Text(stringResource(R.string.memory_shared), style = Dot.type.caption, color = Dot.colors.textTertiary)
                        }
                        Spacer(Modifier.width(DotSpacing.s))
                        DotButton(stringResource(R.string.memory_forget), { app.run { app.client.deleteMemory(memory.id); revision++ } }, style = ButtonStyle.Ghost, compact = true)
                    }
                    Hairline(inset = DotSpacing.gutter)
                }
            }
        }
    }
}

/** The important operations a companion carried out, most recent first. */
@Composable
fun JournalSheet(app: AppState, agent: Agent, onDismiss: () -> Unit) {
    var items by remember { mutableStateOf<List<JournalEntry>?>(null) }
    LaunchedEffect(agent.id) { runCatching { app.client.journal(agent.id) }.onSuccess { items = it }.onFailure { items = emptyList() } }
    val list = items
    DotBottomSheet(onDismiss) {
        Text(stringResource(R.string.journal_title, agentDisplayName(agent)), style = Dot.type.title, color = Dot.colors.textPrimary, modifier = Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.s).semantics { heading() })
        when {
            list == null -> Box(Modifier.fillMaxWidth().padding(DotSpacing.xxxl), contentAlignment = Alignment.Center) { DotSpinner(size = 24.dp) }
            list.isEmpty() -> EmptyState(Icons.Outlined.Subject, stringResource(R.string.journal_empty_title), stringResource(R.string.journal_empty_body))
            else -> LazyColumn(contentPadding = PaddingValues(bottom = DotSpacing.xxl)) {
                items(list, key = { it.id }) { entry ->
                    Column(Modifier.fillMaxWidth().padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.s).testTag("journal")) {
                        Text(entry.summary, style = Dot.type.callout, color = Dot.colors.textPrimary)
                        Text(formatWhen(entry.createdAt), style = Dot.type.caption, color = Dot.colors.textTertiary)
                    }
                }
            }
        }
    }
}

/** What companions say to each other: one row per pair, opening the thread read-only. */
@Composable
fun TeamExchangesPage(app: AppState, ui: AppUiState, onBack: () -> Unit) {
    var threads by remember { mutableStateOf<List<TeamThread>?>(null) }
    var open by remember { mutableStateOf<TeamThread?>(null) }
    LaunchedEffect(Unit) { runCatching { app.client.teamThreads() }.onSuccess { threads = it }.onFailure { threads = emptyList() } }
    fun name(id: String) = ui.agents.firstOrNull { it.id == id }?.takeIf { it.named }?.name
    QuietPage(stringResource(R.string.team_exchanges), onBack, subtitle = stringResource(R.string.team_exchanges_note)) {
        val list = threads
        when {
            list == null -> item { Box(Modifier.fillMaxWidth().padding(DotSpacing.xxxl), contentAlignment = Alignment.Center) { DotSpinner(size = 24.dp) } }
            list.isEmpty() -> item { EmptyState(Icons.Outlined.Forum, stringResource(R.string.team_empty_title), stringResource(R.string.team_empty_body)) }
            else -> items(list, key = { it.conversationId }) { thread ->
                Column(Modifier.fillMaxWidth().clickable(role = Role.Button) { open = thread }.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.m).testTag("team-thread")) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(thread.agentIds.map { name(it) ?: stringResource(R.string.a_companion) }.joinToString(" ↔ "), style = Dot.type.headline, color = Dot.colors.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        Text(formatWhen(thread.lastMessageAt).substringBefore(","), style = Dot.type.caption, color = Dot.colors.textTertiary)
                    }
                    Text(thread.lastMessagePreview?.replace(Regex("\\s+"), " ").orEmpty(), style = Dot.type.callout, color = Dot.colors.textSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
                Hairline(inset = DotSpacing.gutter)
            }
        }
    }
    open?.let { thread -> TeamThreadSheet(app, ui, thread) { open = null } }
}

@Composable
private fun TeamThreadSheet(app: AppState, ui: AppUiState, thread: TeamThread, onDismiss: () -> Unit) {
    var messages by remember(thread.conversationId) { mutableStateOf<List<ChatMessage>?>(null) }
    LaunchedEffect(thread.conversationId) { runCatching { app.client.conversationMessages(thread.conversationId) }.onSuccess { messages = it }.onFailure { messages = emptyList() } }
    val loaded = messages
    DotBottomSheet(onDismiss) {
        val rows = loaded?.mapNotNull { message ->
            val text = message.parts.filterIsInstance<Part.Text>().joinToString("\n") { cleanModelText(it.text) }.trim()
            if (text.isEmpty() || isSilence(text)) null else message to text
        }
        when {
            rows == null -> Box(Modifier.fillMaxWidth().padding(DotSpacing.xxxl), contentAlignment = Alignment.Center) { DotSpinner(size = 24.dp) }
            else -> LazyColumn(contentPadding = PaddingValues(start = DotSpacing.gutter, end = DotSpacing.gutter, bottom = DotSpacing.xxl)) {
                items(rows, key = { it.first.id }) { (message, text) ->
                    val author = ui.agents.firstOrNull { it.id == message.meta.agentId }
                    Column(Modifier.padding(vertical = DotSpacing.s).testTag("team-message")) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            if (author != null) { CompanionOrb(author, size = 16.dp); Spacer(Modifier.width(DotSpacing.s)) }
                            Text(author?.let { agentDisplayName(it) } ?: stringResource(R.string.a_companion), style = Dot.type.label, color = Dot.colors.textPrimary)
                            Text("  ·  " + formatWhen(message.meta.createdAt), style = Dot.type.caption, color = Dot.colors.textTertiary)
                        }
                        Text(text, style = Dot.type.callout, color = Dot.colors.textPrimary)
                    }
                }
            }
        }
    }
}
