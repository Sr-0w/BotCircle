package app.dot.opendots.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Psychology
import androidx.compose.material.icons.outlined.Star
import androidx.compose.material.icons.outlined.StarBorder
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.dot.design.Dot
import app.dot.design.DotSpacing
import app.dot.design.components.DotBottomSheet
import app.dot.design.components.DotIconButton
import app.dot.design.components.DotSpinner
import app.dot.design.components.DotTextField
import app.dot.opendots.AppState
import app.dot.opendots.R
import app.dot.opendots.data.AvailableModels
import app.dot.opendots.data.FavoriteModel
import app.dot.opendots.data.ModelConfig
import app.dot.opendots.data.ModelInfo
import kotlinx.coroutines.launch

private val PROVIDER_NAMES = mapOf("openrouter" to "OpenRouter", "ollama" to "Ollama", "codex" to "ChatGPT / Codex")

/**
 * The models of every configured provider, searchable, grouped by provider, favourites first. A star keeps a model on
 * top of every picker, on every device (an account setting). [onDefault] offers to go back to the default model.
 */
@Composable
fun ModelSheet(
    app: AppState, current: ModelConfig, onDismiss: () -> Unit, onDefault: (() -> Unit)? = null,
    /** Providers shown but not selectable (an ephemeral chat cannot use Codex): [onUnavailable] says why when one is tapped. */
    unavailable: Set<String> = emptySet(), onUnavailable: () -> Unit = {},
    onPick: (ModelInfo) -> Unit,
) {
    val c = Dot.colors
    var data by remember { mutableStateOf<AvailableModels?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var favorites by remember { mutableStateOf<List<FavoriteModel>>(emptyList()) }
    var query by rememberSaveable { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    val failed = stringResource(R.string.generic_error)
    LaunchedEffect(Unit) { runCatching { app.client.availableModels() }.onSuccess { data = it; favorites = it.favorites }.onFailure { error = it.message?.ifBlank { null } ?: failed } }
    fun isFavorite(m: ModelInfo) = favorites.any { it.provider == m.provider && it.model == m.id }
    fun toggle(m: ModelInfo) {
        favorites = if (isFavorite(m)) favorites.filterNot { it.provider == m.provider && it.model == m.id } else favorites + FavoriteModel(m.provider, m.id)
        val next = favorites
        scope.launch { runCatching { app.client.setFavoriteModels(next) }.onFailure { app.notify(it.message ?: failed) } }
    }
    val favoritesTitle = stringResource(R.string.favorites)
    // Sheets are separate windows: their state is read here, in the page that opens them, so changes recompose them.
    val loaded = data
    val loadError = error
    val favs = favorites
    val q = query.trim().lowercase()
    DotBottomSheet(onDismiss) {
        Text(stringResource(R.string.chat_model_short), style = Dot.type.title, color = c.textPrimary, modifier = Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.s).semantics { heading() })
        DotTextField(query, { query = it }, Modifier.fillMaxWidth().padding(horizontal = DotSpacing.gutter), placeholder = stringResource(R.string.code_model_search))
        when {
            loadError != null -> Text(loadError, style = Dot.type.callout, color = c.danger, modifier = Modifier.padding(DotSpacing.gutter))
            loaded == null -> Box(Modifier.fillMaxWidth().padding(DotSpacing.xl), contentAlignment = Alignment.Center) { DotSpinner() }
            loaded.providers.isEmpty() -> Text(stringResource(R.string.no_provider), style = Dot.type.callout, color = c.textSecondary, modifier = Modifier.padding(DotSpacing.gutter))
            else -> {
                fun fav(m: ModelInfo) = favs.any { it.provider == m.provider && it.model == m.id }
                val visible = loaded.models.filter { q.isEmpty() || "${it.name} ${it.id} ${it.provider}".lowercase().contains(q) }
                val groups = buildList {
                    visible.filter(::fav).takeIf { it.isNotEmpty() }?.let { add(favoritesTitle to it) }
                    listOf("openrouter", "ollama", "codex").forEach { p -> visible.filter { it.provider == p && !fav(it) }.take(if (q.isEmpty()) 120 else 200).takeIf { it.isNotEmpty() }?.let { add((PROVIDER_NAMES[p] ?: p) to it) } }
                }
                LazyColumn(Modifier.fillMaxWidth().heightIn(max = 520.dp).testTag("model-sheet"), contentPadding = PaddingValues(vertical = DotSpacing.s)) {
                    loaded.providers.filter { it.error != null }.forEach { p -> item(key = "err-${p.provider}") { Text("${p.name} : ${p.error}", style = Dot.type.caption, color = c.danger, modifier = Modifier.padding(horizontal = DotSpacing.gutter)) } }
                    if (visible.isEmpty()) item { Text(stringResource(R.string.code_model_none), style = Dot.type.callout, color = c.textSecondary, modifier = Modifier.padding(DotSpacing.gutter)) }
                    groups.forEach { (title, list) ->
                        item(key = "h-$title") { Text(title.uppercase(), style = Dot.type.caption, color = c.textTertiary, modifier = Modifier.padding(horizontal = DotSpacing.gutter).padding(top = DotSpacing.m, bottom = DotSpacing.xs)) }
                        items(list, key = { "$title/${it.provider}/${it.id}" }) { m ->
                            val fav = fav(m)
                            val off = m.provider in unavailable
                            Row(Modifier.fillMaxWidth().clickable(role = Role.Button) { if (off) onUnavailable() else onPick(m) }.heightIn(min = 48.dp).padding(start = DotSpacing.gutter, end = DotSpacing.xs), verticalAlignment = Alignment.CenterVertically) {
                                Text(m.name.ifBlank { m.id }, style = Dot.type.body, color = if (off) c.textTertiary else c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                                if (title == favoritesTitle) Text(PROVIDER_NAMES[m.provider] ?: m.provider, style = Dot.type.caption, color = c.textTertiary, modifier = Modifier.padding(start = DotSpacing.s))
                                if (off) Text(stringResource(R.string.ephemeral_model_off), style = Dot.type.caption, color = c.textTertiary, modifier = Modifier.padding(start = DotSpacing.s))
                                if (m.vision) Icon(Icons.Outlined.Visibility, stringResource(R.string.code_reads_images), Modifier.padding(start = DotSpacing.s).size(15.dp), tint = c.textTertiary)
                                if (m.reasoning) Icon(Icons.Outlined.Psychology, stringResource(R.string.reasoning), Modifier.padding(start = DotSpacing.s).size(15.dp), tint = c.textTertiary)
                                if (current.provider == m.provider && current.model == m.id) Icon(Icons.Outlined.Check, null, Modifier.padding(start = DotSpacing.s).size(18.dp), tint = c.accent)
                                DotIconButton(if (fav) Icons.Outlined.Star else Icons.Outlined.StarBorder, stringResource(if (fav) R.string.favorite_remove else R.string.favorite_add), onClick = { toggle(m) }, tint = if (fav) Color(0xFFF5A524) else c.textTertiary)
                            }
                        }
                    }
                    if (onDefault != null) item(key = "default") {
                        Text(stringResource(R.string.model_back_default), style = Dot.type.callout, color = c.accent, modifier = Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onDefault).padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.m))
                    }
                }
            }
        }
        Spacer(Modifier.width(1.dp))
    }
}
