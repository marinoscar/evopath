package com.evopath.android.diagnostics

import com.evopath.android.auth.TokenStore
import com.evopath.android.net.ApiResult
import com.evopath.android.net.HealthSyncBackend
import com.evopath.android.net.UploadDiagnosticsRequest
import com.evopath.android.net.UploadDiagnosticsResponse
import com.evopath.android.sync.RunStatus
import com.evopath.android.sync.SyncHistoryStore
import com.evopath.android.sync.SyncOutcome
import com.evopath.android.sync.SyncStateStore
import java.time.Duration
import java.time.Instant

/** Runs the self-test, builds the report and uploads it. Shared by the screen and the worker. */
class DiagnosticsService(
    private val selfTest: () -> SelfTest,
    private val backend: HealthSyncBackend,
    private val tokens: TokenStore,
    private val state: SyncStateStore,
    private val history: SyncHistoryStore,
    private val log: (Int) -> List<String> = AppLog::tail,
) {
    suspend fun runSelfTest(): SelfTestResult = selfTest().run()

    fun buildReport(result: SelfTestResult): BuiltReport =
        DiagnosticReportBuilder.build(result, tokens, state, history.runs(), log(DiagnosticsLimits.REPORT_LOG_LINES))

    /** `POST /devices/:id/diagnostics`; needs a registered device (works for a revoked one too). */
    suspend fun upload(report: BuiltReport): ApiResult<UploadDiagnosticsResponse>? {
        val deviceId = tokens.deviceId?.takeIf { it.isNotEmpty() && tokens.isPaired } ?: return null
        return backend.uploadDiagnostics(deviceId, UploadDiagnosticsRequest(summary = report.summary.take(500), report = report.json))
            .also { result ->
                when (result) {
                    is ApiResult.Success -> AppLog.i(TAG, "Report uploaded (${result.value.id}, ${report.sizeBytes} bytes)")
                    is ApiResult.Failure -> AppLog.w(TAG, "Report upload failed: ${result.error.httpStatus ?: result.error.kind}")
                }
            }
    }

    private companion object {
        const val TAG = "Diagnostics"
    }
}

/**
 * After a failed or partial sync, uploads a diagnostics report (at most once per [INTERVAL]),
 * so the web always has a recent report when something breaks. Only when the pairing is valid
 * and the server answers its liveness probe.
 */
class AutoDiagnostics(
    private val tokens: TokenStore,
    private val state: SyncStateStore,
    private val server: ServerProbe,
    private val service: DiagnosticsService,
    private val clock: () -> Instant = Instant::now,
) {
    enum class Result { NOT_NEEDED, THROTTLED, NOT_PAIRED, UNREACHABLE, UPLOADED, UPLOAD_FAILED }

    suspend fun afterRun(outcome: SyncOutcome): Result {
        if (!needsReport(outcome)) return Result.NOT_NEEDED
        val now = clock()
        if (!due(state.lastAutoDiagnosticsAt, now)) return Result.THROTTLED
        if (!tokens.isPaired || tokens.deviceId.isNullOrEmpty() || state.pairingExpired) return Result.NOT_PAIRED
        val live = probe(DiagnosticsLimits.NETWORK_TIMEOUT_MS) { server.live() }
        if ((live as? Probe.Ok)?.value !is ApiResult.Success) return Result.UNREACHABLE
        // Counted from the attempt: a failing upload must not run a full self-test every hour.
        state.lastAutoDiagnosticsAt = now
        AppLog.i("Diagnostics", "Uploading a report after a ${describe(outcome)} sync")
        val report = service.buildReport(service.runSelfTest())
        return if (service.upload(report) is ApiResult.Success) Result.UPLOADED else Result.UPLOAD_FAILED
    }

    companion object {
        val INTERVAL: Duration = Duration.ofHours(6)

        /** A failed or partial run (including one the server never recorded). */
        fun needsReport(outcome: SyncOutcome): Boolean = when (outcome) {
            is SyncOutcome.Completed -> outcome.status == RunStatus.FAILED || outcome.status == RunStatus.PARTIAL
            is SyncOutcome.Failed, is SyncOutcome.RetryLater -> true
            SyncOutcome.NotPaired, SyncOutcome.PairingExpired, SyncOutcome.Unpaired -> false
        }

        fun due(last: Instant?, now: Instant): Boolean =
            last == null || now.isBefore(last) || !now.isBefore(last.plus(INTERVAL))

        private fun describe(outcome: SyncOutcome): String = when (outcome) {
            is SyncOutcome.Completed -> outcome.status
            else -> "failed"
        }
    }
}
