package app.dot.opendots

import android.content.Intent
import android.graphics.Color as AndroidColor
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.dot.design.Dot
import app.dot.design.DotMotion
import app.dot.design.DotTheme
import app.dot.design.ThemeMode
import app.dot.design.catalog.QuietCatalogScreen
import app.dot.design.components.DotFloatingDock
import app.dot.design.components.DockMargin
import app.dot.design.components.rememberQuietBackdrop
import app.dot.opendots.ui.LocalRootBackdrop
import app.dot.opendots.ui.LocalRootActions
import app.dot.opendots.ui.RootActions
import app.dot.opendots.ui.CodeSessionsPage
import app.dot.opendots.ui.SshPage
import app.dot.opendots.ui.HomeAssistantPage
import app.dot.opendots.ui.CircleSection
import app.dot.opendots.ui.SettingsSection
import app.dot.opendots.ui.SettingsSectionPage
import app.dot.opendots.ui.CircleSectionPage
import app.dot.opendots.ui.CompanionOrb
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.ui.platform.testTag
import app.dot.design.components.DotBottomBarItem
import app.dot.design.components.DotSnackbar
import androidx.compose.foundation.layout.Column
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.Forum
import app.dot.opendots.data.Agent
import app.dot.opendots.ui.AgentBehaviourPage
import app.dot.opendots.ui.ChatSettingsPage
import app.dot.opendots.ui.JournalSheet
import app.dot.opendots.ui.MemorySheet
import app.dot.opendots.ui.TeamExchangesPage
import app.dot.opendots.ui.CodeWorkspacePage
import app.dot.opendots.ui.OpencodeInstancesPage
import app.dot.opendots.ui.DefaultModelPage
import app.dot.opendots.ui.ProvidersPage
import app.dot.opendots.ui.ChatsPage
import app.dot.opendots.ui.FilesSheet
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Shield
import app.dot.design.components.LocalReduceTransparency
import app.dot.design.rememberReducedMotion
import app.dot.opendots.ui.ApprovalsScreen
import app.dot.opendots.ui.ChatScreen
import app.dot.opendots.ui.CompanionProfilePage
import app.dot.opendots.ui.CompanionsPage
import app.dot.opendots.ui.ModelPickerPage
import app.dot.opendots.ui.DesktopScreen
import app.dot.opendots.ui.OnboardingScreen
import app.dot.opendots.ui.ServerScreen
import app.dot.opendots.ui.SettingsScreen
import app.dot.opendots.ui.SignInScreen
import app.dot.opendots.ui.StartingScreen
import app.dot.opendots.ui.TasksScreen
import app.dot.opendots.ui.UnreachableScreen
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val app: AppState by viewModels {
        val application = application as OpenDotsApp
        AppState.Factory(application.store, application.client)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent {
            val ui by app.state.collectAsStateWithLifecycle()
            val mode = runCatching { ThemeMode.valueOf(ui.themeMode) }.getOrDefault(ThemeMode.SYSTEM)
            val dark = when (mode) { ThemeMode.SYSTEM -> isSystemInDarkTheme(); ThemeMode.LIGHT -> false; else -> true }
            // Transparent bars in every theme: the page (or the frosted header) shows through, icons follow the theme.
            DisposableEffect(dark) {
                val style = if (dark) SystemBarStyle.dark(AndroidColor.TRANSPARENT) else SystemBarStyle.light(AndroidColor.TRANSPARENT, AndroidColor.TRANSPARENT)
                enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
                if (android.os.Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false
                onDispose {}
            }
            DotTheme(mode) {
                CompositionLocalProvider(LocalReduceTransparency provides ui.reduceTransparency) { OpenDotsRoot(app, ui) }
            }
        }
    }
}

@Composable
fun OpenDotsRoot(app: AppState, ui: AppUiState) {
    // Realtime only while visible.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_START) app.setForeground(true) else if (event == Lifecycle.Event.ON_STOP) app.setForeground(false)
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }

    val snackbars = remember { SnackbarHostState() }
    val failed = stringResource(R.string.generic_error)
    LaunchedEffect(app) { app.notices.collect { snackbars.showSnackbar(if (it == AppState.FAILED) failed else it) } }

    Box(Modifier.fillMaxSize().background(Dot.colors.background)) {
        when (val stage = ui.stage) {
            Stage.Starting -> StartingScreen()
            Stage.Server -> ServerScreen(app, ui)
            is Stage.Unreachable -> UnreachableScreen(app, ui, stage.message)
            is Stage.SignIn -> SignInScreen(app, ui, stage.registrationOpen)
            is Stage.Onboarding -> OnboardingScreen(app, ui, stage.keyConfigured)
            Stage.Main -> MainScreens(app, ui)
        }
        SnackbarHost(
            snackbars,
            Modifier.align(Alignment.BottomCenter).windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars)).padding(bottom = 76.dp),
        ) { DotSnackbar(it) }
    }
}


/** Top-level destinations, shown with the bottom navigation bar. */
/**
 * The dock, left to right (#47, #59): Circles · Chat · Code · Settings. This enum is the one ordered list the dock,
 * the selection and the back behaviour all read; Tasks and Approvals are header actions (Activity, Inbox), not tabs.
 */
internal enum class Tab { Circles, Chat, Code, Settings }

@Composable
private fun dockItem(tab: Tab, ui: AppUiState): DotBottomBarItem = when (tab) {
    Tab.Circles -> {
        // The primary Circle's own animated avatar stands for Circles, selected or not.
        val primary = ui.agents.firstOrNull { it.primary } ?: ui.agents.minByOrNull { it.createdAt }
        DotBottomBarItem(
            Icons.Outlined.ChatBubbleOutline, stringResource(R.string.circles), badge = ui.agents.any { it.unread > 0 },
            iconContent = primary?.let { agent -> { _ -> CompanionOrb(agent, size = 26.dp) } },
        )
    }
    Tab.Chat -> DotBottomBarItem(Icons.Outlined.Forum, stringResource(R.string.chat_tab))
    Tab.Code -> DotBottomBarItem(Icons.Outlined.Code, stringResource(R.string.code))
    Tab.Settings -> DotBottomBarItem(Icons.Outlined.Settings, stringResource(R.string.settings))
}

/** Pages pushed on top of a tab. Back always leads to the page that opened them. */
private val SETTINGS_PAGES get() = setOf(Page.Settings, Page.SettingsSection, Page.Ssh, Page.HomeAssistant, Page.Providers, Page.DefaultModel, Page.AgentBehaviour, Page.CodeInstances, Page.CodeWorkspace, Page.Team, Page.Activity, Page.Inbox)

private enum class Page { None, Chat, Profile, CircleSection, SettingsSection, Ssh, HomeAssistant, Model, Desktop, Settings, Catalog, GeneralChat, ChatSettings, ChatModel, Providers, DefaultModel, AgentBehaviour, CodeInstances, CodeWorkspace, Team, Activity, Inbox }

@Composable
private fun MainScreens(app: AppState, ui: AppUiState) {
    var tab by rememberSaveable { mutableStateOf(Tab.Circles) }
    // The app reopens on the conversation it was left on; Back leads to the Companions page.
    var page by rememberSaveable { mutableStateOf(if (ui.currentAgentId != null) Page.Chat else Page.None) }
    // The code workspace opens from a task card anywhere; Back returns to the page that opened it.
    var codeTask by rememberSaveable { mutableStateOf<String?>(null) }
    var codeFrom by rememberSaveable { mutableStateOf(Page.None) }
    var circleSection by rememberSaveable { mutableStateOf<CircleSection?>(null) }
    var settingsSection by rememberSaveable { mutableStateOf(SettingsSection.Appearance) }
    // The chat model picker opens from the chat's field or from its settings; Back returns there.
    var modelFromChat by rememberSaveable { mutableStateOf(false) }
    val openCode = { taskId: String -> codeTask = taskId; codeFrom = page; page = Page.CodeWorkspace }
    val keyboard = LocalSoftwareKeyboardController.current
    val context = LocalContext.current
    val reduced = rememberReducedMotion()
    val openWeb = { ui.serverUrl.takeIf { it.isNotBlank() }?.let { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(it))) } }; Unit }

    fun back() {
        keyboard?.hide()
        page = when (page) {
            Page.CircleSection -> Page.Profile
            // The model is set under Advanced, the computer under Data & connections.
            Page.Model, Page.Desktop -> if (circleSection != null) Page.CircleSection else Page.Profile
            Page.Profile -> Page.Chat
            Page.ChatModel -> if (modelFromChat) Page.GeneralChat else Page.ChatSettings
            Page.DefaultModel -> Page.SettingsSection
            Page.CodeWorkspace -> codeFrom
            Page.ChatSettings -> Page.GeneralChat
            // Pages opened from Settings return to it; Settings returns to the tab it was opened from.
            // Settings is a tab: its pages return to it (the tab stays selected).
            Page.SettingsSection -> Page.None
            Page.Ssh, Page.HomeAssistant -> Page.SettingsSection
            Page.Catalog -> Page.SettingsSection
            Page.Providers, Page.AgentBehaviour -> Page.SettingsSection
            Page.CodeInstances -> if (tab == Tab.Settings) Page.SettingsSection else Page.None
            Page.Team -> Page.Activity
            else -> Page.None
        }
    }
    // Predictive back: the system animates these; they only decide where "back" leads.
    BackHandler(enabled = page != Page.None) { back() }
    BackHandler(enabled = page == Page.None && tab != Tab.Circles) { tab = Tab.Circles }

    AnimatedContent(
        targetState = page,
        transitionSpec = {
            if (reduced) fadeIn(DotMotion.spec(0)) togetherWith fadeOut(DotMotion.spec(0)) else {
                val forward = targetState.ordinal > initialState.ordinal
                (fadeIn(DotMotion.mediumSpec(easing = DotMotion.decelerate)) + slideInHorizontally(DotMotion.mediumSpec()) { if (forward) it / 10 else -it / 10 }) togetherWith
                    (fadeOut(DotMotion.fastSpec(easing = DotMotion.accelerate)) + slideOutHorizontally(DotMotion.fastSpec()) { if (forward) -it / 10 else it / 10 })
            }
        },
        label = "page",
    ) { current ->
        val agent = ui.currentAgent
        val chat = ui.currentChat
        var companionFiles by remember { mutableStateOf(false) }
        var companionMemory by remember { mutableStateOf(false) }
        var companionJournal by remember { mutableStateOf(false) }
        val chatPage = current == Page.GeneralChat || current == Page.ChatSettings || current == Page.ChatModel
        when {
            current == Page.None || (chatPage && chat == null) || (agent == null && current != Page.Catalog && !chatPage && current !in SETTINGS_PAGES) -> {
                // The top-level page scrolls under a floating glass dock; both share one blur source.
                val backdrop = rememberQuietBackdrop()
                Box(Modifier.fillMaxSize()) {
                    val rootActions = RootActions(
                        onActivity = { page = Page.Activity }, onInbox = { page = Page.Inbox },
                        working = ui.activeTasks.any { it.status == "running" },
                        waiting = ui.pendingApprovals.size + ui.activeTasks.count { it.status == "waiting_for_user" },
                    )
                    CompositionLocalProvider(LocalRootBackdrop provides backdrop, LocalRootActions provides rootActions) {
                        when (tab) {
                            Tab.Circles -> CompanionsPage(ui) { picked -> app.selectAgent(picked.id); page = Page.Chat }
                            Tab.Chat -> ChatsPage(app, ui) { picked -> app.selectChat(picked.id); page = Page.GeneralChat }
                            Tab.Code -> CodeSessionsPage(app, ui, onOpen = openCode, onOpenInstances = { page = Page.CodeInstances }, onNew = { app.newCodeSession(onNoMachine = { page = Page.CodeInstances }) { id -> codeTask = id; codeFrom = Page.None; page = Page.CodeWorkspace } })
                            Tab.Settings -> SettingsScreen(app, ui, onOpenSection = { settingsSection = it; page = Page.SettingsSection })
                        }
                    }
                    DotFloatingDock(
                        items = Tab.entries.map { dockItem(it, ui) },
                        selected = tab.ordinal,
                        onSelect = { tab = Tab.entries[it] },
                        backdrop = backdrop,
                        modifier = Modifier.align(Alignment.BottomCenter).windowInsetsPadding(WindowInsets.navigationBars).padding(bottom = DockMargin).testTag("dock"),
                    )
                }
            }
            // Settings is the fourth tab now; an old saved page lands on it.
            current == Page.Settings -> LaunchedEffect(Unit) { tab = Tab.Settings; page = Page.None }
            current == Page.Activity -> TasksScreen(app, ui, onOpenCode = openCode, onBack = ::back, onOpenTeam = { page = Page.Team })
            current == Page.SettingsSection -> SettingsSectionPage(app, ui, settingsSection, onBack = ::back, onOpenCatalog = { page = Page.Catalog }, onOpenWeb = openWeb, onOpenProviders = { page = Page.Providers }, onOpenModel = { page = Page.DefaultModel }, onOpenBehaviour = { page = Page.AgentBehaviour }, onOpenCode = { page = Page.CodeInstances }, onOpenSsh = { page = Page.Ssh }, onOpenHomeAssistant = { page = Page.HomeAssistant })
            current == Page.HomeAssistant -> HomeAssistantPage(app, ui, onBack = ::back)
            current == Page.Ssh -> SshPage(app, ui, onBack = ::back)
            current == Page.Inbox -> ApprovalsScreen(app, ui, onBack = ::back)
            current == Page.Catalog -> QuietCatalogScreen(onBack = ::back)
            current == Page.Providers -> ProvidersPage(app, onBack = ::back, onChooseModel = { page = Page.DefaultModel })
            current == Page.DefaultModel -> DefaultModelPage(app, onBack = ::back)
            current == Page.AgentBehaviour -> AgentBehaviourPage(app, ui.paused, onBack = ::back)
            current == Page.Team -> TeamExchangesPage(app, ui, onBack = ::back)
            current == Page.CodeInstances -> OpencodeInstancesPage(app, onBack = ::back)
            current == Page.CodeWorkspace && codeTask != null -> CodeWorkspacePage(app, ui, codeTask!!, onBack = ::back)
            current == Page.Chat -> ChatScreen(app, ui, agent!!, onBack = ::back, onOpenCompanion = { page = Page.Profile }, onOpenDesktop = { id -> app.selectAgent(id); page = Page.Desktop }, onOpenCode = openCode, onOpenChat = { id -> app.selectChat(id); page = Page.GeneralChat })
            current == Page.GeneralChat -> ChatScreen(
                app, ui, Agent(id = chat!!.id, name = chat.title.ifBlank { stringResource(R.string.new_chat) }, named = true, color = "#8E8E93", effectiveModel = chat.effectiveModel),
                onBack = ::back, onOpenCompanion = { page = Page.ChatSettings }, general = chat, onOpenCode = openCode,
            )
            current == Page.ChatSettings -> ChatSettingsPage(app, ui, chat!!, onBack = ::back, onChangeModel = { modelFromChat = false; page = Page.ChatModel }, onDeleted = { page = Page.None })
            current == Page.ChatModel -> ModelPickerPage(app, chat!!.title, chat.effectiveModel, onBack = ::back) { provider, model ->
                app.updateChat(chat.id, buildJsonObject { putJsonObject("model") { put("provider", provider); put("model", model) } })
            }
            current == Page.Profile -> {
                LaunchedEffect(Unit) { circleSection = null }
                CompanionProfilePage(agent!!, onBack = ::back, onOpenSection = { circleSection = it; page = Page.CircleSection }, onOpenJournal = { companionJournal = true }) { patch -> app.updateAgent(agent.id, patch) }
                if (companionJournal) JournalSheet(app, agent) { companionJournal = false }
            }
            current == Page.CircleSection -> {
                CircleSectionPage(agent!!, circleSection ?: CircleSection.Permissions, onBack = ::back, onOpenComputer = { page = Page.Desktop }, onOpenFiles = { companionFiles = true }, onOpenMemory = { companionMemory = true }, onChangeModel = { page = Page.Model }, onMakePrimary = { app.setPrimaryAgent(agent.id) }, loadPresets = app::avatarPresets, onSetAvatar = { app.setAvatar(agent.id, it) }, onRestoreAvatar = { app.restoreAvatar(agent.id) }) { patch -> app.updateAgent(agent.id, patch) }
                if (companionMemory) MemorySheet(app, agent) { companionMemory = false }
                if (companionFiles) FilesSheet(app, ui, stringResource(R.string.files), agentId = agent.id, conversationId = null) { companionFiles = false }
            }
            current == Page.Model -> ModelPickerPage(app, agent!!, onBack = ::back)
            else -> DesktopScreen(app, agent!!, onBack = ::back)
        }
    }
}
