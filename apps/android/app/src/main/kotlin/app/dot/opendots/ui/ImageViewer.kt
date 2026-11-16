package app.dot.opendots.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.BrokenImage
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import app.dot.design.Dot
import app.dot.design.DotSpacing
import app.dot.design.components.ButtonStyle
import app.dot.design.components.DotButton
import app.dot.design.components.DotIconButton
import app.dot.design.components.DotMenu
import app.dot.design.components.DotMenuItem
import app.dot.design.components.DotSpinner
import app.dot.opendots.R
import app.dot.opendots.data.Part
import coil3.compose.AsyncImagePainter
import coil3.compose.SubcomposeAsyncImage
import kotlinx.coroutines.launch
import kotlin.math.abs

/**
 * #60: photos of a thread open here, inside BotCircle — never in the browser. A black, media-first page: pinch,
 * drag and double tap to zoom; swipe sideways for the thread's other photos; swipe down, Back or ✕ to return to the
 * exact place in the chat. Save, Share and Open with… are explicit actions, on a downloaded copy (the server address
 * and the session never leave the app).
 */
@Composable
fun ImageViewer(images: List<Part.File>, start: Int, actions: FileActions, onDismiss: () -> Unit) {
    if (images.isEmpty()) return
    val pager = rememberPagerState(initialPage = start.coerceIn(0, images.lastIndex)) { images.size }
    val scales = remember { mutableStateMapOf<Int, Float>() }
    val zoomed = (scales[pager.currentPage] ?: 1f) > 1.01f
    var chrome by remember { mutableStateOf(true) }
    var menu by remember { mutableStateOf(false) }
    val drag = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    val current = images[pager.currentPage]
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        BackHandler(onBack = onDismiss)
        val fade = (1f - abs(drag.value) / 900f).coerceIn(0.3f, 1f)
        Box(
            Modifier.fillMaxSize().background(Color.Black.copy(alpha = fade)).testTag("image-viewer")
                // Swipe down (or up) to close, only while the photo is not zoomed.
                .draggable(
                    rememberDraggableState { delta -> scope.launch { drag.snapTo(drag.value + delta) } },
                    Orientation.Vertical, enabled = !zoomed,
                    onDragStopped = { velocity -> if (abs(drag.value) > 220f || abs(velocity) > 2400f) onDismiss() else drag.animateTo(0f) },
                ),
        ) {
            HorizontalPager(pager, Modifier.fillMaxSize().graphicsLayer { translationY = drag.value }, userScrollEnabled = !zoomed, key = { images[it].url }) { page ->
                ZoomableImage(actions.resolve(images[page].url), images[page].filename, onScale = { scales[page] = it }, onTap = { chrome = !chrome }, onRetry = {})
            }
            AnimatedVisibility(chrome, enter = fadeIn(), exit = fadeOut(), modifier = Modifier.align(Alignment.TopCenter)) {
                Row(
                    Modifier.fillMaxWidth().background(Color.Black.copy(alpha = 0.45f)).windowInsetsPadding(WindowInsets.statusBars).padding(horizontal = DotSpacing.s, vertical = DotSpacing.xs),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    DotIconButton(Icons.Outlined.Close, stringResource(R.string.close), onClick = onDismiss, tint = Color.White)
                    Column(Modifier.weight(1f).padding(horizontal = DotSpacing.xs)) {
                        Text(current.filename ?: stringResource(R.string.attached_image), style = Dot.type.label, color = Color.White, maxLines = 1)
                        if (images.size > 1) Text("${pager.currentPage + 1} / ${images.size}", style = Dot.type.caption, color = Color.White.copy(alpha = 0.7f), modifier = Modifier.testTag("image-viewer-position"))
                    }
                    DotIconButton(Icons.Outlined.Download, stringResource(R.string.save_file), onClick = { actions.save(current) }, tint = Color.White)
                    DotIconButton(Icons.Outlined.Share, stringResource(R.string.share), onClick = { actions.share(current) }, tint = Color.White)
                    Box {
                        DotIconButton(Icons.Outlined.MoreVert, stringResource(R.string.more), onClick = { menu = true }, tint = Color.White)
                        DotMenu(menu, { menu = false }) {
                            DotMenuItem(stringResource(R.string.open_with), Icons.AutoMirrored.Outlined.OpenInNew) { menu = false; actions.open(current) }
                        }
                    }
                }
            }
            Spacer(Modifier.align(Alignment.BottomCenter).windowInsetsPadding(WindowInsets.navigationBars))
        }
    }
}

/** One photo: fits the screen at its own aspect ratio; pinch, drag and double tap to zoom; clear loading and error states. */
@Composable
private fun ZoomableImage(url: String, name: String?, onScale: (Float) -> Unit, onTap: () -> Unit, onRetry: () -> Unit) {
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    var box by remember { mutableStateOf(IntSize.Zero) }
    var attempt by remember { mutableIntStateOf(0) }
    fun clamp(o: Offset, s: Float): Offset {
        val maxX = box.width * (s - 1f) / 2f; val maxY = box.height * (s - 1f) / 2f
        return Offset(o.x.coerceIn(-maxX, maxX), o.y.coerceIn(-maxY, maxY))
    }
    fun set(s: Float, o: Offset) { scale = s; offset = clamp(o, s); onScale(s) }
    val label = name ?: stringResource(R.string.attached_image)
    Box(
        Modifier.fillMaxSize().onSizeChanged { box = it }
            .pointerInput(Unit) {
                // Pinch anywhere; one finger moves the photo only once it is zoomed (otherwise the pager and swipe-down get it).
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    do {
                        val event = awaitPointerEvent()
                        if (event.changes.size > 1 || scale > 1.01f) {
                            val s = (scale * event.calculateZoom()).coerceIn(1f, 6f)
                            set(s, if (s <= 1.01f) Offset.Zero else offset + event.calculatePan())
                            event.changes.forEach { if (it.positionChanged()) it.consume() }
                        }
                    } while (event.changes.any { it.pressed })
                }
            }
            .pointerInput(Unit) {
                detectTapGestures(
                    onTap = { onTap() },
                    onDoubleTap = { at -> if (scale > 1.01f) set(1f, Offset.Zero) else set(2.5f, (Offset(box.width / 2f, box.height / 2f) - at) * 1.5f) },
                )
            }
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        androidx.compose.runtime.key(attempt) {
            SubcomposeAsyncImage(
                model = url, contentDescription = label, contentScale = ContentScale.Fit,
                modifier = Modifier.fillMaxSize().graphicsLayer { scaleX = scale; scaleY = scale; translationX = offset.x; translationY = offset.y },
                loading = { Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { DotSpinner(size = 28.dp) } },
                error = {
                    Column(Modifier.fillMaxSize().testTag("image-viewer-error"), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                        Icon(Icons.Outlined.BrokenImage, null, Modifier.size(28.dp), tint = Color.White.copy(alpha = 0.7f))
                        Text(stringResource(R.string.image_unavailable), style = Dot.type.callout, color = Color.White.copy(alpha = 0.8f), modifier = Modifier.padding(top = DotSpacing.s))
                        DotButton(stringResource(R.string.retry), { attempt++; onRetry() }, style = ButtonStyle.Secondary, compact = true, modifier = Modifier.padding(top = DotSpacing.m))
                    }
                },
                success = { state -> androidx.compose.foundation.Image(state.painter, label, Modifier.fillMaxSize().testTag("image-viewer-photo"), contentScale = ContentScale.Fit) },
            )
        }
    }
}
