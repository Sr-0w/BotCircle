package app.dot.opendots.ui

import android.app.Activity
import android.content.ClipData
import android.view.WindowManager
import android.graphics.BitmapFactory
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.automirrored.outlined.InsertDriveFile
import androidx.compose.material.icons.outlined.Close
import androidx.compose.runtime.produceState
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import app.dot.design.components.DotIconButton
import app.dot.opendots.BuildConfig
import app.dot.opendots.data.PickedFile
import app.dot.opendots.data.TEMPORARY_MAX_ATTACHMENTS
import app.dot.opendots.data.TEMPORARY_MAX_FILE_BYTES
import app.dot.opendots.data.TemporaryAttachment
import app.dot.opendots.data.describeFile
import app.dot.opendots.data.formatBytes
import app.dot.opendots.data.readImageForUpload
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.calculateEndPadding
import androidx.compose.foundation.layout.calculateStartPadding
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.toClipEntry
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.dot.design.Dot
import app.dot.design.DotShapes
import app.dot.design.DotSpacing
import app.dot.design.components.DotComposer
import app.dot.design.components.FrostedHeaderLayout
import app.dot.design.components.backdropSource
import app.dot.design.components.dotShimmer
import app.dot.design.components.rememberQuietBackdrop
import app.dot.opendots.AppState
import app.dot.opendots.AppUiState
import app.dot.opendots.R
import app.dot.opendots.chat.TemporaryChatState
import app.dot.opendots.chat.userText
import app.dot.opendots.chat.TemporaryProblem
import app.dot.opendots.data.Agent
import app.dot.opendots.data.ChatMessage
import app.dot.opendots.data.MessageMeta
import app.dot.opendots.data.ModelConfig
import app.dot.opendots.data.Part
import kotlinx.coroutines.launch

/** The message list of an ephemeral chat as the normal chat's messages: same bubbles, same streaming reply. */
internal fun ephemeralMessages(state: TemporaryChatState): List<ChatMessage> = buildList {
    val saved = state.snapshot?.messages.orEmpty()
    saved.forEachIndexed { index, m ->
        add(ChatMessage("e$index", m.role, listOf(Part.Text(m.content)), MessageMeta(model = m.model?.model)))
    }
    state.pending?.takeIf { saved.size <= state.pendingBase }?.let { add(ChatMessage("e-pending", "user", listOf(Part.Text(it)))) }
    if (state.partial.isNotEmpty()) add(ChatMessage("e-stream", "assistant", listOf(Part.Text(state.partial)), MessageMeta(model = state.model?.model)))
}

/** An attachment as drawn in a message: its bytes only while this session still holds them (thumbnails), else metadata. */
internal class EphemeralAttachment(val name: String, val mediaType: String, val size: Long, val bytes: ByteArray?)

/** Attachments of each message of [ephemeralMessages], by message id: the live ones for the message being sent. */
internal fun ephemeralAttachments(state: TemporaryChatState): Map<String, List<EphemeralAttachment>> = buildMap {
    state.snapshot?.messages.orEmpty().forEachIndexed { index, m ->
        val held = state.sentAttachments[index]
        val list = held?.map { EphemeralAttachment(it.name, it.mediaType, it.size, it.data) } ?: m.attachments.map { EphemeralAttachment(it.name, it.mediaType, it.size, null) }
        if (list.isNotEmpty()) put("e$index", list)
    }
    if (state.pending != null && state.attachments.isNotEmpty() && (state.snapshot?.messages?.size ?: 0) <= state.pendingBase)
        put("e-pending", state.attachments.map { EphemeralAttachment(it.name, it.mediaType, it.size, it.data) })
}

/**
 * #57: the ephemeral mode of a new chat. It looks and behaves like the general chat (same header, bubbles, composer,
 * streaming and stop) on the RAM-only [AppState.temporaryChat]. Images and files can be attached (read into memory,
 * sent with the turn, never stored); nothing is mentioned, searched on the web or run as a durable command, and nothing
 * here is saved: no saved draft, no list entry. [onNormal] switches back to a
 * normal chat, offered only while nothing was sent.
 */
@Composable
fun EphemeralChatScreen(app: AppState, ui: AppUiState, onBack: () -> Unit, onNormal: () -> Unit) {
    val activity = LocalContext.current as? Activity
    // Out of screenshots and the recents thumbnail while it is open.
    DisposableEffect(activity) {
        val window = activity?.window
        val secure = WindowManager.LayoutParams.FLAG_SECURE
        val alreadySecure = window?.let { (it.attributes.flags and secure) != 0 } ?: false
        // Debug builds stay screenshot-able for development; release builds are secured.
        if (!BuildConfig.DEBUG) window?.addFlags(secure)
        onDispose { if (!BuildConfig.DEBUG && !alreadySecure) window?.clearFlags(secure) }
    }
    val session = app.temporaryChat
    val chat by session.state.collectAsStateWithLifecycle()
    // (Re)starts the temporary conversation when none exists and nothing explains why (first open, back from the
    // background before it was created). A reported problem waits for the user to dismiss it.
    val needsStart = chat.snapshot == null && !chat.sending && chat.problem == null
    LaunchedEffect(needsStart) { if (needsStart) session.start() }

    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    val backdrop = rememberQuietBackdrop()
    val listState = remember { LazyListState() }
    // Never rememberSaveable: the text of an ephemeral chat does not enter any saved state.
    var draft by remember { mutableStateOf("") }
    var picking by remember { mutableStateOf(false) }
    val working = chat.busy && chat.snapshot != null
    val messages = remember(chat.snapshot, chat.partial, chat.pending, chat.pendingBase, chat.model) { ephemeralMessages(chat) }
    val attachmentsOf = remember(chat.snapshot, chat.pending, chat.pendingBase, chat.attachments, chat.sentAttachments) { ephemeralAttachments(chat) }
    // Picked files are read into memory only (never copied to app storage), then handed to the session.
    val context = LocalContext.current
    var reading by remember { mutableStateOf(0) }
    val tooLarge = stringResource(R.string.file_too_large)
    val uploadFailed = stringResource(R.string.upload_failed)
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        uris.take(TEMPORARY_MAX_ATTACHMENTS - chat.attachments.size).forEach { uri ->
            val picked = describeFile(context, uri)
            if (picked.size > TEMPORARY_MAX_FILE_BYTES) { app.notify(tooLarge); return@forEach }
            reading++
            scope.launch {
                try {
                    val read = readTemporaryAttachment(context, picked)
                    if (session.attach(listOf(read)) == 0) app.notify(tooLarge)
                } catch (e: Exception) {
                    if (e is kotlin.coroutines.cancellation.CancellationException) throw e
                    app.notify(uploadFailed)
                } finally { reading-- }
            }
        }
    }
    val rows = remember(messages) { messages.asReversed() }
    val lastAssistantId = remember(messages) { messages.lastOrNull { !it.isUser }?.id }
    // After a failed send the text comes back into the composer, to be sent again after checking the conversation.
    LaunchedEffect(chat.problem) { if (chat.problem != null && draft.isEmpty()) draft = chat.draft }
    val newestUserId = messages.lastOrNull { it.isUser }?.id
    LaunchedEffect(newestUserId) { if (newestUserId != null) listState.scrollToItem(0) }

    val copied = stringResource(R.string.copied)
    val codexOff = stringResource(R.string.ephemeral_codex_unavailable)
    val env = remember(working) {
        MessageEnv(
            agents = emptyList(), approvals = emptyMap(), requests = emptyMap(), drafts = emptyMap(), busy = working,
            resolveUrl = app.client::resolve,
            onCopy = { text -> scope.launch { clipboard.setClipEntry(ClipData.newPlainText("BotCircle", text).toClipEntry()); if (android.os.Build.VERSION.SDK_INT < 33) app.notify(copied) } },
            onReply = {}, onReact = { _, _ -> }, onDecide = { _, _ -> }, onAnswer = { _, _, _ -> },
            onNeedRequest = {}, onNeedDraft = {}, onOpenWeb = {}, onOpenImage = {},
            attribution = true, interactive = false, remoteMedia = false,
        )
    }
    val agent = Agent(id = "ephemeral", name = stringResource(R.string.ephemeral_chat), named = true, color = "#8E8E93")
    val canSwitch = messages.isEmpty() && !working && chat.problem == null && chat.attachments.isEmpty() && reading == 0
    var composerHeight by remember { mutableStateOf(0.dp) }
    val density = LocalDensity.current

    Box(Modifier.fillMaxSize().background(Dot.colors.background).testTag("ephemeral-chat")) {
        Box(Modifier.fillMaxSize()) {
            FrostedHeaderLayout(
                backdrop = backdrop,
                header = {
                    ChatHeader(
                        agent, ui, reconnecting = false, onBack = onBack, onOpenCompanion = null, onOpenComputer = {}, onOpenWork = {},
                        general = true, onEphemeral = onNormal.takeIf { canSwitch }, ephemeral = true,
                    )
                },
            ) { padding ->
                val direction = LocalLayoutDirection.current
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
                    chat.problem?.let { problem ->
                        item(key = "problem") {
                            TurnError(
                                stringResource(when (problem) {
                                    TemporaryProblem.Connection -> R.string.ephemeral_connection
                                    TemporaryProblem.Interrupted -> R.string.ephemeral_interrupted
                                    TemporaryProblem.Expired -> R.string.ephemeral_expired
                                    TemporaryProblem.Unavailable -> R.string.ephemeral_unavailable
                                    TemporaryProblem.Rejected -> R.string.ephemeral_rejected
                                }),
                                if (problem == TemporaryProblem.Rejected) chat.problemMessage ?: stringResource(R.string.ephemeral_rejected) else "", session::dismissProblem, Modifier.padding(top = DotSpacing.xl).testTag("ephemeral-error"),
                            )
                        }
                    }
                    if (working && chat.partial.isEmpty()) item(key = "live") {
                        val label = stringResource(R.string.state_thinking) + "…"
                        Row(Modifier.padding(top = DotSpacing.l).heightIn(min = 40.dp), verticalAlignment = Alignment.CenterVertically) {
                            ThinkingOrb(OrbState.Working, size = 22.dp, label = label)
                            Spacer(Modifier.width(DotSpacing.s + 2.dp))
                            Text(label, style = Dot.type.callout, color = Dot.colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.dotShimmer())
                        }
                    }
                    items(rows, key = { it.id }, contentType = { if (it.isUser) 0 else 1 }) { message ->
                        val attached = attachmentsOf[message.id].orEmpty()
                        Column(Modifier.padding(top = DotSpacing.l).widthIn(max = 720.dp), horizontalAlignment = Alignment.End) {
                            // A message with only attachments has no bubble of its own.
                            if (attached.isEmpty() || message.userText().isNotBlank()) MessageItem(
                                message, env,
                                streaming = chat.partial.isNotEmpty() && message.id == "e-stream",
                                showActions = message.id == lastAssistantId && !working,
                            )
                            if (attached.isNotEmpty()) EphemeralAttachments(attached, Modifier.padding(top = DotSpacing.xs))
                        }
                    }
                }
            }

            if (messages.isEmpty() && !working) Column(Modifier.align(Alignment.Center).padding(DotSpacing.gutter), horizontalAlignment = Alignment.CenterHorizontally) {
                ThinkingOrb(OrbState.Breathing, size = 64.dp, label = stringResource(R.string.chat_empty_title))
                Spacer(Modifier.height(DotSpacing.l))
                Text(stringResource(R.string.chat_empty_title), style = Dot.type.title, color = Dot.colors.textPrimary)
                Text(stringResource(R.string.ephemeral_empty_note), style = Dot.type.callout, color = Dot.colors.textSecondary, textAlign = TextAlign.Center, modifier = Modifier.padding(top = DotSpacing.s).testTag("ephemeral-note"))
            }
        }

        if (picking) ModelSheet(
            app, chat.model ?: ModelConfig(), onDismiss = { picking = false },
            unavailable = setOf("codex"), onUnavailable = { app.notify(codexOff) },
        ) { m ->
            picking = false
            session.model(ModelConfig(provider = m.provider, model = m.id))
        }

        val model = chat.model
        val ready = chat.snapshot != null && model != null
        Box(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth()
                .onSizeChanged { size -> with(density) { size.height.toDp() }.let { if (it != composerHeight) composerHeight = it } }
                .windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars))
                .padding(horizontal = DotSpacing.m).padding(bottom = DotSpacing.s),
            contentAlignment = Alignment.Center,
        ) {
            DotComposer(
                value = draft,
                onValueChange = { draft = it.take(16_000) },
                modifier = Modifier.widthIn(max = 720.dp),
                backdrop = backdrop,
                placeholder = stringResource(R.string.ephemeral_write),
                busy = working,
                canSend = ready && reading == 0 && (draft.isNotBlank() || chat.attachments.isNotEmpty()),
                onStop = session::stop,
                onSend = {
                    session.draft(draft)
                    session.send()
                    draft = ""
                },
                header = if (model != null && (chat.attachments.isEmpty() || working)) null else {
                    {
                        if (model == null) Text(stringResource(R.string.ephemeral_choose_model), style = Dot.type.caption, color = Dot.colors.textSecondary, modifier = Modifier.padding(bottom = DotSpacing.xs).testTag("ephemeral-model-hint"))
                        if (chat.attachments.isNotEmpty() && !working) Row(Modifier.horizontalScroll(rememberScrollState()).padding(bottom = DotSpacing.xs), horizontalArrangement = Arrangement.spacedBy(DotSpacing.s)) {
                            chat.attachments.forEachIndexed { index, a -> EphemeralThumb(a.name, a.mediaType, a.size, a.data) { session.removeAttachment(index) } }
                        }
                    }
                },
                // Images and files can be attached; no mentions, web search or durable commands here, and only the model can change.
                footer = {
                    PlusMenu(canAttach = chat.attachments.size < TEMPORARY_MAX_ATTACHMENTS && !working, onAttach = { picker.launch(arrayOf("*/*")) }, onAsk = null)
                    Row(
                        Modifier.clip(DotShapes.pill).clickable(role = Role.Button, onClickLabel = stringResource(R.string.chat_model_short), enabled = !working) { picking = true }
                            .heightIn(min = 40.dp).padding(horizontal = DotSpacing.s).widthIn(max = 220.dp).testTag("ephemeral-model"),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(model?.model?.substringAfterLast('/') ?: stringResource(R.string.chat_model_short), style = Dot.type.caption, color = Dot.colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                        Icon(Icons.Outlined.ExpandMore, null, Modifier.size(14.dp), tint = Dot.colors.textTertiary)
                    }
                },
            )
        }
    }
}

/** Reads a picked file into memory. Images are prepared like in a normal chat (large or exotic ones re-encoded to fit 10 MB). */
private suspend fun readTemporaryAttachment(context: android.content.Context, picked: PickedFile): TemporaryAttachment = withContext(Dispatchers.IO) {
    if (picked.isImage) {
        val image = readImageForUpload(context, picked.uri)
        TemporaryAttachment(if (image.mediaType == picked.mediaType) picked.name else image.filename, image.mediaType, image.bytes)
    } else {
        val bytes = context.contentResolver.openInputStream(picked.uri)?.use { it.readBytes() } ?: error("unreadable")
        if (bytes.size > TEMPORARY_MAX_FILE_BYTES) error("too large")
        TemporaryAttachment(picked.name, picked.mediaType, bytes)
    }
}

/** A small preview decoded from the bytes held in memory (null for metadata only or an undecodable file). */
@Composable
private fun rememberThumbnail(bytes: ByteArray?, mediaType: String): ImageBitmap? {
    if (bytes == null || !mediaType.startsWith("image/")) return null
    val bitmap by produceState<ImageBitmap?>(null, bytes) {
        value = withContext(Dispatchers.Default) {
            runCatching {
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                var sample = 1
                while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 512) sample *= 2
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
            }.getOrNull()
        }
    }
    return bitmap
}

/** A picked attachment in the composer: image thumbnail or file chip, removable until it is sent. */
@Composable
private fun EphemeralThumb(name: String, mediaType: String, size: Long, bytes: ByteArray, onRemove: () -> Unit) {
    val thumb = rememberThumbnail(bytes, mediaType)
    val remove = stringResource(R.string.remove_file, name)
    Box(Modifier.testTag("ephemeral-attachment")) {
        if (thumb != null) Image(thumb, name, Modifier.size(64.dp).clip(DotShapes.medium).border(DotSpacing.hairline * 2, Dot.colors.border, DotShapes.medium), contentScale = ContentScale.Crop)
        else AttachmentChip(name, size, Modifier.heightIn(min = 64.dp).widthIn(max = 220.dp).padding(end = 36.dp))
        DotIconButton(Icons.Outlined.Close, remove, onClick = onRemove, tint = Dot.colors.textSecondary, modifier = Modifier.align(Alignment.TopEnd))
    }
}

@Composable
private fun AttachmentChip(name: String, size: Long, modifier: Modifier = Modifier) {
    Row(
        modifier.clip(DotShapes.medium).border(DotSpacing.hairline * 2, Dot.colors.border, DotShapes.medium).padding(horizontal = DotSpacing.m),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.AutoMirrored.Outlined.InsertDriveFile, null, Modifier.size(18.dp), tint = Dot.colors.textSecondary)
        Column(Modifier.padding(horizontal = DotSpacing.s)) {
            Text(name, style = Dot.type.label, color = Dot.colors.textPrimary, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
            if (size > 0) Text(formatBytes(size), style = Dot.type.caption, color = Dot.colors.textSecondary, maxLines = 1)
        }
    }
}

/** The attachments of a user message, under its bubble: image thumbnails while their bytes are held, file chips otherwise. */
@Composable
internal fun EphemeralAttachments(attachments: List<EphemeralAttachment>, modifier: Modifier = Modifier) {
    Column(modifier.testTag("ephemeral-attachments"), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(DotSpacing.xs)) {
        attachments.forEach { a ->
            val thumb = rememberThumbnail(a.bytes, a.mediaType)
            if (thumb != null) Image(thumb, a.name, Modifier.widthIn(max = 260.dp).heightIn(max = 260.dp).clip(DotShapes.medium).border(DotSpacing.hairline * 2, Dot.colors.border, DotShapes.medium).testTag("ephemeral-image"), contentScale = ContentScale.Fit)
            else AttachmentChip(a.name, a.size, Modifier.widthIn(max = 280.dp).heightIn(min = 48.dp).semantics { contentDescription = a.name }.testTag("ephemeral-file"))
        }
    }
}
