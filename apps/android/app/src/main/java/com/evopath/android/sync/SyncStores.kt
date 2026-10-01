package com.evopath.android.sync

import android.content.Context
import android.content.SharedPreferences
import com.evopath.android.healthconnect.SyncToggle
import com.evopath.android.net.ApiClient
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import java.time.Instant

/** Non-secret sync state: per-type toggles, last success, pairing-expired flag, app-open debounce. */
interface SyncStateStore {
    fun isEnabled(toggle: SyncToggle): Boolean
    fun setEnabled(toggle: SyncToggle, enabled: Boolean)

    /** When a sync was last accepted by the server with status ok/partial (drives the 30 vs 7 day window). */
    var lastSuccessfulSyncAt: Instant?

    /** Set on a 401: the token expired or was revoked. Sync stops until the user re-pairs. */
    var pairingExpired: Boolean

    /** Last time an app-open sync was enqueued (debounce). */
    var lastAppOpenSyncAt: Instant?

    /** Last "Allow background access" notification (at most one per 24 h). */
    var lastBackgroundPromptAt: Instant?

    /** Last automatic diagnostics upload after a failed or partial run (at most one per 6 h). */
    var lastAutoDiagnosticsAt: Instant?

    /** Forgets everything tied to a pairing (toggles stay). */
    fun resetPairingState()

    val enabledToggles: List<SyncToggle> get() = SyncToggle.entries.filter { isEnabled(it) }
}

class PrefsSyncStateStore(private val prefs: SharedPreferences) : SyncStateStore {
    override fun isEnabled(toggle: SyncToggle): Boolean = prefs.getBoolean(toggleKey(toggle), true)

    override fun setEnabled(toggle: SyncToggle, enabled: Boolean) {
        prefs.edit().putBoolean(toggleKey(toggle), enabled).apply()
    }

    override var lastSuccessfulSyncAt: Instant?
        get() = instant(KEY_LAST_SUCCESS)
        set(value) = putInstant(KEY_LAST_SUCCESS, value)

    override var pairingExpired: Boolean
        get() = prefs.getBoolean(KEY_PAIRING_EXPIRED, false)
        set(value) {
            prefs.edit().putBoolean(KEY_PAIRING_EXPIRED, value).commit()
        }

    override var lastAppOpenSyncAt: Instant?
        get() = instant(KEY_LAST_APP_OPEN)
        set(value) = putInstant(KEY_LAST_APP_OPEN, value)

    override var lastBackgroundPromptAt: Instant?
        get() = instant(KEY_LAST_BACKGROUND_PROMPT)
        set(value) = putInstant(KEY_LAST_BACKGROUND_PROMPT, value)

    override var lastAutoDiagnosticsAt: Instant?
        get() = instant(KEY_LAST_AUTO_DIAGNOSTICS)
        set(value) = putInstant(KEY_LAST_AUTO_DIAGNOSTICS, value)

    override fun resetPairingState() {
        prefs.edit().remove(KEY_LAST_SUCCESS).remove(KEY_PAIRING_EXPIRED).remove(KEY_LAST_APP_OPEN).commit()
    }

    private fun instant(key: String): Instant? =
        prefs.getString(key, null)?.let { runCatching { Instant.parse(it) }.getOrNull() }

    private fun putInstant(key: String, value: Instant?) {
        prefs.edit().apply { if (value != null) putString(key, value.toString()) else remove(key) }.commit()
    }

    companion object {
        const val PREFS_NAME = "evopath_health_sync"
        private const val KEY_LAST_SUCCESS = "last_successful_sync_at"
        private const val KEY_PAIRING_EXPIRED = "pairing_expired"
        private const val KEY_LAST_APP_OPEN = "last_app_open_sync_at"
        private const val KEY_LAST_BACKGROUND_PROMPT = "last_background_prompt_at"
        private const val KEY_LAST_AUTO_DIAGNOSTICS = "last_auto_diagnostics_at"
        private fun toggleKey(toggle: SyncToggle) = "type_enabled_${toggle.key}"

        fun from(context: Context): PrefsSyncStateStore =
            PrefsSyncStateStore(context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE))
    }
}

/** One run as remembered on the phone (Sync screen, diagnostics `recentRuns`). */
@Serializable
data class LocalSyncRun(
    val startedAt: String,
    val finishedAt: String,
    val trigger: String,
    val status: String,
    /** Whether the server recorded this run. */
    val delivered: Boolean,
    val windowFrom: String? = null,
    val windowTo: String? = null,
    val recordsRead: Int = 0,
    val rowsSent: Int = 0,
    val syncedTypes: List<String> = emptyList(),
    val perType: Map<String, PerTypeDetail> = emptyMap(),
    /** The server's full answer (activity counts at the top, then measurements and sleep). */
    val response: SyncResponse? = null,
    val errorCode: String? = null,
    val errorMessage: String? = null,
)

/** Last [MAX_RUNS] runs, newest first, as JSON in private prefs. */
interface SyncHistoryStore {
    fun runs(): List<LocalSyncRun>
    fun add(run: LocalSyncRun)
    fun clear()
}

class PrefsSyncHistoryStore(private val prefs: SharedPreferences) : SyncHistoryStore {
    private val serializer = ListSerializer(LocalSyncRun.serializer())

    @Synchronized
    override fun runs(): List<LocalSyncRun> {
        val text = prefs.getString(KEY_RUNS, null) ?: return emptyList()
        return runCatching { ApiClient.ApiJson.decodeFromString(serializer, text) }.getOrDefault(emptyList())
    }

    @Synchronized
    override fun add(run: LocalSyncRun) {
        val updated = (listOf(run) + runs()).take(MAX_RUNS)
        prefs.edit().putString(KEY_RUNS, ApiClient.ApiJson.encodeToString(serializer, updated)).commit()
    }

    @Synchronized
    override fun clear() {
        prefs.edit().remove(KEY_RUNS).commit()
    }

    companion object {
        const val MAX_RUNS = 20
        private const val PREFS_NAME = "evopath_health_sync_history"
        private const val KEY_RUNS = "runs"

        fun from(context: Context): PrefsSyncHistoryStore =
            PrefsSyncHistoryStore(context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE))
    }
}
