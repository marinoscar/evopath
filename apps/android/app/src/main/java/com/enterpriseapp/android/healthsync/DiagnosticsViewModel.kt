package com.enterpriseapp.android.healthsync

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.enterpriseapp.android.MobileApplication
import com.enterpriseapp.android.diagnostics.AppLog
import com.enterpriseapp.android.diagnostics.BuiltReport
import com.enterpriseapp.android.diagnostics.SelfTestResult
import com.enterpriseapp.android.net.ApiResult
import com.enterpriseapp.android.notifications.NotificationPermissionState
import com.enterpriseapp.android.sync.LocalSyncRun
import com.enterpriseapp.android.sync.SyncNotifications
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.Duration
import java.time.Instant

data class DiagnosticsUiState(
    val running: Boolean = false,
    val result: SelfTestResult? = null,
    val report: BuiltReport? = null,
    val runs: List<LocalSyncRun> = emptyList(),
    val log: List<String> = emptyList(),
    val uploading: Boolean = false,
    /** Server id of the last uploaded report. */
    val uploadedId: String? = null,
    val uploadError: String? = null,
    /** One-line feedback for the last action (copied, reset…). */
    val message: String? = null,
    /** Notification permission as of the last resume (read by the activity: it needs an Activity). */
    val notifications: NotificationPermissionState? = null,
)

/** Self-test, report actions and the log viewer. Shared by the hub (health line) and Diagnostics. */
class DiagnosticsViewModel(application: Application) : AndroidViewModel(application) {
    private val app = MobileApplication.from(application)
    private val _state = MutableStateFlow(DiagnosticsUiState())
    val state: StateFlow<DiagnosticsUiState> = _state.asStateFlow()
    private var job: Job? = null
    private var rerunOnResume = false

    init {
        runSelfTest()
        viewModelScope.launch {
            app.syncFinished.collect { refreshLocal() }
        }
    }

    /** Runs the self-test unless one is running (or, with [ifOlderThan], a recent result exists). */
    fun runSelfTest(ifOlderThan: Duration? = null) {
        if (job?.isActive == true) return
        val last = _state.value.result?.generatedAt
        if (ifOlderThan != null && last != null && Duration.between(last, Instant.now()) < ifOlderThan) return
        _state.update { it.copy(running = true, message = null) }
        job = viewModelScope.launch {
            val result = runCatching { app.diagnostics.runSelfTest() }
            result.exceptionOrNull()?.let { AppLog.e("Diagnostics", "Self-test crashed", it) }
            val value = result.getOrNull()
            val report = value?.let { runCatching { app.diagnostics.buildReport(it) }.getOrNull() }
            _state.update {
                it.copy(
                    running = false,
                    result = value ?: it.result,
                    report = report ?: it.report,
                    message = if (value == null) "The self-test could not run: ${result.exceptionOrNull()?.javaClass?.simpleName}" else null,
                )
            }
            refreshLocal()
        }
    }

    /** Called after the user left for a settings screen from a check's action. */
    fun markActionTaken() {
        rerunOnResume = true
    }

    fun onResume() {
        refreshLocal()
        if (rerunOnResume) {
            rerunOnResume = false
            runSelfTest()
        }
    }

    fun refreshLocal() {
        _state.update { it.copy(runs = app.syncHistory.runs(), log = AppLog.tail(LOG_LINES)) }
    }

    fun upload() {
        val report = _state.value.report ?: return
        if (_state.value.uploading) return
        _state.update { it.copy(uploading = true, uploadError = null, uploadedId = null) }
        viewModelScope.launch {
            val result = app.diagnostics.upload(report)
            _state.update {
                when (result) {
                    null -> it.copy(uploading = false, uploadError = "Pair this phone first: reports are stored per device.")
                    is ApiResult.Success -> it.copy(uploading = false, uploadedId = result.value.id)
                    is ApiResult.Failure -> it.copy(uploading = false, uploadError = "Upload failed: ${result.error.message}")
                }
            }
            refreshLocal()
        }
    }

    /** Forgets the last successful sync, so the next sync reads the last 30 days again. */
    fun resetLocalSyncState() {
        app.syncState.lastSuccessfulSyncAt = null
        app.syncState.lastAppOpenSyncAt = null
        AppLog.i("Diagnostics", "Local sync state reset: the next sync backfills 30 days")
        _state.update { it.copy(message = "Reset. The next sync reads the last 30 days.") }
        refreshLocal()
    }

    fun syncNow() {
        if (!app.isSyncConfigured) {
            _state.update { it.copy(message = "Pair this phone first.") }
            return
        }
        app.syncScheduler.ensurePeriodic()
        app.syncScheduler.syncNow(com.enterpriseapp.android.sync.SyncTrigger.MANUAL)
        _state.update { it.copy(message = "Sync started. Run the self-test again when it finishes.") }
    }

    fun sendTestNotification() {
        val outcome = SyncNotifications.notifyTest(getApplication())
        AppLog.i("Diagnostics", "Test notification: $outcome")
        val message = when (outcome) {
            SyncNotifications.TestOutcome.SENT -> "Test notification sent. If it did not appear, check the Notifications checks above."
            SyncNotifications.TestOutcome.NOT_ALLOWED -> "Notifications are not allowed: use \"Allow notifications\" first."
            SyncNotifications.TestOutcome.CHANNEL_BLOCKED -> "The \"General\" notification channel is blocked: allow it in the app's notification settings."
        }
        _state.update { it.copy(message = message) }
    }

    fun refreshNotifications(state: NotificationPermissionState) {
        _state.update { it.copy(notifications = state) }
    }

    fun showMessage(message: String) {
        _state.update { it.copy(message = message) }
    }

    companion object {
        const val LOG_LINES = 200
        val AUTO_RERUN: Duration = Duration.ofMinutes(1)
    }
}
