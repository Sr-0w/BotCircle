package app.dot.opendots.push

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import app.dot.opendots.MainActivity
import app.dot.opendots.R
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * #64: native notifications. One channel per category (the user tunes sound and importance in Android's own
 * settings; DND applies), grouped by tag (one per approval, task or reply), closed when the server says it is no
 * longer relevant. A tap opens the exact place in the app; nothing is ever approved from a notification.
 */
object Notifier {
    val CHANNELS = listOf(
        Triple("messages", R.string.notif_channel_messages, NotificationManager.IMPORTANCE_DEFAULT),
        Triple("tasks", R.string.notif_channel_tasks, NotificationManager.IMPORTANCE_DEFAULT),
        Triple("approvals", R.string.notif_channel_approvals, NotificationManager.IMPORTANCE_HIGH),
        Triple("code", R.string.notif_channel_code, NotificationManager.IMPORTANCE_DEFAULT),
        Triple("scheduled", R.string.notif_channel_scheduled, NotificationManager.IMPORTANCE_LOW),
    )
    const val EXTRA_KIND = "od_target_kind"
    const val EXTRA_ID = "od_target_id"
    const val EXTRA_AGENT = "od_target_agent"
    const val EXTRA_MESSAGE = "od_target_message"

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val manager = context.getSystemService(NotificationManager::class.java)
        CHANNELS.forEach { (id, name, importance) -> manager.createNotificationChannel(NotificationChannel(id, context.getString(name), importance)) }
    }

    fun allowed(context: Context): Boolean =
        (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
            NotificationManagerCompat.from(context).areNotificationsEnabled()

    /** [payload] is what the server pushes: id, tag, category, title, body, close, target {kind, id, agentId?, messageId?}. */
    fun handle(context: Context, payload: JsonObject) {
        val tag = payload["tag"]?.jsonPrimitive?.contentOrNull ?: return
        val manager = NotificationManagerCompat.from(context)
        if (payload["close"]?.jsonPrimitive?.contentOrNull == "true") { manager.cancel(tag, 0); return }
        if (!allowed(context)) return
        ensureChannels(context)
        val category = payload["category"]?.jsonPrimitive?.contentOrNull?.takeIf { c -> CHANNELS.any { it.first == c } } ?: "messages"
        val target = payload["target"] as? JsonObject
        val open = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            target?.let { t ->
                putExtra(EXTRA_KIND, t["kind"]?.jsonPrimitive?.contentOrNull); putExtra(EXTRA_ID, t["id"]?.jsonPrimitive?.contentOrNull)
                putExtra(EXTRA_AGENT, t["agentId"]?.jsonPrimitive?.contentOrNull); putExtra(EXTRA_MESSAGE, t["messageId"]?.jsonPrimitive?.contentOrNull)
            }
        }
        val pending = PendingIntent.getActivity(context, tag.hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val body = payload["body"]?.jsonPrimitive?.contentOrNull.orEmpty()
        val notification = NotificationCompat.Builder(context, category)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(payload["title"]?.jsonPrimitive?.contentOrNull ?: "BotCircle")
            .setContentText(body).setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(pending).setAutoCancel(true)
            .setCategory(if (category == "approvals") NotificationCompat.CATEGORY_REMINDER else NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(if (category == "approvals") NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
            // Lock screen: the server already sends a generic line unless previews are on; keep the title only.
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setGroup("botcircle.$category")
            .build()
        @Suppress("MissingPermission") manager.notify(tag, 0, notification)
    }
}
