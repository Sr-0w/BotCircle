package app.dot.opendots.ui

import android.graphics.Bitmap
import android.graphics.pdf.PdfRenderer
import android.os.Build
import android.os.ParcelFileDescriptor
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.KeyboardArrowUp
import androidx.compose.material.icons.outlined.MoreHoriz
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.ZoomIn
import androidx.compose.material.icons.outlined.ZoomOut
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import app.dot.design.Dot
import app.dot.design.DotShapes
import app.dot.design.DotSpacing
import app.dot.design.components.DotFilterChip
import app.dot.design.components.DotIconButton
import app.dot.design.components.DotMarkdown
import app.dot.design.components.DotMenu
import app.dot.design.components.DotMenuItem
import app.dot.design.components.DotSpinner
import app.dot.design.components.Hairline
import app.dot.opendots.R
import app.dot.opendots.data.Part
import app.dot.opendots.data.artifactIdFromUrl
import app.dot.opendots.data.formatBytes
import coil3.compose.AsyncImage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File

// --- What a file is ---------------------------------------------------------------------------

enum class PreviewKind { Code, Text, Markdown, Image, Pdf }

private fun extensionOf(name: String) = name.substringAfterLast('.', "").lowercase().takeIf { it.length in 1..10 && it.all(Char::isLetterOrDigit) } ?: ""

private val CODE_EXTENSIONS = setOf(
    "py", "js", "mjs", "cjs", "jsx", "ts", "mts", "tsx", "json", "jsonc", "html", "htm", "css", "scss", "sass", "less", "sh", "bash", "zsh", "fish", "ps1", "go", "rs",
    "java", "kt", "kts", "c", "h", "cpp", "cc", "hpp", "cs", "rb", "php", "swift", "dart", "lua", "r", "sql", "yml", "yaml", "xml", "svg", "toml", "ini", "cfg", "conf",
    "env", "vue", "svelte", "graphql", "gql", "gradle", "tf", "ex", "exs", "erl", "hs", "scala", "clj", "zig", "nim", "tex", "diff", "patch",
)
private val TEXT_EXTENSIONS = setOf("txt", "log", "csv", "tsv", "text", "lock")

fun previewKind(name: String, mediaType: String): PreviewKind? {
    val ext = extensionOf(name)
    return when {
        Regex("^image/(png|jpe?g|gif|webp|bmp)$").matches(mediaType) || ext in setOf("png", "jpg", "jpeg", "gif", "webp", "bmp") -> PreviewKind.Image
        mediaType == "application/pdf" || ext == "pdf" -> PreviewKind.Pdf
        ext in setOf("md", "markdown", "mdx") || mediaType == "text/markdown" -> PreviewKind.Markdown
        ext in TEXT_EXTENSIONS -> PreviewKind.Text
        ext in CODE_EXTENSIONS || name.lowercase() in setOf("dockerfile", "makefile") -> PreviewKind.Code
        mediaType.startsWith("text/") || mediaType == "application/json" -> PreviewKind.Text
        else -> null
    }
}

private val LANGUAGE_NAMES = mapOf(
    "py" to "Python", "js" to "JavaScript", "mjs" to "JavaScript", "jsx" to "JavaScript", "ts" to "TypeScript", "tsx" to "TypeScript", "json" to "JSON", "sh" to "Shell", "bash" to "Shell",
    "go" to "Go", "rs" to "Rust", "java" to "Java", "kt" to "Kotlin", "kts" to "Kotlin", "c" to "C", "cpp" to "C++", "cs" to "C#", "rb" to "Ruby", "php" to "PHP", "swift" to "Swift",
    "html" to "HTML", "css" to "CSS", "yml" to "YAML", "yaml" to "YAML", "sql" to "SQL", "xml" to "XML", "toml" to "TOML", "md" to "Markdown", "csv" to "CSV",
)

/** "Python", "PDF", "Archive"…: what the file is, in a word. */
@Composable
fun fileKindLabel(name: String, mediaType: String): String {
    val ext = extensionOf(name)
    LANGUAGE_NAMES[ext]?.let { return it }
    return when {
        mediaType == "application/pdf" || ext == "pdf" -> "PDF"
        Regex("zip|tar|gzip|compressed|x-7z|rar").containsMatchIn(mediaType) || ext in setOf("zip", "tar", "gz", "tgz", "7z", "rar") -> stringResource(R.string.kind_archive)
        mediaType.startsWith("image/") -> stringResource(R.string.kind_image)
        mediaType.startsWith("audio/") -> stringResource(R.string.kind_audio)
        mediaType.startsWith("video/") -> stringResource(R.string.kind_video)
        previewKind(name, mediaType) == PreviewKind.Text -> stringResource(R.string.kind_text)
        ext.isNotEmpty() -> ext.uppercase()
        else -> stringResource(R.string.file)
    }
}

private val iconCache = HashMap<String, ImageVector>()

/** Seti UI icon of a file: by exact name, extension, then type; the generic file icon otherwise. */
private fun setiIcon(name: String, mediaType: String): Pair<ImageVector, Long?> {
    val base = name.substringAfterLast('/')
    val hit = SETI_FILES[base] ?: SETI_FILES[extensionOf(base)] ?: when {
        mediaType.startsWith("image/") -> SETI_FILES["png"]
        mediaType == "application/pdf" -> SETI_FILES["pdf"]
        mediaType.startsWith("video/") -> SETI_FILES["mp4"]
        mediaType.startsWith("audio/") -> SETI_FILES["mp3"]
        Regex("zip|tar|gzip|compressed").containsMatchIn(mediaType) -> SETI_FILES["zip"]
        else -> null
    }
    val icon = hit?.first ?: "default"
    val vector = iconCache.getOrPut(icon) {
        ImageVector.Builder(name = "seti-$icon", defaultWidth = 32.dp, defaultHeight = 32.dp, viewportWidth = 32f, viewportHeight = 32f)
            .addPath(PathParser().parsePathString(SETI_PATHS[icon] ?: SETI_PATHS.getValue("default")).toNodes(), fill = SolidColor(Color.White)).build()
    }
    // Seti's "white" and "grey" read as nothing on light themes: they follow the text colour instead.
    val color = hit?.second?.takeUnless { it in setOf(0xFFD4D7D6, 0xFF4D5A5E, 0xFF6D8086, 0xFF41535B) }
    return vector to color
}

@Composable
fun FileTypeIcon(name: String, mediaType: String, modifier: Modifier = Modifier) {
    val (vector, color) = remember(name, mediaType) { setiIcon(name, mediaType) }
    Box(modifier.size(36.dp).clip(DotShapes.small).background(Dot.colors.surfaceRaised), contentAlignment = Alignment.Center) {
        Icon(vector, null, Modifier.size(28.dp), tint = color?.let { Color(it) } ?: Dot.colors.textSecondary)
    }
}

// --- One file, one line ------------------------------------------------------------------------

/**
 * One file on one line (~56dp): its format, name, kind and size, then Preview and Download. Rarer actions (open with
 * another app, access, information) are in the menu.
 */
@Composable
fun FileRow(file: Part.File, actions: FileActions?, size: Long? = null, caption: String? = null, onAccess: ((String) -> Unit)? = null, onPreview: () -> Unit) {
    val c = Dot.colors
    val name = file.filename ?: stringResource(R.string.file)
    val artifactId = remember(file.url) { artifactIdFromUrl(file.url) }
    val realSize by produceState(size, artifactId, size) { if (size == null && artifactId != null && actions != null) value = actions.sizeOf(artifactId) }
    val kind = remember(name, file.mediaType) { previewKind(name, file.mediaType) }
    var menu by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = DotSpacing.m, end = DotSpacing.xs, top = DotSpacing.s, bottom = DotSpacing.s).testTag("file-card"), verticalAlignment = Alignment.CenterVertically) {
        val thumbnail = kind == PreviewKind.Image && actions != null
        Box(Modifier.clip(DotShapes.small).clickable(enabled = kind != null, role = Role.Button, onClickLabel = stringResource(R.string.preview), onClick = onPreview)) {
            if (thumbnail) AsyncImage(actions!!.resolve(file.url), null, Modifier.size(36.dp).clip(DotShapes.small).border(DotSpacing.hairline * 2, c.border, DotShapes.small), contentScale = ContentScale.Crop)
            else FileTypeIcon(name, file.mediaType)
        }
        Spacer(Modifier.width(DotSpacing.m))
        Column(Modifier.weight(1f)) {
            Text(name, style = Dot.type.bodyStrong, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
            Text(listOfNotNull(fileKindLabel(name, file.mediaType), realSize?.let(::formatBytes)?.ifBlank { null }).joinToString(" · "), style = Dot.type.caption, color = c.textSecondary, maxLines = 1)
            if (!caption.isNullOrBlank()) Text(caption, style = Dot.type.caption, color = c.textSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        if (actions != null) {
            if (kind != null) DotIconButton(Icons.Outlined.Visibility, stringResource(R.string.preview), onClick = onPreview, tint = c.textSecondary)
            DotIconButton(Icons.Outlined.Download, stringResource(R.string.save_file), onClick = { actions.save(file) }, tint = c.textSecondary)
            Box {
                DotIconButton(Icons.Outlined.MoreHoriz, stringResource(R.string.more), onClick = { menu = true }, tint = c.textSecondary)
                DotMenu(menu, { menu = false }) {
                    DotMenuItem(stringResource(R.string.open_with), Icons.AutoMirrored.Outlined.OpenInNew) { menu = false; actions.open(file) }
                    if (artifactId != null && onAccess != null) {
                        DotMenuItem(stringResource(R.string.file_access), Icons.Outlined.Shield) { menu = false; onAccess(artifactId) }
                        DotMenuItem(stringResource(R.string.file_info), Icons.Outlined.Info) { menu = false; onAccess(artifactId) }
                    }
                }
            }
        }
    }
}

/** Files sent together share one surface, separated by hairlines: never a card per file. */
@Composable
fun FileGroup(files: List<Part.File>, actions: FileActions?, modifier: Modifier = Modifier, sizes: List<Long?> = emptyList(), captions: List<String?> = emptyList(), onAccess: ((String) -> Unit)? = null) {
    var previewing by remember { mutableStateOf<Part.File?>(null) }
    Column(modifier.fillMaxWidth().clip(DotShapes.large).background(Dot.colors.surface).border(DotSpacing.hairline * 2, Dot.colors.border, DotShapes.large).testTag("file-group")) {
        files.forEachIndexed { index, file ->
            if (index > 0) Hairline(Modifier.padding(start = 36.dp + DotSpacing.m * 2))
            FileRow(file, actions, sizes.getOrNull(index), captions.getOrNull(index), onAccess) { previewing = file }
        }
    }
    previewing?.let { file -> if (actions != null) FilePreview(file, actions, onAccess) { previewing = null } }
}

// --- Preview -----------------------------------------------------------------------------------

/** Text previews stop here: longer files are shown truncated; Save keeps everything. */
private const val TEXT_LIMIT = 2 * 1024 * 1024

/**
 * Full-screen, read-only preview of a file: code with syntax colours, Markdown rendered or as source, images with
 * pinch-to-zoom, PDF pages. Nothing received is executed. Back closes it.
 */
@Composable
fun FilePreview(file: Part.File, actions: FileActions, onAccess: ((String) -> Unit)?, onDismiss: () -> Unit) {
    val c = Dot.colors
    val name = file.filename ?: stringResource(R.string.file)
    val kind = remember(name, file.mediaType) { previewKind(name, file.mediaType) }
    val failed = stringResource(R.string.generic_error)
    val local by produceState<Result<File>?>(null, file.url) { value = runCatching { actions.fetch(file) } }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        BackHandler(onBack = onDismiss)
        Column(Modifier.fillMaxSize().background(c.background).testTag("file-preview")) {
            Row(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.statusBars).padding(horizontal = DotSpacing.s, vertical = DotSpacing.xs), verticalAlignment = Alignment.CenterVertically) {
                DotIconButton(Icons.AutoMirrored.Outlined.ArrowBack, stringResource(R.string.back), onClick = onDismiss)
                Spacer(Modifier.width(DotSpacing.xs))
                FileTypeIcon(name, file.mediaType)
                Spacer(Modifier.width(DotSpacing.m))
                Column(Modifier.weight(1f)) {
                    Text(name, style = Dot.type.bodyStrong, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                    Text(listOfNotNull(fileKindLabel(name, file.mediaType), local?.getOrNull()?.length()?.let(::formatBytes)).joinToString(" · "), style = Dot.type.caption, color = c.textSecondary, maxLines = 1)
                }
                DotIconButton(Icons.Outlined.Download, stringResource(R.string.save_file), onClick = { actions.save(file) })
            }
            Hairline()
            Box(Modifier.weight(1f).fillMaxWidth()) {
                val result = local
                when {
                    result == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { DotSpinner(size = 24.dp) }
                    result.isFailure -> Text(result.exceptionOrNull()?.message?.ifBlank { null } ?: failed, style = Dot.type.callout, color = c.danger, modifier = Modifier.padding(DotSpacing.gutter))
                    kind == PreviewKind.Image -> ImagePreview(result.getOrThrow(), name)
                    kind == PreviewKind.Pdf -> PdfPreview(result.getOrThrow())
                    kind == PreviewKind.Markdown -> MarkdownPreview(result.getOrThrow(), name)
                    else -> CodePreview(result.getOrThrow(), name)
                }
            }
        }
    }
}

private suspend fun readText(file: File): Pair<String, Boolean> = withContext(Dispatchers.IO) {
    val truncated = file.length() > TEXT_LIMIT
    val bytes = file.inputStream().use { input -> if (truncated) ByteArray(TEXT_LIMIT).also { input.read(it) } else input.readBytes() }
    String(bytes, Charsets.UTF_8) to truncated
}

@Composable
private fun TruncatedNote() {
    Text(stringResource(R.string.preview_truncated), style = Dot.type.caption, color = Dot.colors.textSecondary, modifier = Modifier.fillMaxWidth().background(Dot.colors.surface).padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.s))
}

/** Code and text: syntax colours, line numbers, search, copy. */
@Composable
private fun CodePreview(file: File, name: String, preloaded: Pair<String, Boolean>? = null) {
    val c = Dot.colors
    val content by produceState(preloaded, file) { if (value == null) value = readText(file) }
    val loaded = content ?: run { Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { DotSpinner(size = 24.dp) }; return }
    val (text, truncated) = loaded
    val lines = remember(text) { text.split('\n') }
    val language = remember(name) { extensionOf(name).ifEmpty { name.lowercase() } }
    val palette = SyntaxPalette.of(c.isDark)
    val highlighted = remember(text, language, c.isDark) { if (text.length > 400_000) null else highlightLines(lines, language, palette) }
    var query by rememberSaveable { mutableStateOf("") }
    var current by remember { mutableIntStateOf(0) }
    val matches = remember(query, lines) { val q = query.trim().lowercase(); if (q.isEmpty()) emptyList() else lines.indices.filter { lines[it].lowercase().contains(q) } }
    val list = rememberLazyListState()
    LaunchedEffect(matches, current) { matches.getOrNull(current)?.let { list.animateScrollToItem(maxOf(0, it - 3)) } }
    val clipboard = LocalClipboardManager.current
    Column(Modifier.fillMaxSize()) {
        if (truncated) TruncatedNote()
        Row(Modifier.fillMaxWidth().padding(start = DotSpacing.gutter, end = DotSpacing.xs), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.Search, null, Modifier.size(16.dp), tint = c.textTertiary)
            Spacer(Modifier.width(DotSpacing.s))
            Box(Modifier.weight(1f).heightIn(min = 44.dp), contentAlignment = Alignment.CenterStart) {
                val hint = stringResource(R.string.preview_search)
                if (query.isEmpty()) Text(hint, style = Dot.type.callout, color = c.textTertiary)
                BasicTextField(query, { query = it; current = 0 }, singleLine = true, textStyle = Dot.type.callout.copy(color = c.textPrimary), cursorBrush = SolidColor(c.accent), modifier = Modifier.fillMaxWidth().semantics { contentDescription = hint })
            }
            if (query.isNotBlank()) Text(if (matches.isEmpty()) stringResource(R.string.preview_no_match) else "${current + 1}/${matches.size}", style = Dot.type.caption, color = c.textSecondary, modifier = Modifier.testTag("preview-matches"))
            DotIconButton(Icons.Outlined.KeyboardArrowUp, stringResource(R.string.previous), onClick = { if (matches.isNotEmpty()) current = (current + matches.size - 1) % matches.size }, enabled = matches.isNotEmpty(), tint = c.textSecondary)
            DotIconButton(Icons.Outlined.KeyboardArrowDown, stringResource(R.string.next), onClick = { if (matches.isNotEmpty()) current = (current + 1) % matches.size }, enabled = matches.isNotEmpty(), tint = c.textSecondary)
            DotIconButton(Icons.Outlined.ContentCopy, stringResource(R.string.copy), onClick = { clipboard.setText(AnnotatedString(text)) }, tint = c.textSecondary)
        }
        Hairline()
        val digits = lines.size.toString().length
        val mono = Dot.type.caption.copy(fontFamily = FontFamily.Monospace, fontSize = 12.5.sp, lineHeight = 19.sp)
        SelectionContainer(Modifier.weight(1f)) {
            LazyColumn(state = list, modifier = Modifier.fillMaxSize().horizontalScroll(rememberScrollState()).testTag(if (highlighted != null) "code-highlighted" else "code-plain")) {
                itemsIndexed(lines) { index, line ->
                    val hit = index in matches
                    Row(Modifier.background(if (hit && matches.getOrNull(current) == index) c.accent.copy(alpha = 0.28f) else if (hit) c.accent.copy(alpha = 0.12f) else Color.Transparent).padding(end = DotSpacing.l)) {
                        Text((index + 1).toString().padStart(digits), style = mono, color = c.textTertiary, modifier = Modifier.padding(start = DotSpacing.m, end = DotSpacing.m))
                        Text(highlighted?.getOrNull(index) ?: AnnotatedString(line), style = mono, color = c.textPrimary, softWrap = false)
                    }
                }
            }
        }
    }
}

@Composable
private fun MarkdownPreview(file: File, name: String) {
    val content by produceState<Pair<String, Boolean>?>(null, file) { value = readText(file) }
    var source by rememberSaveable { mutableStateOf(false) }
    val loaded = content ?: run { Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { DotSpinner(size = 24.dp) }; return }
    Column(Modifier.fillMaxSize()) {
        if (loaded.second) TruncatedNote()
        Row(Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.s), horizontalArrangement = Arrangement.spacedBy(DotSpacing.s)) {
            DotFilterChip(stringResource(R.string.preview_rendered), !source, { source = false }, radio = true)
            DotFilterChip(stringResource(R.string.preview_source), source, { source = true }, radio = true)
        }
        Hairline()
        if (source) CodePreview(file, name, loaded)
        else LazyColumn(Modifier.fillMaxSize().testTag("markdown-rendered"), contentPadding = androidx.compose.foundation.layout.PaddingValues(DotSpacing.gutter)) { item { DotMarkdown(loaded.first) } }
    }
}

/** Images: fit by default; pinch to zoom, drag to move, double tap to reset. */
@Composable
private fun ImagePreview(file: File, name: String) {
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    val size by produceState<Pair<Int, Int>?>(null, file) {
        value = withContext(Dispatchers.IO) { val o = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }; android.graphics.BitmapFactory.decodeFile(file.path, o); if (o.outWidth > 0) o.outWidth to o.outHeight else null }
    }
    Column(Modifier.fillMaxSize()) {
        Box(
            Modifier.weight(1f).fillMaxWidth().clip(androidx.compose.ui.graphics.RectangleShape)
                .pointerInput(Unit) { detectTransformGestures { _, pan, zoom, _ -> scale = (scale * zoom).coerceIn(1f, 8f); offset = if (scale == 1f) Offset.Zero else offset + pan } }
                .pointerInput(Unit) { detectTapGestures(onDoubleTap = { if (scale > 1f) { scale = 1f; offset = Offset.Zero } else scale = 2.5f }) },
            contentAlignment = Alignment.Center,
        ) {
            AsyncImage(file, name, Modifier.fillMaxSize().graphicsLayer { scaleX = scale; scaleY = scale; translationX = offset.x; translationY = offset.y }.testTag("image-preview"), contentScale = ContentScale.Fit)
        }
        Row(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.navigationBars).padding(DotSpacing.s), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
            DotIconButton(Icons.Outlined.ZoomOut, stringResource(R.string.zoom_out), onClick = { scale = (scale / 1.25f).coerceAtLeast(1f); if (scale == 1f) offset = Offset.Zero }, tint = Dot.colors.textSecondary)
            Text("${(scale * 100).toInt()} %", style = Dot.type.caption, color = Dot.colors.textSecondary)
            DotIconButton(Icons.Outlined.ZoomIn, stringResource(R.string.zoom_in), onClick = { scale = (scale * 1.25f).coerceAtMost(8f) }, tint = Dot.colors.textSecondary)
            size?.let { (w, h) -> Text("  $w × $h", style = Dot.type.caption, color = Dot.colors.textSecondary) }
        }
    }
}

/** PDF pages drawn by Android's own renderer (no scripts), with zoom; search on Android 15+. */
@Composable
private fun PdfPreview(file: File) {
    val c = Dot.colors
    val failed = stringResource(R.string.pdf_unreadable)
    val renderer = remember(file) { runCatching { PdfRenderer(ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)) } }
    DisposableEffect(renderer) { onDispose { renderer.getOrNull()?.close() } }
    val pdf = renderer.getOrNull() ?: run { Text(failed, style = Dot.type.callout, color = c.danger, modifier = Modifier.padding(DotSpacing.gutter)); return }
    val lock = remember(pdf) { Mutex() }
    var zoom by remember { mutableFloatStateOf(1f) }
    var query by rememberSaveable { mutableStateOf("") }
    var hits by remember { mutableStateOf<List<Int>?>(null) }
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val width = with(LocalDensity.current) { LocalConfiguration.current.screenWidthDp.dp.toPx() }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(start = DotSpacing.gutter, end = DotSpacing.xs), verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.pdf_pages, list.firstVisibleItemIndex + 1, pdf.pageCount), style = Dot.type.caption, color = c.textSecondary, modifier = Modifier.weight(1f).testTag("pdf-pages"))
            if (Build.VERSION.SDK_INT >= 35) {
                Box(Modifier.width(120.dp).heightIn(min = 44.dp), contentAlignment = Alignment.CenterStart) {
                    val hint = stringResource(R.string.preview_search)
                    if (query.isEmpty()) Text(hint, style = Dot.type.callout, color = c.textTertiary)
                    BasicTextField(query, { query = it; hits = null }, singleLine = true, textStyle = Dot.type.callout.copy(color = c.textPrimary), cursorBrush = SolidColor(c.accent), modifier = Modifier.fillMaxWidth())
                }
                DotIconButton(Icons.Outlined.Search, stringResource(R.string.preview_search), onClick = {
                    scope.launch {
                        val found = lock.withLock { withContext(Dispatchers.IO) { (0 until pdf.pageCount).filter { i -> pdf.openPage(i).use { if (Build.VERSION.SDK_INT >= 35) it.searchText(query).isNotEmpty() else false } } } }
                        hits = found
                        found.firstOrNull()?.let { list.animateScrollToItem(it) }
                    }
                }, enabled = query.isNotBlank(), tint = c.textSecondary)
            }
            DotIconButton(Icons.Outlined.ZoomOut, stringResource(R.string.zoom_out), onClick = { zoom = (zoom / 1.25f).coerceAtLeast(1f) }, tint = c.textSecondary)
            DotIconButton(Icons.Outlined.ZoomIn, stringResource(R.string.zoom_in), onClick = { zoom = (zoom * 1.25f).coerceAtMost(4f) }, tint = c.textSecondary)
        }
        hits?.let { Text(if (it.isEmpty()) stringResource(R.string.preview_no_match) else stringResource(R.string.pdf_found_on, it.take(8).joinToString(", ") { p -> (p + 1).toString() }), style = Dot.type.caption, color = c.textSecondary, modifier = Modifier.padding(horizontal = DotSpacing.gutter)) }
        Hairline()
        LazyColumn(state = list, modifier = Modifier.fillMaxSize().background(c.surface).horizontalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(DotSpacing.m), contentPadding = androidx.compose.foundation.layout.PaddingValues(DotSpacing.m)) {
            items(pdf.pageCount) { index ->
                val target = (width * zoom - 2 * 16).toInt().coerceAtLeast(200)
                val bitmap by produceState<Bitmap?>(null, index, target) {
                    value = lock.withLock {
                        withContext(Dispatchers.IO) {
                            pdf.openPage(index).use { page ->
                                val h = (target.toFloat() * page.height / page.width).toInt()
                                Bitmap.createBitmap(target, h, Bitmap.Config.ARGB_8888).also { it.eraseColor(android.graphics.Color.WHITE); page.render(it, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY) }
                            }
                        }
                    }
                }
                val ready = bitmap
                if (ready == null) Box(Modifier.width(with(LocalDensity.current) { target.toDp() }).aspectRatio(0.707f).background(Color.White), contentAlignment = Alignment.Center) { DotSpinner(size = 18.dp) }
                else Image(ready.asImageBitmap(), stringResource(R.string.pdf_page, index + 1), Modifier.width(with(LocalDensity.current) { target.toDp() }).border(if (hits?.contains(index) == true) 2.dp else 0.dp, c.accent))
            }
        }
    }
}

// --- Syntax colours ----------------------------------------------------------------------------

/** Close to GitHub's light and dark themes, so code reads the same as on the Web. */
private data class SyntaxPalette(val keyword: Color, val string: Color, val comment: Color, val number: Color, val type: Color) {
    companion object {
        private val light = SyntaxPalette(Color(0xFFD73A49), Color(0xFF032F62), Color(0xFF6A737D), Color(0xFF005CC5), Color(0xFF6F42C1))
        private val dark = SyntaxPalette(Color(0xFFF97583), Color(0xFF9ECBFF), Color(0xFF8B949E), Color(0xFF79B8FF), Color(0xFFB392F0))
        fun of(isDark: Boolean) = if (isDark) dark else light
    }
}

private val KEYWORDS: Map<String, Set<String>> = run {
    val c = "if else for while do switch case break continue return default goto sizeof struct union enum typedef static const volatile extern void int char long short float double unsigned signed bool true false null".split(' ').toSet()
    val js = "if else for while do switch case break continue return function var let const class extends new this super import export from as default async await try catch finally throw typeof instanceof in of yield null undefined true false static get set interface type implements enum readonly private public protected".split(' ').toSet()
    mapOf(
        "py" to "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self match case".split(' ').toSet(),
        "js" to js, "mjs" to js, "cjs" to js, "jsx" to js, "ts" to js, "tsx" to js, "mts" to js, "vue" to js, "svelte" to js,
        "kt" to "package import class interface object fun val var if else when for while do return break continue try catch finally throw null true false is in as this super override open data sealed private public internal protected companion suspend inline lateinit by get set enum annotation const".split(' ').toSet(),
        "java" to "package import class interface extends implements new return if else for while do switch case break continue try catch finally throw throws null true false this super public private protected static final void int long boolean double float char byte short abstract synchronized enum record var".split(' ').toSet(),
        "go" to "package import func var const type struct interface map chan go defer return if else for range switch case default break continue fallthrough select nil true false".split(' ').toSet(),
        "rs" to "fn let mut const static struct enum impl trait pub use mod crate self super match if else loop while for in return break continue as ref move async await dyn where type true false Some None Ok Err".split(' ').toSet(),
        "sh" to "if then else elif fi for in do done while until case esac function return local export echo exit set unset readonly".split(' ').toSet(),
        "sql" to "select from where and or not insert into values update set delete create table drop alter join left right inner outer on as group by order having limit offset union distinct null is in like between primary key foreign references index".split(' ').toSet(),
        "c" to c, "h" to c, "cpp" to c + "class public private protected virtual template typename namespace using new delete this nullptr auto".split(' '), "cs" to js + "namespace using public private void int string bool var".split(' '),
        "rb" to "def end class module if elsif else unless while until for in do return yield self nil true false require begin rescue ensure".split(' ').toSet(),
        "php" to "function class public private protected return if else elseif foreach for while echo new null true false use namespace".split(' ').toSet(),
        "swift" to "func let var class struct enum protocol extension import return if else guard for in while switch case default break continue nil true false self init".split(' ').toSet(),
    ).let { it + mapOf("bash" to it.getValue("sh"), "zsh" to it.getValue("sh"), "hpp" to it.getValue("cpp"), "cc" to it.getValue("cpp"), "kts" to it.getValue("kt")) }
}
private val HASH_COMMENTS = setOf("py", "sh", "bash", "zsh", "fish", "rb", "r", "yml", "yaml", "toml", "ini", "cfg", "conf", "env", "dockerfile", "makefile", "pl", "ex", "exs")
private val SQL_COMMENTS = setOf("sql", "lua", "hs")

/** A small, safe tokenizer: comments, strings, numbers and keywords. Good enough to read; never evaluated. */
private fun highlightLines(lines: List<String>, language: String, palette: SyntaxPalette): List<AnnotatedString> {
    val keywords = KEYWORDS[language] ?: emptySet()
    val hash = language in HASH_COMMENTS
    val dash = language in SQL_COMMENTS
    val slash = !hash && !dash && language !in setOf("json", "md", "txt", "csv", "html", "xml", "svg")
    val markup = language in setOf("html", "htm", "xml", "svg", "vue", "svelte")
    var inBlock = false
    return lines.map { line ->
        buildAnnotatedString {
            var i = 0
            while (i < line.length) {
                if (inBlock) {
                    val end = line.indexOf(if (markup) "-->" else "*/", i)
                    val stop = if (end < 0) line.length else end + (if (markup) 3 else 2)
                    withStyle(SpanStyle(color = palette.comment)) { append(line.substring(i, stop)) }
                    if (end >= 0) inBlock = false
                    i = stop; continue
                }
                val rest = line.substring(i)
                when {
                    (hash && line[i] == '#') || (slash && rest.startsWith("//")) || (dash && rest.startsWith("--")) -> { withStyle(SpanStyle(color = palette.comment)) { append(rest) }; i = line.length }
                    (slash && rest.startsWith("/*")) || (markup && rest.startsWith("<!--")) -> { inBlock = true }
                    line[i] == '"' || line[i] == '\'' || line[i] == '`' -> {
                        val quote = line[i]; var j = i + 1
                        while (j < line.length && line[j] != quote) { if (line[j] == '\\') j++; j++ }
                        val stop = minOf(line.length, j + 1)
                        // A JSON key reads as a name, not a value.
                        val isKey = language in setOf("json", "jsonc") && line.substring(stop).trimStart().startsWith(":")
                        withStyle(SpanStyle(color = if (isKey) palette.number else palette.string)) { append(line.substring(i, stop)) }
                        i = stop
                    }
                    line[i].isDigit() && (i == 0 || !line[i - 1].isLetterOrDigit()) -> {
                        var j = i; while (j < line.length && (line[j].isLetterOrDigit() || line[j] == '.' || line[j] == '_')) j++
                        withStyle(SpanStyle(color = palette.number)) { append(line.substring(i, j)) }; i = j
                    }
                    line[i].isLetter() || line[i] == '_' -> {
                        var j = i; while (j < line.length && (line[j].isLetterOrDigit() || line[j] == '_')) j++
                        val word = line.substring(i, j)
                        when {
                            word in keywords || word.lowercase() in keywords && language == "sql" -> withStyle(SpanStyle(color = palette.keyword)) { append(word) }
                            j < line.length && line[j] == '(' -> withStyle(SpanStyle(color = palette.type)) { append(word) }
                            else -> append(word)
                        }
                        i = j
                    }
                    else -> { append(line[i]); i++ }
                }
            }
        }
    }
}
