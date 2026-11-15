package app.dot.opendots.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import app.dot.design.Dot
import app.dot.design.DotShapes
import app.dot.design.DotSpacing
import app.dot.design.components.ButtonStyle
import app.dot.design.components.DotButton
import app.dot.design.components.DotCard
import app.dot.design.components.DotSpinner
import app.dot.design.components.DotTextField
import app.dot.design.components.Hairline
import app.dot.design.components.ListRow
import app.dot.design.components.SectionLabel
import app.dot.opendots.AppState
import app.dot.opendots.R
import app.dot.opendots.data.CodexLogin
import app.dot.opendots.data.ServerSettings
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Reads the server settings and re-reads them after every change, so the page always shows the stored state. */
@Composable
private fun rememberServerSettings(app: AppState): Pair<ServerSettings?, (JsonObject) -> Unit> {
    var settings by remember { mutableStateOf<ServerSettings?>(null) }
    var revision by remember { mutableStateOf(0) }
    LaunchedEffect(revision) { runCatching { app.client.settings() }.onSuccess { settings = it }.onFailure { app.notify(it.message?.ifBlank { null } ?: AppState.FAILED) } }
    return settings to { patch -> app.run { app.client.updateSettings(patch); revision++ } }
}

@Composable
private fun ProviderCard(name: String, method: String, state: String, detail: String?, content: @Composable () -> Unit) {
    val c = Dot.colors
    DotCard(Modifier.fillMaxWidth().padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.xs).testTag("provider-$state")) {
        Row(verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f)) {
                Text(name, style = Dot.type.headline, color = c.textPrimary, modifier = Modifier.semantics { heading() })
                Text(method, style = Dot.type.caption, color = c.textSecondary)
                if (!detail.isNullOrBlank()) Text(detail, style = Dot.type.caption.copy(fontFamily = FontFamily.Monospace), color = c.textTertiary, maxLines = 1)
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(6.dp).clip(DotShapes.circle).background(if (state == "connected") c.success else if (state == "error") c.danger else c.textTertiary))
                Spacer(Modifier.width(DotSpacing.s))
                Text(
                    stringResource(when (state) { "connected" -> R.string.provider_connected; "error" -> R.string.provider_error; "checking" -> R.string.provider_checking; else -> R.string.provider_disconnected }),
                    style = Dot.type.caption, color = if (state == "error") c.danger else c.textSecondary,
                )
            }
        }
        Spacer(Modifier.height(DotSpacing.m))
        content()
    }
}

/**
 * Model providers, side by side: OpenRouter (API key), ChatGPT / Codex (device-code sign-in) and Ollama (local). Each
 * shows how it authenticates and whether it is connected. Secrets are sent once and never shown back in full.
 */
@Composable
fun ProvidersPage(app: AppState, onBack: () -> Unit, onChooseModel: () -> Unit) {
    val context = LocalContext.current
    val (settings, update) = rememberServerSettings(app)
    var key by rememberSaveable { mutableStateOf("") }
    var ollama by rememberSaveable(settings?.ollamaUrl) { mutableStateOf(settings?.ollamaUrl.orEmpty()) }
    var codex by remember { mutableStateOf<Boolean?>(null) }
    var codexError by remember { mutableStateOf<String?>(null) }
    var login by remember { mutableStateOf<CodexLogin?>(null) }
    var ollamaCount by remember { mutableStateOf<Int?>(null) }
    // While a sign-in is pending the account is polled, exactly as the web app does.
    LaunchedEffect(login) {
        while (true) {
            runCatching { app.client.codexAccount() }.onSuccess { status -> codex = status.account != null; codexError = status.error; if (status.account != null || status.error != null) login = null }.onFailure { codex = false }
            if (login == null) break
            delay(3000)
        }
    }
    LaunchedEffect(settings?.ollamaUrl) { ollamaCount = if (settings?.ollamaUrl.isNullOrBlank()) null else runCatching { app.client.ollamaModels(null).size }.getOrDefault(-1) }
    QuietPage(stringResource(R.string.providers), onBack, subtitle = stringResource(R.string.providers_note)) {
        if (settings == null) { item { Box(Modifier.fillMaxWidth().padding(DotSpacing.xxxl), contentAlignment = Alignment.Center) { DotSpinner(size = 24.dp) } }; return@QuietPage }
        item(key = "openrouter") {
            ProviderCard("OpenRouter", stringResource(R.string.provider_api_key), if (settings.openrouterKey != null) "connected" else "disconnected", settings.openrouterKey) {
                DotTextField(key, { key = it.trim() }, Modifier.fillMaxWidth(), placeholder = "sk-or-v1-…", password = true, keyboardType = KeyboardType.Password, imeAction = ImeAction.Done)
                Spacer(Modifier.height(DotSpacing.s))
                DotButton(stringResource(if (settings.openrouterKey != null) R.string.provider_replace else R.string.provider_connect), { update(buildJsonObject { put("openrouterKey", key) }); key = "" }, enabled = key.length >= 10, compact = true)
            }
        }
        item(key = "codex") {
            ProviderCard("ChatGPT / Codex", stringResource(R.string.provider_device_code), when (codex) { null -> "checking"; true -> "connected"; else -> if (codexError != null) "error" else "disconnected" }, null) {
                val pending = login
                when {
                    codex == true -> DotButton(stringResource(R.string.provider_disconnect), { app.run { app.client.codexLogout(); codex = false } }, style = ButtonStyle.Secondary, compact = true)
                    pending != null -> {
                        Text(stringResource(R.string.codex_enter_code), style = Dot.type.callout, color = Dot.colors.textSecondary)
                        Text(pending.userCode, style = Dot.type.title.copy(fontFamily = FontFamily.Monospace), color = Dot.colors.textPrimary, modifier = Modifier.padding(vertical = DotSpacing.s))
                        Row(horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(DotSpacing.s)) {
                            DotButton(stringResource(R.string.codex_open), { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(pending.verificationUrl))) } }, compact = true)
                            DotButton(stringResource(R.string.cancel), { login = null }, style = ButtonStyle.Ghost, compact = true)
                        }
                    }
                    else -> DotButton(stringResource(R.string.codex_connect), { codexError = null; app.run { login = app.client.codexLogin() } }, compact = true)
                }
                codexError?.let { Text(it, style = Dot.type.caption, color = Dot.colors.danger, modifier = Modifier.padding(top = DotSpacing.s)) }
            }
        }
        item(key = "ollama") {
            ProviderCard(
                "Ollama", stringResource(R.string.provider_local),
                if (settings.ollamaUrl.isNullOrBlank()) "disconnected" else if (ollamaCount == -1) "error" else "connected",
                settings.ollamaUrl?.let { url -> ollamaCount?.takeIf { it >= 0 }?.let { "$url · $it" } ?: url },
            ) {
                DotTextField(ollama, { ollama = it.trim() }, Modifier.fillMaxWidth(), placeholder = "http://127.0.0.1:11434", keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done)
                Spacer(Modifier.height(DotSpacing.s))
                Row(horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(DotSpacing.s)) {
                    // The address is only saved once the server could actually reach it.
                    DotButton(stringResource(R.string.provider_connect), { app.run { app.client.ollamaModels(ollama); update(buildJsonObject { put("ollamaUrl", ollama) }) } }, style = ButtonStyle.Secondary, enabled = ollama.isNotBlank(), compact = true)
                    if (!settings.ollamaUrl.isNullOrBlank()) DotButton(stringResource(R.string.provider_disconnect), { update(JsonObject(mapOf("ollamaUrl" to JsonNull))) }, style = ButtonStyle.Ghost, compact = true)
                }
            }
        }
        item(key = "model") {
            Hairline(Modifier.padding(top = DotSpacing.l))
            SectionLabel(stringResource(R.string.default_model), Modifier.padding(top = DotSpacing.l))
            ListRow(
                settings.defaultModel.model.ifBlank { "—" }, subtitle = providerLabel(settings.defaultModel.provider) + " · " + stringResource(R.string.default_model_note), onClick = onChooseModel,
                trailing = { Text(stringResource(R.string.change), style = Dot.type.label, color = Dot.colors.accent) },
            )
        }
    }
}

/** Choosing the account's default model: what chats and companions without their own model run on. */
@Composable
fun DefaultModelPage(app: AppState, onBack: () -> Unit) {
    val (settings, update) = rememberServerSettings(app)
    if (settings == null) { QuietPage(stringResource(R.string.default_model), onBack) { item { Box(Modifier.fillMaxWidth().padding(DotSpacing.xxxl), contentAlignment = Alignment.Center) { DotSpinner(size = 24.dp) } } }; return }
    ModelPickerPage(app, stringResource(R.string.default_model), settings.defaultModel, onBack) { provider, model ->
        update(buildJsonObject { put("defaultModel", buildJsonObject { put("provider", provider); put("model", model) }) })
    }
}

/** How agents work on their own: the step limit of a turn, autonomous wake-ups, and the time zone they see. */
@Composable
fun AgentBehaviourPage(app: AppState, paused: Boolean, onBack: () -> Unit) {
    val (settings, update) = rememberServerSettings(app)
    var limit by rememberSaveable(settings?.turnStepLimit) { mutableStateOf(settings?.turnStepLimit?.toString().orEmpty()) }
    var zone by rememberSaveable(settings?.timezone) { mutableStateOf(settings?.timezone.orEmpty()) }
    QuietPage(stringResource(R.string.agent_behaviour), onBack, subtitle = stringResource(R.string.agent_behaviour_note)) {
        if (settings == null) { item { Box(Modifier.fillMaxWidth().padding(DotSpacing.xxxl), contentAlignment = Alignment.Center) { DotSpinner(size = 24.dp) } }; return@QuietPage }
        item {
            val parsed = limit.toIntOrNull()
            val valid = limit.isBlank() || (parsed != null && parsed > 0)
            Row(Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.m), verticalAlignment = Alignment.Bottom) {
                DotTextField(limit, { limit = it.filter(Char::isDigit).take(6) }, Modifier.weight(1f), label = stringResource(R.string.step_limit), placeholder = stringResource(R.string.step_limit_none), supporting = stringResource(R.string.step_limit_note), isError = !valid, keyboardType = KeyboardType.Number, imeAction = ImeAction.Done)
                Spacer(Modifier.width(DotSpacing.m))
                DotButton(stringResource(R.string.save), { update(JsonObject(mapOf("turnStepLimit" to (parsed?.let { JsonPrimitive(it) } ?: JsonNull)))) }, enabled = valid && parsed != settings.turnStepLimit, compact = true)
            }
            Hairline()
            SwitchRow(stringResource(R.string.pause_autonomous), stringResource(R.string.pause_autonomous_note), paused, onChange = app::setPaused)
            Hairline()
            Row(Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.m), verticalAlignment = Alignment.Bottom) {
                DotTextField(zone, { zone = it.trim() }, Modifier.weight(1f), label = stringResource(R.string.timezone), supporting = stringResource(R.string.timezone_note), imeAction = ImeAction.Done)
                Spacer(Modifier.width(DotSpacing.m))
                DotButton(stringResource(R.string.save), { update(buildJsonObject { put("timezone", zone) }) }, enabled = zone.isNotBlank() && zone != settings.timezone, compact = true)
            }
        }
    }
}
