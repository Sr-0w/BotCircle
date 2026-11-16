package app.dot.opendots.ui

import android.app.Activity
import android.view.WindowManager
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.dot.design.Dot
import app.dot.design.DotSpacing
import app.dot.design.components.ButtonStyle
import app.dot.design.components.DotButton
import app.dot.design.components.DotDialog
import app.dot.design.components.DotTextField
import app.dot.design.components.SearchField
import app.dot.opendots.AppState
import app.dot.opendots.R
import app.dot.opendots.chat.TemporaryProblem
import app.dot.opendots.data.ModelConfig
import app.dot.opendots.data.ModelInfo
import kotlin.coroutines.cancellation.CancellationException

/** A separate native surface: no normal composer, attachments, mentions, tasks, export or share. */
@Composable
fun TemporaryChatPage(app: AppState, onBack: () -> Unit, onNormalChat: () -> Unit) {
    val activity = LocalContext.current as? Activity
    DisposableEffect(activity) {
        val window = activity?.window
        val secure = WindowManager.LayoutParams.FLAG_SECURE
        val alreadySecure = window?.let { (it.attributes.flags and secure) != 0 } ?: false
        window?.addFlags(secure)
        onDispose { if (!alreadySecure) window?.clearFlags(secure) }
    }
    val session = app.temporaryChat
    val state by session.state.collectAsStateWithLifecycle()
    // These are UI-only controls; neither content, ID nor draft uses rememberSaveable.
    var confirmClose by remember { mutableStateOf(false) }
    var picker by remember { mutableStateOf(false) }
    var provider by remember { mutableStateOf(state.model?.provider ?: "openrouter") }
    var query by remember { mutableStateOf("") }
    var models by remember { mutableStateOf<List<ModelInfo>>(emptyList()) }
    var modelsFailed by remember { mutableStateOf(false) }
    LaunchedEffect(picker, provider) {
        if (!picker) return@LaunchedEffect
        models = emptyList(); modelsFailed = false
        try { models = app.client.models(provider).filter { it.provider == provider } }
        catch (e: Exception) { if (e is CancellationException) throw e; modelsFailed = true }
    }
    val c = Dot.colors
    QuietPage(
        stringResource(R.string.temporary_chat), onBack,
        subtitle = stringResource(R.string.temporary_indicator),
    ) {
        item {
            Column(Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.m), verticalArrangement = Arrangement.spacedBy(DotSpacing.s)) {
                Text(stringResource(R.string.temporary_policy), color = c.textSecondary, style = Dot.type.callout)
                Text(stringResource(R.string.temporary_limits), color = c.textSecondary, style = Dot.type.caption)
                Text(stringResource(R.string.temporary_navigation), color = c.textSecondary, style = Dot.type.caption)
                if (state.snapshot == null) DotButton(stringResource(R.string.temporary_start), session::start, enabled = !state.busy, modifier = Modifier.testTag("temporary-start"))
                else DotButton(stringResource(R.string.temporary_close), { confirmClose = true }, style = ButtonStyle.Secondary, modifier = Modifier.testTag("temporary-close"))
                DotButton(stringResource(R.string.temporary_normal), onNormalChat, style = ButtonStyle.Ghost, enabled = !state.busy)
                Text(stringResource(R.string.temporary_normal_note), color = c.textTertiary, style = Dot.type.caption)
            }
        }
        items(state.snapshot?.messages.orEmpty().withIndex().toList(), key = { it.index }) { (_, message) ->
            Column(Modifier.fillMaxWidth().padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.m), verticalArrangement = Arrangement.spacedBy(DotSpacing.xs)) {
                Text(if (message.role == "user") stringResource(R.string.you) else stringResource(R.string.assistant) + (message.model?.let { " · ${it.model}" } ?: ""), color = c.textSecondary, style = Dot.type.caption)
                // Plain text intentionally avoids remote image/link side effects in temporary replies.
                Text(message.content, color = c.textPrimary, style = Dot.type.body)
            }
        }
        if (state.partial.isNotEmpty()) item {
            Text(state.partial, Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.m).testTag("temporary-stream"), color = c.textPrimary, style = Dot.type.body)
        }
        state.problem?.let { problem -> item {
            Text(stringResource(when (problem) {
                TemporaryProblem.Connection -> R.string.temporary_connection
                TemporaryProblem.Interrupted -> R.string.temporary_interrupted
                TemporaryProblem.Expired -> R.string.temporary_expired
                TemporaryProblem.Unavailable -> R.string.temporary_unavailable
            }), Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.s).testTag("temporary-error"), color = c.danger, style = Dot.type.callout)
        } }
        if (state.snapshot != null) {
            item {
                DotButton(state.model?.let { "${providerLabel(it.provider)} · ${it.model}" } ?: stringResource(R.string.temporary_choose_model),
                    { picker = !picker }, enabled = !state.busy, style = ButtonStyle.Secondary,
                    modifier = Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.s))
            }
            if (picker) {
                item {
                    Row(Modifier.padding(horizontal = DotSpacing.gutter), horizontalArrangement = Arrangement.spacedBy(DotSpacing.s)) {
                        listOf("openrouter", "ollama").forEach { id ->
                            DotButton(providerLabel(id), { provider = id; query = "" }, style = if (provider == id) ButtonStyle.Primary else ButtonStyle.Ghost, compact = true)
                        }
                    }
                    SearchField(query, { query = it }, Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.s), placeholder = stringResource(R.string.search_models))
                    if (modelsFailed) Text(stringResource(R.string.models_unavailable), Modifier.padding(horizontal = DotSpacing.gutter), color = c.danger)
                }
                val shown = models.filter { query.isBlank() || it.id.contains(query, true) || it.name.contains(query, true) }.take(60)
                items(shown, key = { "${it.provider}/${it.id}" }) { model ->
                    DotButton(model.name.ifBlank { model.id }, {
                        session.model(ModelConfig(provider = model.provider, model = model.id)); picker = false
                    }, style = ButtonStyle.Ghost, modifier = Modifier.padding(horizontal = DotSpacing.gutter))
                }
            }
            item {
                Column(Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.m), verticalArrangement = Arrangement.spacedBy(DotSpacing.s)) {
                    DotTextField(state.draft, session::draft, Modifier.fillMaxWidth().testTag("temporary-message"), label = stringResource(R.string.temporary_message),
                        singleLine = false, imeAction = ImeAction.Default, enabled = !state.busy)
                    Row(horizontalArrangement = Arrangement.spacedBy(DotSpacing.s)) {
                        DotButton(stringResource(R.string.send), session::send, enabled = !state.busy && state.model != null && state.draft.isNotBlank(), modifier = Modifier.testTag("temporary-send"))
                        if (state.busy) DotButton(stringResource(R.string.temporary_stop), session::stop, style = ButtonStyle.Secondary)
                    }
                }
            }
        }
    }
    if (confirmClose) DotDialog(
        title = stringResource(R.string.temporary_close),
        message = stringResource(R.string.temporary_close_note),
        confirmLabel = stringResource(R.string.temporary_close),
        dismissLabel = stringResource(R.string.cancel),
        onDismiss = { confirmClose = false },
        onConfirm = { confirmClose = false; picker = false; session.discard() },
        destructive = true,
    )
}
