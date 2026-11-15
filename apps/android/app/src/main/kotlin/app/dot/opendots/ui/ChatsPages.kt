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

/**
 * Chats are their own destination, next to companions: free threads that belong to no companion. A companion only
 * joins one when it is called by name.
 */
@Composable
fun ChatsPage(app: AppState, ui: AppUiState, onOpen: (GeneralChat) -> Unit) {
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
    QuietPage(stringResource(R.string.chats), onBack = null, inTabs = true, subtitle = if (!ui.connected) stringResource(R.string.reconnecting) else null) {
        item {
            Row(Modifier.fillMaxWidth().padding(horizontal = DotSpacing.gutter).padding(bottom = DotSpacing.s), verticalAlignment = Alignment.CenterVertically) {
                if (ui.chats.size > 5) SearchField(query, { query = it }, Modifier.weight(1f).padding(end = DotSpacing.m), placeholder = stringResource(R.string.search_chats)) else Spacer(Modifier.weight(1f))
                DotButton(stringResource(R.string.new_chat), { app.createChat { app.state.value.currentChat?.let(onOpen) } }, icon = Icons.Outlined.Add, compact = true)
            }
        }
        if (shown.isEmpty()) item {
            EmptyState(Icons.Outlined.Forum, stringResource(if (query.isBlank()) R.string.chats_empty_title else R.string.chats_none_found), if (query.isBlank()) stringResource(R.string.chats_empty_body) else "")
        }
        items(shown, key = { it.id }) { chat ->
            ChatRow(chat) { onOpen(chat) }
            Hairline(inset = DotSpacing.gutter + 48.dp + DotSpacing.l)
        }
    }
}

@Composable
private fun ChatRow(chat: GeneralChat, onClick: () -> Unit) {
    val c = Dot.colors
    Row(
        Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onClick).heightIn(min = 76.dp).padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.m).testTag("chat-row"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(48.dp).clip(DotShapes.circle).background(c.surfaceRaised), contentAlignment = Alignment.Center) { Icon(Icons.Outlined.Forum, null, Modifier.size(22.dp), tint = c.textSecondary) }
        Spacer(Modifier.width(DotSpacing.l))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(chat.title.ifBlank { stringResource(R.string.new_chat) }, style = Dot.type.headline, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                formatWhen(chat.updatedAt).takeIf { it.isNotEmpty() }?.let { Text(it.substringBefore(","), style = Dot.type.caption, color = c.textTertiary, maxLines = 1) }
            }
            Text(
                chat.lastMessagePreview?.replace(Regex("\\s+"), " ")?.trim()?.ifBlank { null } ?: stringResource(R.string.chat_empty_row),
                style = Dot.type.callout, color = c.textSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** A chat's own settings: its title, the model that answers in it, the companions that contributed, its files. */
@Composable
fun ChatSettingsPage(app: AppState, ui: AppUiState, chat: GeneralChat, onBack: () -> Unit, onChangeModel: () -> Unit, onDeleted: () -> Unit) {
    val c = Dot.colors
    var title by rememberSaveable(chat.id, chat.title) { mutableStateOf(chat.title) }
    var deleting by remember { mutableStateOf(false) }
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
            Box(Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.xl)) {
                DotButton(stringResource(R.string.chat_delete), { deleting = true }, style = ButtonStyle.Danger)
            }
        }
    }
    if (files) FilesSheet(app, ui, stringResource(R.string.files), agentId = null, conversationId = chat.id) { files = false }
    openTask?.let { id -> TaskSheet(app, ui, id) { openTask = null } }
    if (deleting) DotDialog(
        title = stringResource(R.string.chat_delete), message = chat.title,
        confirmLabel = stringResource(R.string.delete), dismissLabel = stringResource(R.string.cancel),
        onConfirm = { deleting = false; app.deleteChat(chat.id, onDeleted) }, onDismiss = { deleting = false }, destructive = true,
    )
}
