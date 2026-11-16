package app.dot.opendots.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import app.dot.design.DotShapes
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
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
import app.dot.opendots.data.SshConnection
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.add

/**
 * #52: machines reachable over SSH. Secrets are typed here once and never shown again; each machine lists the
 * Circles allowed to use it; the host key must be trusted before any command.
 */
@Composable
fun SshPage(app: AppState, ui: AppUiState, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    var rows by remember { mutableStateOf<List<SshConnection>?>(null) }
    var editing by remember { mutableStateOf<SshConnection?>(null) }
    var adding by remember { mutableStateOf(false) }
    var pending by remember { mutableStateOf<Pair<String, String>?>(null) }
    var busy by remember { mutableStateOf(false) }
    val ok = stringResource(R.string.ssh_ok)
    @Suppress("DEPRECATION") val clipboard = LocalClipboardManager.current
    suspend fun reload() { rows = runCatching { app.client.sshConnections() }.getOrDefault(emptyList()) }
    fun test(id: String, trust: Boolean) = scope.launch {
        busy = true
        runCatching { app.client.testSsh(id, trust) }.onSuccess { r ->
            when {
                r.ok -> { pending = null; app.notify(ok) }
                !r.trusted && r.hostKey != null -> pending = id to r.hostKey
                else -> app.notify(r.error ?: "")
            }
        }.onFailure { app.notify(it.message ?: "") }
        reload(); busy = false
    }
    LaunchedEffect(Unit) { reload() }
    QuietPage("SSH", onBack, subtitle = stringResource(R.string.ssh_note)) {
        if (rows == null) item { Box(Modifier.fillMaxWidth().padding(DotSpacing.xxxl), contentAlignment = Alignment.Center) { DotSpinner(size = 24.dp) } }
        items(rows.orEmpty(), key = { it.id }) { row ->
            Column(Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.m).testTag("ssh-row")) {
                Text(row.name, style = Dot.type.body, color = Dot.colors.textPrimary)
                Text("${row.username}@${row.host}:${row.port} · " + stringResource(when (row.status) { "ok" -> R.string.ssh_status_ok; "error" -> R.string.ssh_status_error; else -> R.string.ssh_status_unknown }), style = Dot.type.caption, color = Dot.colors.textSecondary)
                Text(row.hostKey ?: stringResource(R.string.ssh_unverified), style = Dot.type.caption, color = if (row.hostKey == null) Dot.colors.danger else Dot.colors.textTertiary)
                Text(if (row.agents.isEmpty()) stringResource(R.string.ssh_no_circle) else stringResource(R.string.ssh_circles, row.agents.mapNotNull { id -> ui.agents.firstOrNull { it.id == id }?.name }.joinToString(", ")), style = Dot.type.caption, color = Dot.colors.textSecondary)
                row.lastError?.let { Text(it, style = Dot.type.caption, color = Dot.colors.danger) }
                if (row.installCommand != null) SshPublicKey(row) { text, done -> clipboard.setText(AnnotatedString(text)); app.notify(done) }
                if (pending?.first == row.id) Column(Modifier.padding(top = DotSpacing.s).testTag("ssh-trust")) {
                    Text(stringResource(R.string.ssh_trust_note), style = Dot.type.caption, color = Dot.colors.textSecondary)
                    Text(pending!!.second, style = Dot.type.caption, color = Dot.colors.textPrimary)
                    DotButton(stringResource(R.string.ssh_trust), { test(row.id, true) }, compact = true, modifier = Modifier.padding(top = DotSpacing.xs))
                }
                Row(Modifier.padding(top = DotSpacing.s), horizontalArrangement = Arrangement.spacedBy(DotSpacing.s)) {
                    DotButton(stringResource(R.string.ssh_test), { test(row.id, false) }, style = ButtonStyle.Secondary, compact = true, enabled = !busy)
                    DotButton(stringResource(R.string.edit), { editing = row; adding = false }, style = ButtonStyle.Ghost, compact = true)
                    DotButton(stringResource(R.string.delete), { scope.launch { runCatching { app.client.deleteSsh(row.id) }; reload() } }, style = ButtonStyle.Ghost, compact = true)
                }
            }
            Hairline(inset = DotSpacing.gutter)
        }
        if (!adding && editing == null) item { Box(Modifier.padding(DotSpacing.gutter)) { DotButton(stringResource(R.string.ssh_add), { adding = true }, style = ButtonStyle.Secondary) } }
        if (adding || editing != null) item(key = "form") {
            SshForm(ui, editing, onCancel = { adding = false; editing = null }) { body ->
                scope.launch {
                    runCatching { app.client.saveSsh(editing?.id, body) }
                        .onSuccess { saved -> adding = false; editing = null; reload(); test(saved.id, false) }
                        .onFailure { app.notify(it.message ?: "") }
                }
            }
        }
    }
}

@Composable
private fun SshForm(ui: AppUiState, existing: SshConnection?, onCancel: () -> Unit, onSave: (kotlinx.serialization.json.JsonObject) -> Unit) {
    var name by remember { mutableStateOf(existing?.name.orEmpty()) }
    var host by remember { mutableStateOf(existing?.host.orEmpty()) }
    var port by remember { mutableStateOf((existing?.port ?: 22).toString()) }
    var user by remember { mutableStateOf(existing?.username.orEmpty()) }
    // "generate": BotCircle creates the key (the default for a new machine; for an existing one, only when asked).
    var auth by remember { mutableStateOf(if (existing == null || (existing.auth == "key" && existing.generatedKey)) "generate" else existing.auth) }
    var rotate by remember { mutableStateOf(false) }
    var key by remember { mutableStateOf("") }
    var passphrase by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var agents by remember { mutableStateOf(existing?.agents.orEmpty().toSet()) }
    var approval by remember { mutableStateOf(existing?.approval ?: "ask") }
    Column(Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.m).testTag("ssh-form"), verticalArrangement = Arrangement.spacedBy(DotSpacing.s)) {
        DotTextField(name, { name = it.take(80) }, label = stringResource(R.string.name))
        DotTextField(host, { host = it.take(255) }, label = stringResource(R.string.ssh_host), keyboardType = KeyboardType.Uri)
        DotTextField(user, { user = it.take(64) }, label = stringResource(R.string.ssh_user))
        DotTextField(port, { port = it.filter(Char::isDigit).take(5) }, label = stringResource(R.string.ssh_port), keyboardType = KeyboardType.Number)
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(DotSpacing.s)) {
            DotFilterChip(stringResource(R.string.ssh_key_generate), selected = auth == "generate", onClick = { auth = "generate" }, radio = true)
            DotFilterChip(stringResource(R.string.ssh_key_paste), selected = auth == "key", onClick = { auth = "key" }, radio = true)
            DotFilterChip(stringResource(R.string.ssh_password), selected = auth == "password", onClick = { auth = "password" }, radio = true)
        }
        if (auth == "generate") {
            if (existing != null) SwitchRow(stringResource(R.string.ssh_key_rotate), null, rotate) { rotate = it }
            else Text(stringResource(R.string.ssh_key_generate_note), style = Dot.type.caption, color = Dot.colors.textSecondary)
        } else if (auth == "key") {
            DotTextField(key, { key = it.take(20_000) }, label = stringResource(R.string.ssh_key), placeholder = if (existing != null) stringResource(R.string.ssh_keep_secret) else "-----BEGIN OPENSSH PRIVATE KEY-----", singleLine = false)
            DotTextField(passphrase, { passphrase = it.take(500) }, label = stringResource(R.string.ssh_passphrase), password = true)
        } else DotTextField(password, { password = it.take(500) }, label = stringResource(R.string.ssh_password), password = true, placeholder = if (existing != null) stringResource(R.string.ssh_keep_secret) else null)
        SectionLabel(stringResource(R.string.ssh_allowed))
        ui.agents.forEach { a -> SwitchRow(a.name, null, a.id in agents) { on -> agents = if (on) agents + a.id else agents - a.id } }
        SectionLabel(stringResource(R.string.ssh_approval))
        DotFilterChip(stringResource(R.string.ssh_approval_ask), selected = approval == "ask", onClick = { approval = "ask" }, radio = true)
        DotFilterChip(stringResource(R.string.ssh_approval_auto), selected = approval == "auto", onClick = { approval = "auto" }, radio = true)
        Text(stringResource(R.string.ssh_secret_note), style = Dot.type.caption, color = Dot.colors.textTertiary)
        Spacer(Modifier.height(DotSpacing.xs))
        Row(horizontalArrangement = Arrangement.spacedBy(DotSpacing.s)) {
            DotButton(stringResource(R.string.cancel), onCancel, style = ButtonStyle.Ghost)
            DotButton(stringResource(R.string.save), {
                onSave(buildJsonObject {
                    put("name", name); put("host", host); put("port", port.toIntOrNull() ?: 22); put("username", user); put("auth", if (auth == "generate") "key" else auth); put("approval", approval)
                    if (auth == "generate" && (existing == null || rotate)) put("generateKey", true)
                    putJsonArray("agents") { agents.forEach { add(it) } }
                    if (auth == "key" && key.isNotBlank()) put("privateKey", key)
                    if (auth == "key" && passphrase.isNotBlank()) put("passphrase", passphrase)
                    if (auth == "password" && password.isNotBlank()) put("password", password)
                })
            }, enabled = host.isNotBlank() && user.isNotBlank())
        }
    }
}

/** The one command that authorises BotCircle's key on the machine, and the public key itself, each copied in one tap. */
@Composable
private fun SshPublicKey(row: SshConnection, onCopy: (text: String, done: String) -> Unit) {
    val c = Dot.colors
    val commandCopied = stringResource(R.string.ssh_command_copied)
    val keyCopied = stringResource(R.string.ssh_public_key_copied)
    Column(Modifier.padding(top = DotSpacing.s).fillMaxWidth().clip(DotShapes.medium).background(c.surfaceRaised).padding(DotSpacing.m).testTag("ssh-public-key"), verticalArrangement = Arrangement.spacedBy(DotSpacing.s)) {
        Text(stringResource(R.string.ssh_install_note, row.username), style = Dot.type.caption, color = c.textSecondary)
        Text(row.installCommand.orEmpty(), style = Dot.type.caption.copy(fontFamily = FontFamily.Monospace), color = c.textPrimary, modifier = Modifier.fillMaxWidth().clip(DotShapes.small).background(c.background).padding(DotSpacing.s))
        Row(horizontalArrangement = Arrangement.spacedBy(DotSpacing.s)) {
            DotButton(stringResource(R.string.ssh_copy_command), { onCopy(row.installCommand.orEmpty(), commandCopied) }, compact = true, modifier = Modifier.testTag("ssh-copy-command"))
            DotButton(stringResource(R.string.ssh_copy_public_key), { onCopy(row.publicKey.orEmpty(), keyCopied) }, style = ButtonStyle.Ghost, compact = true)
        }
        Text(stringResource(R.string.ssh_private_stays), style = Dot.type.caption, color = c.textTertiary)
    }
}
