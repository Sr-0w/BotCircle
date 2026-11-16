package app.dot.opendots.ui

import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Unarchive
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.dot.design.Dot
import app.dot.design.DotSpacing
import app.dot.design.components.ButtonStyle
import app.dot.design.components.DotBottomSheet
import app.dot.design.components.DotButton
import app.dot.design.components.DotDialog
import app.dot.design.components.DotIconButton
import app.dot.design.components.DotMenu
import app.dot.design.components.DotMenuItem
import app.dot.design.components.DotSpinner
import app.dot.design.components.Hairline
import app.dot.opendots.AppState
import app.dot.opendots.AppUiState
import app.dot.opendots.ConversationRef
import app.dot.opendots.DeleteOutcome
import app.dot.opendots.R
import app.dot.opendots.data.Agent
import app.dot.opendots.data.ArchivedThread
import app.dot.opendots.data.ChatMessage
import app.dot.opendots.data.Part
import app.dot.opendots.chat.cleanModelText
import kotlinx.coroutines.launch

/**
 * #56: Archive, Restore and Delete with the same rules everywhere. Delete always asks first and says what goes and
 * what stays; a running reply or still-active tasks are confirmed explicitly (the server refuses otherwise).
 */
class ConversationActions internal constructor(
    val archive: (ConversationRef, onDone: () -> Unit) -> Unit,
    val restore: (ConversationRef, onDone: () -> Unit) -> Unit,
    val delete: (ConversationRef, onDone: () -> Unit) -> Unit,
)

private sealed interface Step {
    data class Confirm(val ref: ConversationRef, val onDone: () -> Unit) : Step
    data class Busy(val ref: ConversationRef, val onDone: () -> Unit) : Step
    data class Tasks(val ref: ConversationRef, val titles: List<String>, val stop: Boolean, val onDone: () -> Unit) : Step
}

@Composable
fun rememberConversationActions(app: AppState): ConversationActions {
    val scope = rememberCoroutineScope()
    var step by remember { mutableStateOf<Step?>(null) }
    val archivedChat = stringResource(R.string.chat_archived_toast)
    val archivedThread = stringResource(R.string.thread_archived_toast)
    val restored = stringResource(R.string.conversation_restored)
    val deleted = stringResource(R.string.conversation_deleted)
    fun run(ref: ConversationRef, stop: Boolean, tasks: Boolean, onDone: () -> Unit) = scope.launch {
        when (val outcome = app.deleteConversation(ref, stop, tasks)) {
            DeleteOutcome.Done -> { app.notify(deleted); onDone() }
            DeleteOutcome.Busy -> step = Step.Busy(ref, onDone)
            is DeleteOutcome.ActiveTasks -> step = Step.Tasks(ref, outcome.titles, stop, onDone)
            is DeleteOutcome.Failed -> app.notify(outcome.message)
        }
    }
    when (val current = step) {
        is Step.Confirm -> {
            val ref = current.ref
            val what = when (ref) {
                is ConversationRef.Chat -> stringResource(R.string.delete_chat_what, ref.title)
                is ConversationRef.Thread -> if (ref.current) stringResource(R.string.delete_thread_current, ref.agentName) else stringResource(R.string.delete_thread_archived, ref.agentName)
            }
            DotDialog(
                title = stringResource(R.string.delete_what, what), destructive = true,
                message = stringResource(R.string.delete_explain) + "\n\n" + stringResource(if (ref is ConversationRef.Chat) R.string.delete_keeps_chat else R.string.delete_keeps_thread),
                confirmLabel = stringResource(R.string.delete_forever), dismissLabel = stringResource(R.string.cancel),
                onConfirm = { step = null; run(ref, stop = false, tasks = false, current.onDone) }, onDismiss = { step = null },
                modifier = Modifier.testTag("delete-confirm"),
            )
        }
        is Step.Busy -> DotDialog(
            title = stringResource(R.string.delete_busy_title), destructive = true, message = stringResource(R.string.delete_busy_body),
            confirmLabel = stringResource(R.string.delete_stop_and_delete), dismissLabel = stringResource(R.string.cancel),
            onConfirm = { step = null; run(current.ref, stop = true, tasks = false, current.onDone) }, onDismiss = { step = null },
        )
        is Step.Tasks -> DotDialog(
            title = pluralStringResource(R.plurals.delete_tasks_title, current.titles.size, current.titles.size), destructive = true,
            message = current.titles.take(6).joinToString("\n") { "• $it" } + "\n\n" + stringResource(R.string.delete_tasks_body),
            confirmLabel = stringResource(R.string.delete_anyway), dismissLabel = stringResource(R.string.cancel),
            onConfirm = { step = null; run(current.ref, stop = current.stop, tasks = true, current.onDone) }, onDismiss = { step = null },
            modifier = Modifier.testTag("delete-tasks"),
        )
        null -> Unit
    }
    return remember(app) {
        ConversationActions(
            archive = { ref, onDone ->
                when (ref) {
                    is ConversationRef.Chat -> app.archiveChat(ref.id) { app.notify(archivedChat); onDone() }
                    is ConversationRef.Thread -> app.archiveThread(ref.agentId, ref.id) { app.notify(archivedThread); onDone() }
                }
            },
            restore = { ref, onDone ->
                when (ref) {
                    is ConversationRef.Chat -> app.restoreChat(ref.id) { app.notify(restored); onDone() }
                    is ConversationRef.Thread -> app.restoreThread(ref.agentId, ref.id) { app.notify(restored); onDone() }
                }
            },
            delete = { ref, onDone -> step = Step.Confirm(ref, onDone) },
        )
    }
}

/** A small "…" menu for a conversation row or header. */
@Composable
fun ConversationMenu(items: List<Triple<String, ImageVector, () -> Unit>>, label: String, modifier: Modifier = Modifier, destructiveLast: Boolean = true) {
    var open by remember { mutableStateOf(false) }
    Box(modifier) {
        DotIconButton(Icons.Outlined.MoreVert, label, onClick = { open = true }, tint = Dot.colors.textTertiary, modifier = Modifier.testTag("conversation-menu"))
        DotMenu(open, { open = false }) {
            items.forEachIndexed { index, (text, icon, action) ->
                DotMenuItem(text, icon, color = if (destructiveLast && index == items.lastIndex && icon == Icons.Outlined.DeleteOutline) Dot.colors.danger else Dot.colors.textPrimary) { open = false; action() }
            }
        }
    }
}

/** #56: a Circle's previous threads (archived or set aside by /clear): read, restore as current, delete. */
@Composable
fun ArchivedThreadsSheet(app: AppState, ui: AppUiState, agent: Agent, onDismiss: () -> Unit) {
    val actions = rememberConversationActions(app)
    var threads by remember { mutableStateOf<List<ArchivedThread>?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    var reading by remember { mutableStateOf<ArchivedThread?>(null) }
    LaunchedEffect(agent.id, reload, agent.mainConversationId) { threads = app.archivedThreads(agent.id) }
    val restoreLabel = stringResource(R.string.restore_as_current)
    val deleteLabel = stringResource(R.string.delete_ellipsis)
    DotBottomSheet(onDismiss) {
        Text(stringResource(R.string.previous_threads), style = Dot.type.headline, color = Dot.colors.textPrimary, modifier = Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.s))
        val list = threads
        when {
            list == null -> Box(Modifier.fillMaxWidth().padding(DotSpacing.xxxl), contentAlignment = Alignment.Center) { DotSpinner(size = 24.dp) }
            list.isEmpty() -> Text(stringResource(R.string.previous_threads_empty), style = Dot.type.callout, color = Dot.colors.textSecondary, modifier = Modifier.padding(DotSpacing.gutter))
            else -> LazyColumn(contentPadding = PaddingValues(bottom = DotSpacing.xxl)) {
                items(list, key = { it.id }) { thread ->
                    val ref = ConversationRef.Thread(agent.id, thread.id, agentDisplayName(agent), current = false)
                    Row(Modifier.fillMaxWidth().padding(start = DotSpacing.gutter).testTag("archived-thread"), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f).padding(vertical = DotSpacing.m)) {
                            Text(stringResource(R.string.archived_thread), style = Dot.type.body, color = Dot.colors.textPrimary)
                            Text(formatWhen(thread.archivedAt) + (if (thread.messageCount > 0) " · " + pluralStringResource(R.plurals.messages_count, thread.messageCount, thread.messageCount) else ""), style = Dot.type.caption, color = Dot.colors.textSecondary)
                        }
                        DotButton(stringResource(R.string.read), { reading = thread }, style = ButtonStyle.Ghost, compact = true)
                        ConversationMenu(listOf(
                            Triple(restoreLabel, Icons.Outlined.Unarchive) { actions.restore(ref) { onDismiss() } },
                            Triple(deleteLabel, Icons.Outlined.DeleteOutline) { actions.delete(ref) { reload++ } },
                        ), stringResource(R.string.more))
                    }
                    Hairline(inset = DotSpacing.gutter)
                }
            }
        }
    }
    reading?.let { thread -> ArchivedThreadReader(app, ui, thread) { reading = null } }
}

@Composable
private fun ArchivedThreadReader(app: AppState, ui: AppUiState, thread: ArchivedThread, onDismiss: () -> Unit) {
    var messages by remember(thread.id) { mutableStateOf<List<ChatMessage>?>(null) }
    LaunchedEffect(thread.id) { messages = runCatching { app.client.conversationMessages(thread.id) }.getOrDefault(emptyList()) }
    DotBottomSheet(onDismiss) {
        val rows = messages?.mapNotNull { m -> m.parts.filterIsInstance<Part.Text>().joinToString("\n") { cleanModelText(it.text) }.trim().takeIf { it.isNotEmpty() }?.let { m to it } }
        if (rows == null) Box(Modifier.fillMaxWidth().padding(DotSpacing.xxxl), contentAlignment = Alignment.Center) { DotSpinner(size = 24.dp) }
        else LazyColumn(contentPadding = PaddingValues(start = DotSpacing.gutter, end = DotSpacing.gutter, bottom = DotSpacing.xxl), verticalArrangement = Arrangement.spacedBy(DotSpacing.m), modifier = Modifier.testTag("archived-thread-reader")) {
            items(rows, key = { it.first.id }) { (message, text) ->
                Column {
                    Text(if (message.isUser) stringResource(R.string.you) else ui.agents.firstOrNull { it.id == message.meta.agentId }?.let { agentDisplayName(it) } ?: stringResource(R.string.companion), style = Dot.type.label, color = Dot.colors.textSecondary)
                    Spacer(Modifier.width(DotSpacing.xs))
                    Text(text, style = Dot.type.callout, color = Dot.colors.textPrimary, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

