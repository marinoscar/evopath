package com.evopath.android.sync

import com.evopath.android.auth.TokenStore
import com.evopath.android.diagnostics.AppLog
import com.evopath.android.healthconnect.AppLabels
import com.evopath.android.healthconnect.HcAvailability
import com.evopath.android.healthconnect.HcDataType
import com.evopath.android.healthconnect.HealthConnectGateway
import com.evopath.android.net.ApiError
import com.evopath.android.net.ApiResult
import com.evopath.android.net.HealthSyncBackend
import java.time.Instant
import java.time.ZoneId
import kotlin.coroutines.cancellation.CancellationException

/** What a run ended as, for the worker (retry or not) and the UI. */
sealed interface SyncOutcome {
    /** The server recorded the run ([status] is the run status sent). */
    data class Completed(val status: String, val response: SyncResponse) : SyncOutcome

    /** Not paired (or registration never finished): nothing was read or sent. */
    data object NotPaired : SyncOutcome

    /** The token was refused (401). Sync stays off until the user re-pairs. */
    data object PairingExpired : SyncOutcome

    /** The server says this device was unpaired (409 DEVICE_REVOKED / 404): local pairing cleared. */
    data object Unpaired : SyncOutcome

    /** Network trouble or a server error: try again later (WorkManager backoff). */
    data class RetryLater(val message: String) : SyncOutcome

    /** Not retryable as is (the server refused the payload, no server configured…). */
    data class Failed(val message: String) : SyncOutcome
}

/** Shown when the server refuses the token. */
fun interface PairingExpiredNotifier {
    fun notifyPairingExpired()
}

/**
 * One Health Connect → EvoPath sync.
 *
 * Reads every data type that is switched on and permitted (each read isolated: a failure makes
 * that type partial, never the whole run), maps it with [HealthMapping], builds the payload with
 * [SyncPayloadBuilder], posts it, and records the run locally. It always tries to report the run
 * to the server, including failed and skipped ones.
 */
class HealthSyncEngine(
    private val gateway: HealthConnectGateway,
    private val backend: HealthSyncBackend,
    private val tokens: TokenStore,
    private val state: SyncStateStore,
    private val history: SyncHistoryStore,
    private val labels: AppLabels,
    private val notifier: PairingExpiredNotifier,
    private val clock: () -> Instant = Instant::now,
    private val zone: () -> ZoneId = ZoneId::systemDefault,
) {
    private val builder = SyncPayloadBuilder(labels)

    suspend fun run(trigger: SyncTrigger): SyncOutcome {
        val deviceId = tokens.deviceId
        if (!tokens.isPaired || deviceId.isNullOrEmpty()) return SyncOutcome.NotPaired
        if (state.pairingExpired) return SyncOutcome.PairingExpired

        val startedAt = clock()
        val zoneId = zone()
        val window = SyncWindow.compute(startedAt, zoneId, initial = state.lastSuccessfulSyncAt == null)
        AppLog.i(TAG, "Sync started (${trigger.wire}, ${window.from}..${window.to}, ${zoneId.id})")

        val availability = runCatching { gateway.availability() }.getOrDefault(HcAvailability.NOT_SUPPORTED)
        if (availability != HcAvailability.AVAILABLE) {
            val code = if (availability == HcAvailability.UPDATE_REQUIRED) "HC_UPDATE_REQUIRED" else "HC_UNAVAILABLE"
            return reportFailure(deviceId, trigger, startedAt, window, zoneId, code, "Health Connect is not available ($availability).")
        }

        val granted = try {
            gateway.grantedPermissions()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return reportFailure(deviceId, trigger, startedAt, window, zoneId, "HC_ERROR", "Could not read permissions: ${describe(e)}")
        }

        val enabledTypes = state.enabledToggles.flatMap { it.dataTypes }.toSet()
        val outcomes = readAll(window, zoneId, enabledTypes, granted)
        outcomes.filter { it.error != null }.forEach { AppLog.w(TAG, "Read ${it.type.key} failed: ${it.error}") }
        val built = builder.build(trigger, startedAt, clock(), window, timezoneId(zoneId), outcomes)
        return deliver(deviceId, trigger, built, outcomes, window, zoneId, startedAt)
    }

    // --- reading ----------------------------------------------------------------------------

    private suspend fun readAll(
        window: SyncWindow,
        zoneId: ZoneId,
        enabled: Set<HcDataType>,
        granted: Set<String>,
    ): List<TypeOutcome> {
        val from = window.startInstant(zoneId)
        val to = window.endInstant(zoneId)
        val distanceAllowed = HcDataType.DISTANCE in enabled && HcDataType.DISTANCE.permission in granted
        var distanceRead = 0
        var distanceError: String? = null

        val outcomes = HcDataType.SYNCED.map { type ->
            val base = TypeOutcome(type, enabled = type in enabled, granted = type.permission in granted)
            if (!base.attempted) return@map base
            try {
                when (type) {
                    HcDataType.STEPS -> {
                        val days = gateway.dailySteps(window.from, window.to)
                        val mapped = HealthMapping.steps(days, window)
                        base.copy(read = days.size, entries = mapped.rows, dropped = mapped.dropped, sources = aggregateSources(days.map { it.origins }))
                    }
                    HcDataType.EXERCISE -> {
                        val sessions = gateway.exerciseSessions(from, to)
                        val entries = mutableListOf<SyncEntry>()
                        sessions.sortedBy { it.start }.forEach { session ->
                            if (HealthMapping.exerciseKind(session.exerciseType) == null) return@forEach
                            val distance = if (distanceAllowed && distanceError == null) {
                                try {
                                    gateway.distanceMeters(session.start, session.end)?.also { distanceRead++ }
                                } catch (e: CancellationException) {
                                    throw e
                                } catch (e: Exception) {
                                    distanceError = describe(e)
                                    null
                                }
                            } else {
                                null
                            }
                            HealthMapping.exercise(session, distance, zoneId, window, labels.label(session.origin))?.let { entries += it }
                        }
                        base.copy(
                            read = sessions.size,
                            entries = entries,
                            dropped = sessions.size - entries.size,
                            sources = countSources(sessions.map { it.origin }),
                        )
                    }
                    HcDataType.HEART_RATE -> {
                        val days = gateway.dailyHeartRateAvg(window.from, window.to)
                        val mapped = HealthMapping.heartRateAverage(days, zoneId, window)
                        base.copy(read = days.size, measurements = mapped.rows, dropped = mapped.dropped, sources = aggregateSources(days.map { it.origins }))
                    }
                    HcDataType.RESTING_HEART_RATE -> samples(base, gateway.restingHeartRate(from, to), HealthMapping.Metric.RESTING_HR, zoneId, window)
                    HcDataType.HRV -> samples(base, gateway.heartRateVariability(from, to), HealthMapping.Metric.HRV, zoneId, window)
                    HcDataType.WEIGHT -> samples(base, gateway.weight(from, to), HealthMapping.Metric.WEIGHT, zoneId, window)
                    HcDataType.BODY_FAT -> samples(base, gateway.bodyFat(from, to), HealthMapping.Metric.BODY_FAT, zoneId, window)
                    HcDataType.BLOOD_PRESSURE -> {
                        val readings = gateway.bloodPressure(from, to)
                        val mapped = HealthMapping.bloodPressure(readings, zoneId, window)
                        base.copy(read = readings.size, measurements = mapped.rows, dropped = mapped.dropped, sources = countSources(readings.map { it.origin }))
                    }
                    HcDataType.SLEEP -> {
                        // A night that ends on the window's first day started the evening before.
                        val sessions = gateway.sleepSessions(from.minusSeconds(SLEEP_LOOKBACK_SECONDS), to)
                        val rows = sessions.sortedBy { it.end }.mapNotNull { HealthMapping.sleep(it, zoneId, window, labels.label(it.origin)) }
                        base.copy(read = sessions.size, sleepSessions = rows, dropped = sessions.size - rows.size, sources = countSources(sessions.map { it.origin }))
                    }
                    HcDataType.DISTANCE -> base
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                base.copy(error = describe(e))
            }
        }

        // Distance is read per exercise session; report it for diagnostics, never as a synced type.
        val distance = TypeOutcome(
            HcDataType.DISTANCE,
            enabled = HcDataType.DISTANCE in enabled,
            granted = HcDataType.DISTANCE.permission in granted,
            read = distanceRead,
            error = distanceError,
        )
        return outcomes + distance
    }

    private fun samples(
        base: TypeOutcome,
        samples: List<com.evopath.android.healthconnect.HcSample>,
        metric: HealthMapping.Metric,
        zoneId: ZoneId,
        window: SyncWindow,
    ): TypeOutcome {
        val mapped = HealthMapping.samples(samples, metric, zoneId, window)
        return base.copy(read = samples.size, measurements = mapped.rows, dropped = mapped.dropped, sources = countSources(samples.map { it.origin }))
    }

    // --- delivering ---------------------------------------------------------------------------

    private suspend fun deliver(
        deviceId: String,
        trigger: SyncTrigger,
        firstBuild: BuiltSync,
        outcomes: List<TypeOutcome>,
        window: SyncWindow,
        zoneId: ZoneId,
        startedAt: Instant,
    ): SyncOutcome {
        var built = firstBuild
        var retriedWithoutHealthData = false
        while (true) {
            when (val result = backend.sync(deviceId, built.request)) {
                is ApiResult.Success -> {
                    if (built.status == RunStatus.OK || built.status == RunStatus.PARTIAL) {
                        state.lastSuccessfulSyncAt = clock()
                    }
                    val r = result.value
                    AppLog.i(
                        TAG,
                        "Sync ${built.status}: read ${built.recordsRead}, sent ${built.rowsSent}; server created ${r.totalCreated}, " +
                            "updated ${r.totalUpdated}, deleted ${r.totalDeleted}, skipped ${r.skipped + (r.measurements?.skipped ?: 0) + (r.sleep?.skipped ?: 0)}" +
                            (built.request.run.errorCode?.let { " [$it]" } ?: ""),
                    )
                    record(built, delivered = true, response = result.value)
                    return SyncOutcome.Completed(built.status, result.value)
                }
                is ApiResult.Failure -> {
                    val error = result.error
                    if (error.httpStatus == 403 && error.reason == REASON_HEALTH_DATA_SCOPE && !retriedWithoutHealthData) {
                        // The account may not write health data: resend activity only, once.
                        retriedWithoutHealthData = true
                        val stripped = outcomes.map { outcome ->
                            if (outcome.type in HEALTH_DATA_TYPES && outcome.attempted && outcome.error == null) {
                                outcome.copy(measurements = emptyList(), sleepSessions = emptyList(), error = "forbidden")
                            } else {
                                outcome
                            }
                        }
                        built = builder.build(trigger, startedAt, clock(), window, timezoneId(zoneId), stripped)
                        continue
                    }
                    return handleFailure(deviceId, trigger, built, error, window, zoneId, startedAt)
                }
            }
        }
    }

    private suspend fun handleFailure(
        deviceId: String,
        trigger: SyncTrigger,
        built: BuiltSync,
        error: ApiError,
        window: SyncWindow,
        zoneId: ZoneId,
        startedAt: Instant,
    ): SyncOutcome {
        AppLog.w(TAG, "Sync not accepted: ${error.kind} ${error.httpStatus ?: ""} ${error.reason ?: error.code ?: ""}".trim())
        when {
            error.isUnauthorized -> {
                state.pairingExpired = true
                record(built, delivered = false, errorCode = "UNAUTHORIZED", errorMessage = error.message)
                notifier.notifyPairingExpired()
                return SyncOutcome.PairingExpired
            }
            isUnpaired(error) -> {
                record(built, delivered = false, errorCode = error.reason ?: error.code, errorMessage = error.message)
                tokens.clear()
                state.resetPairingState()
                return SyncOutcome.Unpaired
            }
            isTransient(error) -> {
                record(built, delivered = false, errorCode = error.code ?: error.kind.name, errorMessage = error.message)
                return SyncOutcome.RetryLater(error.message)
            }
            else -> {
                // The server refused the payload: keep it locally and tell the server, without data.
                val code = "SERVER_REJECTED" + (error.reason ?: error.code)?.let { ":$it" }.orEmpty()
                record(built, delivered = false, errorCode = code, errorMessage = error.message)
                if (error.kind == ApiError.Kind.HTTP) {
                    val failedRun = built.request.copy(
                        run = built.request.run.copy(
                            status = RunStatus.FAILED,
                            finishedAt = Iso.instant(clock()),
                            errorCode = code.take(100),
                            errorMessage = error.message.take(SyncPayloadBuilder.MAX_ERROR_MESSAGE),
                            details = built.request.run.details?.copy(syncedTypes = emptyList()),
                        ),
                        window = null,
                        entries = emptyList(),
                        measurements = null,
                        sleepSessions = null,
                    )
                    backend.sync(deviceId, failedRun)
                }
                return SyncOutcome.Failed(error.message)
            }
        }
    }

    /** Reports a run that could not read anything (Health Connect missing or broken). */
    private suspend fun reportFailure(
        deviceId: String,
        trigger: SyncTrigger,
        startedAt: Instant,
        window: SyncWindow,
        zoneId: ZoneId,
        code: String,
        message: String,
    ): SyncOutcome {
        AppLog.w(TAG, "Sync cannot read Health Connect: $code $message")
        val enabledTypes = state.enabledToggles.flatMap { it.dataTypes }.toSet()
        val outcomes = HcDataType.SYNCED.map { TypeOutcome(it, enabled = it in enabledTypes, granted = false) }
        val built = builder.build(trigger, startedAt, clock(), window, timezoneId(zoneId), outcomes)
        val request = built.request.copy(run = built.request.run.copy(status = RunStatus.FAILED, errorCode = code, errorMessage = message))
        val failed = built.copy(request = request, status = RunStatus.FAILED)
        return when (val outcome = deliver(deviceId, trigger, failed, outcomes, window, zoneId, startedAt)) {
            is SyncOutcome.Completed -> SyncOutcome.Failed(message)
            else -> outcome
        }
    }

    private fun record(built: BuiltSync, delivered: Boolean, response: SyncResponse? = null, errorCode: String? = null, errorMessage: String? = null) {
        val run = built.request.run
        history.add(
            LocalSyncRun(
                startedAt = run.startedAt,
                finishedAt = run.finishedAt,
                trigger = run.trigger,
                status = if (delivered) built.status else RunStatus.FAILED,
                delivered = delivered,
                windowFrom = built.request.window?.from,
                windowTo = built.request.window?.to,
                recordsRead = built.recordsRead,
                rowsSent = built.rowsSent,
                syncedTypes = built.syncedTypes,
                perType = run.details?.perType.orEmpty(),
                response = response,
                errorCode = errorCode ?: run.errorCode,
                errorMessage = errorMessage ?: run.errorMessage,
            ),
        )
    }

    companion object {
        private const val TAG = "Sync"
        const val REASON_DEVICE_REVOKED = "DEVICE_REVOKED"
        const val REASON_HEALTH_DATA_SCOPE = "HEALTH_DATA_SCOPE_REQUIRED"
        private const val SLEEP_LOOKBACK_SECONDS = 24 * 3600L

        /** Types stored as measurements or sleep (they need `health_data:write`). */
        val HEALTH_DATA_TYPES: Set<HcDataType> = setOf(
            HcDataType.HEART_RATE,
            HcDataType.RESTING_HEART_RATE,
            HcDataType.HRV,
            HcDataType.WEIGHT,
            HcDataType.BODY_FAT,
            HcDataType.BLOOD_PRESSURE,
            HcDataType.SLEEP,
        )

        fun isUnpaired(error: ApiError): Boolean =
            (error.httpStatus == 409 && error.reason == REASON_DEVICE_REVOKED) || error.httpStatus == 404

        fun isTransient(error: ApiError): Boolean =
            error.kind == ApiError.Kind.NETWORK ||
                error.kind == ApiError.Kind.PARSE ||
                (error.httpStatus ?: 0) >= 500 ||
                error.httpStatus == 429 ||
                error.httpStatus == 408

        private fun timezoneId(zone: ZoneId): String = zone.id

        private fun describe(e: Exception): String {
            val base = "${e.javaClass.simpleName}${e.message?.let { ": $it" }.orEmpty()}"
            return if (e is SecurityException) "$base (permission missing, or background read not allowed)" else base
        }

        private fun countSources(origins: List<String>): Map<String, Int> = origins.groupingBy { it }.eachCount()

        private fun aggregateSources(origins: List<Set<String>>): Map<String, Int> =
            origins.flatten().groupingBy { it }.eachCount()
    }
}
