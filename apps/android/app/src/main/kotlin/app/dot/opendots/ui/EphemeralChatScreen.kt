package app.dot.opendots.ui

import android.app.Activity
import android.content.ClipData
import android.view.WindowManager
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

/**
 * #57: the ephemeral mode of a new chat. It looks and behaves like the general chat (same header, bubbles, composer,
 * streaming and stop) on the RAM-only [AppState.temporaryChat]. Nothing is attached, mentioned, searched on the web or
 * run as a durable command, and nothing here is saved: no saved draft, no list entry. [onNormal] switches back to a
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
        window?.addFlags(secure)
        onDispose { if (!alreadySecure) window?.clearFlags(secure) }
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
    val agent = Agent(id = "ephemeral", name = stringResource(R.string.new_chat), named = true, color = "#8E8E93")
    val canSwitch = messages.isEmpty() && !working && chat.problem == null
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
                                }),
                                "", session::dismissProblem, Modifier.padding(top = DotSpacing.xl).testTag("ephemeral-error"),
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
                        MessageItem(
                            message, env,
                            streaming = chat.partial.isNotEmpty() && message.id == "e-stream",
                            showActions = message.id == lastAssistantId && !working,
                            modifier = Modifier.padding(top = DotSpacing.l).widthIn(max = 720.dp),
                        )
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
                canSend = ready && draft.isNotBlank(),
                onStop = session::stop,
                onSend = {
                    session.draft(draft)
                    session.send()
                    draft = ""
                },
                header = if (model != null) null else {
                    { Text(stringResource(R.string.ephemeral_choose_model), style = Dot.type.caption, color = Dot.colors.textSecondary, modifier = Modifier.padding(bottom = DotSpacing.xs).testTag("ephemeral-model-hint")) }
                },
                // No attachments, mentions, web search or durable commands here: only the model can change.
                footer = {
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
