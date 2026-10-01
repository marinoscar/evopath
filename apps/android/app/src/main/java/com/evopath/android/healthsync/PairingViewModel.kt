package com.evopath.android.healthsync

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.evopath.android.EvoPathApplication
import com.evopath.android.pairing.PairingEvent
import com.evopath.android.pairing.PairingResult
import com.evopath.android.pairing.PollProgress
import com.evopath.android.pairing.UnpairResult
import com.evopath.android.sync.SyncNotifications
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.Instant

/** Pairing as stored on the phone. */
data class PairingStatus(
    val serverConfigured: Boolean = false,
    val hasToken: Boolean = false,
    val deviceId: String? = null,
    val tokenExpiresAt: Instant? = null,
    val expired: Boolean = false,
) {
    val paired: Boolean get() = hasToken && deviceId != null
}

enum class PairingPhase { IDLE, REQUESTING_CODE, WAITING_FOR_APPROVAL, REGISTERING, UNPAIRING }

data class PairingUiState(
    val status: PairingStatus = PairingStatus(),
    val phase: PairingPhase = PairingPhase.IDLE,
    val userCode: String? = null,
    val verificationUri: String? = null,
    val verificationUriComplete: String? = null,
    val secondsRemaining: Long? = null,
    val note: String? = null,
    val error: String? = null,
    val canRetryRegistration: Boolean = false,
    /** Set when unpairing could not reach the server; the UI offers "remove from this phone only". */
    val unpairFailure: String? = null,
    val justPaired: Boolean = false,
)

/**
 * Drives the device flow. Lives in a ViewModel so polling continues across rotation; leaving
 * the screen for the browser (Custom Tab) does not cancel it either.
 */
class PairingViewModel(application: Application) : AndroidViewModel(application) {
    private val app = EvoPathApplication.from(application)
    private val manager = app.newPairingManager()
    private var job: Job? = null

    private val _state = MutableStateFlow(PairingUiState(status = readStatus()))
    val state: StateFlow<PairingUiState> = _state.asStateFlow()

    private val openUrlChannel = Channel<String>(Channel.BUFFERED)

    /** URLs to open in a Custom Tab (the activation page). */
    val openUrl: Flow<String> = openUrlChannel.receiveAsFlow()

    fun refreshStatus() {
        _state.update { it.copy(status = readStatus()) }
    }

    fun startPairing() {
        if (job?.isActive == true) return
        _state.update { PairingUiState(status = it.status, phase = PairingPhase.REQUESTING_CODE) }
        job = viewModelScope.launch {
            val result = manager.pair { event -> onEvent(event) }
            finish(result)
        }
    }

    fun retryRegistration() {
        if (job?.isActive == true) return
        _state.update { it.copy(phase = PairingPhase.REGISTERING, error = null, canRetryRegistration = false) }
        job = viewModelScope.launch { finish(manager.register()) }
    }

    fun cancel() {
        job?.cancel()
        job = null
        _state.update { PairingUiState(status = readStatus()) }
    }

    fun reopenActivationPage() {
        val state = _state.value
        (state.verificationUriComplete ?: state.verificationUri)?.let { openUrlChannel.trySend(it) }
    }

    fun unpair(forgetLocallyOnFailure: Boolean = false) {
        if (job?.isActive == true) return
        _state.update { it.copy(phase = PairingPhase.UNPAIRING, unpairFailure = null, error = null) }
        job = viewModelScope.launch {
            when (val result = manager.unpair(forgetLocallyOnFailure)) {
                UnpairResult.Done -> {
                    SyncNotifications.cancelPairingExpired(app)
                    app.syncHistory.clear()
                    app.onSyncFinished()
                    _state.value = PairingUiState(status = readStatus(), note = "This phone is no longer paired.")
                }
                is UnpairResult.ServerUnreachable ->
                    _state.update { it.copy(phase = PairingPhase.IDLE, unpairFailure = result.message) }
            }
        }
    }

    fun dismissUnpairFailure() {
        _state.update { it.copy(unpairFailure = null) }
    }

    private fun onEvent(event: PairingEvent) {
        when (event) {
            is PairingEvent.CodeReady -> {
                _state.update {
                    it.copy(
                        phase = PairingPhase.WAITING_FOR_APPROVAL,
                        userCode = event.grant.userCode,
                        verificationUri = event.grant.verificationUri,
                        verificationUriComplete = event.grant.verificationUriComplete,
                        secondsRemaining = event.grant.expiresIn.toLong(),
                    )
                }
                openUrlChannel.trySend(event.grant.verificationUriComplete ?: event.grant.verificationUri)
            }
            is PairingEvent.Progress -> when (val p = event.progress) {
                is PollProgress.Waiting -> _state.update { it.copy(secondsRemaining = p.secondsRemaining, note = null) }
                is PollProgress.SlowedDown -> Unit
                is PollProgress.NetworkTrouble -> _state.update { it.copy(note = "Connection trouble, still trying… (${p.message})") }
            }
            PairingEvent.Registering -> _state.update { it.copy(phase = PairingPhase.REGISTERING, note = null) }
        }
    }

    private fun finish(result: PairingResult) {
        when (result) {
            is PairingResult.Paired -> {
                SyncNotifications.cancelPairingExpired(app)
                app.onSyncFinished()
                _state.value = PairingUiState(status = readStatus(), note = "Paired. The first sync has started.", justPaired = true)
            }
            is PairingResult.Failed -> _state.value = PairingUiState(
                status = readStatus(),
                error = result.message,
                canRetryRegistration = result.canRetryRegistration,
            )
        }
    }

    private fun readStatus(): PairingStatus {
        val tokens = app.tokenStore
        return PairingStatus(
            serverConfigured = app.serverConfig.isConfigured,
            hasToken = tokens.isPaired,
            deviceId = tokens.deviceId,
            tokenExpiresAt = tokens.expiresAt,
            expired = app.syncState.pairingExpired,
        )
    }
}
