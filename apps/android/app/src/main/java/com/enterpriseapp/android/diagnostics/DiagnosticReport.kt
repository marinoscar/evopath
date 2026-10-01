package com.enterpriseapp.android.diagnostics

import com.enterpriseapp.android.auth.TokenStore
import com.enterpriseapp.android.net.ApiClient
import com.enterpriseapp.android.sync.LocalSyncRun
import com.enterpriseapp.android.sync.SyncStateStore
import com.enterpriseapp.android.update.UpdatePolicy
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import java.time.Instant

/**
 * The diagnostics report the phone uploads (`POST /api/health-sync/devices/:id/diagnostics`),
 * shares and copies. Shape: HS contract, "Android → Diagnostics" + scope update. It never
 * contains the token: the builder scrubs the serialized document (see [DiagnosticReportBuilder]).
 */
@Serializable
data class DiagnosticReport(
    val generatedAt: String,
    val summary: String,
    val app: AppSection,
    val device: DeviceSnapshot,
    val server: ServerSection,
    val pairing: PairingSection,
    val healthConnect: HealthConnectSection,
    val work: WorkSection,
    val checks: List<CheckResult>,
    val recentRuns: List<LocalSyncRun>,
    val log: List<String>,
) {
    @Serializable
    data class AppSection(
        val versionName: String,
        val versionCode: Long,
        val packageName: String,
        val signingSha256: String? = null,
        /** The server's current release (`app.update`); absent when it could not be read. */
        val latestVersionCode: Long? = null,
        val latestVersionName: String? = null,
        val updateAvailable: Boolean? = null,
    )

    @Serializable
    data class ServerSection(val url: String? = null)

    @Serializable
    data class PairingSection(val deviceId: String? = null, val tokenExpiresAt: String? = null, val expired: Boolean = false)

    @Serializable
    data class HealthConnectSection(
        val status: String,
        val version: String? = null,
        val grantedPermissions: List<String>,
        val backgroundAvailable: Boolean,
        val inventory: List<InventoryEntry>,
        val sources: List<SourceSummary>,
    )

    @Serializable
    data class WorkSection(val state: String? = null, val nextRunAt: String? = null)
}

/** A built report: the typed document, its scrubbed JSON and the upload summary. */
class BuiltReport(val report: DiagnosticReport, val json: JsonObject, val text: String) {
    val summary: String get() = report.summary
    val sizeBytes: Int get() = text.toByteArray(Charsets.UTF_8).size
}

object DiagnosticReportBuilder {
    /** The API accepts at most 256 KB; stay well below. */
    const val MAX_BYTES = 200 * 1024

    private val pretty = kotlinx.serialization.json.Json(ApiClient.ApiJson) { prettyPrint = true }

    fun build(
        result: SelfTestResult,
        tokens: TokenStore,
        state: SyncStateStore,
        runs: List<LocalSyncRun>,
        log: List<String>,
        now: Instant = result.generatedAt,
    ): BuiltReport {
        val expiresAt = runCatching { tokens.expiresAt }.getOrNull()
        val expired = runCatching { state.pairingExpired }.getOrDefault(false) || (expiresAt != null && !expiresAt.isAfter(now))
        val hc = result.healthConnect
        var report = DiagnosticReport(
            generatedAt = result.generatedAt.toString(),
            summary = result.summary,
            app = DiagnosticReport.AppSection(
                versionName = result.app.versionName,
                versionCode = result.app.versionCode,
                packageName = result.app.packageName,
                signingSha256 = result.app.signingSha256,
                latestVersionCode = result.latestRelease?.versionCode,
                latestVersionName = result.latestRelease?.versionName,
                updateAvailable = result.latestRelease?.let {
                    UpdatePolicy.isUpdate(it, result.app.packageName, result.app.versionCode)
                },
            ),
            device = result.device,
            server = DiagnosticReport.ServerSection(result.serverUrl),
            pairing = DiagnosticReport.PairingSection(runCatching { tokens.deviceId }.getOrNull(), expiresAt?.toString(), expired),
            healthConnect = DiagnosticReport.HealthConnectSection(
                status = hc.status,
                version = hc.version,
                grantedPermissions = hc.grantedPermissions,
                backgroundAvailable = hc.backgroundAvailable,
                inventory = hc.inventory,
                sources = hc.sources,
            ),
            work = DiagnosticReport.WorkSection(result.work?.state, result.work?.nextRunAt?.toString()),
            checks = result.checks,
            recentRuns = runs.take(DiagnosticsLimits.REPORT_RUNS),
            log = log.takeLast(DiagnosticsLimits.REPORT_LOG_LINES),
        )
        val secret = runCatching { tokens.token }.getOrNull()
        var built = serialize(report, secret)
        // Shrink the bulky parts until the document fits the upload limit.
        var logLines = report.log.size
        while (built.sizeBytes > MAX_BYTES && (logLines > 0 || report.recentRuns.size > 1)) {
            if (logLines > 0) {
                logLines /= 2
                report = report.copy(log = report.log.takeLast(logLines))
            } else {
                report = report.copy(recentRuns = report.recentRuns.take(report.recentRuns.size / 2))
            }
            built = serialize(report, secret)
        }
        return built
    }

    private fun serialize(report: DiagnosticReport, secret: String?): BuiltReport {
        val raw = pretty.encodeToString(DiagnosticReport.serializer(), report)
        val text = Redaction.redact(raw, secret)
        val json = ApiClient.ApiJson.parseToJsonElement(text).jsonObject
        return BuiltReport(report, json, text)
    }
}
