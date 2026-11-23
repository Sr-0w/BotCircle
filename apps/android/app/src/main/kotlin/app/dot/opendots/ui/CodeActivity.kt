package app.dot.opendots.ui

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import app.dot.design.Dot
import app.dot.design.DotSpacing
import app.dot.design.components.QuietBackdrop
import app.dot.design.components.ButtonStyle
import app.dot.design.components.DotBottomSheet
import app.dot.design.components.DotButton
import app.dot.design.components.QuietGlassSurface
import app.dot.opendots.R
import app.dot.opendots.data.Agent
import app.dot.opendots.data.BgTask
import kotlinx.coroutines.delay
import kotlin.math.PI
import kotlin.math.cos

internal fun BgTask.codeSessionKey(): Any =
    external?.takeIf { it.instanceId.isNotBlank() && it.sessionId.isNotBlank() }?.let { it.instanceId to it.sessionId } ?: id

internal fun canonicalCodeTasks(tasks: Collection<BgTask>): List<BgTask> = tasks.filter { it.isCode }
    .sortedWith(compareByDescending<BgTask> { it.createdAt }.thenByDescending { it.id })
    .distinctBy { it.codeSessionKey() }

internal fun BgTask.codeStatus(synchronized: Boolean): String = when {
    active && (!synchronized || external?.unreachable == true) -> "disconnected"
    status == "paused" && external?.quota?.kind == "quota" -> "quota"
    status == "waiting_for_user" && phase == "Action requise" -> "attention"
    status == "waiting_for_user" && blocker?.startsWith("OpenCode pose une question") == true -> "question"
    else -> status
}

@Composable
internal fun codeActivityStatusLabel(status: String): String = stringResource(when (status) {
    "running" -> R.string.code_state_running
    "queued" -> R.string.code_state_queued
    "waiting_for_user" -> R.string.code_state_permission
    "paused" -> R.string.code_state_paused
    "quota" -> R.string.code_activity_quota
    "attention" -> R.string.code_activity_attention
    "question" -> R.string.code_activity_question
    "disconnected" -> R.string.code_state_disconnected
    "completed" -> R.string.code_state_done
    "failed" -> R.string.code_state_failed
    "cancelled" -> R.string.code_state_stopped
    else -> R.string.code_activity_unknown
})

internal fun BgTask.codeFinished() = status in setOf("completed", "failed", "cancelled")

/** The system's motion preference and battery saver can change while the app is open. */
@Composable
internal fun rememberCodeMotionAllowed(visible: Boolean): Boolean {
    val context = LocalContext.current
    val lifecycle by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    val foreground = visible && lifecycle.isAtLeast(Lifecycle.State.RESUMED)
    var allowed by remember(context, foreground) { mutableStateOf(false) }
    DisposableEffect(context, foreground) {
        if (!foreground) return@DisposableEffect onDispose {}
        val resolver = context.contentResolver
        val power = context.getSystemService(PowerManager::class.java)
        fun update() {
            allowed = power?.isPowerSaveMode != true && Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) != 0f
        }
        val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) { update() }
        }
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) { update() }
        }
        resolver.registerContentObserver(Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE), false, observer)
        ContextCompat.registerReceiver(context, receiver, IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED), ContextCompat.RECEIVER_NOT_EXPORTED)
        update()
        onDispose { resolver.unregisterContentObserver(observer); context.unregisterReceiver(receiver) }
    }
    return foreground && allowed
}

@Composable
internal fun rememberCodePulse(animate: Boolean): State<Float>? {
    if (!animate) return null
    return rememberInfiniteTransition(label = "Code activity").animateFloat(
        initialValue = 0f, targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(durationMillis = 2800, easing = LinearEasing)),
        label = "Activity phase",
    )
}

private fun breathe(progress: Float) = (1 - cos(progress * 2 * PI)).toFloat() / 2

@Composable
internal fun CodeActivityLogo(pulse: State<Float>?, width: Dp) {
    OpencodeLogo(
        modifier = Modifier.testTag(if (pulse == null) "code-motion-off" else "code-motion-on")
            .graphicsLayer { alpha = 1f - 0.28f * breathe(pulse?.value ?: 0f) },
        width = width,
    )
}

@Composable
internal fun CodeActivityIndicator(pulse: State<Float>?) {
    val color = Dot.colors.textSecondary
    Row(horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically) {
        repeat(3) { dot ->
            Spacer(Modifier.size(2.dp).graphicsLayer {
                alpha = pulse?.let { .55f + .45f * breathe(it.value - dot * .12f) } ?: .55f
            }.background(color, CircleShape))
        }
    }
}

@Composable
internal fun CodeActivityCapsule(
    conversationId: String,
    tasks: Collection<BgTask>,
    agents: List<Agent>,
    synchronized: Boolean,
    screenVisible: Boolean,
    backdrop: QuietBackdrop?,
    onOpenCode: (String) -> Unit,
) {
    if (conversationId.isBlank()) return
    val related = remember(tasks, conversationId) {
        canonicalCodeTasks(tasks).filter {
            it.conversationId == conversationId && it.external?.sessionId?.isNotBlank() == true && it.external.instanceId.isNotBlank()
        }
    }
    val active = remember(related) { related.filter { it.active } }
    val seen = remember(conversationId) { mutableSetOf<Any>() }
    var ending by remember(conversationId) { mutableStateOf(emptySet<Any>()) }
    var details by remember(conversationId) { mutableStateOf(false) }
    LaunchedEffect(related, active, synchronized) {
        if (!synchronized) return@LaunchedEffect
        if (active.isNotEmpty()) {
            seen.retainAll(related.map { it.codeSessionKey() }.toSet())
            seen.addAll(active.map { it.codeSessionKey() })
            ending = emptySet()
        } else if (seen.isNotEmpty()) {
            ending = related.filter { it.codeFinished() && it.codeSessionKey() in seen }.map { it.codeSessionKey() }.toSet()
            seen.clear()
        }
    }
    LaunchedEffect(ending) {
        if (ending.isNotEmpty()) { delay(3200); ending = emptySet() }
    }
    val finished = if (synchronized && active.isEmpty()) ending + seen else ending
    val visible = active.ifEmpty { related.filter { it.codeFinished() && it.codeSessionKey() in finished } }
    LaunchedEffect(visible.isNotEmpty()) { if (visible.isEmpty()) details = false }
    if (visible.isEmpty()) return
    val single = visible.singleOrNull()
    val statuses = visible.map { it.codeStatus(synchronized) }
    val running = statuses.count { it == "running" }
    val otherStatus = listOf("attention", "question", "waiting_for_user", "failed", "disconnected", "quota", "paused", "queued", "cancelled", "completed").firstOrNull { it in statuses }
    val status = when {
        single != null -> codeActivityStatusLabel(statuses.single())
        running == visible.size -> pluralStringResource(R.plurals.code_activity_running, running, running)
        running > 0 -> stringResource(R.string.code_activity_mixed, running, codeActivityStatusLabel(otherStatus.orEmpty()))
        else -> codeActivityStatusLabel(otherStatus.orEmpty())
    }
    val pulse = rememberCodePulse(rememberCodeMotionAllowed(screenVisible && running > 0))
    QuietGlassSurface(
        backdrop = backdrop,
        modifier = Modifier.padding(bottom = 4.dp).widthIn(max = 400.dp).height(42.dp).testTag("code-activity-capsule"),
    ) {
        Row(
            Modifier.clickable(role = Role.Button) { details = true }.height(42.dp).padding(horizontal = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically,
        ) {
            CodeActivityLogo(pulse, 16.dp)
            Text(single?.title?.ifBlank { "OpenCode" } ?: "OpenCode", style = Dot.type.label, color = Dot.colors.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            Text(status, style = Dot.type.caption, color = Dot.colors.textSecondary, maxLines = 1)
            if (running > 0) CodeActivityIndicator(pulse)
        }
    }
    if (details && screenVisible) DotBottomSheet(onDismiss = { details = false }, modifier = Modifier.testTag("code-activity-details")) {
        Text(stringResource(R.string.code_activity_title), style = Dot.type.title, color = Dot.colors.textPrimary, modifier = Modifier.padding(horizontal = DotSpacing.gutter))
        LazyColumn(Modifier.heightIn(max = 340.dp).padding(horizontal = DotSpacing.gutter)) {
            items(visible, key = { it.id }) { task ->
                Column(Modifier.testTag("code-activity-task:" + task.id).padding(vertical = DotSpacing.m), verticalArrangement = Arrangement.spacedBy(DotSpacing.xs)) {
                    Text(task.title.ifBlank { stringResource(R.string.code_untitled) }, style = Dot.type.body, color = Dot.colors.textPrimary)
                    val circle = agents.firstOrNull { it.id == task.agentId }
                    val author = when {
                        task.requestedBy == "user" -> stringResource(R.string.code_by_you)
                        circle != null -> stringResource(R.string.code_by, agentDisplayName(circle))
                        else -> stringResource(R.string.code_by_chat)
                    }
                    val meta = listOfNotNull(
                        codeActivityStatusLabel(task.codeStatus(synchronized)), author, task.external?.instanceName ?: "OpenCode",
                        task.external?.model?.id ?: task.usedModel ?: task.model?.model, task.lastHeartbeat?.let(::formatWhen)?.ifBlank { null },
                    ).joinToString(" · ")
                    Text(meta, style = Dot.type.caption, color = Dot.colors.textSecondary)
                    (task.blocker ?: task.error ?: task.currentActionSummary ?: task.phase)?.let {
                        Text(it, style = Dot.type.caption, color = Dot.colors.textSecondary)
                    }
                    DotButton(stringResource(R.string.code_activity_view), { details = false; onOpenCode(task.id) }, compact = true, style = ButtonStyle.Secondary)
                }
            }
        }
    }
}
