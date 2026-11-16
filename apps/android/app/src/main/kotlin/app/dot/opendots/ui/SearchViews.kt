package app.dot.opendots.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.KeyboardArrowUp
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.dot.design.Dot
import app.dot.design.DotShapes
import app.dot.design.DotSpacing
import app.dot.design.components.ButtonStyle
import app.dot.design.components.DotButton
import app.dot.design.components.DotFilterChip
import app.dot.design.components.DotIconButton
import app.dot.design.components.DotSpinner
import app.dot.design.components.Hairline
import app.dot.design.components.SearchField
import app.dot.opendots.AppState
import app.dot.opendots.AppUiState
import app.dot.opendots.R
import app.dot.opendots.data.ArchivedThread
import app.dot.opendots.data.SearchHit
import app.dot.opendots.data.ThreadMatch
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** #58: matched words in a snippet, highlighted. */
fun highlighted(text: String, ranges: List<List<Int>>, color: androidx.compose.ui.graphics.Color): AnnotatedString = buildAnnotatedString {
    append(text)
    ranges.forEach { r -> if (r.size == 2 && r[0] in 0..text.length && r[1] in r[0]..text.length) addStyle(SpanStyle(background = color, fontWeight = FontWeight.SemiBold), r[0], r[1]) }
}

/**
 * #58: search every conversation's messages — all, chats only, Circles (or one Circle), archives on request — and
 * open a result at its exact message.
 */
@Composable
fun SearchPage(app: AppState, ui: AppUiState, initial: String, onBack: () -> Unit, onOpenChat: (chatId: String) -> Unit, onOpenAgent: (agentId: String) -> Unit) {
    val c = Dot.colors
    var q by rememberSaveable { mutableStateOf(initial) }
    var scope by rememberSaveable { mutableStateOf("all") }
    var agentId by rememberSaveable { mutableStateOf<String?>(null) }
    var archived by rememberSaveable { mutableStateOf(false) }
    var recent by rememberSaveable { mutableStateOf(false) }
    var hits by remember { mutableStateOf<List<SearchHit>?>(null) }
    var more by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var reading by remember { mutableStateOf<SearchHit?>(null) }
    val coroutines = rememberCoroutineScope()
    LaunchedEffect(q, scope, agentId, archived, recent) {
        if (q.isBlank()) { hits = null; more = false; return@LaunchedEffect }
        delay(250); loading = true; error = null
        runCatching { app.client.search(q.trim(), scope, if (scope == "circles") agentId else null, archived, if (recent) "recent" else "relevance") }
            .onSuccess { hits = it.hits; more = it.more }.onFailure { error = it.message }
        loading = false
    }
    QuietPage(stringResource(R.string.search_title), onBack) {
        item {
            SearchField(q, { q = it.take(300) }, Modifier.padding(horizontal = DotSpacing.gutter).fillMaxWidth().testTag("search-field"), placeholder = stringResource(R.string.search_all_hint))
            Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.s), horizontalArrangement = Arrangement.spacedBy(DotSpacing.s), verticalAlignment = Alignment.CenterVertically) {
                DotFilterChip(stringResource(R.string.search_scope_all), scope == "all", { scope = "all" }, radio = true)
                DotFilterChip(stringResource(R.string.chats), scope == "chats", { scope = "chats" }, radio = true)
                DotFilterChip(stringResource(R.string.companions), scope == "circles", { scope = "circles" }, radio = true)
                DotFilterChip(stringResource(R.string.search_recent), recent, { recent = !recent })
                DotFilterChip(stringResource(R.string.search_archived), archived, { archived = !archived })
            }
            if (scope == "circles" && ui.agents.isNotEmpty()) Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = DotSpacing.gutter), horizontalArrangement = Arrangement.spacedBy(DotSpacing.s)) {
                DotFilterChip(stringResource(R.string.search_all_circles), agentId == null, { agentId = null }, radio = true)
                ui.agents.forEach { a -> DotFilterChip(agentDisplayName(a), agentId == a.id, { agentId = a.id }, radio = true) }
            }
        }
        when {
            loading && hits == null -> item { Box(Modifier.fillMaxWidth().padding(DotSpacing.xxl), contentAlignment = Alignment.Center) { DotSpinner(size = 24.dp) } }
            error != null -> item { Text(error.orEmpty(), style = Dot.type.callout, color = c.danger, modifier = Modifier.padding(DotSpacing.gutter)) }
            hits == null -> item { Text(stringResource(R.string.search_help), style = Dot.type.callout, color = c.textSecondary, modifier = Modifier.padding(DotSpacing.gutter)) }
            hits!!.isEmpty() -> item { Text(stringResource(R.string.search_none), style = Dot.type.callout, color = c.textSecondary, modifier = Modifier.padding(DotSpacing.gutter)) }
        }
        items(hits.orEmpty(), key = { it.messageId }) { hit ->
            val agent = hit.agentId?.let { id -> ui.agents.firstOrNull { it.id == id } }
            Row(
                Modifier.fillMaxWidth().clickable(role = Role.Button) {
                    when {
                        hit.kind == "chat" -> { app.focusOn(hit.conversationId, hit.messageId); onOpenChat(hit.conversationId) }
                        hit.current && hit.agentId != null -> { app.focusOn(hit.agentId, hit.messageId); onOpenAgent(hit.agentId) }
                        else -> reading = hit
                    }
                }.heightIn(min = 64.dp).padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.m).testTag("search-hit"),
                verticalAlignment = Alignment.Top,
            ) {
                if (agent != null) CompanionOrb(agent, size = 28.dp)
                else Box(Modifier.size(28.dp).clip(DotShapes.circle).background(c.surfaceRaised), contentAlignment = Alignment.Center) { Icon(Icons.Outlined.Forum, null, Modifier.size(15.dp), tint = c.textSecondary) }
                Spacer(Modifier.width(DotSpacing.m))
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(hit.title, style = Dot.type.label, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                        Text("  " + stringResource(when { hit.kind == "chat" -> R.string.search_kind_chat; hit.current -> R.string.search_kind_circle; else -> R.string.archived_thread }) + (if (hit.archived) " · " + stringResource(R.string.archived_short) else ""), style = Dot.type.caption, color = c.textTertiary, maxLines = 1)
                        Spacer(Modifier.weight(1f))
                        Text(formatWhen(hit.createdAt).substringBefore(","), style = Dot.type.caption, color = c.textTertiary)
                    }
                    Text(
                        buildAnnotatedString {
                            append(if (hit.role == "user") stringResource(R.string.you) + " : " else (if (hit.kind == "chat") stringResource(R.string.search_assistant) else hit.title) + " : ")
                            append(highlighted(hit.snippet, hit.highlights, c.accent.copy(alpha = 0.28f)))
                        },
                        style = Dot.type.callout, color = c.textSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            Hairline(inset = DotSpacing.gutter)
        }
        if (more) item {
            Box(Modifier.fillMaxWidth().padding(DotSpacing.m), contentAlignment = Alignment.Center) {
                DotButton(stringResource(R.string.search_more), {
                    coroutines.launch { runCatching { app.client.search(q.trim(), scope, if (scope == "circles") agentId else null, archived, if (recent) "recent" else "relevance", offset = hits?.size ?: 0) }.onSuccess { r -> hits = hits.orEmpty() + r.hits; more = r.more } }
                }, style = ButtonStyle.Ghost, compact = true)
            }
        }
    }
    reading?.let { hit -> ArchivedThreadReader(app, ui, ArchivedThread(hit.conversationId, archivedAt = hit.createdAt), focusId = hit.messageId) { reading = null } }
}

/** #58: find in the open thread — whole history, previous / next, "2 / 5"; the match is scrolled to and highlighted. */
@Composable
fun ThreadFindBar(app: AppState, conversation: () -> String?, onFocus: (String) -> Unit, onClose: () -> Unit) {
    val c = Dot.colors
    var q by remember { mutableStateOf("") }
    var matches by remember { mutableStateOf<List<ThreadMatch>?>(null) }
    var index by remember { mutableIntStateOf(0) }
    val focus = remember { FocusRequester() }
    BackHandler(onBack = onClose)
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    LaunchedEffect(q) {
        if (q.isBlank()) { matches = null; return@LaunchedEffect }
        delay(250)
        val id = conversation() ?: return@LaunchedEffect
        val found = runCatching { app.client.searchThread(id, q.trim()) }.getOrDefault(emptyList())
        matches = found; index = (found.size - 1).coerceAtLeast(0)
        found.lastOrNull()?.let { onFocus(it.messageId) }
    }
    fun go(delta: Int) { val list = matches ?: return; if (list.isEmpty()) return; index = (index + delta + list.size) % list.size; onFocus(list[index].messageId) }
    Row(
        Modifier.fillMaxWidth().padding(horizontal = DotSpacing.m, vertical = DotSpacing.xs).clip(DotShapes.pill).background(c.surfaceRaised.copy(alpha = 0.96f))
            .border(DotSpacing.hairline * 2, c.border, DotShapes.pill).padding(start = DotSpacing.m).testTag("thread-find"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Outlined.Search, null, Modifier.size(16.dp), tint = c.textTertiary)
        Spacer(Modifier.width(DotSpacing.s))
        val hint = stringResource(R.string.search_in_thread_hint)
        Box(Modifier.weight(1f).heightIn(min = 44.dp), contentAlignment = Alignment.CenterStart) {
            if (q.isEmpty()) Text(hint, style = Dot.type.callout, color = c.textTertiary)
            BasicTextField(q, { q = it.take(200) }, singleLine = true, textStyle = Dot.type.callout.copy(color = c.textPrimary), cursorBrush = SolidColor(c.accent), modifier = Modifier.fillMaxWidth().focusRequester(focus).semantics { contentDescription = hint })
        }
        matches?.let { Text(if (it.isEmpty()) stringResource(R.string.search_none_short) else "${index + 1} / ${it.size}", style = Dot.type.caption, color = c.textSecondary, modifier = Modifier.testTag("thread-find-position")) }
        DotIconButton(Icons.Outlined.KeyboardArrowUp, stringResource(R.string.previous), onClick = { go(-1) }, enabled = !matches.isNullOrEmpty(), tint = c.textSecondary)
        DotIconButton(Icons.Outlined.KeyboardArrowDown, stringResource(R.string.next), onClick = { go(1) }, enabled = !matches.isNullOrEmpty(), tint = c.textSecondary)
        DotIconButton(Icons.Outlined.Close, stringResource(R.string.close), onClick = onClose, tint = c.textSecondary)
    }
}
