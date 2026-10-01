package com.evopath.android.healthsync

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.work.WorkInfo
import androidx.work.WorkManager
import com.evopath.android.EvoPathApplication
import com.evopath.android.healthconnect.HcAvailability
import com.evopath.android.healthconnect.HealthPermissions
import com.evopath.android.healthconnect.SyncToggle
import com.evopath.android.sync.LocalSyncRun
import com.evopath.android.sync.SyncTrigger
import com.evopath.android.sync.WorkManagerSyncScheduler
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.Instant

data class SyncUiState(
    val availability: HcAvailability? = null,
    val providerVersion: String? = null,
    val backgroundReadAvailable: Boolean = false,
    val granted: Set<String> = emptySet(),
    val permissionsError: String? = null,
    val toggles: Map<SyncToggle, Boolean> = SyncToggle.entries.associateWith { true },
    val paired: Boolean = false,
    val pairingExpired: Boolean = false,
    val lastSuccessAt: Instant? = null,
    val runs: List<LocalSyncRun> = emptyList(),
    val syncing: Boolean = false,
    val syncQueued: Boolean = false,
) {
    val enabledToggles: List<SyncToggle> get() = toggles.filterValues { it }.keys.toList()

    /** Permissions still to request for the enabled types (+ background when supported). */
    val missingPermissions: Set<String>
        get() = SyncToggle.permissionsFor(enabledToggles, includeBackground = backgroundReadAvailable) - granted

    val backgroundGranted: Boolean get() = HealthPermissions.READ_HEALTH_DATA_IN_BACKGROUND in granted
}

/** Health Connect status, per-type toggles, Sync now and local history. */
class SyncViewModel(application: Application) : AndroidViewModel(application) {
    private val app = EvoPathApplication.from(application)
    private val _state = MutableStateFlow(SyncUiState())
    val state: StateFlow<SyncUiState> = _state.asStateFlow()

    init {
        refresh()
        viewModelScope.launch { app.syncFinished.collect { refreshLocal() } }
        viewModelScope.launch {
            WorkManager.getInstance(application)
                .getWorkInfosForUniqueWorkFlow(WorkManagerSyncScheduler.NOW_WORK)
                .collect { infos ->
                    val running = infos.any { it.state == WorkInfo.State.RUNNING }
                    val queued = infos.any { it.state == WorkInfo.State.ENQUEUED || it.state == WorkInfo.State.BLOCKED }
                    _state.update { it.copy(syncing = running, syncQueued = queued) }
                    if (infos.any { it.state.isFinished }) refreshLocal()
                }
        }
    }

    /** Re-reads Health Connect status and local state (call on resume). */
    fun refresh() {
        refreshLocal()
        viewModelScope.launch {
            val gateway = app.healthConnect
            val availability = runCatching { gateway.availability() }.getOrDefault(HcAvailability.NOT_SUPPORTED)
            if (availability != HcAvailability.AVAILABLE) {
                _state.update { it.copy(availability = availability, granted = emptySet(), providerVersion = null) }
                return@launch
            }
            val granted = runCatching { gateway.grantedPermissions() }
            if (granted.getOrNull()?.contains(HealthPermissions.READ_HEALTH_DATA_IN_BACKGROUND) == true) {
                com.evopath.android.sync.SyncNotifications.cancelBackgroundAccess(app)
            }
            _state.update {
                it.copy(
                    availability = availability,
                    providerVersion = gateway.providerVersion(),
                    backgroundReadAvailable = gateway.isBackgroundReadAvailable(),
                    granted = granted.getOrDefault(emptySet()),
                    permissionsError = granted.exceptionOrNull()?.let { e -> "${e.javaClass.simpleName}: ${e.message}" },
                )
            }
        }
    }

    private fun refreshLocal() {
        val state = app.syncState
        _state.update {
            it.copy(
                toggles = SyncToggle.entries.associateWith { t -> state.isEnabled(t) },
                paired = app.tokenStore.isPaired && app.tokenStore.deviceId != null,
                pairingExpired = state.pairingExpired,
                lastSuccessAt = state.lastSuccessfulSyncAt,
                runs = app.syncHistory.runs(),
            )
        }
    }

    fun setToggle(toggle: SyncToggle, enabled: Boolean) {
        app.syncState.setEnabled(toggle, enabled)
        refreshLocal()
    }

    fun onPermissionsResult(@Suppress("UNUSED_PARAMETER") granted: Set<String>) {
        // The contract returns only what was granted in this request; re-read the full set.
        refresh()
    }

    fun syncNow() {
        if (!app.isSyncConfigured) return
        app.syncScheduler.ensurePeriodic()
        app.syncScheduler.syncNow(SyncTrigger.MANUAL)
        _state.update { it.copy(syncQueued = true) }
    }
}
