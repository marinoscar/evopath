package com.evopath.android.pairing

import com.evopath.android.auth.TokenStore
import com.evopath.android.diagnostics.AppLog
import com.evopath.android.net.ApiError
import com.evopath.android.net.ApiResult
import com.evopath.android.net.HealthSyncBackend
import com.evopath.android.net.RegisterDeviceRequest
import com.evopath.android.sync.SyncScheduling
import com.evopath.android.sync.SyncStateStore
import com.evopath.android.sync.SyncTrigger
import java.time.Instant

/** Events of one pairing attempt, for the Connect screen. */
sealed interface PairingEvent {
    data class CodeReady(val grant: DeviceCodeGrant) : PairingEvent
    data class Progress(val progress: PollProgress) : PairingEvent
    data object Registering : PairingEvent
}

sealed interface PairingResult {
    data class Paired(val deviceId: String, val tokenExpiresAt: Instant?) : PairingResult
    data class Failed(val message: String, val canRetryRegistration: Boolean = false) : PairingResult
}

sealed interface UnpairResult {
    data object Done : UnpairResult

    /** The server could not be reached; [message] says why. The caller may forget locally anyway. */
    data class ServerUnreachable(val message: String) : UnpairResult
}

/**
 * Pairing = device flow for a PAT, then `POST /api/health-sync/devices`.
 *
 * The token is stored as soon as it is collected, so a failed registration can be retried
 * without a new browser approval ([retryRegistration]). Successful pairing clears the
 * pairing-expired flag, forgets the last successful sync (the next sync backfills 30 days),
 * schedules the hourly sync and starts an initial one.
 */
class PairingManager(
    private val transport: DeviceFlowTransport,
    private val poller: DeviceFlowPoller,
    private val backend: HealthSyncBackend,
    private val tokens: TokenStore,
    private val state: SyncStateStore,
    private val scheduler: SyncScheduling,
    /** Client info for the device-code request. */
    private val clientInfo: () -> DeviceClientInfo,
    /** Registration body for this phone (installation id filled in here). */
    private val deviceRegistration: (installationId: String) -> RegisterDeviceRequest,
    private val clock: () -> Instant = Instant::now,
) {
    suspend fun pair(onEvent: (PairingEvent) -> Unit): PairingResult {
        AppLog.i(TAG, "Pairing started")
        val grant = when (val code = transport.requestCode(clientInfo())) {
            is ApiResult.Success -> code.value
            is ApiResult.Failure -> return failed("Could not start pairing: ${code.error.message}")
        }
        onEvent(PairingEvent.CodeReady(grant))

        return when (val polled = poller.poll(grant) { onEvent(PairingEvent.Progress(it)) }) {
            is PollResult.Approved -> {
                val expiresAt = polled.credential.expiryInstant(clock())
                tokens.setToken(polled.credential.accessToken, expiresAt)
                tokens.setDeviceId(null)
                AppLog.i(TAG, "Pairing approved; token stored (expires ${expiresAt ?: "unknown"})")
                onEvent(PairingEvent.Registering)
                register()
            }
            PollResult.Denied -> failed("Pairing was denied in the browser. Nothing was saved.")
            PollResult.Expired -> failed("The pairing code expired. Start again.")
            is PollResult.Failed -> failed(polled.message)
        }
    }

    private fun failed(message: String, canRetryRegistration: Boolean = false): PairingResult.Failed {
        AppLog.w(TAG, "Pairing failed: $message")
        return PairingResult.Failed(message, canRetryRegistration)
    }

    /** Registers this phone with the stored token (after pairing, or to retry a failed registration). */
    suspend fun register(): PairingResult {
        if (!tokens.isPaired) return failed("Not signed in: pair again.")
        return when (val result = backend.registerDevice(deviceRegistration(tokens.installationId))) {
            is ApiResult.Success -> {
                AppLog.i(TAG, "Phone registered as device ${result.value.id}")
                tokens.setDeviceId(result.value.id)
                state.resetPairingState()
                scheduler.ensurePeriodic()
                scheduler.syncNow(SyncTrigger.INITIAL)
                PairingResult.Paired(result.value.id, tokens.expiresAt)
            }
            is ApiResult.Failure -> {
                val error = result.error
                if (error.isUnauthorized) {
                    tokens.clear()
                    failed("The server refused the new token: pair again.")
                } else {
                    failed("Could not register this phone: ${error.message}", canRetryRegistration = true)
                }
            }
        }
    }

    /**
     * Unpairs on the server (`DELETE /devices/:id`, which also revokes the token), then forgets
     * the pairing here. A server that already forgot the device (401/404/409) counts as done.
     */
    suspend fun unpair(forgetLocallyOnFailure: Boolean = false): UnpairResult {
        val deviceId = tokens.deviceId
        if (deviceId != null && tokens.isPaired) {
            when (val result = backend.unpair(deviceId)) {
                is ApiResult.Success -> Unit
                is ApiResult.Failure -> {
                    val status = result.error.httpStatus
                    val alreadyGone = status == 401 || status == 404 || status == 409
                    if (!alreadyGone && !forgetLocallyOnFailure) {
                        return UnpairResult.ServerUnreachable(describe(result.error))
                    }
                }
            }
        }
        forgetLocally()
        return UnpairResult.Done
    }

    fun forgetLocally() {
        AppLog.i(TAG, "Pairing removed from this phone")
        scheduler.cancelAll()
        tokens.clear()
        state.resetPairingState()
    }

    private fun describe(error: ApiError): String = error.message

    private companion object {
        const val TAG = "Pairing"
    }
}
