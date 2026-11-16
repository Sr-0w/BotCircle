package app.dot.opendots.ui

import android.content.ClipData
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.calculateEndPadding
import androidx.compose.foundation.layout.calculateStartPadding
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.ArrowDownward
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.pluralStringResource
import app.dot.design.components.DotDialog
import app.dot.design.components.DotBottomSheet
import app.dot.design.components.DotCapsuleButton
import app.dot.design.components.DotFloatingCapsule
import app.dot.design.components.Hairline
import app.dot.design.components.dotShimmer
import app.dot.opendots.chat.presentAssistantTurn
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.material.icons.outlined.AttachFile
import app.dot.design.components.DotPrimaryButton
import androidx.compose.foundation.layout.height
import androidx.compose.ui.platform.testTag
import app.dot.opendots.data.ChatMessage
import kotlinx.serialization.json.putJsonObject
import app.dot.design.components.DotTextField
import app.dot.design.components.DotMenuItem
import app.dot.design.components.DotMenu
import app.dot.opendots.chat.ChatStatus
import app.dot.opendots.data.Part
import app.dot.opendots.data.ModelInfo
import androidx.compose.runtime.produceState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.Psychology
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.toClipEntry
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.dot.design.Dot
import app.dot.design.DotShapes
import app.dot.design.DotSpacing
import app.dot.design.components.ButtonStyle
import app.dot.design.components.DotButton
import app.dot.design.components.DotCard
import app.dot.design.components.DotComposer
import app.dot.design.components.DotFrostedPill
import app.dot.design.components.DotIconButton
import app.dot.design.components.DotQuote
import app.dot.design.components.DotSpinner
import app.dot.design.components.DotThinking
import app.dot.design.components.EmptyState
import app.dot.design.R as DesignR
import app.dot.design.components.FrostedHeaderLayout
import app.dot.design.components.UnreadDot
import app.dot.design.components.backdropSource
import app.dot.design.components.rememberQuietBackdrop
import app.dot.design.rememberReducedMotion
import app.dot.opendots.AppState
import app.dot.opendots.AppUiState
import app.dot.opendots.R
import app.dot.opendots.chat.ChatUiState
import app.dot.opendots.data.Agent
import app.dot.opendots.data.ARTIFACT_MAX_BYTES
import app.dot.opendots.data.Attachment
import app.dot.opendots.data.ChatTarget
import app.dot.opendots.data.FILES_MAX_COUNT
import app.dot.opendots.data.GeneralChat
import app.dot.opendots.data.PickedFile
import app.dot.opendots.data.describeFile
import app.dot.opendots.data.fileBody
import app.dot.opendots.data.formatBytes
import app.dot.design.components.DotFilterChip
import androidx.compose.material.icons.automirrored.outlined.InsertDriveFile
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material.icons.outlined.AlternateEmail
import app.dot.opendots.data.ReplyRef
import app.dot.opendots.data.readImageForUpload
import coil3.compose.AsyncImage
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private class PendingImage(val uri: Uri, val file: PickedFile? = null) {
    var attachment by mutableStateOf<Attachment?>(null)
    var failed by mutableStateOf(false)
}

@Composable
fun ChatScreen(app: AppState, ui: AppUiState, agent: Agent, onBack: () -> Unit, onOpenCompanion: () -> Unit, general: GeneralChat? = null, onOpenDesktop: (agentId: String) -> Unit = {}, onOpenCode: (taskId: String) -> Unit = {}, onOpenChat: (chatId: String) -> Unit = {}) {
    // A general chat reuses the whole conversation screen: [agent] then only carries its title for the header.
    val session = remember(agent.id, general != null) { app.session(if (general != null) ChatTarget.General(general.id) else ChatTarget.Companion(agent.id)) }
    LaunchedEffect(session) { session.open() }
    val chat by session.state.collectAsStateWithLifecycle()

    val context = LocalContext.current
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    val backdrop = rememberQuietBackdrop()
    val listState = remember(agent.id) { androidx.compose.foundation.lazy.LazyListState() }
    var draft by rememberSaveable(agent.id) { mutableStateOf("") }
    var reply by remember(agent.id) { mutableStateOf<ReplyRef?>(null) }
    val images = remember(agent.id) { mutableStateListOf<PendingImage>() }
    var workSheet by remember(agent.id) { mutableStateOf(false) }
    var editing by remember(agent.id) { mutableStateOf<Pair<String, String>?>(null) }
    var clearing by remember(agent.id) { mutableStateOf(false) }
    var taskSheet by remember(agent.id) { mutableStateOf<String?>(null) }
    var accessSheet by remember(agent.id) { mutableStateOf<String?>(null) }
    val fileActions = rememberFileActions(app)
    val tooLarge = stringResource(R.string.file_too_large)
    val copied = stringResource(R.string.copied)
    val uploadFailed = stringResource(R.string.upload_failed)

    // Any document: images are prepared for the model, every other file is handed over unchanged as an artifact.
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        uris.take(FILES_MAX_COUNT - images.size).forEach { uri ->
            val picked = describeFile(context, uri)
            if (!picked.isImage && picked.size > ARTIFACT_MAX_BYTES) { app.notify(tooLarge); return@forEach }
            val pending = PendingImage(uri, picked.takeUnless { it.isImage }).also(images::add)
            scope.launch {
                try {
                    if (picked.isImage) {
                        val encoded = readImageForUpload(context, uri)
                        pending.attachment = app.client.uploadImage(encoded.bytes, encoded.filename, encoded.mediaType)
                    } else {
                        val artifact = app.client.uploadArtifact(fileBody(context, picked), picked.name, agentId = agent.id.takeIf { general == null }, conversationId = general?.id)
                        pending.attachment = Attachment(artifact.id, artifact.url, artifact.name, artifact.mediaType)
                    }
                } catch (e: Exception) {
                    if (e is kotlin.coroutines.cancellation.CancellationException) throw e
                    pending.failed = true
                    app.notify(e.message?.takeIf { it.isNotBlank() } ?: uploadFailed)
                }
            }
        }
    }

    val env = remember(ui.agents, ui.approvals, ui.requests, ui.drafts, ui.tasks, ui.secureLogins, chat.busy, session) {
        MessageEnv(
            agents = ui.agents, approvals = ui.approvals, requests = ui.requests, drafts = ui.drafts, busy = chat.busy,
            resolveUrl = app.client::resolve,
            onCopy = { text -> scope.launch { clipboard.setClipEntry(ClipData.newPlainText("BotCircle", text).toClipEntry()); if (android.os.Build.VERSION.SDK_INT < 33) app.notify(copied) } },
            onReply = { reply = it },
            onReact = session::react,
            onDecide = { id, approve -> app.decide(id, approve) },
            onAnswer = { requestId, answers, summary ->
                session.send(summary, answer = buildJsonObject { put("requestId", requestId); put("answers", answers) })
            },
            onNeedRequest = app::ensureRequest,
            onNeedDraft = app::ensureDraft,
            onOpenWeb = { ui.serverUrl.takeIf { it.isNotBlank() }?.let { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(it))) } } },
            onOpenImage = { url -> runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } },
            onShowWork = { workSheet = true },
            tasks = ui.tasks, onNeedTask = app::loadTask, onOpenTask = { taskSheet = it }, onTaskAction = app::taskAction, onOpenChat = onOpenChat,
            fileActions = fileActions, onFileAccess = { accessSheet = it }, attribution = general != null,
            secureLogins = ui.secureLogins, onNeedSecureLogin = app::ensureSecureLogin, onResolveSecureLogin = { id, outcome -> app.resolveSecureLogin(id, outcome) }, onTakeControl = onOpenDesktop, onOpenCode = onOpenCode,
            onEdit = if (general != null) { id, text -> editing = id to text } else null,
            onRegenerate = if (general != null && !chat.busy) session::regenerate else null,
        )
    }

    // Newest first: the list is laid out from the bottom, so a growing reply stays anchored without any scroll jump.
    val rows = remember(chat.messages) { chat.messages.asReversed() }
    val lastAssistantId = remember(chat.messages) { chat.messages.lastOrNull { !it.isUser && it.meta.kind != "event" }?.id }
    val atLatest by remember(listState) { derivedStateOf { listState.firstVisibleItemIndex == 0 && listState.firstVisibleItemScrollOffset < 200 } }

    // Sending always brings the conversation back to the latest message.
    val newestUserId = chat.messages.lastOrNull { it.isUser }?.id
    LaunchedEffect(newestUserId) { if (newestUserId != null) listState.scrollToItem(0) }
    // Older history loads when the user nears the top.
    LaunchedEffect(listState, chat.cursor) {
        if (chat.cursor == null) return@LaunchedEffect
        snapshotFlow { listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0 }.collect { last ->
            if (last >= listState.layoutInfo.totalItemsCount - 4) session.loadOlder()
        }
    }

    // The messages fill the screen and scroll under the floating glass composer, which leaves them room at the end.
    var composerHeight by remember { mutableStateOf(0.dp) }
    val density = LocalDensity.current
    Box(Modifier.fillMaxSize().background(Dot.colors.background)) {
        Box(Modifier.fillMaxSize()) {
            FrostedHeaderLayout(
                backdrop = backdrop,
                header = { ChatHeader(agent, ui, chat.reconnecting, onBack, onOpenCompanion, onOpenWork = { workSheet = true }, general = general != null) },
            ) { padding ->
                val direction = LocalLayoutDirection.current
                // In landscape the navigation bar or a display cutout can sit beside the content.
                val sideInsets = WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal).asPaddingValues()
                LazyColumn(
                    state = listState,
                    reverseLayout = true,
                    verticalArrangement = Arrangement.Top,
                    contentPadding = PaddingValues(
                        start = DotSpacing.gutter + sideInsets.calculateStartPadding(direction),
                        end = DotSpacing.gutter + sideInsets.calculateEndPadding(direction),
                        top = padding.calculateTopPadding(), bottom = DotSpacing.l + composerHeight,
                    ),
                    modifier = Modifier.fillMaxSize().backdropSource(backdrop),
                ) {
                    chat.error?.let { message ->
                        item(key = "error") { TurnError(if (chat.notSent) stringResource(R.string.not_sent) else if (general != null) stringResource(R.string.assistant_failed) else stringResource(R.string.turn_failed, agentDisplayName(agent)), message, session::dismissError, Modifier.padding(top = DotSpacing.xl)) }
                    }
                    // The thread only shows *that* the companion works and on what; the detail lives in the work panel.
                    if (chat.busy) item(key = "live") {
                        val step = liveStepLabel(chat.messages.lastOrNull())
                        LiveStatus(
                            agent, orb = if (general != null) orbStateOf(chat.messages.lastOrNull(), chat.status) else null,
                            label = if (chat.steering) stringResource(R.string.steering_status) else step?.first ?: agent.stateDetail ?: (agentStateLabel(if (agent.state == "available") "thinking" else agent.state) + "…"),
                            actions = step?.second ?: 0,
                            onClick = { workSheet = true },
                            modifier = Modifier.padding(top = DotSpacing.l),
                        )
                    }
                    items(rows, key = { it.id }, contentType = { if (it.isUser) 0 else 1 }) { message ->
                        MessageItem(
                            message, env,
                            streaming = chat.busy && message.id == rows.firstOrNull()?.id && !message.isUser,
                            showActions = message.id == lastAssistantId,
                            modifier = Modifier.padding(top = DotSpacing.l).widthIn(max = 720.dp),
                        )
                    }
                    if (chat.loadingOlder) item(key = "older") {
                        Box(Modifier.fillMaxWidth().padding(DotSpacing.l), contentAlignment = Alignment.Center) { DotSpinner() }
                    }
                }
            }

            when {
                chat.loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { DotSpinner(size = 24.dp) }
                chat.loadError != null && chat.messages.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    EmptyState(Icons.Outlined.ErrorOutline, stringResource(R.string.load_failed), chat.loadError.orEmpty()) {
                        DotButton(stringResource(R.string.retry), session::open, style = ButtonStyle.Secondary)
                    }
                }
                chat.messages.isEmpty() && !chat.busy -> if (general != null) Column(Modifier.align(Alignment.Center).padding(DotSpacing.gutter), horizontalAlignment = Alignment.CenterHorizontally) {
                    ThinkingOrb(OrbState.Breathing, size = 64.dp, label = stringResource(R.string.chat_empty_title))
                    Spacer(Modifier.height(DotSpacing.l))
                    Text(stringResource(R.string.chat_empty_title), style = Dot.type.title, color = Dot.colors.textPrimary)
                    Text(stringResource(R.string.chat_empty_body), style = Dot.type.callout, color = Dot.colors.textSecondary, textAlign = androidx.compose.ui.text.style.TextAlign.Center, modifier = Modifier.padding(top = DotSpacing.s))
                } else EmptyConversation(agent, Modifier.align(Alignment.Center))
            }

            val reduced = rememberReducedMotion()
            androidx.compose.animation.AnimatedVisibility(
                visible = !atLatest,
                modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = composerHeight + DotSpacing.s),
                enter = if (reduced) fadeIn() else fadeIn() + scaleIn(initialScale = 0.9f),
                exit = if (reduced) fadeOut() else fadeOut() + scaleOut(targetScale = 0.9f),
            ) {
                DotFrostedPill(
                    Icons.Outlined.ArrowDownward, onClick = { scope.launch { listState.animateScrollToItem(0) } },
                    contentDescription = stringResource(DesignR.string.ds_scroll_to_latest), backdrop = backdrop,
                )
            }
        }

        if (workSheet) WorkSheet(agent, chat, env) { workSheet = false }
        if (clearing) ClearDialog(
            name = agentDisplayName(agent), general = general != null, busy = chat.busy,
            onDismiss = { clearing = false },
        ) {
            clearing = false
            if (general != null) app.restartChat(general) {} else session.clear()
        }
        editing?.let { (id, original) -> EditMessageSheet(original, onDismiss = { editing = null }) { text -> editing = null; session.edit(id, text) } }
        taskSheet?.let { id -> TaskSheet(app, ui, id) { taskSheet = null } }
        accessSheet?.let { id -> ArtifactSheet(app, ui, id) { accessSheet = null } }

        // @mention: the word being typed at the end of the draft, completed from the companions' names.
        val mentionable = remember(ui.agents, general != null) { if (general == null) emptyList() else ui.agents.filter { it.named } }
        val mentionQuery = remember(draft) { MENTION_TAIL.find(draft)?.groupValues?.get(2) }
        val suggestions = remember(mentionQuery, mentionable) { mentionQuery?.let { q -> mentionable.filter { it.name.startsWith(q, ignoreCase = true) }.take(5) }.orEmpty() }

        // The composer floats in the same glass as the header's buttons: the messages pass under it, blurred.
        val ready = images.all { it.attachment != null || it.failed }
        Box(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth()
                .onSizeChanged { size -> with(density) { size.height.toDp() }.let { if (it != composerHeight) composerHeight = it } }
                .windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars))
                .padding(horizontal = DotSpacing.m).padding(bottom = DotSpacing.s),
            contentAlignment = Alignment.Center,
        ) {
            DotComposer(
                value = draft,
                onValueChange = { draft = it },
                modifier = Modifier.widthIn(max = 720.dp),
                backdrop = backdrop,
                placeholder = if (general != null) stringResource(R.string.write_chat) else if (agent.named) stringResource(R.string.write_to, agent.name) else stringResource(R.string.write_to_companion),
                busy = chat.busy,
                canSend = ready && (draft.isNotBlank() || images.any { it.attachment != null }),
                onStop = session::stop,
                onSend = {
                    // `/clear` typed alone is a command, not a message: it asks before starting over.
                    if (draft.trim() == "/clear" && images.isEmpty()) { draft = ""; clearing = true; return@DotComposer }
                    session.send(draft, images.mapNotNull { it.attachment }, reply)
                    draft = ""; reply = null; images.clear()
                },
                header = if (reply == null && images.isEmpty() && suggestions.isEmpty()) null else {
                    {
                        if (suggestions.isNotEmpty()) Row(Modifier.horizontalScroll(rememberScrollState()).padding(bottom = DotSpacing.xs), horizontalArrangement = Arrangement.spacedBy(DotSpacing.s)) {
                            suggestions.forEach { target -> DotFilterChip("@" + target.name, selected = false, onClick = { draft = draft.dropLast(mentionQuery.orEmpty().length + 1) + "@" + target.name + " " }) }
                        }
                        reply?.let { target ->
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                DotQuote(if (target.role == "user") stringResource(R.string.you) else agentDisplayName(agent), target.preview, Modifier.weight(1f))
                                DotIconButton(Icons.Outlined.Close, stringResource(R.string.cancel_reply), onClick = { reply = null }, tint = Dot.colors.textSecondary)
                            }
                        }
                        if (images.isNotEmpty()) Row(Modifier.horizontalScroll(rememberScrollState()).padding(bottom = DotSpacing.xs), horizontalArrangement = Arrangement.spacedBy(DotSpacing.s)) {
                            images.forEach { image -> if (image.file == null) ImageThumb(image) { images.remove(image) } else FileThumb(image) { images.remove(image) } }
                        }
                    }
                },
                // Under the text: "+" (attach, ask a companion), then the conversation's model, and for a general chat
                // its effort and web search.
                footer = {
                    PlusMenu(
                        canAttach = images.size < FILES_MAX_COUNT, onAttach = { picker.launch(arrayOf("*/*")) },
                        onAsk = if (general != null && mentionable.isNotEmpty()) ({ if (mentionQuery == null) draft = if (draft.isEmpty() || draft.last().isWhitespace()) "$draft@" else "$draft @" }) else null,
                    )
                    if (general != null) ChatControls(app, general) else AgentModelChip(app, agent)
                },
            )
        }
    }
}

/**
 * The conversation header floats on the progressive blur: navigation on one side, the companion's own controls on the
 * other, and in the middle the companion itself - its dot, with its name on a small glass pill underneath.
 */
@Composable
private fun ChatHeader(agent: Agent, ui: AppUiState, reconnecting: Boolean, onBack: () -> Unit, onOpenCompanion: () -> Unit, onOpenWork: () -> Unit, general: Boolean = false) {
    val c = Dot.colors
    val elsewhere = ui.agents.any { it.id != agent.id && it.unread > 0 } || ui.pendingApprovals.isNotEmpty()
    val name = agentDisplayName(agent)
    val status = when {
        !ui.connected || reconnecting -> stringResource(R.string.reconnecting)
        agent.state == "error" -> agentStateLabel("error")
        ui.paused -> stringResource(R.string.paused_short)
        else -> null
    }
    Box(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.statusBars).padding(horizontal = DotSpacing.m, vertical = 6.dp)) {
        Box(Modifier.align(Alignment.TopStart)) {
            DotIconButton(Icons.AutoMirrored.Outlined.ArrowBack, stringResource(R.string.companions), onClick = onBack)
            if (elsewhere) UnreadDot(Modifier.align(Alignment.TopEnd).padding(top = 9.dp, end = 9.dp))
        }
        Column(
            Modifier.align(Alignment.TopCenter).padding(horizontal = 112.dp).clip(DotShapes.large)
                .clickable(role = Role.Button, onClickLabel = stringResource(R.string.companion_details), onClick = onOpenCompanion),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            // A general chat is a conversation, not a companion: no dot, only its title.
            if (!general) CompanionOrb(agent, size = 48.dp)
            Row(
                Modifier.padding(top = if (general) 6.dp else 4.dp).clip(DotShapes.pill)
                    .background(c.surfaceRaised.copy(alpha = 0.92f))
                    .border(DotSpacing.hairline * 2, c.border, DotShapes.pill)
                    .padding(horizontal = DotSpacing.m, vertical = 3.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(name, style = Dot.type.label, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false).semantics { heading() })
                if (status != null) Text("  ·  $status", style = Dot.type.caption, color = if (agent.state == "error" && ui.connected) c.danger else c.textTertiary, maxLines = 1)
            }
        }
        DotFloatingCapsule(Modifier.align(Alignment.TopEnd)) {
            DotCapsuleButton(Icons.Outlined.Checklist, stringResource(R.string.work), onOpenWork)
            DotCapsuleButton(Icons.Outlined.Tune, stringResource(R.string.companion_details), onOpenCompanion)
        }
    }
}

/** While the companion works: its dot, animated, and one sentence saying what it is doing right now. Opens the work panel. */
@Composable
private fun LiveStatus(agent: Agent, label: String, actions: Int, onClick: () -> Unit, modifier: Modifier = Modifier, orb: OrbState? = null) {
    Row(
        modifier.clip(DotShapes.pill).clickable(role = Role.Button, onClickLabel = stringResource(R.string.show_work), onClick = onClick)
            .heightIn(min = 40.dp).padding(end = DotSpacing.m),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (orb != null) ThinkingOrb(orb, size = 22.dp, label = label)
        else CompanionOrb(parseAgentColor(agent.color), size = 22.dp, state = if (agent.busy) agent.state else "thinking", named = agent.named)
        Spacer(Modifier.width(DotSpacing.s + 2.dp))
        Text(label, style = Dot.type.callout, color = Dot.colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false).dotShimmer())
        if (actions > 0) Text("  ·  " + pluralStringResource(R.plurals.actions, actions, actions), style = Dot.type.caption, color = Dot.colors.textTertiary, maxLines = 1)
    }
}

/** The work panel: what the companion reasoned and which tools it used, turn by turn, each folded by default. */
@Composable
private fun WorkSheet(agent: Agent, chat: ChatUiState, env: MessageEnv, onDismiss: () -> Unit) {
    val turns = remember(chat.messages) {
        chat.messages.filter { !it.isUser && it.meta.kind != "event" }.map { it to presentAssistantTurn(it) }.filter { it.second.hasWork }.asReversed()
    }
    val streamingId = if (chat.busy) chat.messages.lastOrNull()?.takeIf { !it.isUser }?.id else null
    DotBottomSheet(onDismiss) {
        Text(stringResource(R.string.work_title, agentDisplayName(agent)), style = Dot.type.title, color = Dot.colors.textPrimary, modifier = Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.s).semantics { heading() })
        if (turns.isEmpty()) {
            EmptyState(Icons.Outlined.Checklist, stringResource(R.string.work_empty_title), stringResource(R.string.work_empty_body))
        } else LazyColumn(contentPadding = PaddingValues(start = DotSpacing.gutter, end = DotSpacing.gutter, bottom = DotSpacing.xxl)) {
            items(turns, key = { it.first.id }) { (message, turn) ->
                TurnWorkDisclosure(message, turn, streaming = message.id == streamingId, env = env, initiallyOpen = message.id == streamingId)
                Hairline()
            }
        }
    }
}

@Composable
private fun EmptyConversation(agent: Agent, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth().padding(horizontal = DotSpacing.xxxl), horizontalAlignment = Alignment.CenterHorizontally) {
        CompanionOrb(agent, size = 72.dp)
        Spacer(Modifier.size(DotSpacing.xl))
        Text(
            if (agent.named) stringResource(R.string.empty_named_title, agent.name) else stringResource(R.string.empty_new_title),
            style = Dot.type.title, color = Dot.colors.textPrimary, textAlign = TextAlign.Center,
        )
        Spacer(Modifier.size(DotSpacing.s))
        Text(
            if (agent.named) agent.description.ifBlank { stringResource(R.string.empty_named_body) } else stringResource(R.string.empty_new_body),
            style = Dot.type.callout, color = Dot.colors.textSecondary, textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun TurnError(title: String, message: String, onDismiss: () -> Unit, modifier: Modifier = Modifier) {
    DotCard(modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.Top) {
            Icon(Icons.Outlined.ErrorOutline, null, Modifier.padding(top = 2.dp).size(18.dp), tint = Dot.colors.danger)
            Spacer(Modifier.width(DotSpacing.m))
            Column(Modifier.weight(1f)) {
                Text(title, style = Dot.type.bodyStrong, color = Dot.colors.textPrimary)
                if (message.isNotBlank()) Text(message, style = Dot.type.caption, color = Dot.colors.textSecondary, maxLines = 6, overflow = TextOverflow.Ellipsis)
            }
            DotIconButton(Icons.Outlined.Close, stringResource(R.string.close), onClick = onDismiss, tint = Dot.colors.textSecondary)
        }
    }
}

private val MENTION_TAIL = Regex("(^|\\s)@([\\p{L}\\p{N}_-]*)$")

/** A picked document waiting to be sent: its real name and size, and whether it reached the server. */
@Composable
private fun FileThumb(pending: PendingImage, onRemove: () -> Unit) {
    val c = Dot.colors
    val file = pending.file ?: return
    Row(
        Modifier.heightIn(min = 64.dp).widthIn(max = 220.dp).clip(DotShapes.medium).border(DotSpacing.hairline * 2, if (pending.failed) c.danger else c.border, DotShapes.medium).padding(start = DotSpacing.m),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (pending.attachment == null && !pending.failed) DotSpinner(size = 16.dp) else Icon(Icons.AutoMirrored.Outlined.InsertDriveFile, null, Modifier.size(18.dp), tint = if (pending.failed) c.danger else c.textSecondary)
        Column(Modifier.padding(horizontal = DotSpacing.s).weight(1f, fill = false)) {
            Text(file.name, style = Dot.type.label, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
            Text(formatBytes(file.size), style = Dot.type.caption, color = c.textSecondary, maxLines = 1)
        }
        DotIconButton(Icons.Outlined.Close, stringResource(R.string.remove_file, file.name), onClick = onRemove, tint = c.textSecondary)
    }
}

@Composable
private fun ImageThumb(image: PendingImage, onRemove: () -> Unit) {
    val c = Dot.colors
    val remove = stringResource(R.string.remove_image)
    Box(Modifier.size(64.dp)) {
        AsyncImage(
            model = image.uri, contentDescription = stringResource(R.string.attached_image), contentScale = ContentScale.Crop,
            modifier = Modifier.fillMaxSize().clip(DotShapes.medium).border(DotSpacing.hairline * 2, if (image.failed) c.danger else c.border, DotShapes.medium),
        )
        if (image.attachment == null && !image.failed) {
            Box(Modifier.fillMaxSize().clip(DotShapes.medium).background(c.scrim), contentAlignment = Alignment.Center) { DotSpinner(size = 18.dp, color = Color.White) }
        }
        Box(
            Modifier.align(Alignment.TopEnd).size(28.dp).clip(DotShapes.circle).clickable(role = Role.Button, onClick = onRemove).semantics { contentDescription = remove },
            contentAlignment = Alignment.Center,
        ) {
            Box(Modifier.size(20.dp).clip(DotShapes.circle).background(c.inverse), contentAlignment = Alignment.Center) {
                Icon(Icons.Outlined.Close, null, Modifier.size(13.dp), tint = c.onInverse)
            }
        }
    }
}

/** The orb follows what the request is really doing, read from the streamed parts, never from the text. */
private fun orbStateOf(last: ChatMessage?, status: ChatStatus): OrbState {
    if (status == ChatStatus.Submitted || last == null || last.isUser) return OrbState.Working
    val part = last.parts.lastOrNull() ?: return OrbState.Working
    return when {
        part is Part.Tool && part.state.startsWith("input") && (part.name == "web_search" || part.name == "web_fetch") -> OrbState.Searching
        part is Part.Tool && part.state.startsWith("input") && (part.name == "invoke_agent" || part.name.startsWith("task_")) -> OrbState.Connecting
        part is Part.Tool && part.state.startsWith("input") -> OrbState.Working
        part is Part.Reasoning -> OrbState.Solving
        else -> OrbState.Composing
    }
}

/** A general chat's own controls, in its field: model (for the next answers), effort when the model has one, web search. */
@Composable
private fun ChatControls(app: AppState, chat: GeneralChat) {
    val c = Dot.colors
    val model = chat.effectiveModel
    val info by produceState<ModelInfo?>(null, model.provider, model.model) { value = runCatching { app.client.models(model.provider).firstOrNull { it.id == model.model } }.getOrNull() }
    var effortMenu by remember { mutableStateOf(false) }
    var picking by remember { mutableStateOf(false) }
    if (picking) ModelSheet(app, model, onDismiss = { picking = false }, onDefault = if (chat.model != null) ({ picking = false; app.updateChat(chat.id, buildJsonObject { put("model", kotlinx.serialization.json.JsonNull) }) }) else null) { m ->
        picking = false
        app.updateChat(chat.id, buildJsonObject { putJsonObject("model") { put("provider", m.provider); put("model", m.id); if (m.reasoning && model.reasoning != null) put("reasoning", model.reasoning) } })
    }
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.testTag("chat-controls")) {
        Row(
            Modifier.clip(DotShapes.pill).clickable(role = Role.Button, onClickLabel = stringResource(R.string.chat_model_short)) { picking = true }.heightIn(min = 40.dp).padding(horizontal = DotSpacing.s).widthIn(max = 150.dp).testTag("chat-model"),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(info?.name?.ifBlank { null } ?: model.model.substringAfterLast('/'), style = Dot.type.caption, color = c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            Icon(Icons.Outlined.ExpandMore, null, Modifier.size(14.dp), tint = c.textTertiary)
        }
        if (info?.reasoning == true) Box {
            Row(Modifier.clip(DotShapes.pill).clickable(role = Role.Button, onClickLabel = stringResource(R.string.effort)) { effortMenu = true }.heightIn(min = 40.dp).padding(horizontal = DotSpacing.s).testTag("chat-effort"), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.Psychology, stringResource(R.string.effort), Modifier.size(16.dp), tint = c.textSecondary)
                Text(" " + stringResource(effortLabel(model.reasoning)), style = Dot.type.caption, color = c.textSecondary)
            }
            DotMenu(effortMenu, { effortMenu = false }) {
                listOf(null, "low", "medium", "high").forEach { value ->
                    DotMenuItem(stringResource(effortLabel(value)), if (model.reasoning == value) Icons.Outlined.Check else null) {
                        effortMenu = false
                        app.updateChat(chat.id, buildJsonObject { putJsonObject("model") { put("provider", model.provider); put("model", model.model); if (value != null) put("reasoning", value) else put("reasoning", kotlinx.serialization.json.JsonNull) } })
                    }
                }
            }
        }
        // Web search: off is enforced on the server, the model is not given the web tools.
        Row(
            Modifier.clip(DotShapes.pill).background(if (chat.webSearch) c.accent.copy(alpha = 0.12f) else androidx.compose.ui.graphics.Color.Transparent)
                .toggleable(chat.webSearch, role = Role.Switch) { on -> app.updateChat(chat.id, buildJsonObject { put("webSearch", on) }) }
                .semantics { contentDescription = if (chat.webSearch) "web-on" else "web-off" }
                .heightIn(min = 40.dp).padding(horizontal = DotSpacing.s).testTag("chat-web"),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Outlined.Language, null, Modifier.size(16.dp), tint = if (chat.webSearch) c.accent else c.textTertiary)
            Text(" " + stringResource(R.string.web), style = Dot.type.caption, color = if (chat.webSearch) c.accent else c.textSecondary)
        }
    }
}

private fun effortLabel(value: String?) = when (value) { "low" -> R.string.effort_low; "medium" -> R.string.effort_medium; "high" -> R.string.effort_high; else -> R.string.effort_auto }

/** Edits one of the user's messages: what followed is set aside (kept), and an answer restarts from it. */
/** Confirms `/clear`: what starts over, and everything that stays. */
@Composable
private fun ClearDialog(name: String, general: Boolean, busy: Boolean, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    val kept = if (general) listOf(R.string.clear_kept_chat_settings, R.string.clear_kept_chat_running, R.string.clear_kept_chat_list)
    else listOf(R.string.clear_kept_profile, R.string.clear_kept_memory, R.string.clear_kept_tasks, R.string.clear_kept_archive)
    DotDialog(
        title = if (general) stringResource(R.string.clear_title_chat) else stringResource(R.string.clear_title, name),
        message = if (general) stringResource(R.string.clear_body_chat) else stringResource(R.string.clear_body, name),
        onDismiss = onDismiss,
        confirmLabel = if (general) stringResource(R.string.new_chat) else stringResource(R.string.clear_confirm),
        onConfirm = { if (!busy) onConfirm() },
        dismissLabel = stringResource(R.string.cancel),
    ) {
        kept.forEach { id ->
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 2.dp)) {
                Icon(Icons.Outlined.Check, null, tint = Dot.colors.textSecondary, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(DotSpacing.s))
                Text(stringResource(id), style = Dot.type.callout, color = Dot.colors.textPrimary)
            }
        }
        if (busy) Text(stringResource(R.string.clear_busy), style = Dot.type.caption, color = Dot.colors.danger, modifier = Modifier.padding(top = DotSpacing.s))
    }
}

@Composable
private fun EditMessageSheet(original: String, onDismiss: () -> Unit, onSend: (String) -> Unit) {
    var text by rememberSaveable { mutableStateOf(original) }
    DotBottomSheet(onDismiss) {
        Column(Modifier.padding(horizontal = DotSpacing.gutter).padding(bottom = DotSpacing.xl).testTag("edit-sheet"), verticalArrangement = Arrangement.spacedBy(DotSpacing.m)) {
            Text(stringResource(R.string.edit_message), style = Dot.type.title, color = Dot.colors.textPrimary)
            DotTextField(text, { text = it }, Modifier.fillMaxWidth(), singleLine = false)
            Text(stringResource(R.string.edit_note), style = Dot.type.caption, color = Dot.colors.textSecondary)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                DotButton(stringResource(R.string.cancel), onDismiss, style = ButtonStyle.Ghost, compact = true)
                Spacer(Modifier.width(DotSpacing.s))
                DotPrimaryButton(stringResource(R.string.send_edit), { onSend(text.trim()) }, enabled = text.isNotBlank() && text.trim() != original, compact = true)
            }
        }
    }
}

/** "+" holds the less frequent actions: attach files, and in a general chat, ask a companion (no separate @ button). */
@Composable
private fun PlusMenu(canAttach: Boolean, onAttach: () -> Unit, onAsk: (() -> Unit)?) {
    var open by remember { mutableStateOf(false) }
    if (onAsk == null) { DotIconButton(Icons.Outlined.Add, stringResource(R.string.attach_files), onClick = onAttach, tint = Dot.colors.textSecondary, enabled = canAttach); return }
    Box {
        DotIconButton(Icons.Outlined.Add, stringResource(R.string.add), onClick = { open = true }, tint = Dot.colors.textSecondary)
        DotMenu(open, { open = false }) {
            DotMenuItem(stringResource(R.string.attach_files), Icons.Outlined.AttachFile) { open = false; if (canAttach) onAttach() }
            DotMenuItem(stringResource(R.string.ask_companion), Icons.Outlined.AlternateEmail) { open = false; onAsk() }
        }
    }
}

/** A companion's model, from its conversation's field: the same picker, favourites first. */
@Composable
private fun AgentModelChip(app: AppState, agent: Agent) {
    val c = Dot.colors
    val model = agent.effectiveModel
    val info by produceState<ModelInfo?>(null, model.provider, model.model) { value = runCatching { app.client.models(model.provider).firstOrNull { it.id == model.model } }.getOrNull() }
    var picking by remember { mutableStateOf(false) }
    if (picking) ModelSheet(app, model, onDismiss = { picking = false }, onDefault = if (agent.model != null) ({ picking = false; app.updateAgent(agent.id, buildJsonObject { put("model", kotlinx.serialization.json.JsonNull) }) }) else null) { m ->
        picking = false
        app.updateAgent(agent.id, buildJsonObject { putJsonObject("model") { put("provider", m.provider); put("model", m.id); if (m.reasoning && model.reasoning != null) put("reasoning", model.reasoning) } })
    }
    Row(
        Modifier.clip(DotShapes.pill).clickable(role = Role.Button, onClickLabel = stringResource(R.string.chat_model_short)) { picking = true }.heightIn(min = 40.dp).padding(horizontal = DotSpacing.s).widthIn(max = 180.dp).testTag("agent-model"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(info?.name?.ifBlank { null } ?: model.model.substringAfterLast('/'), style = Dot.type.caption, color = c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        Icon(Icons.Outlined.ExpandMore, null, Modifier.size(14.dp), tint = c.textTertiary)
    }
}
