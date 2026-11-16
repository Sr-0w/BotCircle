package app.dot.opendots.push

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.unifiedpush.android.connector.UnifiedPush

/** #64: this device's UnifiedPush state: which distributor, and its subscription on the server. */
object PushRegistration {
    private const val PREFS = "od_push"
    data class State(val subscriptionId: String? = null, val distributor: String? = null, val distributors: List<String> = emptyList(), val error: String? = null)
    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state

    fun refresh(context: Context) {
        _state.value = State(id(context), UnifiedPush.getAckDistributor(context), UnifiedPush.getDistributors(context), _state.value.error)
    }
    fun id(context: Context): String? = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("id", null)
    fun saved(context: Context, id: String?) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().apply { if (id == null) remove("id") else putString("id", id) }.apply()
        _state.value = _state.value.copy(subscriptionId = id, error = null); refresh(context)
    }
    fun failed(context: Context, reason: String) { _state.value = _state.value.copy(error = reason); refresh(context) }

    /** Uses the distributor already chosen, or the default one (may show the system's choice); then registers with the server's VAPID key. */
    fun register(activity: android.app.Activity, vapid: String, onResult: (Boolean) -> Unit) {
        UnifiedPush.tryUseCurrentOrDefaultDistributor(activity) { ok ->
            if (ok) UnifiedPush.register(activity, messageForDistributor = "BotCircle", vapid = vapid)
            refresh(activity); onResult(ok)
        }
    }
    fun unregister(context: Context) { UnifiedPush.unregister(context); refresh(context) }
}
