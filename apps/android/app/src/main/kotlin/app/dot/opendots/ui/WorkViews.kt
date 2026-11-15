package app.dot.opendots.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.InsertDriveFile
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.Cancel
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.HourglassEmpty
import androidx.compose.material.icons.outlined.PauseCircle
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.dot.design.Dot
import app.dot.design.DotShapes
import androidx.compose.foundation.border
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.automirrored.outlined.CallMade
import androidx.compose.foundation.clickable
import app.dot.design.DotSpacing
import app.dot.design.components.ButtonStyle
import app.dot.design.components.DotBottomSheet
import app.dot.design.components.DotButton
import app.dot.design.components.DotCard
import app.dot.design.components.DotDialog
import app.dot.design.components.DotSpinner
import app.dot.design.components.DotTextField
import app.dot.design.components.EmptyState
import app.dot.design.components.Hairline
import app.dot.design.components.SectionLabel
import app.dot.opendots.AppState
import app.dot.opendots.AppUiState
import app.dot.opendots.R
import app.dot.opendots.data.Agent
import app.dot.opendots.data.Artifact
import app.dot.opendots.data.ArtifactAccess
import app.dot.opendots.data.ArtifactDetails
import app.dot.opendots.data.BgTask
import app.dot.opendots.data.Part
import app.dot.opendots.data.artifactIdFromUrl
import app.dot.opendots.data.fetchToCache
import app.dot.opendots.data.fileKind
import app.dot.opendots.data.formatBytes
import app.dot.opendots.data.saveTo
import app.dot.opendots.data.viewIntent
import kotlinx.coroutines.launch

// --- Files ----------------------------------------------------------------------------------------

/** What a file card can do. One object per screen, so cards stay stable. */
@Immutable
class FileActions(
    val open: (Part.File) -> Unit,
    val save: (Part.File) -> Unit,
    val sizeOf: suspend (String) -> Long?,
    /** The file downloaded to the app's cache, with the session, for the preview. */
    val fetch: suspend (Part.File) -> java.io.File = { error("unavailable") },
    /** Absolute address of a server path, for thumbnails loaded with the session. */
    val resolve: (String) -> String = { it },
)

/** Opening hands the file to another app; saving copies it, unchanged, where the user chooses. */
@Composable
fun rememberFileActions(app: AppState): FileActions {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val failed = stringResource(R.string.file_failed)
    val saved = stringResource(R.string.file_saved)
    val noApp = stringResource(R.string.file_no_app)
    var saving by remember { mutableStateOf<Part.File?>(null) }
    val saver = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { destination ->
        val file = saving
        saving = null
        if (destination != null && file != null) scope.launch {
            runCatching { saveTo(context, app.client, file, destination) }.onSuccess { app.notify(saved) }.onFailure { app.notify(it.message?.ifBlank { null } ?: failed) }
        }
    }
    return remember(app) {
        FileActions(
            open = { file ->
                scope.launch {
                    runCatching { fetchToCache(context, app.client, file) }
                        .onSuccess { local -> runCatching { context.startActivity(viewIntent(context, local, file.mediaType)) }.onFailure { app.notify(noApp) } }
                        .onFailure { app.notify(it.message?.ifBlank { null } ?: failed) }
                }
            },
            save = { file -> saving = file; runCatching { saver.launch(file.filename ?: "file") }.onFailure { saving = null; app.notify(failed) } },
            sizeOf = { id -> runCatching { app.client.artifact(id).size }.getOrNull() },
            fetch = { file -> fetchToCache(context, app.client, file) },
            resolve = app.client::resolve,
        )
    }
}

/** A file of the thread: one compact line (format, name, size), then Preview and Save; access in its menu. */
@Composable
fun FileCard(file: Part.File, actions: FileActions?, modifier: Modifier = Modifier, size: Long? = null, caption: String? = null, onAccess: ((String) -> Unit)? = null) {
    FileGroup(listOf(file), actions, modifier, listOf(size), listOf(caption), onAccess)
}

private fun Artifact.asPart() = Part.File(url, mediaType, name)

/** Who may read a file, who handed it to whom, and what was done with it. Access is given and withdrawn here. */
@Composable
fun ArtifactSheet(app: AppState, ui: AppUiState, artifactId: String, onDismiss: () -> Unit) {
    val c = Dot.colors
    var data by remember(artifactId) { mutableStateOf<ArtifactDetails?>(null) }
    var error by remember(artifactId) { mutableStateOf<String?>(null) }
    var deleting by remember { mutableStateOf(false) }
    val failed = stringResource(R.string.generic_error)
    LaunchedEffect(artifactId) { runCatching { app.client.artifact(artifactId) }.onSuccess { data = it }.onFailure { error = it.message?.ifBlank { null } ?: failed } }
    val you = stringResource(R.string.you)
    val someone = stringResource(R.string.a_companion)
    val worker = stringResource(R.string.a_worker)
    fun who(actor: String?): String = when {
        actor.isNullOrBlank() || actor == "user" -> you
        else -> ui.agents.firstOrNull { it.id == actor }?.let { if (it.named) it.name else null } ?: if (actor.startsWith("task")) worker else someone
    }
    val artifact = data
    val loadError = error
    DotBottomSheet(onDismiss) {
        Text(artifact?.name ?: stringResource(R.string.file), style = Dot.type.title, color = c.textPrimary, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = DotSpacing.gutter).padding(top = DotSpacing.s).semantics { heading() })
        when {
            loadError != null -> Text(loadError, style = Dot.type.callout, color = c.danger, modifier = Modifier.padding(DotSpacing.gutter))
            artifact == null -> Box(Modifier.fillMaxWidth().padding(DotSpacing.xxxl), contentAlignment = Alignment.Center) { DotSpinner(size = 24.dp) }
            else -> {
                Text(
                    listOf(formatBytes(artifact.size), stringResource(R.string.file_added_by, who(if (artifact.authorKind == "user") "user" else artifact.authorId)), formatWhen(artifact.createdAt)).filter { it.isNotBlank() }.joinToString(" · "),
                    style = Dot.type.caption, color = c.textSecondary, modifier = Modifier.padding(horizontal = DotSpacing.gutter),
                )
                val granted = artifact.grants.filter { it.revokedAt == null }
                val others = ui.agents.filter { agent -> granted.none { it.agentId == agent.id } }
                fun apply(block: suspend () -> app.dot.opendots.data.ArtifactHistory) = app.run { val history = block(); data = data?.copy(grants = history.grants, access = history.access) }
                LazyColumn(contentPadding = PaddingValues(bottom = DotSpacing.xxl)) {
                    item { SectionLabel(stringResource(R.string.file_grants), Modifier.padding(top = DotSpacing.l)) }
                    if (granted.isEmpty()) item { Text(stringResource(R.string.file_no_grants), style = Dot.type.callout, color = c.textSecondary, modifier = Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.s)) }
                    items(granted, key = { "g-" + it.agentId }) { grant ->
                        val agent = ui.agents.firstOrNull { it.id == grant.agentId }
                        Row(Modifier.fillMaxWidth().padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.s).testTag("file-grant"), verticalAlignment = Alignment.CenterVertically) {
                            if (agent != null) { CompanionOrb(agent, size = 22.dp); Spacer(Modifier.width(DotSpacing.m)) }
                            Column(Modifier.weight(1f)) {
                                Text(agent?.let { agentDisplayName(it) } ?: someone, style = Dot.type.bodyStrong, color = c.textPrimary)
                                Text(stringResource(R.string.file_granted_by, who(grant.grantedBy)) + " · " + formatWhen(grant.createdAt), style = Dot.type.caption, color = c.textSecondary)
                            }
                            DotButton(stringResource(R.string.file_revoke), { apply { app.client.revokeArtifact(artifactId, grant.agentId) } }, style = ButtonStyle.Ghost, compact = true)
                        }
                    }
                    if (others.isNotEmpty()) item {
                        @OptIn(ExperimentalLayoutApi::class)
                        FlowRow(Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.s), horizontalArrangement = Arrangement.spacedBy(DotSpacing.s), verticalArrangement = Arrangement.spacedBy(DotSpacing.s)) {
                            others.forEach { agent -> DotButton(stringResource(R.string.file_give_to, agentDisplayName(agent)), { apply { app.client.grantArtifact(artifactId, agent.id) } }, style = ButtonStyle.Secondary, compact = true) }
                        }
                    }
                    item { Hairline(); SectionLabel(stringResource(R.string.file_history), Modifier.padding(top = DotSpacing.l)) }
                    items(artifact.access.size) { index ->
                        val entry = artifact.access[index]
                        Column(Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.xs)) {
                            Text(who(entry.actor) + " — " + accessLabel(entry) + accessTarget(entry, ui.agents), style = Dot.type.callout, color = c.textPrimary)
                            Text(formatWhen(entry.createdAt), style = Dot.type.caption, color = c.textTertiary)
                        }
                    }
                    item {
                        Box(Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.l)) {
                            DotButton(stringResource(R.string.file_delete), { deleting = true }, style = ButtonStyle.Danger, compact = true)
                        }
                    }
                }
            }
        }
    }
    if (deleting) DotDialog(
        title = stringResource(R.string.file_delete), message = data?.name.orEmpty(),
        confirmLabel = stringResource(R.string.delete), dismissLabel = stringResource(R.string.cancel),
        onConfirm = { deleting = false; app.run { app.client.deleteArtifact(artifactId); onDismiss() } }, onDismiss = { deleting = false }, destructive = true,
    )
}

@Composable
private fun accessLabel(entry: ArtifactAccess): String = stringResource(
    when (entry.action) {
        "create" -> R.string.access_create
        "read" -> R.string.access_read
        "download" -> R.string.access_download
        "share" -> R.string.access_share
        "revoke" -> R.string.access_revoke
        "publish" -> R.string.access_publish
        "delete" -> R.string.access_delete
        else -> R.string.access_denied
    },
)

private fun accessTarget(entry: ArtifactAccess, agents: List<Agent>): String {
    if (entry.action != "share" && entry.action != "revoke") return ""
    val agent = agents.firstOrNull { entry.detail?.contains(it.id) == true } ?: return ""
    return " → " + agent.name
}

/** The files a companion may read, or those exchanged in a general chat. */
@Composable
fun FilesSheet(app: AppState, ui: AppUiState, title: String, agentId: String?, conversationId: String?, onDismiss: () -> Unit) {
    var files by remember { mutableStateOf<List<Artifact>?>(null) }
    var access by remember { mutableStateOf<String?>(null) }
    val actions = rememberFileActions(app)
    LaunchedEffect(agentId, conversationId, access) { if (access == null) runCatching { app.client.artifacts(agentId, conversationId) }.onSuccess { files = it }.onFailure { files = emptyList() } }
    val list = files
    DotBottomSheet(onDismiss) {
        Text(title, style = Dot.type.title, color = Dot.colors.textPrimary, modifier = Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.s).semantics { heading() })
        when {
            list == null -> Box(Modifier.fillMaxWidth().padding(DotSpacing.xxxl), contentAlignment = Alignment.Center) { DotSpinner(size = 24.dp) }
            list.isEmpty() -> EmptyState(Icons.AutoMirrored.Outlined.InsertDriveFile, stringResource(R.string.files_empty_title), stringResource(R.string.files_empty_body))
            else -> LazyColumn(contentPadding = PaddingValues(start = DotSpacing.gutter, end = DotSpacing.gutter, bottom = DotSpacing.xxl), verticalArrangement = Arrangement.spacedBy(DotSpacing.s)) {
                items(list, key = { it.id }) { file -> FileCard(file.asPart(), actions, size = file.size, onAccess = { access = it }) }
            }
        }
    }
    access?.let { id -> ArtifactSheet(app, ui, id) { access = null } }
}

// --- Background tasks -----------------------------------------------------------------------------

@Composable
fun taskStatusLabel(status: String): String = stringResource(
    when (status) {
        "queued" -> R.string.task_queued
        "running" -> R.string.task_running
        "waiting_for_user" -> R.string.task_waiting
        "paused" -> R.string.task_paused
        "completed" -> R.string.task_completed
        "cancelled" -> R.string.task_cancelled
        else -> R.string.task_failed
    },
)

private fun taskIcon(status: String): ImageVector = when (status) {
    "running" -> Icons.Outlined.Sync
    "queued" -> Icons.Outlined.HourglassEmpty
    "paused" -> Icons.Outlined.PauseCircle
    "completed" -> Icons.Outlined.CheckCircle
    "cancelled" -> Icons.Outlined.Cancel
    else -> Icons.Outlined.ErrorOutline
}

/**
 * One card per task, updated in place: status, the step in progress, how many actions really ran, then Details /
 * Pause / Cancel. [agent] signs a companion's contribution to a general chat.
 */
@Composable
fun TaskCard(task: BgTask?, onDetails: () -> Unit, onAction: (String) -> Unit, modifier: Modifier = Modifier, agent: Agent? = null, onOpenCode: ((String) -> Unit)? = null) {
    if (task != null && task.isCode && onOpenCode != null) { CodeResultCard(task, { onOpenCode(task.id) }, modifier); return }
    val c = Dot.colors
    var cancelling by remember { mutableStateOf(false) }
    DotCard(modifier.fillMaxWidth().testTag("task-card"), emphasized = task?.status == "waiting_for_user") {
        if (task == null) { Text(stringResource(R.string.task_loading), style = Dot.type.callout, color = c.textSecondary); return@DotCard }
        if (agent != null) Row(Modifier.padding(bottom = DotSpacing.s), verticalAlignment = Alignment.CenterVertically) {
            CompanionOrb(agent, size = 16.dp)
            Spacer(Modifier.width(DotSpacing.s))
            Text(agentDisplayName(agent), style = Dot.type.label, color = c.textPrimary)
            Text("  ·  " + stringResource(R.string.intervention), style = Dot.type.caption, color = c.textTertiary)
        }
        if (task.isCode) Row(Modifier.padding(bottom = DotSpacing.s).testTag("task-opencode"), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.Terminal, null, Modifier.size(15.dp), tint = c.textSecondary)
            Spacer(Modifier.width(DotSpacing.s))
            Text("OpenCode", style = Dot.type.label, color = c.textPrimary)
            task.external?.let { Text("  ·  " + listOfNotNull(it.instanceName, it.project).joinToString(" · "), style = Dot.type.caption, color = c.textTertiary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false)) }
            if (task.external?.unreachable == true) Text("  ·  " + stringResource(R.string.code_unknown), style = Dot.type.caption, color = c.danger, maxLines = 1)
        }
        val alert = task.status == "failed" || task.status == "waiting_for_user"
        Row(verticalAlignment = Alignment.Top) {
            Icon(taskIcon(task.status), null, Modifier.padding(top = 2.dp).size(18.dp), tint = if (alert) c.danger else if (task.status == "completed") c.success else c.textSecondary)
            Spacer(Modifier.width(DotSpacing.m))
            Column(Modifier.weight(1f)) {
                Text(task.title, style = Dot.type.bodyStrong, color = c.textPrimary, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(
                    taskStatusLabel(task.status) + (if (task.completedSteps > 0) "  ·  " + pluralStringResource(R.plurals.actions, task.completedSteps, task.completedSteps) else "") +
                        // The model that really served the task (or the one asked, before it ran).
                        ((task.usedModel ?: task.model?.model)?.let { "  ·  " + it.substringAfterLast(':').substringAfterLast('/') } ?: ""),
                    style = Dot.type.caption, color = c.textSecondary,
                )
            }
        }
        task.line?.takeIf { it.isNotBlank() }?.let {
            Spacer(Modifier.height(DotSpacing.s))
            Text(it, style = Dot.type.callout, color = if (alert) c.danger else c.textSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.height(DotSpacing.m))
        @OptIn(ExperimentalLayoutApi::class)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(DotSpacing.s), verticalArrangement = Arrangement.spacedBy(DotSpacing.s)) {
            if (task.isCode && onOpenCode != null) DotButton(stringResource(R.string.code_open), { onOpenCode(task.id) }, compact = true)
            DotButton(stringResource(R.string.details), onDetails, style = ButtonStyle.Secondary, compact = true)
            // OpenCode has no pause: a session is stopped or given an instruction.
            if (!task.isCode && (task.status == "running" || task.status == "queued")) DotButton(stringResource(R.string.task_pause), { onAction("pause") }, style = ButtonStyle.Ghost, compact = true)
            if (!task.isCode && (task.status == "paused" || task.status == "waiting_for_user")) DotButton(stringResource(R.string.task_resume), { onAction("resume") }, style = ButtonStyle.Ghost, compact = true)
            if (task.active) DotButton(stringResource(if (task.isCode) R.string.code_stop else R.string.cancel), { cancelling = true }, style = ButtonStyle.Ghost, compact = true)
        }
    }
    if (cancelling && task != null) DotDialog(
        title = stringResource(R.string.task_cancel_title), message = task.title,
        confirmLabel = stringResource(R.string.task_cancel_confirm), dismissLabel = stringResource(R.string.back),
        onConfirm = { cancelling = false; onAction("cancel") }, onDismiss = { cancelling = false }, destructive = true,
    )
}

/**
 * A coding task in a conversation: one card, updated in place, that opens that exact OpenCode session. The title, the
 * real state, and what the session really changed (read from its diff), nothing else; details live in the session.
 */
@Composable
fun CodeResultCard(task: BgTask, onOpen: () -> Unit, modifier: Modifier = Modifier) {
    val c = Dot.colors
    val changes = task.external?.changes
    val disconnected = task.external?.unreachable == true && task.active
    val status = if (disconnected) stringResource(R.string.code_state_disconnected) else stringResource(when (task.status) {
        "queued" -> R.string.code_state_queued; "running" -> R.string.code_state_running; "waiting_for_user" -> R.string.code_state_permission
        "paused" -> R.string.code_state_paused; "completed" -> R.string.code_state_done; "failed" -> R.string.code_state_failed; else -> R.string.code_state_stopped
    })
    val activity = if (task.status == "running" && !disconnected) task.currentActionSummary else if (task.status == "failed") task.error else null
    val noChange = changes != null && changes.files == 0 && task.status == "completed"
    val alert = task.status == "failed" || task.status == "waiting_for_user"
    val label = listOfNotNull(
        stringResource(R.string.code_open_session), task.title, status,
        if (changes != null && changes.files > 0) pluralStringResource(R.plurals.code_changes_spoken, changes.files, changes.files, changes.additions, changes.deletions) else if (noChange) stringResource(R.string.code_no_file_changed) else null,
    ).joinToString(", ")
    Column(
        modifier.fillMaxWidth().clip(DotShapes.large).background(c.surface).border(DotSpacing.hairline * 2, c.border, DotShapes.large)
            .clickable(role = Role.Button, onClick = onOpen).semantics(mergeDescendants = true) { contentDescription = label }
            .padding(horizontal = DotSpacing.m, vertical = DotSpacing.m).testTag("task-card"),
    ) {
        Row(verticalAlignment = Alignment.Top) {
            OpencodeLogo(Modifier.padding(top = 2.dp).testTag("opencode-logo"), width = 20.dp)
            Spacer(Modifier.width(DotSpacing.m))
            Column(Modifier.weight(1f)) {
                Text(task.title, style = Dot.type.bodyStrong, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (task.status == "completed") { Icon(Icons.Outlined.Check, null, Modifier.size(13.dp), tint = c.textSecondary); Spacer(Modifier.width(3.dp)) }
                    else if (task.status == "running" && !disconnected) { DotSpinner(size = 11.dp); Spacer(Modifier.width(DotSpacing.xs)) }
                    Text("$status · OpenCode", style = Dot.type.caption, color = if (alert) c.danger else c.textSecondary, maxLines = 1)
                }
                activity?.takeIf { it.isNotBlank() }?.let { Text(it, style = Dot.type.caption, color = c.textTertiary, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                if (noChange) Text(stringResource(R.string.code_no_file_changed), style = Dot.type.caption, color = c.textTertiary)
            }
            Spacer(Modifier.width(DotSpacing.s))
            Icon(Icons.AutoMirrored.Outlined.CallMade, null, Modifier.size(18.dp), tint = c.textTertiary)
        }
        if (changes != null && changes.files > 0) {
            Box(Modifier.padding(top = DotSpacing.s).fillMaxWidth().height(DotSpacing.hairline).background(c.border))
            Row(Modifier.padding(top = DotSpacing.s, start = 20.dp + DotSpacing.m).testTag("code-changes-stats"), horizontalArrangement = Arrangement.spacedBy(DotSpacing.l)) {
                Text(pluralStringResource(R.plurals.code_files, changes.files, changes.files), style = Dot.type.caption, color = c.textSecondary)
                Text("+${changes.additions}", style = Dot.type.caption, color = c.success)
                Text("−${changes.deletions}", style = Dot.type.caption, color = c.danger)
            }
        }
    }
}

/** "Details" of a task: its instruction, observed state, the journal of its steps, the files it produced. */
@Composable
fun TaskSheet(app: AppState, ui: AppUiState, taskId: String, onDismiss: () -> Unit) {
    val c = Dot.colors
    val task = ui.tasks[taskId]
    // The journal is re-read whenever the task moves.
    LaunchedEffect(taskId, task?.status, task?.completedSteps) { app.loadTask(taskId) }
    val actions = rememberFileActions(app)
    var instruction by rememberSaveable(taskId) { mutableStateOf("") }
    var access by remember { mutableStateOf<String?>(null) }
    val sent = stringResource(R.string.task_instruction_sent)
    DotBottomSheet(onDismiss) {
        if (task == null) { Box(Modifier.fillMaxWidth().padding(DotSpacing.xxxl), contentAlignment = Alignment.Center) { DotSpinner(size = 24.dp) }; return@DotBottomSheet }
        val agent = ui.agents.firstOrNull { it.id == task.agentId }
        Text(task.title, style = Dot.type.title, color = c.textPrimary, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = DotSpacing.gutter).padding(top = DotSpacing.s).semantics { heading() })
        Text(
            listOfNotNull(agent?.let { agentDisplayName(it) }, taskStatusLabel(task.status), if (task.completedSteps > 0) pluralStringResource(R.plurals.actions, task.completedSteps, task.completedSteps) else null, formatWhen(task.createdAt).ifBlank { null }).joinToString(" · "),
            style = Dot.type.caption, color = c.textSecondary, modifier = Modifier.padding(horizontal = DotSpacing.gutter),
        )
        LazyColumn(Modifier.weight(1f, fill = false), contentPadding = PaddingValues(bottom = DotSpacing.l)) {
            item {
                SectionLabel(stringResource(R.string.task_instruction), Modifier.padding(top = DotSpacing.l))
                Text(task.instruction, style = Dot.type.callout, color = c.textPrimary, modifier = Modifier.padding(horizontal = DotSpacing.gutter))
            }
            (task.error ?: task.blocker)?.takeIf { it.isNotBlank() }?.let { problem ->
                item {
                    SectionLabel(stringResource(if (task.error != null) R.string.task_failure else R.string.task_blocker), Modifier.padding(top = DotSpacing.l))
                    Text(problem, style = Dot.type.callout, color = c.danger, modifier = Modifier.padding(horizontal = DotSpacing.gutter))
                }
            }
            task.result?.takeIf { it.isNotBlank() }?.let { result ->
                item {
                    SectionLabel(stringResource(R.string.task_result), Modifier.padding(top = DotSpacing.l))
                    Text(result, style = Dot.type.callout, color = c.textPrimary, modifier = Modifier.padding(horizontal = DotSpacing.gutter))
                }
            }
            if (task.artifacts.isNotEmpty()) {
                item { SectionLabel(stringResource(R.string.task_files), Modifier.padding(top = DotSpacing.l)) }
                items(task.artifacts, key = { "f-" + it.id }) { file -> FileCard(file.asPart(), actions, Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.xs), size = file.size, onAccess = { access = it }) }
            }
            item { SectionLabel(stringResource(R.string.task_journal), Modifier.padding(top = DotSpacing.l)) }
            if (task.events.isEmpty()) item { Text(stringResource(R.string.task_no_steps), style = Dot.type.callout, color = c.textSecondary, modifier = Modifier.padding(horizontal = DotSpacing.gutter)) }
            items(task.events, key = { "e-" + it.seq }) { event ->
                Column(Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.xs).testTag("task-event")) {
                    Text(
                        if (event.kind == "instruction") stringResource(R.string.task_instruction) + " : " + event.summary else event.summary,
                        style = Dot.type.callout, color = if (event.kind == "error") c.danger else if (event.kind == "step") c.textPrimary else c.textSecondary,
                    )
                    Text(formatWhen(event.createdAt), style = Dot.type.caption, color = c.textTertiary)
                }
            }
        }
        if (task.active) {
            Hairline()
            Row(Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.m), verticalAlignment = Alignment.Bottom) {
                val send = { if (instruction.isNotBlank()) app.taskInstruction(taskId, instruction.trim().take(2000)) { instruction = ""; app.notify(sent) } }
                DotTextField(instruction, { instruction = it.take(2000) }, Modifier.weight(1f), placeholder = stringResource(R.string.task_instruction_hint), imeAction = ImeAction.Send, onImeAction = send)
                Spacer(Modifier.width(DotSpacing.m))
                DotButton(stringResource(R.string.send), send, enabled = instruction.isNotBlank(), compact = true)
            }
        }
        Spacer(Modifier.height(DotSpacing.l))
    }
    access?.let { id -> ArtifactSheet(app, ui, id) { access = null } }
}
