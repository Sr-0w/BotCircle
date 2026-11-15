package app.dot.opendots.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.InsertDriveFile
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.dot.design.Dot
import app.dot.design.DotShapes
import app.dot.design.DotSpacing
import app.dot.design.components.BackButton
import app.dot.design.components.ButtonStyle
import app.dot.design.components.DotButton
import app.dot.design.components.DotCard
import app.dot.design.components.DotComposer
import app.dot.design.components.DotDialog
import app.dot.design.components.DotFilterChip
import app.dot.design.components.DotMarkdown
import app.dot.design.components.DotSpinner
import app.dot.design.components.DotTextField
import app.dot.design.components.DotDisclosure
import app.dot.design.components.EmptyState
import app.dot.design.components.Hairline
import app.dot.opendots.AppState
import app.dot.opendots.AppUiState
import app.dot.opendots.R
import app.dot.opendots.data.CodeDiff
import app.dot.opendots.data.CodeFile
import app.dot.opendots.data.CodeFileNode
import app.dot.opendots.data.CodeMessage
import app.dot.opendots.data.CodePart
import app.dot.opendots.data.CodeQuestion
import app.dot.opendots.data.CodeWorkspace
import app.dot.opendots.data.OpencodeInstance
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The account's OpenCode instances: development machines running `opencode serve`. The address and password are typed
 * here, never in a conversation; the password is sent once and never shown back.
 */
@Composable
fun OpencodeInstancesPage(app: AppState, onBack: () -> Unit) {
    var instances by remember { mutableStateOf<List<OpencodeInstance>?>(null) }
    var revision by remember { mutableIntStateOf(0) }
    var editing by remember { mutableStateOf<OpencodeInstance?>(null) }
    var adding by remember { mutableStateOf(false) }
    var removing by remember { mutableStateOf<OpencodeInstance?>(null) }
    var pairing by remember { mutableStateOf(false) }
    LaunchedEffect(revision) { runCatching { app.client.opencodeInstances() }.onSuccess { instances = it }.onFailure { instances = emptyList(); app.notify(it.message?.ifBlank { null } ?: AppState.FAILED) } }
    QuietPage("OpenCode", onBack, subtitle = stringResource(R.string.code_instances_note)) {
        val list = instances
        when {
            list == null -> item { Box(Modifier.fillMaxWidth().padding(DotSpacing.xxxl), contentAlignment = Alignment.Center) { DotSpinner(size = 24.dp) } }
            list.isEmpty() && !adding && !pairing -> item { EmptyState(Icons.Outlined.Terminal, stringResource(R.string.code_no_instance), stringResource(R.string.code_expose_note)) }
            else -> items(list, key = { it.id }) { instance ->
                val c = Dot.colors
                DotCard(Modifier.fillMaxWidth().padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.xs).testTag("instance-${instance.state}")) {
                    Row(verticalAlignment = Alignment.Top) {
                        Column(Modifier.weight(1f)) {
                            Text(instance.name, style = Dot.type.headline, color = c.textPrimary)
                            Text(listOfNotNull(instance.baseUrl, instance.defaultDirectory).joinToString(" · "), style = Dot.type.caption.copy(fontFamily = FontFamily.Monospace), color = c.textTertiary, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                        Box(Modifier.padding(top = 6.dp).size(6.dp).clip(DotShapes.circle).background(if (instance.state == "online") c.success else if (instance.state == "offline") c.danger else c.textTertiary))
                        Spacer(Modifier.width(DotSpacing.s))
                        Text(stringResource(when (instance.state) { "online" -> R.string.code_online; "offline" -> R.string.code_offline; else -> R.string.code_never_checked }), style = Dot.type.caption, color = if (instance.state == "offline") c.danger else c.textSecondary)
                    }
                    Text(
                        if (instance.state == "offline") instance.lastError.orEmpty() else listOfNotNull(
                            instance.version?.let { "OpenCode $it" },
                            if (instance.activeTasks > 0) pluralStringResource(R.plurals.code_active, instance.activeTasks, instance.activeTasks) else null,
                            if (instance.authKind == "pairing") instance.tokenExpiresAt?.let { stringResource(R.string.code_paired_until, formatWhen(it).substringBefore(",")) } ?: stringResource(R.string.code_paired) else null,
                        ).joinToString(" · "),
                        style = Dot.type.caption, color = if (instance.state == "offline") c.danger else c.textSecondary, modifier = Modifier.padding(top = DotSpacing.xs),
                    )
                    Spacer(Modifier.height(DotSpacing.m))
                    Row(horizontalArrangement = Arrangement.spacedBy(DotSpacing.s)) {
                        DotButton(stringResource(R.string.code_check), { app.run { app.client.checkOpencodeInstance(instance.id); revision++ } }, style = ButtonStyle.Secondary, compact = true)
                        DotButton(stringResource(R.string.code_edit), { editing = instance; adding = false }, style = ButtonStyle.Ghost, compact = true)
                        DotButton(stringResource(R.string.file_revoke), { removing = instance }, style = ButtonStyle.Ghost, compact = true)
                    }
                }
            }
        }
        if (pairing) item(key = "pair") {
            PairForm(app, onCancel = { pairing = false }) { pairing = false; revision++ }
        } else if (adding || editing != null) item(key = "form") {
            InstanceForm(editing, onCancel = { adding = false; editing = null }) { body -> app.run { app.client.saveOpencodeInstance(editing?.id, body); adding = false; editing = null; revision++ } }
        } else item(key = "add") {
            Row(Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.l), horizontalArrangement = Arrangement.spacedBy(DotSpacing.s)) {
                DotButton(stringResource(R.string.code_pair), { pairing = true })
                DotButton(stringResource(R.string.code_add_manual), { adding = true }, style = ButtonStyle.Secondary)
            }
        }
        item(key = "help") { Text(stringResource(R.string.code_expose_note), style = Dot.type.caption, color = Dot.colors.textTertiary, modifier = Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.s)) }
    }
    removing?.let { instance ->
        DotDialog(
            title = stringResource(R.string.code_remove_title), message = instance.name + "\n" + stringResource(R.string.code_remove_note),
            confirmLabel = stringResource(R.string.file_revoke), dismissLabel = stringResource(R.string.cancel),
            onConfirm = { removing = null; app.run { app.client.deleteOpencodeInstance(instance.id); revision++ } }, onDismiss = { removing = null }, destructive = true,
        )
    }
}

/**
 * Pairing with the one-time link of `opencode pair --remote`: pasted, or read from its QR code with the system scanner
 * (Google Play services, no camera permission for the app). Scanning it with the phone's own camera app would open
 * it in a browser and use it up.
 */
@Composable
private fun PairForm(app: AppState, onCancel: () -> Unit, onPaired: () -> Unit) {
    val context = LocalContext.current
    var link by rememberSaveable { mutableStateOf("") }
    var directory by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val failed = stringResource(R.string.generic_error)
    val noScanner = stringResource(R.string.code_scan_unavailable)
    val pairedLabel = stringResource(R.string.code_paired)
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    fun pair(value: String) {
        if (value.isBlank() || busy) return
        busy = true; error = null
        scope.launch {
            runCatching { app.client.pairOpencode(value, directory) }
                .onSuccess { app.notify("${it.name} · $pairedLabel"); onPaired() }
                .onFailure { error = it.message?.ifBlank { null } ?: failed }
            busy = false
        }
    }
    Column(Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.m).testTag("pair-form"), verticalArrangement = Arrangement.spacedBy(DotSpacing.m)) {
        Text(stringResource(R.string.code_pair_note), style = Dot.type.callout, color = Dot.colors.textSecondary)
        DotButton(stringResource(R.string.code_scan), {
            runCatching {
                com.google.mlkit.vision.codescanner.GmsBarcodeScanning.getClient(
                    context, com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions.Builder().setBarcodeFormats(com.google.mlkit.vision.barcode.common.Barcode.FORMAT_QR_CODE).build(),
                ).startScan()
                    .addOnSuccessListener { code -> code.rawValue?.trim()?.let { link = it; pair(it) } }
                    .addOnFailureListener { error = noScanner }
            }.onFailure { error = noScanner }
        }, style = ButtonStyle.Secondary)
        DotTextField(link, { link = it.trim(); error = null }, Modifier.fillMaxWidth(), label = stringResource(R.string.code_link), placeholder = "https://….opentunnel.xyz/auth/connect/…", keyboardType = KeyboardType.Uri)
        DotTextField(directory, { directory = it.trim() }, Modifier.fillMaxWidth(), label = stringResource(R.string.code_directory_optional), placeholder = "/home/me/projects/app", imeAction = ImeAction.Done)
        error?.let { Text(it, style = Dot.type.callout, color = Dot.colors.danger, modifier = Modifier.testTag("pair-error")) }
        Row(horizontalArrangement = Arrangement.spacedBy(DotSpacing.s)) {
            DotButton(stringResource(R.string.code_pair_button), { pair(link) }, enabled = link.isNotBlank() && !busy, loading = busy, compact = true)
            DotButton(stringResource(R.string.cancel), onCancel, style = ButtonStyle.Ghost, compact = true)
        }
    }
}

@Composable
private fun InstanceForm(existing: OpencodeInstance?, onCancel: () -> Unit, onSave: (kotlinx.serialization.json.JsonObject) -> Unit) {
    var name by rememberSaveable(existing?.id) { mutableStateOf(existing?.name.orEmpty()) }
    var url by rememberSaveable(existing?.id) { mutableStateOf(existing?.baseUrl.orEmpty()) }
    var user by rememberSaveable(existing?.id) { mutableStateOf(existing?.username ?: "opencode") }
    var password by rememberSaveable(existing?.id) { mutableStateOf("") }
    var directory by rememberSaveable(existing?.id) { mutableStateOf(existing?.defaultDirectory.orEmpty()) }
    Column(Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.m), verticalArrangement = Arrangement.spacedBy(DotSpacing.m)) {
        DotTextField(name, { name = it.take(60) }, Modifier.fillMaxWidth(), label = stringResource(R.string.name), placeholder = stringResource(R.string.code_name_hint))
        DotTextField(url, { url = it.trim() }, Modifier.fillMaxWidth(), label = stringResource(R.string.code_url), placeholder = "https://code.example.com", keyboardType = KeyboardType.Uri)
        DotTextField(user, { user = it.trim() }, Modifier.fillMaxWidth(), label = stringResource(R.string.code_user))
        DotTextField(password, { password = it }, Modifier.fillMaxWidth(), label = stringResource(R.string.password), placeholder = if (existing != null) stringResource(R.string.code_unchanged) else "OPENCODE_SERVER_PASSWORD", password = true, keyboardType = KeyboardType.Password)
        DotTextField(directory, { directory = it.trim() }, Modifier.fillMaxWidth(), label = stringResource(R.string.code_directory), placeholder = "/home/me/projects/app", imeAction = ImeAction.Done)
        Row(horizontalArrangement = Arrangement.spacedBy(DotSpacing.s)) {
            DotButton(stringResource(R.string.code_save), {
                onSave(buildJsonObject {
                    put("name", name.trim()); put("baseUrl", url); put("username", user.ifBlank { "opencode" })
                    if (directory.isBlank()) put("defaultDirectory", JsonNull) else put("defaultDirectory", directory)
                    // An empty password while editing means "unchanged".
                    if (password.isNotEmpty()) put("password", password)
                })
            }, enabled = name.isNotBlank() && url.isNotBlank(), compact = true)
            DotButton(stringResource(R.string.cancel), onCancel, style = ButtonStyle.Ghost, compact = true)
        }
    }
}

private enum class CodeTab { Session, Changes, Files, Exchanges }

/**
 * The code workspace of one OpenCode task, full screen: that exact session, live. Session (messages and tools), what
 * changed, the project's files, and the exchanges; a field to write to OpenCode directly, permission prompts, Stop.
 */
@Composable
fun CodeWorkspacePage(app: AppState, ui: AppUiState, taskId: String, onBack: () -> Unit) {
    val c = Dot.colors
    var data by remember(taskId) { mutableStateOf<CodeWorkspace?>(null) }
    var error by remember(taskId) { mutableStateOf<String?>(null) }
    var tab by rememberSaveable(taskId) { mutableStateOf(CodeTab.Session) }
    var draft by rememberSaveable(taskId) { mutableStateOf("") }
    var revision by remember { mutableIntStateOf(0) }
    // While OpenCode works, a message is folded into the current work (steer) or handled after it (queue).
    var delivery by rememberSaveable(taskId) { mutableStateOf("steer") }
    val live = ui.tasks[taskId]
    val failed = stringResource(R.string.generic_error)
    val queued = stringResource(R.string.code_queued)
    val steered = stringResource(R.string.code_steered)
    // While the session works the state is re-read; at rest only server events refresh it.
    LaunchedEffect(taskId, revision, live?.status, live?.completedSteps, live?.currentActionSummary) {
        runCatching { app.client.codeWorkspace(taskId) }.onSuccess { data = it; error = null }.onFailure { error = it.message?.ifBlank { null } ?: failed }
    }
    LaunchedEffect(taskId, data?.task?.active) { while (data?.task?.active != false) { delay(3000); revision++ } }
    val task = live ?: data?.task
    val listState = rememberLazyListState()
    val parts = data?.messages?.sumOf { it.parts.size } ?: 0
    LaunchedEffect(parts, tab) { if (tab == CodeTab.Session && parts > 0) listState.scrollToItem(Int.MAX_VALUE / 2) }

    Column(Modifier.fillMaxSize().background(c.background).testTag("code-workspace")) {
        Row(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.statusBars).padding(horizontal = DotSpacing.s, vertical = DotSpacing.xs), verticalAlignment = Alignment.CenterVertically) {
            BackButton(onBack)
            Column(Modifier.weight(1f).padding(horizontal = DotSpacing.s)) {
                Text(task?.title ?: stringResource(R.string.code_workspace), style = Dot.type.headline, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.semantics { heading() })
                Text(listOfNotNull("OpenCode", task?.external?.instanceName, task?.external?.directory).joinToString(" · "), style = Dot.type.caption, color = c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (task?.active == true) DotButton(stringResource(R.string.code_stop), { app.taskAction(taskId, "cancel"); revision++ }, style = ButtonStyle.Secondary, compact = true)
        }
        if (task != null) Text(
            listOfNotNull(taskStatusLabel(task.status), if (task.completedSteps > 0) pluralStringResource(R.plurals.actions, task.completedSteps, task.completedSteps) else null, task.blocker ?: task.currentActionSummary).joinToString(" · "),
            style = Dot.type.caption, color = if (task.status == "failed" || task.status == "waiting_for_user") c.danger else c.textSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(horizontal = DotSpacing.gutter).padding(bottom = DotSpacing.s).testTag("code-status"),
        )
        Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = DotSpacing.gutter).padding(bottom = DotSpacing.s), horizontalArrangement = Arrangement.spacedBy(DotSpacing.s)) {
            DotFilterChip(stringResource(R.string.code_tab_session), tab == CodeTab.Session, { tab = CodeTab.Session }, radio = true)
            DotFilterChip(stringResource(R.string.code_tab_changes) + (data?.diffs?.size?.takeIf { it > 0 }?.let { " · $it" } ?: ""), tab == CodeTab.Changes, { tab = CodeTab.Changes }, radio = true)
            DotFilterChip(stringResource(R.string.files), tab == CodeTab.Files, { tab = CodeTab.Files }, radio = true)
            DotFilterChip(stringResource(R.string.code_tab_exchanges), tab == CodeTab.Exchanges, { tab = CodeTab.Exchanges }, radio = true)
        }
        Hairline()
        val space = data
        if (space != null && !space.reachable) Row(Modifier.fillMaxWidth().background(c.surface).padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.s), verticalAlignment = Alignment.Top) {
            Icon(Icons.Outlined.CloudOff, null, Modifier.padding(top = 2.dp).size(14.dp), tint = c.textSecondary)
            Spacer(Modifier.width(DotSpacing.s))
            Text(stringResource(R.string.code_unreachable) + " " + space.error.orEmpty(), style = Dot.type.caption, color = c.textSecondary)
        }
        Box(Modifier.weight(1f)) {
            when {
                space == null && error != null -> Text(error.orEmpty(), style = Dot.type.callout, color = c.danger, modifier = Modifier.padding(DotSpacing.gutter))
                space == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { DotSpinner(size = 24.dp) }
                tab == CodeTab.Session -> LazyColumn(state = listState, contentPadding = PaddingValues(DotSpacing.gutter), verticalArrangement = Arrangement.spacedBy(DotSpacing.m)) {
                    if (space.messages.isEmpty()) item { Text(stringResource(if (space.reachable) R.string.code_no_message else R.string.code_cannot_read), style = Dot.type.callout, color = c.textSecondary) }
                    items(space.messages, key = { it.id }) { message -> CodeMessageView(message) }
                    items(space.permissions, key = { "p-" + it.id }) { request ->
                        DotCard(Modifier.fillMaxWidth().testTag("code-permission"), emphasized = true) {
                            Text(stringResource(R.string.code_permission), style = Dot.type.bodyStrong, color = c.textPrimary)
                            Text(listOf(request.permission, request.patterns.joinToString(", ")).filter { it.isNotBlank() }.joinToString(" · "), style = Dot.type.caption.copy(fontFamily = FontFamily.Monospace), color = c.textSecondary, modifier = Modifier.padding(vertical = DotSpacing.s))
                            @OptIn(ExperimentalLayoutApi::class)
                            FlowRow(horizontalArrangement = Arrangement.spacedBy(DotSpacing.s), verticalArrangement = Arrangement.spacedBy(DotSpacing.s)) {
                                DotButton(stringResource(R.string.code_allow_once), { app.run { app.client.codePermission(taskId, request.id, "once"); revision++ } }, compact = true)
                                DotButton(stringResource(R.string.code_allow_always), { app.run { app.client.codePermission(taskId, request.id, "always"); revision++ } }, style = ButtonStyle.Secondary, compact = true)
                                DotButton(stringResource(R.string.code_deny), { app.run { app.client.codePermission(taskId, request.id, "reject"); revision++ } }, style = ButtonStyle.Ghost, compact = true)
                            }
                        }
                    }
                    items(space.questions, key = { "q-" + it.id }) { request -> CodeQuestionCard(request) { answers -> app.run { app.client.codeQuestion(taskId, request.id, answers); revision++ } } }
                }
                tab == CodeTab.Changes -> LazyColumn(contentPadding = PaddingValues(DotSpacing.gutter), verticalArrangement = Arrangement.spacedBy(DotSpacing.s)) {
                    if (space.diffs.isEmpty()) item { Text(stringResource(if (space.reachable) R.string.code_no_change else R.string.code_cannot_read), style = Dot.type.callout, color = c.textSecondary) }
                    items(space.diffs, key = { it.path }) { diff -> CodeDiffView(diff) }
                }
                tab == CodeTab.Files -> CodeFiles(app, taskId)
                else -> LazyColumn(contentPadding = PaddingValues(DotSpacing.gutter), verticalArrangement = Arrangement.spacedBy(DotSpacing.s)) {
                    items(space.exchanges, key = { it.seq }) { entry ->
                        val author = when (entry.author) { "user" -> stringResource(R.string.you); "opencode" -> "OpenCode"; else -> ui.agents.firstOrNull { it.id == entry.agentId }?.name ?: stringResource(R.string.a_companion) }
                        DotCard(Modifier.fillMaxWidth().testTag("exchange-${entry.author}")) {
                            Text(author + " → " + (if (entry.author == "opencode") stringResource(R.string.code_to_companion) else "OpenCode") + " · " + formatWhen(entry.createdAt), style = Dot.type.caption, color = c.textSecondary)
                            Text(entry.text, style = Dot.type.callout, color = c.textPrimary, modifier = Modifier.padding(top = DotSpacing.xs))
                            entry.original?.takeIf { it.isNotBlank() }?.let { original ->
                                var open by remember(entry.seq) { mutableStateOf(false) }
                                DotDisclosure(stringResource(R.string.code_original), open, { open = !open }) { Text(original, style = Dot.type.caption, color = c.textSecondary) }
                            }
                        }
                    }
                }
            }
        }
        if (space?.sessionStatus == "busy") Row(Modifier.fillMaxWidth().padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.xs), horizontalArrangement = Arrangement.spacedBy(DotSpacing.s), verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.code_while_working), style = Dot.type.caption, color = c.textSecondary)
            DotFilterChip(stringResource(R.string.code_steer), delivery == "steer", { delivery = "steer" }, radio = true)
            DotFilterChip(stringResource(R.string.code_queue), delivery == "queue", { delivery = "queue" }, radio = true)
        }
        Box(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars)).padding(horizontal = DotSpacing.m).padding(bottom = DotSpacing.s)) {
            DotComposer(
                value = draft, onValueChange = { draft = it },
                placeholder = stringResource(if (space?.reachable == false) R.string.code_offline else R.string.code_write),
                enabled = space?.reachable != false,
                onSend = { val text = draft.trim(); draft = ""; app.run { val result = app.client.codePrompt(taskId, text, if (space?.sessionStatus == "busy") delivery else null); if (result.queued) app.notify(if (result.delivery == "steer") steered else queued); revision++ } },
            )
        }
    }
}

@Composable
private fun CodeMessageView(message: CodeMessage) {
    val c = Dot.colors
    if (message.role == "user") {
        val body = message.parts.filter { it.type == "text" }.joinToString("\n\n") { it.text }
        if (body.isNotBlank()) Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
            Text(body, style = Dot.type.callout, color = c.textPrimary, modifier = Modifier.fillMaxWidth(0.9f).clip(DotShapes.large).background(c.surfaceRaised).padding(horizontal = DotSpacing.m, vertical = DotSpacing.s).testTag("code-user"))
        }
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(DotSpacing.s)) {
        message.parts.forEach { part -> CodePartView(part) }
        message.error?.let { Text(it, style = Dot.type.caption, color = c.danger) }
        if (message.model != null && message.completedAt != null) Text(message.model, style = Dot.type.caption, color = c.textTertiary)
    }
}

@Composable
private fun CodePartView(part: CodePart) {
    val c = Dot.colors
    when (part.type) {
        "text" -> DotMarkdown(part.text)
        "reasoning" -> { var open by remember { mutableStateOf(false) }; DotDisclosure(stringResource(R.string.reasoning), open, { open = !open }) { Text(part.text, style = Dot.type.caption, color = c.textSecondary) } }
        "tool" -> {
            var open by remember { mutableStateOf(false) }
            val running = part.status == "running" || part.status == "pending"
            Column(Modifier.fillMaxWidth().clip(DotShapes.medium).background(c.surface).clickable(role = Role.Button) { open = !open }.padding(horizontal = DotSpacing.m, vertical = DotSpacing.s).testTag("code-tool-${part.status}")) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (running) { DotSpinner(size = 12.dp); Spacer(Modifier.width(DotSpacing.s)) }
                    Text(part.tool, style = Dot.type.caption.copy(fontFamily = FontFamily.Monospace), color = c.textTertiary)
                    Spacer(Modifier.width(DotSpacing.s))
                    Text(part.title.orEmpty(), style = Dot.type.caption, color = if (part.status == "error") c.danger else c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (open) Text((part.input + (part.output?.let { "\n\n$it" } ?: "")).take(6000), style = Dot.type.caption.copy(fontFamily = FontFamily.Monospace), color = c.textSecondary, modifier = Modifier.padding(top = DotSpacing.s))
            }
        }
        "patch" -> Text(stringResource(R.string.code_files_changed, part.files.joinToString(", ")), style = Dot.type.caption, color = c.textSecondary)
        else -> Text(part.filename.orEmpty(), style = Dot.type.caption, color = c.textSecondary)
    }
}

@Composable
private fun CodeDiffView(diff: CodeDiff) {
    val c = Dot.colors
    var open by remember(diff.path) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().clip(DotShapes.medium).background(c.surface).testTag("code-diff")) {
        Row(Modifier.fillMaxWidth().clickable(role = Role.Button) { open = !open }.padding(horizontal = DotSpacing.m, vertical = DotSpacing.m), verticalAlignment = Alignment.CenterVertically) {
            Text(diff.path, style = Dot.type.caption.copy(fontFamily = FontFamily.Monospace), color = c.textPrimary, maxLines = 2, overflow = TextOverflow.MiddleEllipsis, modifier = Modifier.weight(1f))
            Text("  +${diff.additions}", style = Dot.type.caption.copy(fontFamily = FontFamily.Monospace), color = c.success)
            Text("  −${diff.deletions}", style = Dot.type.caption.copy(fontFamily = FontFamily.Monospace), color = c.danger)
        }
        if (open) Column(Modifier.horizontalScroll(rememberScrollState()).padding(bottom = DotSpacing.s)) {
            if (diff.patch.isBlank()) Text(stringResource(R.string.code_no_patch), style = Dot.type.caption, color = c.textSecondary, modifier = Modifier.padding(horizontal = DotSpacing.m))
            diff.patch.lineSequence().take(800).forEach { line ->
                val added = line.startsWith("+") && !line.startsWith("+++")
                val removed = line.startsWith("-") && !line.startsWith("---")
                Text(
                    line.ifEmpty { " " }, style = Dot.type.caption.copy(fontFamily = FontFamily.Monospace), softWrap = false,
                    color = if (added) c.success else if (removed) c.danger else if (line.startsWith("@@")) c.accent else c.textSecondary,
                    modifier = Modifier.background(if (added) c.success.copy(alpha = 0.10f) else if (removed) c.danger.copy(alpha = 0.10f) else Color.Transparent).padding(horizontal = DotSpacing.m),
                )
            }
        }
    }
}

@Composable
private fun CodeQuestionCard(request: CodeQuestion, onAnswer: (List<List<String>>) -> Unit) {
    var answers by remember(request.id) { mutableStateOf(request.questions.map { emptyList<String>() }) }
    DotCard(Modifier.fillMaxWidth().testTag("code-question"), emphasized = true) {
        request.questions.forEachIndexed { index, question ->
            Text(question.question, style = Dot.type.bodyStrong, color = Dot.colors.textPrimary)
            @OptIn(ExperimentalLayoutApi::class)
            FlowRow(Modifier.padding(vertical = DotSpacing.s), horizontalArrangement = Arrangement.spacedBy(DotSpacing.s), verticalArrangement = Arrangement.spacedBy(DotSpacing.s)) {
                question.options.forEach { option ->
                    val on = option in answers[index]
                    DotFilterChip(option, on, { answers = answers.mapIndexed { i, list -> if (i != index) list else if (on) list - option else if (question.multiple) list + option else listOf(option) } }, radio = !question.multiple)
                }
            }
        }
        DotButton(stringResource(R.string.code_answer), { onAnswer(answers) }, enabled = answers.none { it.isEmpty() }, compact = true)
    }
}

/** The project's files, read on the development machine on demand: nothing is copied to BotCircle. */
@Composable
private fun CodeFiles(app: AppState, taskId: String) {
    val c = Dot.colors
    var path by rememberSaveable(taskId) { mutableStateOf("") }
    var nodes by remember { mutableStateOf<List<CodeFileNode>?>(null) }
    var file by remember { mutableStateOf<CodeFile?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(taskId, path) { nodes = null; error = null; runCatching { app.client.codeFiles(taskId, path) }.onSuccess { nodes = it }.onFailure { error = it.message } }
    val opened = file
    LazyColumn(contentPadding = PaddingValues(vertical = DotSpacing.s)) {
        if (opened != null) {
            item { Text("← " + stringResource(R.string.code_back_files), style = Dot.type.label, color = c.accent, modifier = Modifier.clickable(role = Role.Button) { file = null }.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.m)) }
            item { Text(opened.path, style = Dot.type.caption.copy(fontFamily = FontFamily.Monospace), color = c.textSecondary, modifier = Modifier.padding(horizontal = DotSpacing.gutter)) }
            item {
                if (opened.binary) Text(stringResource(R.string.code_binary), style = Dot.type.callout, color = c.textSecondary, modifier = Modifier.padding(DotSpacing.gutter))
                else Text(opened.content.take(60_000), style = Dot.type.caption.copy(fontFamily = FontFamily.Monospace), color = c.textPrimary, softWrap = false, modifier = Modifier.horizontalScroll(rememberScrollState()).padding(DotSpacing.gutter).testTag("code-file"))
            }
            return@LazyColumn
        }
        item {
            Row(Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.s), verticalAlignment = Alignment.CenterVertically) {
                if (path.isNotEmpty()) Text("←  ", style = Dot.type.label, color = c.accent, modifier = Modifier.clickable(role = Role.Button) { path = path.substringBeforeLast('/', "") })
                Text("/$path", style = Dot.type.caption.copy(fontFamily = FontFamily.Monospace), color = c.textSecondary)
            }
        }
        error?.let { message -> item { Text(message, style = Dot.type.callout, color = c.danger, modifier = Modifier.padding(horizontal = DotSpacing.gutter)) } }
        if (nodes == null && error == null) item { Box(Modifier.fillMaxWidth().padding(DotSpacing.xl), contentAlignment = Alignment.Center) { DotSpinner() } }
        items(nodes.orEmpty(), key = { it.path }) { node ->
            Row(
                Modifier.fillMaxWidth().clickable(role = Role.Button) { if (node.type == "directory") path = node.path else app.run { file = app.client.codeFile(taskId, node.path) } }.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.m),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(if (node.type == "directory") Icons.Outlined.Folder else Icons.AutoMirrored.Outlined.InsertDriveFile, null, Modifier.size(16.dp), tint = c.textSecondary)
                Spacer(Modifier.width(DotSpacing.m))
                Text(node.name, style = Dot.type.callout.copy(fontFamily = FontFamily.Monospace), color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}
