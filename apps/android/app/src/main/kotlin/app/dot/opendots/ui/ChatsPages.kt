package app.dot.opendots.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.InsertDriveFile
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import app.dot.design.components.DotIconButton
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.dot.design.Dot
import app.dot.design.DotShapes
import app.dot.design.DotSpacing
import app.dot.design.components.ButtonStyle
import app.dot.design.components.DotButton
import app.dot.design.components.DotDialog
import app.dot.design.components.DotPrimaryButton
import app.dot.design.components.DotTextField
import app.dot.design.components.EmptyState
import app.dot.design.components.Hairline
import app.dot.design.components.ListRow
import app.dot.design.components.SearchField
import app.dot.design.components.SectionLabel
import app.dot.opendots.AppState
import app.dot.opendots.AppUiState
import app.dot.opendots.R
import app.dot.opendots.data.GeneralChat
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import androidx.compose.material.icons.outlined.ManageSearch
import androidx.compose.foundation.layout.Arrangement
import app.dot.opendots.ConversationRef
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.Unarchive
import androidx.compose.material.icons.outlined.Archive

/**
 * Chats are their own destination, next to companions: free threads that belong to no companion. A companion only
 * joins one when it is called by name.
 */
@Composable
fun ChatsPage(app: AppState, ui: AppUiState, onSearch: (String) -> Unit = {}, onOpen: (GeneralChat) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    var found by remember { mutableStateOf<List<GeneralChat>?>(null) }
    // Search covers titles and content, on the server.
    LaunchedEffect(query, ui.chats) {
        val q = query.trim()
        if (q.isEmpty()) { found = null; return@LaunchedEffect }
        delay(250)
        runCatching { app.client.chats(q) }.onSuccess { found = it }
    }
    val shown = found ?: ui.chats
    val actions = rememberConversationActions(app)
    var showArchived by rememberSaveable { mutableStateOf(false) }
    val pin = stringResource(R.string.pin); val unpin = stringResource(R.string.unpin); val archive = stringResource(R.string.archive)
    val restore = stringResource(R.string.restore); val delete = stringResource(R.string.delete_ellipsis); val more = stringResource(R.string.chat_actions)
    QuietPage(stringResource(R.string.chats), onBack = null, inTabs = true, actions = { DotIconButton(Icons.Outlined.ManageSearch, stringResource(R.string.search_title), onClick = { onSearch(query) }, modifier = Modifier.testTag("open-search")) }, subtitle = if (!ui.connected) stringResource(R.string.reconnecting) else null) {
        item {
            Row(Modifier.fillMaxWidth().padding(horizontal = DotSpacing.gutter).padding(bottom = DotSpacing.s), verticalAlignment = Alignment.CenterVertically) {
                if (ui.chats.isNotEmpty()) SearchField(query, { query = it }, Modifier.weight(1f).padding(end = DotSpacing.m), placeholder = stringResource(R.string.search_chats)) else Spacer(Modifier.weight(1f))
                DotButton(stringResource(R.string.new_chat), { app.newChat(); app.state.value.currentChat?.let(onOpen) }, icon = Icons.Outlined.Add, compact = true)
            }
        }
        // #58: the field filters chats; the full search covers every message of chats and Circles.
        if (query.isNotBlank()) item(key = "search-everywhere") {
            ListRow(stringResource(R.string.search_everywhere, query.trim()), icon = Icons.Outlined.ManageSearch, onClick = { onSearch(query.trim()) }, modifier = Modifier.testTag("search-everywhere"))
        }
        if (shown.isEmpty()) item {
            EmptyState(Icons.Outlined.Forum, stringResource(if (query.isBlank()) R.string.chats_empty_title else R.string.chats_none_found), if (query.isBlank()) stringResource(R.string.chats_empty_body) else "")
        }
        items(shown, key = { it.id }) { chat ->
            val ref = ConversationRef.Chat(chat.id, chat.title)
            ChatRow(chat, menu = { ConversationMenu(listOf(
                Triple(if (chat.pinned) unpin else pin, Icons.Outlined.PushPin) { app.updateChat(chat.id, buildJsonObject { put("pinned", !chat.pinned) }) },
                Triple(archive, Icons.Outlined.Archive) { actions.archive(ref) {} },
                Triple(delete, Icons.Outlined.DeleteOutline) { actions.delete(ref) {} },
            ), more) }) { onOpen(chat) }
            Hairline(inset = DotSpacing.gutter + 48.dp + DotSpacing.l)
        }
        // #56: archived chats, out of the way but one tap from here; they open, and can be restored or deleted.
        if (query.isBlank() && ui.archivedChats.isNotEmpty()) {
            item(key = "archived-toggle") {
                ListRow(stringResource(R.string.archived_chats, ui.archivedChats.size), icon = Icons.Outlined.Archive, onClick = { showArchived = !showArchived }, modifier = Modifier.testTag("archived-toggle"),
                    trailing = { Icon(if (showArchived) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, null, tint = Dot.colors.textTertiary) })
            }
            if (showArchived) items(ui.archivedChats, key = { "a-" + it.id }) { chat ->
                val ref = ConversationRef.Chat(chat.id, chat.title)
                ChatRow(chat, archived = true, menu = { ConversationMenu(listOf(
                    Triple(restore, Icons.Outlined.Unarchive) { actions.restore(ref) {} },
                    Triple(delete, Icons.Outlined.DeleteOutline) { actions.delete(ref) {} },
                ), more) }) { onOpen(chat) }
                Hairline(inset = DotSpacing.gutter + 48.dp + DotSpacing.l)
            }
        }
    }
}

@Composable
private fun ChatRow(chat: GeneralChat, archived: Boolean = false, menu: @Composable () -> Unit, onClick: () -> Unit) {
    val c = Dot.colors
    Row(
        Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onClick).heightIn(min = 76.dp).padding(start = DotSpacing.gutter, end = DotSpacing.s, top = DotSpacing.m, bottom = DotSpacing.m).testTag(if (archived) "archived-chat-row" else "chat-row"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(48.dp).clip(DotShapes.circle).background(c.surfaceRaised), contentAlignment = Alignment.Center) { Icon(Icons.Outlined.Forum, null, Modifier.size(22.dp), tint = c.textSecondary) }
        Spacer(Modifier.width(DotSpacing.l))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(chat.title.ifBlank { stringResource(R.string.new_chat) }, style = Dot.type.headline, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                if (chat.pinned) Icon(Icons.Outlined.PushPin, stringResource(R.string.pinned), Modifier.padding(end = DotSpacing.xs).size(14.dp), tint = c.textTertiary)
                formatWhen(chat.updatedAt).takeIf { it.isNotEmpty() }?.let { Text(it.substringBefore(","), style = Dot.type.caption, color = c.textTertiary, maxLines = 1) }
            }
            Text(
                chat.lastMessagePreview?.replace(Regex("\\s+"), " ")?.trim()?.ifBlank { null } ?: stringResource(R.string.chat_empty_row),
                style = Dot.type.callout, color = c.textSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis,
            )
        }
        menu()
    }
}

/** A chat's own settings: its title, the model that answers in it, the companions that contributed, its files. */
@Composable
fun ChatSettingsPage(app: AppState, ui: AppUiState, chat: GeneralChat, onBack: () -> Unit, onChangeModel: () -> Unit, onDeleted: () -> Unit) {
    val c = Dot.colors
    var title by rememberSaveable(chat.id, chat.title) { mutableStateOf(chat.title) }
    val actions = rememberConversationActions(app)
    var files by remember { mutableStateOf(false) }
    var openTask by remember { mutableStateOf<String?>(null) }
    val interventions = remember(ui.tasks, chat.id) { ui.tasks.values.filter { it.conversationId == chat.id }.sortedByDescending { it.createdAt } }
    QuietPage(stringResource(R.string.chat_settings), onBack, subtitle = chat.title) {
        item {
            Row(Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.m), verticalAlignment = Alignment.Bottom) {
                DotTextField(title, { title = it.take(200) }, Modifier.weight(1f), label = stringResource(R.string.chat_title), imeAction = ImeAction.Done)
                Spacer(Modifier.width(DotSpacing.m))
                DotPrimaryButton(stringResource(R.string.rename), { app.updateChat(chat.id, buildJsonObject { put("title", title.trim()) }) }, enabled = title.isNotBlank() && title.trim() != chat.title)
            }
            Hairline()
        }
        item {
            SectionLabel(stringResource(R.string.model), Modifier.padding(top = DotSpacing.l))
            ListRow(
                chat.effectiveModel.model,
                subtitle = providerLabel(chat.effectiveModel.provider) + " · " + stringResource(if (chat.model == null) R.string.model_default else R.string.chat_model_own),
                onClick = onChangeModel,
                trailing = { Text(stringResource(R.string.change), style = Dot.type.label, color = c.accent) },
            )
            if (chat.model != null) Box(Modifier.padding(horizontal = DotSpacing.gutter).padding(bottom = DotSpacing.s)) {
                DotButton(stringResource(R.string.model_reset), { app.updateChat(chat.id, JsonObject(mapOf("model" to JsonNull))) }, style = ButtonStyle.Secondary, compact = true)
            }
            Hairline()
            ListRow(
                stringResource(R.string.files), subtitle = stringResource(R.string.chat_files_note), icon = Icons.AutoMirrored.Outlined.InsertDriveFile, onClick = { files = true },
                trailing = { Icon(Icons.Outlined.ChevronRight, null, tint = c.textTertiary) },
            )
            Hairline()
        }
        if (interventions.isNotEmpty()) {
            item { SectionLabel(stringResource(R.string.interventions), Modifier.padding(top = DotSpacing.l)) }
            items(interventions, key = { it.id }) { task ->
                TaskCard(
                    task, onDetails = { openTask = task.id }, onAction = { app.taskAction(task.id, it) },
                    modifier = Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.xs), agent = ui.agents.firstOrNull { it.id == task.agentId },
                )
            }
        }
        item {
            val ref = ConversationRef.Chat(chat.id, chat.title)
            Row(Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.xl), horizontalArrangement = Arrangement.spacedBy(DotSpacing.s)) {
                if (chat.archived) DotButton(stringResource(R.string.restore), { actions.restore(ref) {} }, style = ButtonStyle.Secondary, icon = Icons.Outlined.Unarchive)
                else DotButton(stringResource(R.string.archive), { actions.archive(ref, onDeleted) }, style = ButtonStyle.Secondary, icon = Icons.Outlined.Archive)
                DotButton(stringResource(R.string.delete_ellipsis), { actions.delete(ref, onDeleted) }, style = ButtonStyle.Danger, modifier = Modifier.testTag("chat-delete"))
            }
        }
    }
    if (files) FilesSheet(app, ui, stringResource(R.string.files), agentId = null, conversationId = chat.id) { files = false }
    openTask?.let { id -> TaskSheet(app, ui, id) { openTask = null } }
}
