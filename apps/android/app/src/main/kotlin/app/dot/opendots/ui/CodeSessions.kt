package app.dot.opendots.ui

import app.dot.opendots.data.OpencodeMachineSessions
import app.dot.opendots.data.OpencodeProject
import app.dot.opendots.data.OpencodeInstance
import app.dot.opendots.AppState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.foundation.layout.Box
import app.dot.design.components.DotSpinner
import app.dot.design.components.DotTextField
import app.dot.design.components.DotDialog
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import app.dot.design.components.DotIconButton
import androidx.compose.material.icons.outlined.Add
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.dot.design.components.ButtonStyle
import app.dot.design.components.DotButton
import app.dot.design.components.DotFilterChip
import app.dot.design.components.EmptyState
import app.dot.design.components.Hairline
import app.dot.design.components.SectionLabel
import app.dot.design.Dot
import app.dot.design.DotSpacing
import app.dot.opendots.AppUiState
import app.dot.opendots.R
import app.dot.opendots.data.BgTask
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId

/**
 * The Code destination (#47, #59): every coding session in one list, one row per canonical session, newest activity
 * first, grouped by day. Who started it is always visible: you, or a Circle.
 */
@Composable
fun CodeSessionsPage(app: AppState, ui: AppUiState, onOpen: (String) -> Unit, onOpenInstances: () -> Unit, onNew: () -> Unit) {
    var filter by rememberSaveable { mutableStateOf("all") }
    val sessions = remember(ui.tasks) { ui.tasks.values.filter { it.isCode }.sortedByDescending { it.createdAt } }
    val shown = remember(sessions, filter) {
        when (filter) {
            "mine" -> sessions.filter { it.requestedBy == "user" }
            "circles" -> sessions.filter { it.requestedBy == "agent" }
            else -> sessions
        }
    }
    val today = LocalDate.now()
    val groups = remember(shown) {
        shown.groupBy { task ->
            val day = runCatching { OffsetDateTime.parse(task.createdAt).atZoneSameInstant(ZoneId.systemDefault()).toLocalDate() }.getOrNull()
            when (day) { today -> 0; today.minusDays(1) -> 1; else -> 2 }
        }.toSortedMap()
    }
    // Sessions started in OpenCode itself on a connected machine, not yet opened here.
    var machines by remember { mutableStateOf<List<OpencodeMachineSessions>?>(null) }
    LaunchedEffect(Unit) { machines = runCatching { app.client.opencodeSessions() }.getOrNull() }
    val outside = remember(machines) { machines.orEmpty().flatMap { m -> m.sessions.filter { it.taskId == null }.map { m to it } } }
    QuietPage(stringResource(R.string.code), onBack = null, inTabs = true, actions = { DotIconButton(Icons.Outlined.Add, stringResource(R.string.code_new), onClick = onNew) }) {
        if (sessions.isEmpty() && outside.isEmpty()) {
            item {
                EmptyState(Icons.Outlined.Code, stringResource(R.string.code_empty_title), stringResource(R.string.code_empty_body)) {
                    DotButton(stringResource(R.string.code_connect_instance), onOpenInstances, style = ButtonStyle.Secondary)
                }
            }
            return@QuietPage
        }
        item(key = "filters") {
            Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.s), horizontalArrangement = Arrangement.spacedBy(DotSpacing.s)) {
                listOf("all" to R.string.code_filter_all, "mine" to R.string.code_filter_mine, "circles" to R.string.code_filter_circles).forEach { (value, label) ->
                    DotFilterChip(stringResource(label), selected = filter == value, onClick = { filter = value }, radio = true)
                }
            }
        }
        groups.forEach { (group, list) ->
            item(key = "g$group") { SectionLabel(stringResource(listOf(R.string.today, R.string.yesterday, R.string.earlier)[group]), Modifier.padding(top = DotSpacing.l)) }
            items(list, key = { it.id }) { task ->
                CodeSessionRow(app, task, ui, onOpen = { onOpen(task.id) })
                Hairline(inset = DotSpacing.gutter)
            }
        }
        if (outside.isNotEmpty() && (filter == "all")) {
            item(key = "outside") { SectionLabel(stringResource(R.string.code_from_opencode), Modifier.padding(top = DotSpacing.l)) }
            items(outside, key = { (m, s) -> "o-${m.instanceId}-${s.id}" }) { (machine, session) ->
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 56.dp).clickable(role = Role.Button) { app.attachCodeSession(machine.instanceId, session.id, session.directory.ifBlank { null }) { onOpen(it) } }
                        .padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.m).testTag("outside-session"),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    OpencodeLogo(width = 18.dp)
                    Spacer(Modifier.width(DotSpacing.l))
                    Column(Modifier.weight(1f)) {
                        Text(session.title.ifBlank { stringResource(R.string.code_untitled) }, style = Dot.type.body, color = Dot.colors.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(listOfNotNull(stringResource(R.string.code_from_opencode), machine.instanceName, session.directory.trimEnd('/').substringAfterLast('/').ifBlank { null }).joinToString(" · "), style = Dot.type.caption, color = Dot.colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                Hairline(inset = DotSpacing.gutter)
            }
        }
        item(key = "instances") {
            Text(
                stringResource(R.string.code_manage_instances), style = Dot.type.callout, color = Dot.colors.textSecondary,
                modifier = Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.l).clickable(role = Role.Button, onClick = onOpenInstances),
            )
        }
    }
}

/** #69: the title as typed becomes the session's name; blank or over-long titles are refused before any request. */
internal fun cleanSessionTitle(raw: String): String? = raw.replace(Regex("\\s+"), " ").trim().takeIf { it.isNotEmpty() && it.length <= 200 }

/** #69: small rename dialog (pre-filled, selected, Done on the keyboard validates); the new title arrives through the task event. */
@Composable
fun RenameSessionDialog(app: AppState, taskId: String, current: String, onDismiss: () -> Unit) {
    var value by remember(taskId) { mutableStateOf(androidx.compose.ui.text.input.TextFieldValue(current, androidx.compose.ui.text.TextRange(0, current.length))) }
    var failed by remember { mutableStateOf<String?>(null) }
    val clean = cleanSessionTitle(value.text)
    val submit = { if (clean != null) { if (clean == current) onDismiss() else app.run { try { app.client.renameCodeSession(taskId, clean); onDismiss() } catch (e: Exception) { if (e is kotlinx.coroutines.CancellationException) throw e; failed = e.message ?: "" } } } }
    DotDialog(
        title = stringResource(R.string.code_rename_title), onDismiss = onDismiss, confirmLabel = stringResource(R.string.rename), onConfirm = { submit() }, dismissLabel = stringResource(R.string.cancel),
    ) {
        DotTextField(
            value.text, { value = value.copy(text = it.take(220)) }, label = stringResource(R.string.code_rename_label),
            imeAction = androidx.compose.ui.text.input.ImeAction.Done, onImeAction = { submit() },
            isError = failed != null || (value.text.isNotBlank() && clean == null), supporting = failed,
        )
    }
}

@Composable
@OptIn(ExperimentalFoundationApi::class)
private fun CodeSessionRow(app: AppState, task: BgTask, ui: AppUiState, onOpen: () -> Unit) {
    val c = Dot.colors
    var renaming by remember { mutableStateOf(false) }
    if (renaming) RenameSessionDialog(app, task.id, task.title.ifBlank { task.instruction }) { renaming = false }
    val circle = if (task.requestedBy == "agent") ui.agents.firstOrNull { it.id == task.agentId } else null
    val by = when {
        circle != null -> stringResource(R.string.code_by, agentDisplayName(circle))
        task.requestedBy == "user" -> stringResource(R.string.code_by_you)
        task.requestedBy == "opencode" -> stringResource(R.string.code_from_opencode)
        else -> stringResource(R.string.code_by_chat)
    }
    val changes = task.external?.changes?.takeIf { it.files > 0 && (it.additions > 0 || it.deletions > 0) }
    Row(
        Modifier.fillMaxWidth().heightIn(min = 64.dp).combinedClickable(role = Role.Button, onLongClickLabel = stringResource(R.string.code_rename_title), onLongClick = { renaming = true }, onClick = onOpen).padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.m).testTag("code-session"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        OpencodeLogo(width = 18.dp)
        Spacer(Modifier.width(DotSpacing.l))
        Column(Modifier.weight(1f)) {
            Text(task.title.ifBlank { task.instruction }, style = Dot.type.body, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 2.dp)) {
                if (circle != null) { CompanionOrb(circle, size = 14.dp); Spacer(Modifier.width(DotSpacing.xs)) }
                Text(
                    listOfNotNull(by, task.external?.project, taskStatusLabel(task.status), formatWhen(task.createdAt).ifBlank { null }).joinToString(" · "),
                    style = Dot.type.caption, color = c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (changes != null) {
            Spacer(Modifier.width(DotSpacing.s))
            Text("+${changes.additions}", style = Dot.type.caption, color = c.success)
            Text(" −${changes.deletions}", style = Dot.type.caption, color = c.danger)
        }
    }
}
