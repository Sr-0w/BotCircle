package app.dot.opendots.ui

import androidx.compose.foundation.background
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Build
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Difference
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.Lightbulb
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.StopCircle
import androidx.compose.material.icons.outlined.SwapHoriz
import androidx.compose.material.icons.outlined.SwapVert
import app.dot.design.components.DotIconButton
import app.dot.design.components.DotMenu
import app.dot.design.components.DotMenuItem
import app.dot.design.components.FrostedHeaderLayout
import app.dot.design.components.backdropSource
import app.dot.design.components.dotShimmer
import app.dot.design.components.rememberQuietBackdrop
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
 * The code workspace of one OpenCode task, full screen, laid out like a coding agent on a phone: OpenCode's prose, and
 * between its paragraphs one quiet line per stretch of work ("Ran 4 commands, read 2 files") that unfolds on demand.
 * The frosted header and its glass buttons are the conversation's. What changed opens from a pill above the field;
 * files and exchanges from the header menu. Stop is the field's own button while OpenCode works.
 */
@Composable
fun CodeWorkspacePage(app: AppState, ui: AppUiState, taskId: String, onBack: () -> Unit) {
    val c = Dot.colors
    var data by remember(taskId) { mutableStateOf<CodeWorkspace?>(null) }
    var error by remember(taskId) { mutableStateOf<String?>(null) }
    var tab by rememberSaveable(taskId) { mutableStateOf(CodeTab.Session) }
    var draft by rememberSaveable(taskId) { mutableStateOf("") }
    var revision by remember { mutableIntStateOf(0) }
    var menu by remember { mutableStateOf(false) }
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
    BackHandler(enabled = tab != CodeTab.Session) { tab = CodeTab.Session }
    val task = live ?: data?.task
    val space = data
    val busy = space?.sessionStatus == "busy" || space?.sessionStatus == "retry"
    val stop: () -> Unit = { app.taskAction(taskId, "cancel"); revision++ }
    val backdrop = rememberQuietBackdrop()
    val listState = rememberLazyListState()
    val blocks = remember(space?.messages) { codeBlocks(space?.messages.orEmpty()) }
    val pending = (space?.permissions?.size ?: 0) + (space?.questions?.size ?: 0)
    // The newest content is at the bottom, like a conversation: follow it while the user is there.
    LaunchedEffect(blocks.size, blocks.lastOrNull()?.size, pending, tab) {
        if (tab == CodeTab.Session && blocks.isNotEmpty()) listState.scrollToItem(Int.MAX_VALUE / 2)
    }

    Column(Modifier.fillMaxSize().background(c.background).testTag("code-workspace")) {
        Box(Modifier.weight(1f)) {
            FrostedHeaderLayout(
                backdrop = backdrop,
                header = {
                    Box(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.statusBars).padding(horizontal = DotSpacing.m, vertical = 6.dp)) {
                        DotIconButton(Icons.AutoMirrored.Outlined.ArrowBack, stringResource(R.string.back), onClick = { if (tab != CodeTab.Session) tab = CodeTab.Session else onBack() }, modifier = Modifier.align(Alignment.TopStart))
                        Column(Modifier.align(Alignment.Center).padding(horizontal = 64.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(
                                when (tab) { CodeTab.Session -> task?.title ?: stringResource(R.string.code_workspace); CodeTab.Changes -> stringResource(R.string.code_tab_changes); CodeTab.Files -> stringResource(R.string.files); CodeTab.Exchanges -> stringResource(R.string.code_tab_exchanges) },
                                style = Dot.type.label, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.semantics { heading() },
                            )
                            Text(
                                listOfNotNull(task?.external?.instanceName, task?.external?.directory?.trimEnd('/')?.substringAfterLast('/')?.ifBlank { null }).joinToString(" · ").ifBlank { "OpenCode" },
                                style = Dot.type.caption, color = c.textTertiary, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                        }
                        Box(Modifier.align(Alignment.TopEnd)) {
                            DotIconButton(Icons.Outlined.MoreVert, stringResource(R.string.more), onClick = { menu = true })
                            DotMenu(menu, { menu = false }) {
                                DotMenuItem(stringResource(R.string.code_tab_changes) + (space?.diffs?.size?.takeIf { it > 0 }?.let { " · $it" } ?: ""), Icons.Outlined.Difference) { menu = false; tab = CodeTab.Changes }
                                DotMenuItem(stringResource(R.string.files), Icons.Outlined.Folder) { menu = false; tab = CodeTab.Files }
                                DotMenuItem(stringResource(R.string.code_tab_exchanges), Icons.Outlined.SwapHoriz) { menu = false; tab = CodeTab.Exchanges }
                                if (task?.active == true) DotMenuItem(stringResource(R.string.code_stop), Icons.Outlined.StopCircle, color = c.danger) { menu = false; stop() }
                            }
                        }
                    }
                },
            ) { padding ->
                val top = padding.calculateTopPadding()
                when {
                    space == null && error != null -> Text(error.orEmpty(), style = Dot.type.callout, color = c.danger, modifier = Modifier.padding(top = top).padding(DotSpacing.gutter))
                    space == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { DotSpinner(size = 24.dp) }
                    tab == CodeTab.Session -> LazyColumn(
                        state = listState,
                        contentPadding = PaddingValues(start = DotSpacing.gutter, end = DotSpacing.gutter, top = top, bottom = DotSpacing.l),
                        verticalArrangement = Arrangement.spacedBy(DotSpacing.l),
                        modifier = Modifier.fillMaxSize().backdropSource(backdrop),
                    ) {
                        if (!space.reachable) item(key = "offline") {
                            Row(verticalAlignment = Alignment.Top) {
                                Icon(Icons.Outlined.CloudOff, null, Modifier.padding(top = 2.dp).size(14.dp), tint = c.textTertiary)
                                Spacer(Modifier.width(DotSpacing.s))
                                Text(stringResource(R.string.code_unreachable) + " " + space.error.orEmpty(), style = Dot.type.caption, color = c.textTertiary)
                            }
                        }
                        if (space.messages.isEmpty()) item(key = "empty") { Text(stringResource(if (space.reachable) R.string.code_no_message else R.string.code_cannot_read), style = Dot.type.callout, color = c.textSecondary) }
                        items(blocks, key = { it.key }) { block ->
                            when (block) {
                                is CodeBlock.User -> CodeUserBubble(block.text)
                                is CodeBlock.Prose -> DotMarkdown(block.text)
                                is CodeBlock.Failure -> Text(block.text, style = Dot.type.callout, color = c.danger)
                                is CodeBlock.Work -> CodeWorkGroup(block, live = busy && block === blocks.last())
                            }
                        }
                        // Working, between two visible steps: one quiet line, like the conversation's.
                        if (busy && pending == 0 && (blocks.lastOrNull() as? CodeBlock.Work)?.running == null) item(key = "live") {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                DotSpinner(size = 14.dp)
                                Spacer(Modifier.width(DotSpacing.s + 2.dp))
                                Text(stringResource(R.string.code_working), style = Dot.type.callout, color = c.textSecondary, modifier = Modifier.dotShimmer())
                            }
                        }
                        items(space.permissions, key = { "p-" + it.id }) { request ->
                            DotCard(Modifier.fillMaxWidth().testTag("code-permission"), emphasized = true) {
                                Text(stringResource(R.string.code_permission), style = Dot.type.bodyStrong, color = c.textPrimary)
                                Text(listOf(request.permission, request.patterns.joinToString(", ")).filter { it.isNotBlank() }.joinToString(" · "), style = Dot.type.caption.copy(fontFamily = FontFamily.Monospace), color = c.textSecondary, maxLines = 6, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(vertical = DotSpacing.s))
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
                    tab == CodeTab.Changes -> LazyColumn(contentPadding = PaddingValues(start = DotSpacing.gutter, end = DotSpacing.gutter, top = top, bottom = DotSpacing.l), verticalArrangement = Arrangement.spacedBy(DotSpacing.s), modifier = Modifier.fillMaxSize().backdropSource(backdrop)) {
                        if (space.diffs.isEmpty()) item { Text(stringResource(if (space.reachable) R.string.code_no_change else R.string.code_cannot_read), style = Dot.type.callout, color = c.textSecondary) }
                        items(space.diffs, key = { it.path }) { diff -> CodeDiffView(diff) }
                    }
                    tab == CodeTab.Files -> Box(Modifier.fillMaxSize().backdropSource(backdrop)) { CodeFiles(app, taskId, top) }
                    else -> LazyColumn(contentPadding = PaddingValues(start = DotSpacing.gutter, end = DotSpacing.gutter, top = top, bottom = DotSpacing.l), verticalArrangement = Arrangement.spacedBy(DotSpacing.l), modifier = Modifier.fillMaxSize().backdropSource(backdrop)) {
                        items(space.exchanges, key = { it.seq }) { entry ->
                            val author = when (entry.author) { "user" -> stringResource(R.string.you); "opencode" -> "OpenCode"; else -> ui.agents.firstOrNull { it.id == entry.agentId }?.name ?: stringResource(R.string.a_companion) }
                            Column(Modifier.fillMaxWidth().testTag("exchange-${entry.author}")) {
                                Text(author + " → " + (if (entry.author == "opencode") stringResource(R.string.code_to_companion) else "OpenCode") + " · " + formatWhen(entry.createdAt), style = Dot.type.caption, color = c.textTertiary)
                                Text(entry.text, style = Dot.type.callout, color = c.textPrimary, maxLines = 12, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = DotSpacing.xs))
                                entry.original?.takeIf { it.isNotBlank() }?.let { original ->
                                    var open by remember(entry.seq) { mutableStateOf(false) }
                                    DotDisclosure(stringResource(R.string.code_original), open, { open = !open }) { Text(original, style = Dot.type.caption, color = c.textSecondary) }
                                }
                            }
                        }
                    }
                }
            }
        }
        if (tab == CodeTab.Session) {
            // What changed, as one pill above the field: it opens the diff.
            val diffs = space?.diffs.orEmpty()
            if (diffs.isNotEmpty()) Box(Modifier.fillMaxWidth().padding(bottom = DotSpacing.xs), contentAlignment = Alignment.Center) {
                Row(
                    Modifier.clip(DotShapes.pill).background(c.surfaceRaised).border(DotSpacing.hairline * 2, c.border, DotShapes.pill)
                        .clickable(role = Role.Button) { tab = CodeTab.Changes }.heightIn(min = 36.dp).padding(horizontal = DotSpacing.m).testTag("code-changes-pill"),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(pluralStringResource(R.plurals.code_files, diffs.size, diffs.size), style = Dot.type.caption, color = c.textPrimary)
                    Text("  +${diffs.sumOf { it.additions }}", style = Dot.type.caption.copy(fontFamily = FontFamily.Monospace), color = c.success)
                    Text(" −${diffs.sumOf { it.deletions }}", style = Dot.type.caption.copy(fontFamily = FontFamily.Monospace), color = c.danger)
                }
            }
            Box(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars)).padding(horizontal = DotSpacing.m).padding(bottom = DotSpacing.s)) {
                DotComposer(
                    value = draft, onValueChange = { draft = it },
                    placeholder = stringResource(if (space?.reachable == false) R.string.code_offline else R.string.code_write),
                    enabled = space?.reachable != false,
                    busy = busy && task?.active == true,
                    onStop = stop,
                    // While OpenCode works, one quiet switch says when the message is taken into account.
                    header = if (busy && draft.isNotBlank()) {
                        {
                            Row(
                                Modifier.clip(DotShapes.pill).clickable(role = Role.Switch) { delivery = if (delivery == "steer") "queue" else "steer" }.padding(vertical = DotSpacing.xs).testTag("code-delivery"),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Icon(Icons.Outlined.SwapVert, null, Modifier.size(14.dp), tint = c.textTertiary)
                                Spacer(Modifier.width(DotSpacing.xs))
                                Text(stringResource(if (delivery == "steer") R.string.code_steer else R.string.code_queue), style = Dot.type.caption, color = c.textSecondary)
                            }
                        }
                    } else null,
                    onSend = { val text = draft.trim(); draft = ""; app.run { val result = app.client.codePrompt(taskId, text, if (busy) delivery else null); if (result.queued) app.notify(if (result.delivery == "steer") steered else queued); revision++ } },
                )
            }
        } else Spacer(Modifier.windowInsetsPadding(WindowInsets.navigationBars))
    }
}

/** What the session shows, in order: requests, OpenCode's prose, and the stretches of work between them. */
private sealed interface CodeBlock {
    val key: String
    val size: Int get() = 1
    data class User(override val key: String, val text: String) : CodeBlock
    data class Prose(override val key: String, val text: String) : CodeBlock
    data class Failure(override val key: String, val text: String) : CodeBlock
    data class Work(override val key: String, val parts: List<CodePart>) : CodeBlock {
        override val size: Int get() = parts.size
        val running: CodePart? get() = parts.lastOrNull { it.type == "tool" && (it.status == "running" || it.status == "pending") }
    }
}

/** Consecutive tools and reasoning, even across OpenCode's steps, fold into one line; prose and requests break it. */
private fun codeBlocks(messages: List<CodeMessage>): List<CodeBlock> {
    val out = mutableListOf<CodeBlock>()
    var work = mutableListOf<CodePart>()
    var workKey = ""
    fun flush() { if (work.isNotEmpty()) { out += CodeBlock.Work(workKey, work); work = mutableListOf() } }
    for (message in messages) {
        if (message.role == "user") {
            flush()
            val body = message.parts.filter { it.type == "text" }.joinToString("\n\n") { it.text }.trim()
            if (body.isNotEmpty()) out += CodeBlock.User("u-${message.id}", body)
            continue
        }
        message.parts.forEachIndexed { index, part ->
            when {
                part.type == "text" -> { if (part.text.isNotBlank()) { flush(); out += CodeBlock.Prose("t-${message.id}-$index", part.text.trim()) } }
                part.type == "reasoning" && part.text.isBlank() -> Unit
                else -> { if (work.isEmpty()) workKey = "w-${message.id}-$index"; work += part }
            }
        }
        message.error?.let { flush(); out += CodeBlock.Failure("e-${message.id}", it) }
    }
    flush()
    return out
}

private enum class ToolKind { Command, Read, Edit, Search, Other }

private fun toolKind(tool: String): ToolKind = when (tool.lowercase()) {
    "bash", "shell", "command", "terminal" -> ToolKind.Command
    "read", "view", "cat" -> ToolKind.Read
    "edit", "write", "patch", "multiedit", "apply_patch" -> ToolKind.Edit
    "grep", "glob", "list", "ls", "find", "search", "codesearch", "websearch", "webfetch", "fetch" -> ToolKind.Search
    else -> ToolKind.Other
}

@Composable
private fun CodeUserBubble(text: String) {
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
        Text(text, style = Dot.type.body, color = Dot.colors.textPrimary, modifier = Modifier.fillMaxWidth(0.85f).wrapContentWidth(Alignment.End).clip(DotShapes.large).background(Dot.colors.surfaceRaised).padding(horizontal = DotSpacing.l, vertical = DotSpacing.m).testTag("code-user"))
    }
}

/** One line for a stretch of work: what is running now, or a summary ("Ran 4 commands, read 2 files"). Tap to unfold. */
@Composable
private fun CodeWorkGroup(block: CodeBlock.Work, live: Boolean) {
    val c = Dot.colors
    var open by rememberSaveable(block.key) { mutableStateOf(false) }
    val tools = block.parts.filter { it.type == "tool" }
    val running = block.running
    val failures = tools.count { it.status == "error" }
    val counts = tools.groupingBy { toolKind(it.tool) }.eachCount()
    val summary = buildList {
        counts[ToolKind.Command]?.let { add(pluralStringResource(R.plurals.code_g_commands, it, it)) }
        counts[ToolKind.Read]?.let { add(pluralStringResource(R.plurals.code_g_reads, it, it)) }
        counts[ToolKind.Edit]?.let { add(pluralStringResource(R.plurals.code_g_edits, it, it)) }
        counts[ToolKind.Search]?.let { add(pluralStringResource(R.plurals.code_g_searches, it, it)) }
        counts[ToolKind.Other]?.let { add(pluralStringResource(R.plurals.code_g_other, it, it)) }
        block.parts.count { it.type == "patch" }.takeIf { it > 0 && counts[ToolKind.Edit] == null }?.let { add(pluralStringResource(R.plurals.code_files, it, it)) }
    }.mapIndexed { i, item -> if (i == 0) item else item.replaceFirstChar { it.lowercase() } }.joinToString(", ").ifEmpty { stringResource(R.string.code_thought) }
    Column(Modifier.fillMaxWidth().testTag("code-work")) {
        Row(
            Modifier.clip(DotShapes.small).clickable(role = Role.Button, onClickLabel = stringResource(if (open) R.string.hide else R.string.show)) { open = !open }.heightIn(min = 32.dp).padding(end = DotSpacing.s),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (running != null && live) {
                DotSpinner(size = 14.dp)
                Spacer(Modifier.width(DotSpacing.s + 2.dp))
                Text(running.title?.ifBlank { null } ?: running.tool, style = Dot.type.callout, color = c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false).dotShimmer())
            } else {
                Text(summary, style = Dot.type.callout, color = c.textTertiary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                if (failures > 0) Text("  ·  " + pluralStringResource(R.plurals.errors, failures, failures), style = Dot.type.callout, color = c.danger, maxLines = 1)
            }
            Spacer(Modifier.width(DotSpacing.xs))
            Icon(if (open) Icons.Outlined.ExpandLess else Icons.Outlined.ChevronRight, null, Modifier.size(18.dp), tint = c.textTertiary)
        }
        if (open) Column(Modifier.padding(top = DotSpacing.xs).fillMaxWidth().clip(DotShapes.medium).background(c.surface).padding(vertical = DotSpacing.xs)) {
            block.parts.forEach { part -> CodeStep(part) }
        }
    }
}

/** One step inside an unfolded stretch of work: an icon, its title; tap for its input and output. */
@Composable
private fun CodeStep(part: CodePart) {
    val c = Dot.colors
    var open by remember { mutableStateOf(false) }
    val mono = Dot.type.caption.copy(fontFamily = FontFamily.Monospace)
    val label = when (part.type) {
        "tool" -> part.title?.ifBlank { null } ?: part.tool
        "reasoning" -> stringResource(R.string.reasoning)
        "patch" -> part.files.joinToString(", ")
        else -> part.filename.orEmpty()
    }
    val detail = when (part.type) {
        "tool" -> (part.input + (part.output?.let { "\n\n$it" } ?: "")).trim()
        "reasoning" -> part.text
        else -> ""
    }
    Column(Modifier.fillMaxWidth().clickable(enabled = detail.isNotEmpty(), role = Role.Button) { open = !open }.padding(horizontal = DotSpacing.m, vertical = DotSpacing.s).testTag("code-tool-${part.status}")) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            val running = part.type == "tool" && (part.status == "running" || part.status == "pending")
            if (running) DotSpinner(size = 12.dp) else Icon(
                when { part.type == "reasoning" -> Icons.Outlined.Lightbulb; part.type == "patch" -> Icons.Outlined.Difference; else -> when (toolKind(part.tool)) { ToolKind.Command -> Icons.Outlined.Terminal; ToolKind.Read -> Icons.AutoMirrored.Outlined.InsertDriveFile; ToolKind.Edit -> Icons.Outlined.Edit; ToolKind.Search -> Icons.Outlined.Search; ToolKind.Other -> Icons.Outlined.Build } },
                null, Modifier.size(14.dp), tint = if (part.status == "error") c.danger else c.textTertiary,
            )
            Spacer(Modifier.width(DotSpacing.s))
            Text(label, style = if (part.type == "tool") mono else Dot.type.caption, color = if (part.status == "error") c.danger else c.textSecondary, maxLines = if (open) 6 else 1, overflow = TextOverflow.Ellipsis)
        }
        if (open) Text(detail.take(6000), style = mono, color = c.textSecondary, modifier = Modifier.padding(top = DotSpacing.s, start = 22.dp))
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
private fun CodeFiles(app: AppState, taskId: String, top: androidx.compose.ui.unit.Dp = 0.dp) {
    val c = Dot.colors
    var path by rememberSaveable(taskId) { mutableStateOf("") }
    var nodes by remember { mutableStateOf<List<CodeFileNode>?>(null) }
    var file by remember { mutableStateOf<CodeFile?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(taskId, path) { nodes = null; error = null; runCatching { app.client.codeFiles(taskId, path) }.onSuccess { nodes = it }.onFailure { error = it.message } }
    val opened = file
    LazyColumn(contentPadding = PaddingValues(top = top + DotSpacing.s, bottom = DotSpacing.l)) {
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
