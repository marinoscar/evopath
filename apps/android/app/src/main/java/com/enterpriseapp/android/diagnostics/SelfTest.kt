package com.enterpriseapp.android.diagnostics

import com.enterpriseapp.android.auth.TokenStore
import com.enterpriseapp.android.healthconnect.AppLabels
import com.enterpriseapp.android.healthconnect.HcAvailability
import com.enterpriseapp.android.healthconnect.HcDataType
import com.enterpriseapp.android.healthconnect.HealthConnectGateway
import com.enterpriseapp.android.net.ApiClient
import com.enterpriseapp.android.net.ApiResult
import com.enterpriseapp.android.net.HealthSyncBackend
import com.enterpriseapp.android.net.HealthSyncDevice
import com.enterpriseapp.android.sync.SyncHistoryStore
import com.enterpriseapp.android.sync.SyncStateStore
import com.enterpriseapp.android.util.AppInfo
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import java.time.Duration
import java.time.Instant
import java.time.ZoneId

/** The phone, as reported in `device` of a report. */
@Serializable
data class DeviceSnapshot(
    val manufacturer: String? = null,
    val model: String? = null,
    val androidVersion: String? = null,
    val sdkInt: Int = 0,
    val timezone: String? = null,
)

/** Android-only inputs of the self-test (a fake in tests). */
interface DiagnosticsPlatform {
    fun appInfo(): AppInfo
    fun device(): DeviceSnapshot

    /** `PowerManager.isIgnoringBatteryOptimizations`, or null if unknown. */
    fun isIgnoringBatteryOptimizations(): Boolean?

    /** POST_NOTIFICATIONS granted (always true below Android 13). */
    fun notificationPermissionGranted(): Boolean

    /** Notifications enabled for the app at all. */
    fun notificationsEnabled(): Boolean

    /** The unique periodic sync work, or null when none exists. */
    suspend fun periodicWork(): WorkSnapshot?
}

/** Unauthenticated server calls the self-test makes. */
interface ServerProbe {
    /** `GET /api/health/live`. */
    suspend fun live(): ApiResult<JsonElement>

    /** `GET <path>` as text (e.g. `/.well-known/assetlinks.json`). */
    suspend fun text(path: String): ApiResult<String>
}

class ApiServerProbe(private val api: ApiClient) : ServerProbe {
    override suspend fun live() = api.checkLive()
    override suspend fun text(path: String) = api.getText(path)
}

/** Health Connect state the report shows next to the checks. */
data class HealthConnectSnapshot(
    /** `available`, `update_required`, `not_supported` or `error`. */
    val status: String,
    val version: String?,
    val grantedPermissions: List<String>,
    val backgroundAvailable: Boolean,
    val inventory: List<InventoryEntry>,
    val sources: List<SourceSummary>,
)

data class SelfTestResult(
    val generatedAt: Instant,
    val checks: List<CheckResult>,
    val app: AppInfo,
    val device: DeviceSnapshot,
    val serverUrl: String?,
    val healthConnect: HealthConnectSnapshot,
    val work: WorkSnapshot?,
    /** The server's view of this phone, when it could be read. */
    val serverDevice: HealthSyncDevice?,
) {
    val failCount: Int get() = checks.count { it.verdict == CheckStatus.FAIL }
    val warnCount: Int get() = checks.count { it.verdict == CheckStatus.WARN }
    val passCount: Int get() = checks.count { it.verdict == CheckStatus.PASS }
    val problemCount: Int get() = failCount + warnCount
    val summary: String get() = DiagnosticSummary.of(checks)
}

object DiagnosticSummary {
    /** `"N fail, M warn: <first failing check label>"`, or "All checks pass". */
    fun of(checks: List<CheckResult>): String {
        val fails = checks.count { it.verdict == CheckStatus.FAIL }
        val warns = checks.count { it.verdict == CheckStatus.WARN }
        if (fails == 0 && warns == 0) return "All checks pass"
        val first = checks.firstOrNull { it.verdict == CheckStatus.FAIL } ?: checks.first { it.verdict == CheckStatus.WARN }
        return "$fails fail, $warns warn: ${first.label}".take(500)
    }
}

/**
 * Runs every diagnostics check. Each probe is independent and bounded by a timeout; nothing
 * here throws, so one broken subsystem never hides the others. Network probes and Health
 * Connect run concurrently.
 */
class SelfTest(
    private val platform: DiagnosticsPlatform,
    private val serverUrl: () -> String?,
    private val server: ServerProbe,
    private val backend: HealthSyncBackend,
    private val gateway: HealthConnectGateway,
    private val labels: AppLabels,
    private val tokens: TokenStore,
    private val state: SyncStateStore,
    private val history: SyncHistoryStore,
    private val clock: () -> Instant = Instant::now,
    private val zone: () -> ZoneId = ZoneId::systemDefault,
    private val networkTimeoutMs: Long = DiagnosticsLimits.NETWORK_TIMEOUT_MS,
    private val hcTimeoutMs: Long = DiagnosticsLimits.HC_CONNECTION_TIMEOUT_MS,
    private val inventoryTimeoutMs: Long = DiagnosticsLimits.HC_INVENTORY_TIMEOUT_MS,
) {
    suspend fun run(): SelfTestResult = coroutineScope {
        val now = clock()
        val zoneId = zone()
        val url = safe { serverUrl() }
        val app = platform.appInfo()
        val deviceId = safe { tokens.deviceId }
        val hasToken = safe { tokens.isPaired } ?: false
        val pairingExpired = safe { state.pairingExpired } ?: false
        val paired = hasToken && !deviceId.isNullOrEmpty()

        val liveJob = async { url?.let { probe(networkTimeoutMs) { server.live() } } }
        val deviceJob = async { if (url != null && paired) probe(networkTimeoutMs) { backend.getDevice(deviceId!!) } else null }
        val linksJob = async { url?.let { probe(networkTimeoutMs) { server.text(ASSET_LINKS_PATH) } } }
        val workJob = async { probe(DiagnosticsLimits.LOCAL_TIMEOUT_MS) { platform.periodicWork() } }

        // Health Connect: availability, a live call, then the 30-day inventory.
        val availability = probe(DiagnosticsLimits.LOCAL_TIMEOUT_MS) { gateway.availability() }
        val available = availability.valueOrNull() == HcAvailability.AVAILABLE
        val version = if (available) safe { gateway.providerVersion() } else null
        val featureAvailable = if (available) safe { gateway.isBackgroundReadAvailable() } ?: false else false
        val grantedProbe = if (available) probe(hcTimeoutMs) { gateway.grantedPermissions() } else null
        val granted = grantedProbe?.valueOrNull()
        val from = now.minus(Duration.ofDays(DiagnosticsLimits.INVENTORY_DAYS))
        val inventory: List<InventoryEntry>? = if (granted == null) {
            null
        } else {
            HcDataType.entries.map { type ->
                async {
                    if (type.permission !in granted) {
                        InventoryEntry.denied(type)
                    } else {
                        when (val p = probe(inventoryTimeoutMs) { gateway.inventory(type, from, now, DiagnosticsLimits.INVENTORY_CAP) }) {
                            is Probe.Ok -> InventoryEntry.from(p.value, labels)
                            is Probe.Error -> InventoryEntry.failed(type, p.description)
                            is Probe.TimedOut -> InventoryEntry.failed(type, "no answer within ${p.timeoutMs / 1000} s")
                        }
                    }
                }
            }.awaitAll()
        }
        val sources = inventory?.let { SourceAggregation.aggregate(it) }.orEmpty()

        val live = liveJob.await()
        val deviceProbe = deviceJob.await()
        val links = linksJob.await()
        val work = workJob.await()
        val serverDevice = ((deviceProbe as? Probe.Ok)?.value as? ApiResult.Success)?.value
        val enabled = safe { state.enabledToggles } ?: emptyList()
        val runs = safe { history.runs() }.orEmpty()
        val configured = paired && !pairingExpired

        val reachable = Checks.serverReachable(url, live)
        val auth = Checks.authValid(url, paired, deviceProbe)
        val checks = buildList {
            add(Checks.appVersion(app))
            add(Checks.serverConfigured(url))
            add(reachable)
            add(Checks.pairingToken(hasToken, deviceId, safe { tokens.expiresAt }, pairingExpired, now, zoneId))
            add(auth)
            add(Checks.apiConnection(reachable, auth))
            add(Checks.hcAvailability(availability, version))
            add(Checks.hcConnection(available, grantedProbe))
            add(Checks.hcPermissions(granted, enabled))
            add(Checks.hcBackground(available, featureAvailable, granted))
            add(Checks.hcSources(available, inventory, sources, zoneId))
            val likely = Checks.likelySourceApp(sources)
            HcDataType.SYNCED.forEach { type ->
                val entry = inventory?.firstOrNull { it.dataType == type.key }
                val typeEnabled = enabled.any { type in it.dataTypes }
                add(Checks.hcData(type, typeEnabled, entry, likely, zoneId))
            }
            add(Checks.batteryOptimization(safe { platform.isIgnoringBatteryOptimizations() }))
            add(
                Checks.notifications(
                    platform.device().sdkInt,
                    safe { platform.notificationPermissionGranted() } ?: false,
                    safe { platform.notificationsEnabled() } ?: false,
                ),
            )
            add(Checks.workScheduled(configured, work, zoneId))
            add(Checks.syncLast(configured, runs.firstOrNull(), now))
            add(Checks.syncDelivery(runs.firstOrNull()))
            add(Checks.timezone(zoneId, serverDevice, now))
            add(Checks.twaVerification(url, app, links))
        }

        val hcStatus = when (availability.valueOrNull()) {
            HcAvailability.AVAILABLE -> "available"
            HcAvailability.UPDATE_REQUIRED -> "update_required"
            HcAvailability.NOT_SUPPORTED -> "not_supported"
            null -> "error"
        }
        SelfTestResult(
            generatedAt = now,
            checks = checks,
            app = app,
            device = platform.device().copy(timezone = zoneId.id),
            serverUrl = url,
            healthConnect = HealthConnectSnapshot(
                status = hcStatus,
                version = version,
                grantedPermissions = granted?.sorted().orEmpty(),
                backgroundAvailable = featureAvailable,
                inventory = inventory ?: HcDataType.entries.map { InventoryEntry.unknown(it) },
                sources = sources,
            ),
            work = work.valueOrNull(),
            serverDevice = serverDevice,
        ).also { AppLog.i("Diagnostics", "Self-test: ${it.summary}") }
    }

    private inline fun <T> safe(block: () -> T): T? = try {
        block()
    } catch (e: Exception) {
        if (e is kotlin.coroutines.cancellation.CancellationException) throw e
        null
    }

    companion object {
        const val ASSET_LINKS_PATH = "/.well-known/assetlinks.json"
    }
}
