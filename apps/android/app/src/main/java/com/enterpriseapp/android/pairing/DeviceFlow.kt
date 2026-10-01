package com.enterpriseapp.android.pairing

import com.enterpriseapp.android.net.ApiClient
import com.enterpriseapp.android.net.ApiError
import com.enterpriseapp.android.net.ApiResult
import kotlinx.coroutines.delay
import kotlinx.serialization.Serializable
import java.time.Instant

// Wire format: docs/DEVICE-AUTH.md (RFC 8628). Reference client: apps/cli/src/device-auth.ts.

@Serializable
data class DeviceClientInfo(val deviceName: String, val userAgent: String, val tokenType: String = "pat")

@Serializable
data class DeviceCodeRequest(val clientInfo: DeviceClientInfo)

@Serializable
data class DeviceCodeGrant(
    val deviceCode: String,
    val userCode: String,
    val verificationUri: String,
    val verificationUriComplete: String? = null,
    val expiresIn: Int,
    val interval: Int = 5,
)

@Serializable
data class DeviceTokenRequest(val deviceCode: String)

/** `POST /api/auth/device/token` success. For `tokenType: "pat"`, [credentialType] is `"pat"`. */
@Serializable
data class DeviceCredential(
    val accessToken: String,
    val tokenType: String = "Bearer",
    val expiresIn: Long? = null,
    val credentialType: String? = null,
    val expiresAt: String? = null,
    val tokenId: String? = null,
    val tokenName: String? = null,
) {
    /** Server expiry, or now + [expiresIn] when only that is present. */
    fun expiryInstant(now: Instant): Instant? =
        expiresAt?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: expiresIn?.let { now.plusSeconds(it) }
}

/** The two device-flow calls, as an interface so the poller can be tested with a fake. */
interface DeviceFlowTransport {
    suspend fun requestCode(clientInfo: DeviceClientInfo): ApiResult<DeviceCodeGrant>
    suspend fun pollToken(deviceCode: String): ApiResult<DeviceCredential>
}

/** Both routes are public: never send a (possibly stale) bearer token. */
class ApiDeviceFlowTransport(private val api: ApiClient) : DeviceFlowTransport {
    override suspend fun requestCode(clientInfo: DeviceClientInfo): ApiResult<DeviceCodeGrant> =
        api.post(
            "/api/auth/device/code",
            DeviceCodeRequest(clientInfo),
            DeviceCodeRequest.serializer(),
            DeviceCodeGrant.serializer(),
            authenticated = false,
        )

    override suspend fun pollToken(deviceCode: String): ApiResult<DeviceCredential> =
        api.post(
            "/api/auth/device/token",
            DeviceTokenRequest(deviceCode),
            DeviceTokenRequest.serializer(),
            DeviceCredential.serializer(),
            authenticated = false,
        )
}

/** Progress reported while polling. */
sealed interface PollProgress {
    data class Waiting(val attempt: Int, val intervalSeconds: Int, val secondsRemaining: Long) : PollProgress
    data class SlowedDown(val intervalSeconds: Int) : PollProgress
    data class NetworkTrouble(val message: String) : PollProgress
}

sealed interface PollResult {
    data class Approved(val credential: DeviceCredential) : PollResult
    data object Denied : PollResult
    data object Expired : PollResult
    data class Failed(val message: String) : PollResult
}

/**
 * RFC 8628 polling state machine (mirrors `pollForDeviceToken` in the CLI):
 * - `authorization_pending` → keep polling at the interval;
 * - `slow_down` → interval + 5 s (capped at 60 s);
 * - `expired_token` → [PollResult.Expired]; `access_denied` → [PollResult.Denied];
 * - `invalid_grant` / `invalid_request` → [PollResult.Failed];
 * - network errors, 5xx and an unclassifiable 4xx keep polling until the code's own deadline.
 *
 * Every sleep is padded by [POLL_MARGIN_MS] (the server compares with a strict `<`) and never
 * runs past the deadline. Cancellation (the ViewModel going away) propagates.
 */
class DeviceFlowPoller(
    private val transport: DeviceFlowTransport,
    private val sleep: suspend (Long) -> Unit = { delay(it) },
    private val nowMillis: () -> Long = System::currentTimeMillis,
) {
    suspend fun poll(grant: DeviceCodeGrant, onProgress: (PollProgress) -> Unit = {}): PollResult {
        var interval = clampInterval(grant.interval)
        val deadline = nowMillis() + grant.expiresIn * 1000L
        var attempt = 0
        while (true) {
            if (nowMillis() >= deadline) return PollResult.Expired
            attempt += 1
            onProgress(PollProgress.Waiting(attempt, interval, ((deadline - nowMillis()) / 1000).coerceAtLeast(0)))

            when (val result = transport.pollToken(grant.deviceCode)) {
                is ApiResult.Success -> {
                    val credential = result.value
                    if (credential.accessToken.isBlank()) return PollResult.Failed("The server returned an empty token.")
                    if (credential.credentialType != null && credential.credentialType != "pat") {
                        return PollResult.Failed("The server issued a ${credential.credentialType} instead of an access token.")
                    }
                    return PollResult.Approved(credential)
                }
                is ApiResult.Failure -> when (val signal = classify(result.error)) {
                    Signal.Pending -> Unit
                    Signal.SlowDown -> {
                        interval = clampInterval(interval + SLOW_DOWN_INCREMENT_SECONDS)
                        onProgress(PollProgress.SlowedDown(interval))
                    }
                    Signal.Denied -> return PollResult.Denied
                    Signal.Expired -> return PollResult.Expired
                    is Signal.Fatal -> return PollResult.Failed(signal.message)
                    is Signal.Transient -> onProgress(PollProgress.NetworkTrouble(signal.message))
                }
            }

            val remaining = deadline - nowMillis()
            if (remaining <= 0) return PollResult.Expired
            sleep(minOf(interval * 1000L + POLL_MARGIN_MS, remaining))
        }
    }

    private sealed interface Signal {
        data object Pending : Signal
        data object SlowDown : Signal
        data object Denied : Signal
        data object Expired : Signal
        data class Fatal(val message: String) : Signal
        data class Transient(val message: String) : Signal
    }

    private fun classify(error: ApiError): Signal = when (error.oauthError) {
        "authorization_pending" -> Signal.Pending
        "slow_down" -> Signal.SlowDown
        "access_denied" -> Signal.Denied
        "expired_token" -> Signal.Expired
        "invalid_grant" -> Signal.Fatal("The server rejected this code (${error.message}). Start pairing again.")
        "invalid_request" -> Signal.Fatal("The server rejected the request (${error.message}). Start pairing again.")
        null -> when {
            error.kind == ApiError.Kind.NOT_CONFIGURED -> Signal.Fatal(error.message)
            error.kind == ApiError.Kind.NETWORK -> Signal.Transient(error.message)
            (error.httpStatus ?: 0) >= 500 || error.httpStatus == 429 -> Signal.Transient(error.message)
            // An unclassifiable 4xx: keep waiting (bounded by the deadline), like the CLI.
            else -> Signal.Pending
        }
        else -> Signal.Fatal("Unexpected answer from the server: ${error.oauthError}.")
    }

    companion object {
        const val SLOW_DOWN_INCREMENT_SECONDS = 5
        const val MAX_POLL_INTERVAL_SECONDS = 60
        const val POLL_MARGIN_MS = 250L

        fun clampInterval(seconds: Int): Int = seconds.coerceIn(1, MAX_POLL_INTERVAL_SECONDS)
    }
}
