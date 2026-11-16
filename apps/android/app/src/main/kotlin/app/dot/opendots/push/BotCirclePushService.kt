package app.dot.opendots.push

import android.os.Build
import app.dot.opendots.OpenDotsApp
import app.dot.opendots.data.OdJson
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

/**
 * #64: receives UnifiedPush events from the distributor (e.g. ntfy). A new endpoint is registered with the BotCircle
 * server (Web Push encryption keys included: the distributor only sees ciphertext); messages become notifications.
 */
class BotCirclePushService : PushService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val app get() = application as OpenDotsApp

    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
        val keys = endpoint.pubKeySet ?: return
        scope.launch {
            runCatching { app.client.addPushSubscription("unifiedpush", endpoint.url, keys.pubKey, keys.auth, Build.MODEL ?: "Android") }
                .onSuccess { id -> PushRegistration.saved(this@BotCirclePushService, id) }
        }
    }

    override fun onMessage(message: PushMessage, instance: String) {
        val payload = runCatching { OdJson.parseToJsonElement(message.content.decodeToString()) as? JsonObject }.getOrNull() ?: return
        Notifier.handle(this, payload)
    }

    override fun onRegistrationFailed(reason: FailedReason, instance: String) { PushRegistration.failed(this, reason.name) }

    override fun onUnregistered(instance: String) {
        val id = PushRegistration.id(this) ?: return
        scope.launch { runCatching { app.client.removePushSubscription(id) }; PushRegistration.saved(this@BotCirclePushService, null) }
    }
}
