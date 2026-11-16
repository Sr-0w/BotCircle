package app.dot.opendots.ui

import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material3.Icon
import app.dot.design.DotShapes
import androidx.compose.foundation.border
import androidx.compose.ui.platform.testTag
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.outlined.Edit
import app.dot.design.components.DotTextField
import androidx.compose.material.icons.outlined.Timeline
import androidx.compose.material.icons.outlined.Inbox
import app.dot.design.components.UnreadDot
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.unit.sp
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.dot.design.Dot
import app.dot.design.DotSpacing
import app.dot.design.components.BackButton
import app.dot.design.components.ButtonStyle
import app.dot.design.components.DotButton
import app.dot.design.components.DotDialog
import app.dot.design.components.DotFilterChip
import app.dot.design.components.DotIconButton
import app.dot.design.components.DotMenu
import app.dot.design.components.DotMenuItem
import app.dot.design.components.DotSpinner
import app.dot.design.components.DotSwitch
import app.dot.design.components.DotTopBar
import app.dot.design.components.EmptyState
import app.dot.design.components.FrostedHeaderLayout
import app.dot.design.components.Hairline
import app.dot.design.components.ListRow
import app.dot.design.components.SectionLabel
import app.dot.design.components.backdropSource
import app.dot.design.components.rememberQuietBackdrop
import app.dot.design.rememberDotHaptics
import androidx.compose.runtime.staticCompositionLocalOf
import app.dot.design.components.QuietBackdrop
import app.dot.design.components.DockHeight
import app.dot.design.components.DockMargin
import androidx.compose.material.icons.outlined.Settings
import app.dot.opendots.AppState
import app.dot.opendots.AppUiState
import app.dot.opendots.BuildInfo
import app.dot.opendots.R
import app.dot.opendots.data.Activity

/** The backdrop shared by a top-level page and the floating dock over it: the dock blurs what scrolls under it. */
val LocalRootBackdrop = staticCompositionLocalOf<QuietBackdrop?> { null }

/**
 * The two header actions of the top-level pages (#47, #59): Activity (work in progress, scheduled and recent) and the
 * Inbox (decisions waiting for the user). They are not dock destinations.
 */
class RootActions(val onActivity: () -> Unit, val onInbox: () -> Unit, val working: Boolean, val waiting: Int)

val LocalRootActions = staticCompositionLocalOf<RootActions?> { null }

/**
 * A full page: content scrolling under the same frosted header as the conversation. With [onBack] it is a pushed page
 * with a Back capsule; without ([inTabs]), it is a top-level page: its list scrolls under the floating dock, which it
 * leaves room for at the end, and its header carries the Settings button.
 */
@Composable
fun QuietPage(title: String, onBack: (() -> Unit)?, inTabs: Boolean = false, subtitle: String? = null, actions: (@Composable () -> Unit)? = null, content: LazyListScope.() -> Unit) {
    val shared = if (inTabs) LocalRootBackdrop.current else null
    val own = rememberQuietBackdrop()
    val backdrop = shared ?: own
    val root = if (inTabs && onBack == null) LocalRootActions.current else null
    Box(Modifier.fillMaxSize().background(Dot.colors.background)) {
        FrostedHeaderLayout(
            backdrop,
            header = {
                DotTopBar(
                    title = title, subtitle = subtitle,
                    navigation = if (onBack == null) null else { { Box(Modifier.padding(start = DotSpacing.s)) { BackButton(onBack) } } },
                    actions = {
                        Row(Modifier.padding(end = DotSpacing.s), verticalAlignment = Alignment.CenterVertically) {
                            actions?.invoke()
                            if (root != null) {
                                Box {
                                    DotIconButton(Icons.Outlined.Timeline, stringResource(R.string.activity), onClick = root.onActivity)
                                    if (root.working) UnreadDot(Modifier.align(Alignment.TopEnd).padding(top = 10.dp, end = 10.dp), size = 6.dp)
                                }
                                Box {
                                    DotIconButton(Icons.Outlined.Inbox, if (root.waiting > 0) stringResource(R.string.inbox_waiting, root.waiting) else stringResource(R.string.inbox), onClick = root.onInbox)
                                    if (root.waiting > 0) CountBadge(root.waiting, Modifier.align(Alignment.TopEnd).padding(top = 4.dp, end = 4.dp))
                                }
                            }
                        }
                    },
                )
            },
        ) { padding ->
            LazyColumn(
                Modifier.fillMaxSize().backdropSource(backdrop),
                contentPadding = PaddingValues(
                    top = padding.calculateTopPadding(),
                    bottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding() + DotSpacing.xxl + (if (inTabs && onBack == null) DockHeight + DockMargin else 0.dp),
                ),
                content = content,
            )
        }
    }
}

// --- Scheduled tasks ---------------------------------------------------------------------------

@Composable
fun TasksScreen(app: AppState, ui: AppUiState, onOpenCode: (String) -> Unit = {}, onBack: (() -> Unit)? = null, onOpenTeam: (() -> Unit)? = null) {
    LaunchedEffect(Unit) { app.loadActivities() }
    val started = stringResource(R.string.task_started)
    var deleting by remember { mutableStateOf<Activity?>(null) }
    val activities = ui.activities
    var openTask by remember { mutableStateOf<String?>(null) }
    val background = remember(ui.tasks) { ui.tasks.values.sortedByDescending { it.createdAt } }
    val running = background.filter { it.active }
    val past = background.filterNot { it.active }.take(20)
    QuietPage(stringResource(R.string.activity), onBack = onBack, inTabs = onBack == null) {
        // #54: what the Circles say to each other is activity, not a setting.
        if (onOpenTeam != null) item(key = "team") {
            ListRow(stringResource(R.string.team_exchanges), subtitle = stringResource(R.string.team_exchanges_note), onClick = onOpenTeam, trailing = { Icon(Icons.Outlined.ChevronRight, null, tint = Dot.colors.textTertiary) })
            Hairline(inset = DotSpacing.gutter)
        }
        // Work handed to the background: what is running now, then what finished. Each card updates in place.
        listOf(R.string.tasks_running to running, R.string.tasks_finished to past).forEach { (label, list) ->
            if (list.isEmpty()) return@forEach
            item(key = "bg-$label") { SectionLabel(stringResource(label), Modifier.padding(top = DotSpacing.l)) }
            items(list, key = { "bg-" + it.id }) { task ->
                TaskCard(
                    task, onDetails = { openTask = task.id }, onAction = { app.taskAction(task.id, it) }, onOpenCode = onOpenCode,
                    modifier = Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.xs), agent = ui.agents.firstOrNull { it.id == task.agentId },
                )
            }
        }
        if (background.isNotEmpty()) item(key = "bg-end") { SectionLabel(stringResource(R.string.tasks_scheduled), Modifier.padding(top = DotSpacing.l)) }
        when {
            activities == null -> item { Box(Modifier.fillMaxWidth().padding(DotSpacing.xxxl), contentAlignment = Alignment.Center) { DotSpinner(size = 24.dp) } }
            activities.isEmpty() -> item { EmptyState(Icons.Outlined.CalendarMonth, stringResource(R.string.tasks_empty_title), stringResource(R.string.tasks_empty_body)) }
            else -> ui.agents.forEach { agent ->
                val mine = activities.filter { it.agentId == agent.id }
                if (mine.isEmpty()) return@forEach
                item(key = "h-${agent.id}") {
                    Row(Modifier.padding(start = DotSpacing.gutter, top = DotSpacing.l), verticalAlignment = Alignment.CenterVertically) {
                        CompanionOrb(agent, size = 18.dp)
                        SectionLabel(agentDisplayName(agent), Modifier.padding(start = 0.dp).width(240.dp))
                    }
                }
                items(mine, key = { it.id }) { activity ->
                    TaskRow(activity, onToggle = { app.setActivityEnabled(activity.id, it) }, onRun = { app.runActivity(activity.id) { app.notify(started) } }, onDelete = { deleting = activity })
                    Hairline(inset = DotSpacing.gutter)
                }
            }
        }
    }
    openTask?.let { id -> TaskSheet(app, ui, id) { openTask = null } }
    deleting?.let { activity ->
        DotDialog(
            title = stringResource(R.string.task_delete_title),
            message = activity.title,
            confirmLabel = stringResource(R.string.delete), dismissLabel = stringResource(R.string.cancel),
            onConfirm = { app.deleteActivity(activity.id); deleting = null }, onDismiss = { deleting = null }, destructive = true,
        )
    }
}

@Composable
private fun TaskRow(activity: Activity, onToggle: (Boolean) -> Unit, onRun: () -> Unit, onDelete: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    val haptics = rememberDotHaptics()
    Row(Modifier.fillMaxWidth().padding(start = DotSpacing.gutter, end = DotSpacing.s, top = DotSpacing.m, bottom = DotSpacing.m), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(activity.title, style = Dot.type.bodyStrong, color = if (activity.enabled) Dot.colors.textPrimary else Dot.colors.textTertiary, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(activitySummary(activity), style = Dot.type.caption, color = Dot.colors.textSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (activity.lastStatus == "error") Text(stringResource(R.string.task_last_failed), style = Dot.type.caption, color = Dot.colors.danger)
        }
        Spacer(Modifier.width(DotSpacing.m))
        DotSwitch(activity.enabled, { haptics.toggle(it); onToggle(it) })
        Box {
            DotIconButton(Icons.Outlined.MoreVert, stringResource(R.string.more), onClick = { menu = true }, tint = Dot.colors.textSecondary)
            DotMenu(menu, { menu = false }) {
                DotMenuItem(stringResource(R.string.task_run_now), Icons.Outlined.PlayArrow) { menu = false; onRun() }
                DotMenuItem(stringResource(R.string.delete), Icons.Outlined.DeleteOutline, color = Dot.colors.danger) { menu = false; onDelete() }
            }
        }
    }
}

/** A small count on a header action: only for decisions really waiting for the user. */
@Composable
private fun CountBadge(count: Int, modifier: Modifier = Modifier) {
    Box(modifier.heightIn(min = 16.dp).widthIn(min = 16.dp).clip(CircleShape).background(Dot.colors.accent).padding(horizontal = 4.dp), contentAlignment = Alignment.Center) {
        Text(if (count > 9) "9+" else count.toString(), style = Dot.type.caption.copy(fontSize = 10.sp, lineHeight = 12.sp), color = androidx.compose.ui.graphics.Color.White, maxLines = 1)
    }
}

// --- Approvals ------------------------------------------------------------------------------------

@Composable
fun ApprovalsScreen(app: AppState, ui: AppUiState, onBack: (() -> Unit)? = null) {
    val env = remember(ui.approvals, ui.agents) {
        MessageEnv(ui.agents, ui.approvals, emptyMap(), emptyMap(), false, { it }, {}, {}, { _, _ -> }, { id, approve -> app.decide(id, approve) }, { _, _, _ -> }, {}, {}, {}, {})
    }
    val pending = ui.pendingApprovals
    val recent = remember(ui.approvals) { ui.approvals.values.filter { it.status != "pending" }.sortedByDescending { it.createdAt }.take(20) }
    QuietPage(stringResource(R.string.inbox), onBack = onBack, inTabs = onBack == null) {
        if (pending.isEmpty() && recent.isEmpty()) item { EmptyState(Icons.Outlined.Shield, stringResource(R.string.approvals_empty_title), stringResource(R.string.approvals_empty_body)) }
        if (pending.isNotEmpty()) item { SectionLabel(stringResource(R.string.approvals_waiting)) }
        items(pending, key = { it.id }) { approval ->
            Column(Modifier.padding(horizontal = DotSpacing.l, vertical = DotSpacing.xs)) {
                val agent = ui.agents.firstOrNull { it.id == approval.agentId }
                Text(listOfNotNull(agent?.let { agentDisplayName(it) }, formatWhen(approval.createdAt).ifBlank { null }).joinToString(" · "), style = Dot.type.caption, color = Dot.colors.textTertiary, modifier = Modifier.padding(start = DotSpacing.xs, bottom = DotSpacing.xs))
                ApprovalCard(approval.id, null, env, approval = approval)
            }
        }
        if (recent.isNotEmpty()) item { SectionLabel(stringResource(R.string.approvals_recent), Modifier.padding(top = DotSpacing.l)) }
        items(recent, key = { it.id }) { approval ->
            ListRow(approval.summary.ifBlank { approval.action }, subtitle = approvalStatusLabel(approval.status) + formatWhen(approval.createdAt).let { if (it.isBlank()) "" else " · $it" },
                subtitleColor = if (approval.status == "failed") Dot.colors.danger else Dot.colors.textSecondary)
            Hairline(inset = DotSpacing.gutter)
        }
    }
}

// --- Settings ---------------------------------------------------------------------------------------

/** #54: the five destinations of Settings, in order. */
enum class SettingsSection(val title: Int, val note: Int) {
    Appearance(R.string.appearance, R.string.settings_appearance_note),
    Ai(R.string.ai_and_models, R.string.settings_ai_note),
    Connections(R.string.connections, R.string.settings_connections_note),
    Server(R.string.server, R.string.settings_server_note),
    About(R.string.about, R.string.settings_about_note),
}

/** One destination of Settings. Values and flows are the existing ones, reorganised. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SettingsSectionPage(app: AppState, ui: AppUiState, section: SettingsSection, onBack: () -> Unit, onOpenCatalog: () -> Unit, onOpenWeb: () -> Unit, onOpenProviders: () -> Unit, onOpenModel: () -> Unit, onOpenBehaviour: () -> Unit, onOpenCode: () -> Unit, onOpenSsh: () -> Unit = {}) {
    val chevron: @Composable () -> Unit = { Icon(Icons.Outlined.ChevronRight, null, tint = Dot.colors.textTertiary) }
    QuietPage(stringResource(section.title), onBack) {
        when (section) {
            SettingsSection.Appearance -> item {
                SectionLabel(stringResource(R.string.theme))
                FlowRow(Modifier.padding(horizontal = DotSpacing.gutter), horizontalArrangement = Arrangement.spacedBy(DotSpacing.s)) {
                    listOf("SYSTEM" to R.string.theme_system, "LIGHT" to R.string.theme_light, "DARK" to R.string.theme_dark, "OLED" to R.string.theme_oled).forEach { (mode, label) ->
                        DotFilterChip(stringResource(label), selected = ui.themeMode == mode, onClick = { app.setThemeMode(mode) }, radio = true)
                    }
                }
                Text(stringResource(R.string.theme_oled_note), style = Dot.type.caption, color = Dot.colors.textTertiary, modifier = Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.s))
                SwitchRow(stringResource(R.string.reduce_transparency), stringResource(R.string.reduce_transparency_note), ui.reduceTransparency, onChange = app::setReduceTransparency)
            }
            SettingsSection.Ai -> item {
                ListRow(stringResource(R.string.providers), subtitle = stringResource(R.string.providers_note), onClick = onOpenProviders, trailing = chevron)
                Hairline(inset = DotSpacing.gutter)
                ListRow(stringResource(R.string.default_model), subtitle = stringResource(R.string.default_model_note), onClick = onOpenModel, trailing = chevron)
                Hairline(inset = DotSpacing.gutter)
                ListRow(stringResource(R.string.agent_behaviour), subtitle = stringResource(R.string.agent_behaviour_note), onClick = onOpenBehaviour, trailing = chevron)
                Text(stringResource(R.string.settings_ai_circle_note), style = Dot.type.caption, color = Dot.colors.textTertiary, modifier = Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.l))
            }
            SettingsSection.Connections -> item {
                SectionLabel(stringResource(R.string.connections_code))
                ListRow("OpenCode", subtitle = stringResource(R.string.opencode_row_note), onClick = onOpenCode, trailing = chevron)
                SectionLabel(stringResource(R.string.connections_machines), Modifier.padding(top = DotSpacing.l))
                ListRow("SSH", subtitle = stringResource(R.string.ssh_note), onClick = onOpenSsh, trailing = chevron)
                Text(stringResource(R.string.settings_connections_scope), style = Dot.type.caption, color = Dot.colors.textTertiary, modifier = Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.l))
            }
            SettingsSection.Server -> item {
                ListRow(stringResource(R.string.server), subtitle = ui.serverUrl)
                Hairline(inset = DotSpacing.gutter)
                ListRow(stringResource(R.string.server_status), subtitle = stringResource(if (ui.connected) R.string.server_connected else R.string.reconnecting))
                Hairline(inset = DotSpacing.gutter)
                ListRow(stringResource(R.string.open_web_app), subtitle = stringResource(R.string.open_web_app_note), onClick = onOpenWeb, trailing = chevron)
            }
            SettingsSection.About -> item {
                ListRow(stringResource(R.string.version), subtitle = BuildInfo.VERSION)
                Hairline(inset = DotSpacing.gutter)
                SectionLabel(stringResource(R.string.developer_tools), Modifier.padding(top = DotSpacing.l))
                ListRow(stringResource(R.string.quiet_catalog), subtitle = stringResource(R.string.quiet_catalog_note), onClick = onOpenCatalog, trailing = chevron)
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SettingsScreen(app: AppState, ui: AppUiState, onOpenSection: (SettingsSection) -> Unit, onBack: (() -> Unit)? = null) {
    var confirmSignOut by remember { mutableStateOf(false) }
    var editingName by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { app.loadProfile() }
    QuietPage(stringResource(R.string.settings), onBack = onBack, inTabs = onBack == null) {
        // #54: one compact profile card first: the name every Circle uses, the account, sign out.
        item(key = "profile") {
            val name = ui.profile?.display.orEmpty()
            Row(
                Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.s).fillMaxWidth().clip(DotShapes.large).border(DotSpacing.hairline * 2, Dot.colors.border, DotShapes.large).padding(DotSpacing.l).testTag("profile-card"),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.size(44.dp).clip(CircleShape).background(Dot.colors.accentSoft), contentAlignment = Alignment.Center) {
                    Text((ui.profile?.firstName ?: ui.account?.email ?: "?").take(1).uppercase(), style = Dot.type.title, color = Dot.colors.accent)
                }
                Spacer(Modifier.width(DotSpacing.m))
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(name.ifBlank { stringResource(R.string.profile_add_name) }, style = Dot.type.body, color = if (name.isBlank()) Dot.colors.textSecondary else Dot.colors.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                        DotIconButton(Icons.Outlined.Edit, stringResource(R.string.profile_edit_name), onClick = { editingName = true })
                    }
                    Text(ui.account?.email.orEmpty(), style = Dot.type.caption, color = Dot.colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                DotButton(stringResource(R.string.sign_out), { confirmSignOut = true }, style = ButtonStyle.Secondary, compact = true)
            }
            // Inline edit: two fields under the card, no separate account page.
            if (editingName) {
                var first by remember { mutableStateOf(ui.profile?.firstName.orEmpty()) }
                var last by remember { mutableStateOf(ui.profile?.lastName.orEmpty()) }
                Column(Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.s).testTag("profile-edit")) {
                    Text(stringResource(R.string.profile_name_body), style = Dot.type.caption, color = Dot.colors.textSecondary)
                    Spacer(Modifier.height(DotSpacing.s))
                    DotTextField(first, { first = it.take(60) }, label = stringResource(R.string.profile_first_name))
                    Spacer(Modifier.height(DotSpacing.s))
                    DotTextField(last, { last = it.take(60) }, label = stringResource(R.string.profile_last_name), imeAction = androidx.compose.ui.text.input.ImeAction.Done)
                    Row(Modifier.fillMaxWidth().padding(top = DotSpacing.s), horizontalArrangement = Arrangement.End) {
                        DotButton(stringResource(R.string.cancel), { editingName = false }, style = ButtonStyle.Ghost, compact = true)
                        Spacer(Modifier.width(DotSpacing.s))
                        DotButton(stringResource(R.string.save), { app.saveProfile(first, last) { editingName = false } }, compact = true)
                    }
                }
            }
        }
        // #54: a short home: the profile card, then five focused destinations.
        item {
            Spacer(Modifier.height(DotSpacing.s))
            SettingsSection.entries.forEach { section ->
                ListRow(stringResource(section.title), subtitle = stringResource(section.note), onClick = { onOpenSection(section) }, trailing = { Icon(Icons.Outlined.ChevronRight, null, tint = Dot.colors.textTertiary) })
                Hairline(inset = DotSpacing.gutter)
            }
            Text("BotCircle · " + BuildInfo.VERSION, style = Dot.type.caption, color = Dot.colors.textTertiary, modifier = Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.l))
        }
    }
    if (confirmSignOut) DotDialog(
        title = stringResource(R.string.sign_out_title), message = stringResource(R.string.sign_out_body),
        confirmLabel = stringResource(R.string.sign_out), dismissLabel = stringResource(R.string.cancel),
        onConfirm = { confirmSignOut = false; app.signOut() }, onDismiss = { confirmSignOut = false }, destructive = true,
    )
}
