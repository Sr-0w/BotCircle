package app.dot.opendots.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import app.dot.design.Dot
import app.dot.design.DotSpacing
import app.dot.design.components.ButtonStyle
import app.dot.design.components.DotButton
import app.dot.design.components.DotFilterChip
import app.dot.design.components.DotSpinner
import app.dot.design.components.DotTextField
import app.dot.design.components.Hairline
import app.dot.design.components.SectionLabel
import app.dot.opendots.AppState
import app.dot.opendots.AppUiState
import app.dot.opendots.R
import app.dot.opendots.data.HaInstance
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/**
 * #39: Home Assistant through its official MCP server. Connect (Home Assistant sign-in in the browser, or a
 * long-lived token), then choose Circle by Circle who may read or drive the home; enforced on the server.
 */
@Composable
fun HomeAssistantPage(app: AppState, ui: AppUiState, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var rows by remember { mutableStateOf<List<HaInstance>?>(null) }
    var url by remember { mutableStateOf("") }
    var mode by remember { mutableStateOf("assist") }
    var token by remember { mutableStateOf("") }
    var useToken by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    val connected = stringResource(R.string.ha_connected)
    suspend fun reload() { rows = runCatching { app.client.haInstances() }.getOrDefault(emptyList()) }
    LaunchedEffect(Unit) { reload() }
    fun setAccess(row: HaInstance, agentId: String?, value: String) = scope.launch {
        runCatching {
            app.client.haPolicy(row.id, buildJsonObject {
                if (agentId == null) put("chats", value) else putJsonObject("agents") { row.policy.agents.forEach { (k, v) -> put(k, v) }; put(agentId, value) }
            })
        }.onFailure { app.notify(it.message ?: "") }
        reload()
    }
    val levels = listOf("none" to stringResource(R.string.ha_none), "read" to stringResource(R.string.ha_read), "control" to stringResource(R.string.ha_control))
    QuietPage("Home Assistant", onBack, subtitle = stringResource(R.string.ha_note)) {
        if (rows == null) item { Box(Modifier.fillMaxWidth().padding(DotSpacing.xxxl), contentAlignment = Alignment.Center) { DotSpinner(size = 24.dp) } }
        items(rows.orEmpty(), key = { it.id }) { row ->
            Column(Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.m).testTag("ha-row")) {
                Text(row.name, style = Dot.type.body, color = Dot.colors.textPrimary)
                Text(row.base + " · " + (if (row.mode == "assist") "Assist" else stringResource(R.string.ha_full)), style = Dot.type.caption, color = Dot.colors.textSecondary)
                Text(stringResource(R.string.ha_tools, row.tools.joinToString(", ").ifBlank { "—" }), style = Dot.type.caption, color = Dot.colors.textTertiary)
                row.lastError?.let { Text(it, style = Dot.type.caption, color = Dot.colors.danger) }
                SectionLabel(stringResource(R.string.ha_rights), Modifier.padding(top = DotSpacing.s))
                (ui.agents.map { it.id to it.name } + listOf<Pair<String?, String>>(null to stringResource(R.string.ha_chats))).forEach { (id, name) ->
                    val current = if (id == null) row.policy.chats else row.policy.agents[id] ?: "none"
                    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(name, style = Dot.type.callout, color = Dot.colors.textPrimary, modifier = Modifier.weight(1f))
                        Row(horizontalArrangement = Arrangement.spacedBy(DotSpacing.xs)) {
                            levels.forEach { (value, label) -> DotFilterChip(label, selected = current == value, onClick = { setAccess(row, id, value) }, radio = true) }
                        }
                    }
                }
                Text(stringResource(R.string.ha_sensitive, row.policy.sensitive.joinToString(", ")), style = Dot.type.caption, color = Dot.colors.textTertiary, modifier = Modifier.padding(top = DotSpacing.s))
                DotButton(stringResource(R.string.ha_disconnect), { scope.launch { runCatching { app.client.haDelete(row.id) }; reload() } }, style = ButtonStyle.Ghost, compact = true)
            }
            Hairline(inset = DotSpacing.gutter)
        }
        item(key = "connect") {
            Column(Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.m).testTag("ha-connect"), verticalArrangement = Arrangement.spacedBy(DotSpacing.s)) {
                SectionLabel(stringResource(R.string.ha_connect_title))
                DotTextField(url, { url = it.take(500) }, label = stringResource(R.string.ha_address), placeholder = "http://homeassistant.local:8123", keyboardType = KeyboardType.Uri)
                Row(horizontalArrangement = Arrangement.spacedBy(DotSpacing.s)) {
                    DotFilterChip(stringResource(R.string.ha_assist), selected = mode == "assist", onClick = { mode = "assist" }, radio = true)
                    DotFilterChip(stringResource(R.string.ha_full), selected = mode == "full", onClick = { mode = "full" }, radio = true)
                }
                if (useToken) DotTextField(token, { token = it.take(4000) }, label = stringResource(R.string.ha_token), password = true)
                DotButton(stringResource(if (useToken) R.string.ha_use_signin else R.string.ha_use_token), { useToken = !useToken }, style = ButtonStyle.Ghost, compact = true)
                DotButton(stringResource(if (useToken) R.string.ha_connect else R.string.ha_signin), {
                    busy = true
                    scope.launch {
                        if (useToken) runCatching { app.client.haToken(url.trim(), mode, token.trim()) }.onSuccess { token = ""; app.notify(connected) }.onFailure { app.notify(it.message ?: "") }
                        else runCatching { app.client.haOAuth(url.trim(), mode) }.onSuccess { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(it.authorizeUrl))) }.onFailure { app.notify(it.message ?: "") }
                        busy = false; reload()
                    }
                }, enabled = !busy && url.isNotBlank() && (!useToken || token.isNotBlank()), loading = busy)
            }
        }
    }
}
