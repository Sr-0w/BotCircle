package app.dot.opendots.ui

import androidx.compose.ui.platform.testTag
import app.dot.design.components.DotIconButton
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.InsertDriveFile
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.DesktopWindows
import androidx.compose.material.icons.outlined.SmartToy
import androidx.compose.material3.Icon
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.dot.design.Dot
import app.dot.design.DotShapes
import app.dot.design.DotSpacing
import app.dot.design.components.ButtonStyle
import app.dot.design.components.DotButton
import app.dot.design.components.DotCheckbox
import app.dot.design.components.DotFilterChip
import app.dot.design.components.DotPrimaryButton
import app.dot.design.components.DotSpinner
import app.dot.design.components.DotSwitch
import app.dot.design.components.DotTextField
import app.dot.design.components.EmptyState
import app.dot.design.components.Hairline
import app.dot.design.components.ListRow
import app.dot.design.components.SearchField
import app.dot.design.components.SectionLabel
import app.dot.design.components.UnreadDot
import app.dot.design.rememberDotHaptics
import app.dot.opendots.AppState
import app.dot.opendots.AppUiState
import app.dot.opendots.R
import app.dot.opendots.data.Agent
import app.dot.opendots.data.ModelInfo
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

private val MARKDOWN_NOISE = Regex("[*_`#>]+")

/**
 * The Companions page: the app's home. A full-screen list of who you can talk to, each with its own dot, what it last
 * said or what it is doing right now, and a mark when something is waiting. One tap opens the conversation.
 */
@Composable
fun CompanionsPage(ui: AppUiState, onOpen: (Agent) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    val shown = remember(ui.agents, query) {
        val q = query.trim().lowercase()
        if (q.isEmpty()) ui.agents else ui.agents.filter { q in it.name.lowercase() || q in it.description.lowercase() }
    }
    QuietPage(stringResource(R.string.companions), onBack = null, inTabs = true, subtitle = if (!ui.connected) stringResource(R.string.reconnecting) else if (ui.paused) stringResource(R.string.paused_long) else null) {
        if (ui.agents.size > 5) item {
            SearchField(query, { query = it }, Modifier.fillMaxWidth().padding(horizontal = DotSpacing.gutter).padding(bottom = DotSpacing.s), placeholder = stringResource(R.string.search_companions))
        }
        if (ui.agents.isEmpty()) item { EmptyState(Icons.Outlined.SmartToy, stringResource(R.string.companions_empty_title), stringResource(R.string.companions_empty_body)) }
        items(shown, key = { it.id }) { agent ->
            CompanionRow(agent) { onOpen(agent) }
            Hairline(inset = DotSpacing.gutter + 48.dp + DotSpacing.l)
        }
        if (ui.agents.isNotEmpty()) item {
            Text(stringResource(R.string.companions_hint), style = Dot.type.caption, color = Dot.colors.textTertiary, modifier = Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.l))
        }
    }
}

@Composable
private fun CompanionRow(agent: Agent, onClick: () -> Unit) {
    val c = Dot.colors
    val preview = when {
        agent.busy -> agent.stateDetail ?: agentStateLabel(agent.state)
        agent.state == "error" -> agentStateLabel("error")
        else -> agent.lastMessagePreview?.replace(MARKDOWN_NOISE, "")?.replace(Regex("\\s+"), " ")?.trim()?.ifBlank { null } ?: agent.description.ifBlank { stringResource(R.string.say_hello) }
    }
    Row(
        Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onClick).heightIn(min = 76.dp).padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.m),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CompanionOrb(agent, size = 48.dp)
        Spacer(Modifier.width(DotSpacing.l))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(agentDisplayName(agent), style = Dot.type.headline, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                formatWhen(agent.lastMessageAt).takeIf { it.isNotEmpty() }?.let { Text(it.substringBefore(","), style = Dot.type.caption, color = c.textTertiary, maxLines = 1) }
            }
            Text(
                preview, style = Dot.type.callout, maxLines = 2, overflow = TextOverflow.Ellipsis,
                color = if (agent.state == "error") c.danger else if (agent.unread > 0) c.textPrimary else c.textSecondary,
            )
        }
        if (agent.unread > 0) Box(Modifier.padding(start = DotSpacing.m)) { UnreadDot() }
    }
}

/**
 * A companion's profile page: who it is, which model it runs on, what it may do, and the way to its computer. Identity
 * normally changes by talking to it; this is the direct route.
 */
/** The sections of a Circle's details (#53): what it may do, what it can reach, its technical settings. */
enum class CircleSection { Permissions, Data, Advanced }

/**
 * A Circle's details (#53): a short summary — avatar, name (renamed in place with the pencil), state, description,
 * the model it really runs on — then four entries. Toggles and technical settings live in their own pages.
 */
@Composable
fun CompanionProfilePage(agent: Agent, onBack: () -> Unit, onOpenSection: (CircleSection) -> Unit, onOpenJournal: () -> Unit, onUpdate: (JsonObject) -> Unit) {
    val c = Dot.colors
    QuietPage(stringResource(R.string.companion_details), onBack) {
        item {
            Row(Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.s), verticalAlignment = Alignment.CenterVertically) {
                CompanionOrb(agent, size = 64.dp)
                Spacer(Modifier.width(DotSpacing.l))
                Column(Modifier.weight(1f)) {
                    InlineName(agent) { name -> onUpdate(buildJsonObject { put("name", name) }) }
                    Text(agent.stateDetail?.takeIf { agent.busy } ?: agentStateLabel(agent.state), style = Dot.type.callout, color = if (agent.state == "error") c.danger else c.textSecondary)
                }
            }
            if (agent.description.isNotBlank()) Text(agent.description, style = Dot.type.body, color = c.textSecondary, modifier = Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.s))
            Hairline(Modifier.padding(top = DotSpacing.s))
        }
        item {
            // The model it really runs on; its settings are under Advanced.
            ListRow(
                stringResource(R.string.model), subtitle = agent.effectiveModel.model + " · " + providerLabel(agent.effectiveModel.provider) + " · " + stringResource(if (agent.model == null) R.string.model_default else R.string.model_own),
                onClick = { onOpenSection(CircleSection.Advanced) }, trailing = { Icon(Icons.Outlined.ChevronRight, null, tint = c.textTertiary) },
            )
            Hairline()
            ListRow(stringResource(R.string.permissions), subtitle = stringResource(R.string.circle_permissions_note), onClick = { onOpenSection(CircleSection.Permissions) }, trailing = { Icon(Icons.Outlined.ChevronRight, null, tint = c.textTertiary) })
            Hairline()
            ListRow(stringResource(R.string.circle_data), subtitle = stringResource(R.string.circle_data_note), onClick = { onOpenSection(CircleSection.Data) }, trailing = { Icon(Icons.Outlined.ChevronRight, null, tint = c.textTertiary) })
            Hairline()
            ListRow(stringResource(R.string.circle_advanced), subtitle = stringResource(R.string.circle_advanced_note), onClick = { onOpenSection(CircleSection.Advanced) }, trailing = { Icon(Icons.Outlined.ChevronRight, null, tint = c.textTertiary) })
            Hairline()
            ListRow(stringResource(R.string.activity), subtitle = stringResource(R.string.journal_note), onClick = onOpenJournal, trailing = { Icon(Icons.Outlined.ChevronRight, null, tint = c.textTertiary) })
            Hairline()
        }
    }
}

/** The name, with a pencil: tapping it edits the name in place; ✓ or Done saves, × cancels. */
@Composable
private fun InlineName(agent: Agent, onSave: (String) -> Unit) {
    val c = Dot.colors
    var editing by rememberSaveable(agent.id) { mutableStateOf(false) }
    if (!editing) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(agentDisplayName(agent), style = Dot.type.display, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false).semantics { heading() })
            DotIconButton(Icons.Outlined.Edit, stringResource(R.string.rename), onClick = { editing = true }, tint = c.textSecondary)
        }
        return
    }
    var name by rememberSaveable(agent.id) { mutableStateOf(if (agent.named) agent.name else "") }
    val valid = name.isNotBlank() && name.trim().length <= 40
    val save = { if (valid) { if (name.trim() != agent.name) onSave(name.trim()); editing = false } }
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.testTag("rename")) {
        DotTextField(name, { name = it.take(40) }, Modifier.weight(1f), placeholder = stringResource(R.string.name), imeAction = ImeAction.Done, onImeAction = save)
        DotIconButton(Icons.Outlined.Check, stringResource(R.string.save), onClick = save, enabled = valid, tint = c.accent)
        DotIconButton(Icons.Outlined.Close, stringResource(R.string.cancel), onClick = { name = if (agent.named) agent.name else ""; editing = false }, tint = c.textSecondary)
    }
}

/** One section of a Circle's details. Permissions are what it may DO; Data & connections, what it can REACH. */
@Composable
fun CircleSectionPage(agent: Agent, section: CircleSection, onBack: () -> Unit, onOpenComputer: () -> Unit, onOpenFiles: () -> Unit, onOpenMemory: () -> Unit, onChangeModel: () -> Unit, onUpdate: (JsonObject) -> Unit) {
    val c = Dot.colors
    val title = stringResource(when (section) { CircleSection.Permissions -> R.string.permissions; CircleSection.Data -> R.string.circle_data; CircleSection.Advanced -> R.string.circle_advanced })
    QuietPage(title, onBack, subtitle = agentDisplayName(agent)) {
        when (section) {
            CircleSection.Permissions -> {
                val p = agent.permissions
                listOf(
                    R.string.perm_group_info to listOf(Triple("web", R.string.perm_web, p.web), Triple("mail", R.string.perm_mail, p.mail), Triple("connectors", R.string.perm_connectors, p.connectors)),
                    R.string.perm_group_computer to listOf(Triple("shell", R.string.perm_shell, p.shell), Triple("computer", R.string.perm_computer, p.computer), Triple("code", R.string.perm_code, p.code)),
                    R.string.perm_group_autonomy to listOf(Triple("manageMemory", R.string.perm_memory, p.manageMemory), Triple("manageActivities", R.string.perm_activities, p.manageActivities), Triple("messageAgents", R.string.perm_team, p.messageAgents)),
                ).forEach { (group, perms) ->
                    item(key = "g$group") { SectionLabel(stringResource(group), Modifier.padding(top = DotSpacing.l)) }
                    perms.forEach { (key, label, value) ->
                        item(key = key) { SwitchRow(stringResource(label), null, value) { on -> onUpdate(buildJsonObject { putJsonObject("permissions") { put(key, on) } }) } }
                    }
                }
                item { Text(stringResource(R.string.permissions_note), style = Dot.type.caption, color = c.textTertiary, modifier = Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.l)) }
            }
            CircleSection.Data -> {
                item { SectionLabel(stringResource(R.string.circle_knowledge), Modifier.padding(top = DotSpacing.l)) }
                item {
                    ListRow(stringResource(R.string.files), subtitle = stringResource(R.string.files_row_note), icon = Icons.AutoMirrored.Outlined.InsertDriveFile, onClick = onOpenFiles, trailing = { Icon(Icons.Outlined.ChevronRight, null, tint = c.textTertiary) })
                    Hairline()
                    ListRow(stringResource(R.string.memory), subtitle = stringResource(R.string.memory_note), onClick = onOpenMemory, trailing = { Icon(Icons.Outlined.ChevronRight, null, tint = c.textTertiary) })
                    Hairline()
                }
                item { SectionLabel(stringResource(R.string.circle_resources), Modifier.padding(top = DotSpacing.l)) }
                item {
                    ListRow(stringResource(R.string.computer_row), subtitle = stringResource(R.string.computer_row_note), icon = Icons.Outlined.DesktopWindows, onClick = onOpenComputer, trailing = { Icon(Icons.Outlined.ChevronRight, null, tint = c.textTertiary) })
                    Hairline()
                }
            }
            CircleSection.Advanced -> {
                item { SectionLabel(stringResource(R.string.model), Modifier.padding(top = DotSpacing.l)) }
                item {
                    ListRow(
                        agent.effectiveModel.model,
                        subtitle = providerLabel(agent.effectiveModel.provider) + " · " + stringResource(if (agent.model == null) R.string.model_default else R.string.model_own),
                        onClick = onChangeModel,
                        trailing = { Text(stringResource(R.string.change), style = Dot.type.label, color = c.accent) },
                    )
                    if (agent.model != null) Box(Modifier.padding(horizontal = DotSpacing.gutter).padding(bottom = DotSpacing.s)) {
                        DotButton(stringResource(R.string.model_reset), { onUpdate(JsonObject(mapOf("model" to JsonNull))) }, style = ButtonStyle.Secondary, compact = true)
                    }
                }
            }
        }
    }
}

@Composable
fun providerLabel(provider: String): String = when (provider) {
    "codex" -> "ChatGPT / Codex"
    "ollama" -> "Ollama"
    else -> "OpenRouter"
}

/** Choosing the model one companion runs on: a provider, then one of that provider's models. */
@Composable
fun ModelPickerPage(app: AppState, agent: Agent, onBack: () -> Unit) =
    ModelPickerPage(app, agentDisplayName(agent), agent.effectiveModel, onBack) { provider, model -> app.updateAgent(agent.id, buildJsonObject { putJsonObject("model") { put("provider", provider); put("model", model) } }) }

/** The same picker for anything that runs on a model: a companion or a general chat. */
@Composable
fun ModelPickerPage(app: AppState, subtitle: String, current: app.dot.opendots.data.ModelConfig, onBack: () -> Unit, onPick: (provider: String, model: String) -> Unit) {
    var provider by rememberSaveable { mutableStateOf(current.provider.takeIf { it == "codex" } ?: "openrouter") }
    var models by remember { mutableStateOf<List<ModelInfo>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var query by rememberSaveable { mutableStateOf("") }
    val failed = stringResource(R.string.generic_error)
    LaunchedEffect(provider) {
        models = null; error = null
        runCatching { app.client.models(provider) }
            .onSuccess { list -> models = list.filter { it.provider == provider && (provider != "openrouter" || it.tools) } }
            .onFailure { error = it.message?.ifBlank { null } ?: failed }
    }
    val shown = remember(models, query) {
        val q = query.trim().lowercase()
        models.orEmpty().filter { q.isEmpty() || q in it.id.lowercase() || q in it.name.lowercase() }.take(120)
    }
    QuietPage(stringResource(R.string.model), onBack, subtitle = subtitle) {
        item {
            Row(Modifier.padding(horizontal = DotSpacing.gutter), horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(DotSpacing.s)) {
                listOf("openrouter", "codex").forEach { id -> DotFilterChip(providerLabel(id), selected = provider == id, onClick = { provider = id; query = "" }, radio = true) }
            }
            SearchField(query, { query = it }, Modifier.fillMaxWidth().padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.s), placeholder = stringResource(R.string.search_models))
        }
        when {
            error != null -> item { EmptyState(Icons.Outlined.SmartToy, stringResource(R.string.models_unavailable), error.orEmpty() + if (provider == "codex") "\n" + stringResource(R.string.models_codex_hint) else "") }
            models == null -> item { Box(Modifier.fillMaxWidth().padding(DotSpacing.xxxl), contentAlignment = Alignment.Center) { DotSpinner(size = 24.dp) } }
            shown.isEmpty() -> item { EmptyState(Icons.Outlined.SmartToy, stringResource(R.string.models_unavailable), if (provider == "codex") stringResource(R.string.models_codex_hint) else "") }
            else -> items(shown, key = { it.id }) { model ->
                val selected = current.provider == provider && current.model == model.id
                Row(
                    Modifier.fillMaxWidth()
                        .selectable(selected, role = Role.RadioButton) {
                            onPick(provider, model.id)
                            onBack()
                        }
                        .heightIn(min = 60.dp).padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.s),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(model.name.ifBlank { model.id }, style = Dot.type.bodyStrong, color = Dot.colors.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(model.id, style = Dot.type.caption.copy(fontFamily = FontFamily.Monospace), color = Dot.colors.textTertiary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    DotCheckbox(selected, Modifier.padding(start = DotSpacing.m))
                }
            }
        }
    }
}

/** A setting with a switch: the whole row toggles (one 48dp+ target, one TalkBack node), with a light haptic. */
@Composable
fun SwitchRow(title: String, subtitle: String?, checked: Boolean, enabled: Boolean = true, onChange: (Boolean) -> Unit) {
    val haptics = rememberDotHaptics()
    Row(
        Modifier.fillMaxWidth().heightIn(min = 52.dp)
            .toggleable(checked, enabled = enabled, role = Role.Switch) { haptics.toggle(it); onChange(it) }
            .padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.s),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = Dot.type.bodyStrong, color = Dot.colors.textPrimary)
            if (subtitle != null) Text(subtitle, style = Dot.type.caption, color = Dot.colors.textSecondary)
        }
        Spacer(Modifier.width(DotSpacing.m))
        DotSwitch(checked, null, enabled = enabled)
    }
}

