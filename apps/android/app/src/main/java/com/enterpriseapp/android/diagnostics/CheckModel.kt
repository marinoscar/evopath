package com.enterpriseapp.android.diagnostics

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import kotlinx.serialization.json.JsonObject
import kotlin.coroutines.cancellation.CancellationException

/** Verdict of one check. Wire values are lowercase (`pass`, `warn`, `fail`, `skip`). */
enum class CheckStatus(val wire: String) {
    PASS("pass"),
    WARN("warn"),
    FAIL("fail"),
    SKIP("skip"),
    ;

    companion object {
        fun fromWire(value: String): CheckStatus = entries.firstOrNull { it.wire == value } ?: SKIP
    }
}

/** Something the Diagnostics screen can do about a check (a button next to its remedy). */
enum class CheckAction(val label: String) {
    SET_SERVER("Set server"),
    REPAIR("Re-pair"),
    GRANT_PERMISSIONS("Grant permissions"),
    GRANT_BACKGROUND("Allow background access"),
    OPEN_HEALTH_CONNECT("Open Health Connect"),
    UPDATE_HEALTH_CONNECT("Install or update Health Connect"),
    BATTERY_SETTINGS("Battery settings"),
    NOTIFICATION_SETTINGS("Notification settings"),
    SYNC_NOW("Sync now"),
    OPEN_CONNECTED_DEVICES("Open Connected devices"),
    OPEN_ANDROID_APP_ADMIN("Open Admin → Android app"),
    GET_UPDATE("Get the update"),
}

/**
 * One self-test result. Serialized into the report as
 * `{ id, label, status, detail, remedy?, data? }`; [action] stays on the phone.
 */
@Serializable
data class CheckResult(
    val id: String,
    val label: String,
    val status: String,
    val detail: String,
    val remedy: String? = null,
    val data: JsonObject? = null,
    @Transient val action: CheckAction? = null,
) {
    val verdict: CheckStatus get() = CheckStatus.fromWire(status)

    companion object {
        fun of(
            id: String,
            label: String,
            status: CheckStatus,
            detail: String,
            remedy: String? = null,
            action: CheckAction? = null,
            data: JsonObject? = null,
        ) = CheckResult(id, label, status.wire, detail, remedy, data, action)
    }
}

/** Outcome of one timed probe (a call a check depends on). Never thrown. */
sealed interface Probe<out T> {
    data class Ok<T>(val value: T, val elapsedMs: Long) : Probe<T>
    data class Error(val error: Throwable, val elapsedMs: Long) : Probe<Nothing> {
        val description: String get() = "${error.javaClass.simpleName}${error.message?.let { ": $it" }.orEmpty()}"
    }
    data class TimedOut(val timeoutMs: Long) : Probe<Nothing>

    fun valueOrNull(): T? = (this as? Ok<T>)?.value
}

/**
 * Runs [block] with a hard deadline. The block runs in a detached scope, so a call that
 * ignores cancellation (blocking I/O) cannot hold the self-test past [timeoutMs].
 */
suspend fun <T> probe(timeoutMs: Long, nanoTime: () -> Long = System::nanoTime, block: suspend () -> T): Probe<T> {
    val start = nanoTime()
    fun elapsed() = (nanoTime() - start) / 1_000_000
    val deferred = ProbeScope.async {
        try {
            Result.success(block())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            Result.failure<T>(e)
        }
    }
    val result = try {
        withTimeoutOrNull(timeoutMs) { deferred.await() }
    } catch (e: CancellationException) {
        deferred.cancel()
        throw e
    }
    if (result == null) {
        deferred.cancel()
        return Probe.TimedOut(timeoutMs)
    }
    return result.fold(onSuccess = { Probe.Ok(it, elapsed()) }, onFailure = { Probe.Error(it, elapsed()) })
}

private val ProbeScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
