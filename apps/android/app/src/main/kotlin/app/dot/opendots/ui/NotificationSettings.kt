package app.dot.opendots.ui

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import app.dot.design.Dot
import app.dot.design.DotSpacing
import app.dot.design.components.ButtonStyle
import app.dot.design.components.DotButton
import app.dot.design.components.DotFilterChip
import app.dot.design.components.DotIconButton
import app.dot.design.components.Hairline
import app.dot.design.components.SectionLabel
import app.dot.opendots.AppState
import app.dot.opendots.AppUiState
import app.dot.opendots.R
import app.dot.opendots.data.NotificationPrefs
import app.dot.opendots.data.PushDevice
import app.dot.opendots.push.Notifier
import app.dot.opendots.push.PushRegistration
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

private val CATEGORY_ROWS = listOf(
    "messages" to (R.string.notif_channel_messages to R.string.notif_messages_note),
    "tasks" to (R.string.notif_channel_tasks to R.string.notif_tasks_note),
    "approvals" to (R.string.notif_channel_approvals to R.string.notif_approvals_note),
    "code" to (R.string.notif_channel_code to R.string.notif_code_note),
    "scheduled" to (R.string.notif_channel_scheduled to R.string.notif_scheduled_note),
)

/**
 * #64: Settings → Notifications. Android's permission (asked here, on a tap), the UnifiedPush distributor that
 * delivers while the app is closed, what to be told about, lock-screen preview, quiet hours, muted Circles, devices.
 */
@Composable
fun NotificationSettings(app: AppState, ui: AppUiState) {
    val c = Dot.colors
    val context = LocalContext.current
    val activity = context as? android.app.Activity
    val scope = rememberCoroutineScope()
    var prefs by remember { mutableStateOf<NotificationPrefs?>(null) }
    var devices by remember { mutableStateOf<List<PushDevice>>(emptyList()) }
    var tick by remember { mutableIntStateOf(0) }
    var allowed by remember { mutableStateOf(Notifier.allowed(context)) }
    val push by PushRegistration.state.collectAsState()
    val testSent = stringResource(R.string.notif_test_sent)
    val noDistributor = stringResource(R.string.notif_no_distributor)
    LaunchedEffect(tick) {
        PushRegistration.refresh(context); allowed = Notifier.allowed(context)
        runCatching { app.client.notificationPrefs() }.onSuccess { prefs = it }
        runCatching { app.client.pushDevices() }.onSuccess { devices = it }
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { tick++ }
    fun save(patch: kotlinx.serialization.json.JsonObject) = scope.launch { runCatching { app.client.setNotificationPrefs(patch) }.onSuccess { prefs = it }.onFailure { app.notify(it.message ?: "") } }
    Column(Modifier.fillMaxWidth().testTag("notification-settings")) {
        // 1. Android permission
        SectionLabel(stringResource(R.string.notif_this_device))
        SwitchRow(stringResource(R.string.notif_allow), stringResource(if (allowed) R.string.notif_allowed_note else R.string.notif_denied_note), allowed) { on ->
            if (on && Build.VERSION.SDK_INT >= 33) permission.launch(Manifest.permission.POST_NOTIFICATIONS)
            else context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))
        }
        Hairline(inset = DotSpacing.gutter)
        // 2. UnifiedPush: delivery while the app is closed
        val registered = push.subscriptionId != null
        SwitchRow(
            stringResource(R.string.notif_push), when {
                registered -> stringResource(R.string.notif_push_on, push.distributor ?: "UnifiedPush")
                push.distributors.isEmpty() -> noDistributor
                else -> stringResource(R.string.notif_push_off)
            }, registered,
        ) { on ->
            if (!on) { PushRegistration.id(context)?.let { id -> scope.launch { runCatching { app.client.removePushSubscription(id) } } }; PushRegistration.unregister(context); PushRegistration.saved(context, null); tick++ }
            else if (activity != null) scope.launch {
                val key = runCatching { app.client.vapidKey() }.getOrNull()
                if (key.isNullOrBlank()) { app.notify(noDistributor); return@launch }
                PushRegistration.register(activity, key) { ok -> if (!ok) app.notify(noDistributor); tick++ }
            }
        }
        if (push.distributors.isEmpty() && !registered) Box(Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.xs)) {
            DotButton(stringResource(R.string.notif_get_distributor), { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://unifiedpush.org/users/distributors/"))) } }, style = ButtonStyle.Secondary, compact = true)
        }
        push.error?.let { Text(it, style = Dot.type.caption, color = c.danger, modifier = Modifier.padding(horizontal = DotSpacing.gutter)) }
        Text(stringResource(R.string.notif_push_explain), style = Dot.type.caption, color = c.textTertiary, modifier = Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.s))

        val p = prefs ?: return@Column
        // 3. What to be told about
        SectionLabel(stringResource(R.string.notif_what), Modifier.padding(top = DotSpacing.l))
        SwitchRow(stringResource(R.string.notif_all), null, p.enabled) { on -> save(buildJsonObject { put("enabled", on) }) }
        CATEGORY_ROWS.forEach { (key, labels) ->
            Hairline(inset = DotSpacing.gutter)
            SwitchRow(stringResource(labels.first), stringResource(labels.second), p.categories[key] != false, enabled = p.enabled) { on -> save(buildJsonObject { putJsonObject("categories") { put(key, on) } }) }
        }
        // 4. Privacy and quiet
        SectionLabel(stringResource(R.string.notif_privacy), Modifier.padding(top = DotSpacing.l))
        SwitchRow(stringResource(R.string.notif_preview), stringResource(R.string.notif_preview_note), p.preview) { on -> save(buildJsonObject { put("preview", on) }) }
        Hairline(inset = DotSpacing.gutter)
        SwitchRow(stringResource(R.string.notif_quiet), p.quietHours?.let { "${it.start} – ${it.end} · ${it.timezone}" } ?: stringResource(R.string.notif_quiet_note), p.quietHours != null) { on ->
            save(buildJsonObject { if (on) putJsonObject("quietHours") { put("start", "22:00"); put("end", "07:00"); put("timezone", java.util.TimeZone.getDefault().id) } else put("quietHours", JsonNull) })
        }
        if (ui.agents.isNotEmpty()) {
            SectionLabel(stringResource(R.string.notif_muted), Modifier.padding(top = DotSpacing.l))
            Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = DotSpacing.gutter), horizontalArrangement = Arrangement.spacedBy(DotSpacing.s)) {
                ui.agents.forEach { a ->
                    val muted = a.id in p.mutedAgents
                    DotFilterChip(agentDisplayName(a), muted, { save(buildJsonObject { putJsonArray("mutedAgents") { (if (muted) p.mutedAgents - a.id else p.mutedAgents + a.id).forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } } }) })
                }
            }
        }
        // 5. Devices and browsers
        SectionLabel(stringResource(R.string.notif_devices), Modifier.padding(top = DotSpacing.l))
        devices.forEach { d ->
            Row(Modifier.fillMaxWidth().padding(start = DotSpacing.gutter).testTag("push-device"), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f).padding(vertical = DotSpacing.s)) {
                    Text(d.label.ifBlank { d.endpointHost } + if (d.id == push.subscriptionId) " · " + stringResource(R.string.notif_this_phone) else "", style = Dot.type.body, color = c.textPrimary)
                    Text((if (d.kind == "unifiedpush") "UnifiedPush" else "Web Push") + " · " + d.endpointHost + (d.lastOkAt?.let { " · " + formatWhen(it) } ?: ""), style = Dot.type.caption, color = c.textSecondary)
                }
                DotButton(stringResource(R.string.ssh_test), { scope.launch { runCatching { app.client.testPush(d.id) }.onSuccess { app.notify(testSent) }.onFailure { app.notify(it.message ?: "") } } }, style = ButtonStyle.Ghost, compact = true)
                DotIconButton(Icons.Outlined.DeleteOutline, stringResource(R.string.delete), onClick = { scope.launch { runCatching { app.client.removePushSubscription(d.id) }; if (d.id == push.subscriptionId) { PushRegistration.unregister(context); PushRegistration.saved(context, null) }; tick++ } }, tint = c.textTertiary)
            }
            Hairline(inset = DotSpacing.gutter)
        }
        if (devices.isEmpty()) Text(stringResource(R.string.notif_no_device), style = Dot.type.caption, color = c.textSecondary, modifier = Modifier.padding(horizontal = DotSpacing.gutter))
        Text(stringResource(R.string.notif_inbox_note), style = Dot.type.caption, color = c.textTertiary, modifier = Modifier.padding(horizontal = DotSpacing.gutter, vertical = DotSpacing.l))
    }
}
