package com.enterpriseapp.android.diagnostics

import com.enterpriseapp.android.healthconnect.HcAvailability
import com.enterpriseapp.android.healthconnect.HcDataType
import com.enterpriseapp.android.healthconnect.HealthPermissions
import com.enterpriseapp.android.healthconnect.SyncToggle
import com.enterpriseapp.android.net.ApiError
import com.enterpriseapp.android.net.ApiResult
import com.enterpriseapp.android.net.HealthSyncDevice
import com.enterpriseapp.android.sync.HealthSyncEngine
import com.enterpriseapp.android.sync.LocalSyncRun
import com.enterpriseapp.android.sync.RunStatus
import com.enterpriseapp.android.util.AppInfo
import com.enterpriseapp.android.util.Brand
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Check ids (stable: the runbook's troubleshooting table and the web viewer key on them). */
object CheckIds {
    const val APP_VERSION = "app.version"
    const val SERVER_CONFIGURED = "server.configured"
    const val SERVER_REACHABLE = "server.reachable"
    const val PAIRING_TOKEN = "pairing.token"
    const val AUTH_VALID = "auth.valid"
    const val API_CONNECTION = "api.connection"
    const val HC_AVAILABILITY = "hc.availability"
    const val HC_CONNECTION = "hc.connection"
    const val HC_PERMISSIONS = "hc.permissions"
    const val HC_BACKGROUND = "hc.background"
    const val HC_SOURCES = "hc.sources"
    const val HC_DATA_PREFIX = "hc.data."
    const val BATTERY = "battery.optimization"
    const val NOTIFICATIONS = "notifications.permission"
    const val WORK_SCHEDULED = "work.scheduled"
    const val SYNC_LAST = "sync.last"
    const val SYNC_DELIVERY = "sync.delivery"
    const val TIMEZONE = "timezone.match"
    const val TWA_VERIFICATION = "twa.verification"

    fun hcData(type: HcDataType) = HC_DATA_PREFIX + type.key
}

/** Labels shown on the phone and stored with each check. */
object CheckLabels {
    const val APP_VERSION = "App version"
    const val SERVER_CONFIGURED = "Server address"
    const val SERVER_REACHABLE = "Server reachable"
    const val PAIRING_TOKEN = "Pairing token"
    const val AUTH_VALID = "Token accepted"
    const val API_CONNECTION = "API connection"
    const val HC_AVAILABILITY = "Health Connect installed"
    const val HC_CONNECTION = "Health Connect connection"
    const val HC_PERMISSIONS = "Health Connect permissions"
    const val HC_BACKGROUND = "Background access"
    const val HC_SOURCES = "Apps feeding Health Connect"
    const val BATTERY = "Battery optimization"
    const val NOTIFICATIONS = "Notifications"
    const val WORK_SCHEDULED = "Hourly sync scheduled"
    const val SYNC_LAST = "Last sync"
    const val SYNC_DELIVERY = "Data delivery"
    const val TIMEZONE = "Time zone"
    const val TWA_VERIFICATION = "Full-screen web app (Digital Asset Links)"

    fun hcData(type: HcDataType) = "${type.label} in Health Connect"
}

/** Periodic work as WorkManager sees it. */
data class WorkSnapshot(
    /** `WorkInfo.State` name (`ENQUEUED`, `RUNNING`, `BLOCKED`, …), or null when nothing is scheduled. */
    val state: String?,
    val nextRunAt: Instant? = null,
)

/**
 * Pure evaluation of each self-test check. Inputs are what the runner probed; nothing here
 * touches Android, the network or Health Connect, so every verdict is unit-tested.
 */
object Checks {
    private val TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")
    private val HISTORY_NOTE =
        "Without the history permission Health Connect only exposes data from the 30 days before ${Brand.name} was first granted access."

    fun formatTime(instant: Instant?, zone: ZoneId): String = instant?.let { TIME.format(it.atZone(zone)) } ?: "unknown"

    private fun formatTime(iso: String?, zone: ZoneId): String =
        formatTime(iso?.let { runCatching { Instant.parse(it) }.getOrNull() }, zone)

    /** "12 min ago", "3 h ago", "2 days ago". */
    fun age(from: Instant, now: Instant): String {
        val d = Duration.between(from, now)
        return when {
            d.isNegative -> "in the future"
            d.toMinutes() < 1 -> "just now"
            d.toMinutes() < 60 -> "${d.toMinutes()} min ago"
            d.toHours() < 48 -> "${d.toHours()} h ago"
            else -> "${d.toDays()} days ago"
        }
    }

    // --- app and server -------------------------------------------------------------------

    fun appVersion(app: AppInfo): CheckResult {
        val base = "${Brand.name} ${app.versionName} (code ${app.versionCode}), ${app.packageName}"
        return if (app.signingSha256 == null) {
            CheckResult.of(
                CheckIds.APP_VERSION, CheckLabels.APP_VERSION, CheckStatus.WARN,
                "$base. The signing certificate could not be read.",
                remedy = "Reinstall the APK from the android-latest release.",
            )
        } else {
            CheckResult.of(CheckIds.APP_VERSION, CheckLabels.APP_VERSION, CheckStatus.PASS, "$base, signed with ${app.signingSha256}.")
        }
    }

    fun serverConfigured(url: String?): CheckResult =
        if (url == null) {
            CheckResult.of(
                CheckIds.SERVER_CONFIGURED, CheckLabels.SERVER_CONFIGURED, CheckStatus.FAIL,
                "No ${Brand.name} server address is set.",
                remedy = "Set the server address on the Health sync screen.",
                action = CheckAction.SET_SERVER,
            )
        } else {
            CheckResult.of(CheckIds.SERVER_CONFIGURED, CheckLabels.SERVER_CONFIGURED, CheckStatus.PASS, url)
        }

    private fun describe(error: ApiError): String = when (error.kind) {
        ApiError.Kind.HTTP -> "HTTP ${error.httpStatus} ${error.code.orEmpty()}${error.reason?.let { " ($it)" }.orEmpty()}: ${error.message}"
        else -> error.message
    }

    private fun <T> describe(probe: Probe<ApiResult<T>>): String? = when (probe) {
        is Probe.Ok -> (probe.value as? ApiResult.Failure)?.error?.let(::describe)
        is Probe.Error -> probe.description
        is Probe.TimedOut -> "No answer within ${probe.timeoutMs / 1000} s"
    }

    private fun latency(probe: Probe<*>?): Long? = (probe as? Probe.Ok<*>)?.elapsedMs

    fun serverReachable(url: String?, live: Probe<ApiResult<JsonElement>>?): CheckResult {
        val id = CheckIds.SERVER_REACHABLE
        val label = CheckLabels.SERVER_REACHABLE
        if (url == null || live == null) return CheckResult.of(id, label, CheckStatus.SKIP, "No server address is set.")
        val failure = describe(live)
        val ms = latency(live)
        val data = buildJsonObject { ms?.let { put("latencyMs", it) } }
        return when {
            failure != null -> CheckResult.of(
                id, label, CheckStatus.FAIL,
                "GET /api/health/live failed: $failure",
                remedy = "Check the phone's network and the server address: open $url/api/health/live in the phone's browser; it must answer 200.",
                action = CheckAction.SET_SERVER,
                data = data,
            )
            ms != null && ms > DiagnosticsLimits.SLOW_SERVER_MS -> CheckResult.of(
                id, label, CheckStatus.WARN,
                "The server answered, but slowly ($ms ms).",
                remedy = "A slow network or server can make syncs time out; try again on Wi-Fi.",
                data = data,
            )
            else -> CheckResult.of(id, label, CheckStatus.PASS, "The server answered in $ms ms.", data = data)
        }
    }

    fun pairingToken(
        hasToken: Boolean,
        deviceId: String?,
        expiresAt: Instant?,
        pairingExpired: Boolean,
        now: Instant,
        zone: ZoneId,
    ): CheckResult {
        val id = CheckIds.PAIRING_TOKEN
        val label = CheckLabels.PAIRING_TOKEN
        val data = buildJsonObject {
            put("tokenExpiresAt", expiresAt?.toString())
            put("expired", pairingExpired || (expiresAt != null && !expiresAt.isAfter(now)))
        }
        fun fail(detail: String, remedy: String) = CheckResult.of(id, label, CheckStatus.FAIL, detail, remedy, CheckAction.REPAIR, data)
        return when {
            !hasToken -> fail("This phone is not paired with an ${Brand.name} account.", "Pair on the Connect screen.")
            deviceId.isNullOrEmpty() -> fail("Signed in, but the phone was never registered.", "Retry registration or re-pair on the Connect screen.")
            pairingExpired -> fail(
                "The server refused this phone's token (pairing expired or revoked). Syncing is stopped.",
                "Re-pair on the Connect screen.",
            )
            expiresAt != null && !expiresAt.isAfter(now) -> fail(
                "The pairing token expired on ${formatTime(expiresAt, zone)}.",
                "Re-pair on the Connect screen.",
            )
            expiresAt == null -> CheckResult.of(id, label, CheckStatus.PASS, "Paired (the server reported no expiry).", data = data)
            else -> {
                val days = Duration.between(now, expiresAt).toDays()
                if (days < DiagnosticsLimits.TOKEN_WARN_DAYS) {
                    CheckResult.of(
                        id, label, CheckStatus.WARN,
                        "The pairing token expires in $days day${if (days == 1L) "" else "s"} (${formatTime(expiresAt, zone)}).",
                        remedy = "Re-pair before it expires, or syncing stops at expiry.",
                        action = CheckAction.REPAIR,
                        data = data,
                    )
                } else {
                    CheckResult.of(id, label, CheckStatus.PASS, "Valid until ${formatTime(expiresAt, zone)} ($days days).", data = data)
                }
            }
        }
    }

    fun authValid(
        url: String?,
        paired: Boolean,
        device: Probe<ApiResult<HealthSyncDevice>>?,
    ): CheckResult {
        val id = CheckIds.AUTH_VALID
        val label = CheckLabels.AUTH_VALID
        if (url == null) return CheckResult.of(id, label, CheckStatus.SKIP, "No server address is set.")
        if (!paired || device == null) return CheckResult.of(id, label, CheckStatus.SKIP, "Not paired: nothing to authenticate.")
        val ms = latency(device)
        val data = buildJsonObject { ms?.let { put("latencyMs", it) } }
        val result = (device as? Probe.Ok)?.value
        if (result is ApiResult.Success) {
            val view = result.value
            return if (view.status == "revoked") {
                revoked("The server lists this phone as revoked.", data)
            } else {
                CheckResult.of(id, label, CheckStatus.PASS, "Token accepted; device ${view.name ?: view.id} is ${view.status ?: "active"} ($ms ms).", data = data)
            }
        }
        val error = (result as? ApiResult.Failure)?.error
        return when {
            error?.httpStatus == 401 -> CheckResult.of(
                id, label, CheckStatus.FAIL,
                "Pairing expired: the server refused the token (HTTP 401).",
                remedy = "Re-pair on the Connect screen.",
                action = CheckAction.REPAIR,
                data = data,
            )
            error != null && (HealthSyncEngine.isUnpaired(error) || error.httpStatus == 409) ->
                revoked("Device revoked: the server no longer accepts this phone (HTTP ${error.httpStatus}${error.reason?.let { " $it" }.orEmpty()}).", data)
            else -> CheckResult.of(
                id, label, CheckStatus.FAIL,
                "GET /api/health-sync/devices/:id failed: ${describe(device)}",
                remedy = "Fix the server connection first (see ${CheckLabels.SERVER_REACHABLE}).",
                data = data,
            )
        }
    }

    private fun revoked(detail: String, data: JsonObject) = CheckResult.of(
        CheckIds.AUTH_VALID, CheckLabels.AUTH_VALID, CheckStatus.FAIL, detail,
        remedy = "Connect again: pair this phone on the Connect screen.",
        action = CheckAction.REPAIR,
        data = data,
    )

    /** Reachability plus the authenticated call, with both latencies. */
    fun apiConnection(serverReachable: CheckResult, authValid: CheckResult): CheckResult {
        val id = CheckIds.API_CONNECTION
        val label = CheckLabels.API_CONNECTION
        val liveMs = (serverReachable.data?.get("latencyMs") as? JsonPrimitive)?.contentOrNull?.toLongOrNull()
        val authMs = (authValid.data?.get("latencyMs") as? JsonPrimitive)?.contentOrNull?.toLongOrNull()
        val data = buildJsonObject {
            put("serverReachable", serverReachable.status)
            put("authValid", authValid.status)
            liveMs?.let { put("liveLatencyMs", it) }
            authMs?.let { put("authLatencyMs", it) }
        }
        return when {
            serverReachable.verdict == CheckStatus.SKIP -> CheckResult.of(id, label, CheckStatus.SKIP, serverReachable.detail, data = data)
            serverReachable.verdict == CheckStatus.FAIL ->
                CheckResult.of(id, label, CheckStatus.FAIL, "Server unreachable. ${serverReachable.detail}", serverReachable.remedy, serverReachable.action, data)
            authValid.verdict == CheckStatus.FAIL ->
                CheckResult.of(id, label, CheckStatus.FAIL, "Server reachable ($liveMs ms), but: ${authValid.detail}", authValid.remedy, authValid.action, data)
            authValid.verdict == CheckStatus.SKIP ->
                CheckResult.of(id, label, serverReachable.verdict, "Server reachable ($liveMs ms); authentication not tested (not paired).", serverReachable.remedy, data = data)
            serverReachable.verdict == CheckStatus.WARN ->
                CheckResult.of(id, label, CheckStatus.WARN, "Reachable and authenticated, but slow (live $liveMs ms, API $authMs ms).", serverReachable.remedy, data = data)
            else -> CheckResult.of(id, label, CheckStatus.PASS, "Reachable in $liveMs ms; authenticated API call in $authMs ms.", data = data)
        }
    }

    // --- Health Connect -------------------------------------------------------------------

    fun hcAvailability(availability: Probe<HcAvailability>, version: String?): CheckResult {
        val id = CheckIds.HC_AVAILABILITY
        val label = CheckLabels.HC_AVAILABILITY
        return when (val value = availability.valueOrNull()) {
            HcAvailability.AVAILABLE -> CheckResult.of(id, label, CheckStatus.PASS, "Available (version ${version ?: "unknown"}).")
            HcAvailability.UPDATE_REQUIRED -> CheckResult.of(
                id, label, CheckStatus.FAIL,
                "Health Connect must be installed or updated before ${Brand.name} can read it.",
                remedy = "Install or update Health Connect from Google Play.",
                action = CheckAction.UPDATE_HEALTH_CONNECT,
            )
            HcAvailability.NOT_SUPPORTED -> CheckResult.of(
                id, label, CheckStatus.FAIL,
                "Health Connect is not available on this phone.",
                remedy = "On Android 13 and below install Health Connect from Google Play; from Android 14 it is built in (Settings → Security & privacy → Health Connect).",
                action = CheckAction.UPDATE_HEALTH_CONNECT,
            )
            null -> CheckResult.of(
                id, label, CheckStatus.FAIL,
                "Could not ask Android for Health Connect's status: ${probeFailure(availability)}",
                remedy = "Restart the phone and run the self-test again.",
            )
        }
    }

    private fun probeFailure(probe: Probe<*>): String = when (probe) {
        is Probe.Error -> probe.description
        is Probe.TimedOut -> "no answer within ${probe.timeoutMs / 1000} s"
        is Probe.Ok -> "ok"
    }

    fun hcConnection(available: Boolean, granted: Probe<Set<String>>?): CheckResult {
        val id = CheckIds.HC_CONNECTION
        val label = CheckLabels.HC_CONNECTION
        if (!available || granted == null) return CheckResult.of(id, label, CheckStatus.SKIP, "Health Connect is not available.")
        return when (granted) {
            is Probe.Ok -> CheckResult.of(
                id, label, CheckStatus.PASS,
                "Health Connect answered in ${granted.elapsedMs} ms (${granted.value.size} permissions granted).",
                data = buildJsonObject { put("latencyMs", granted.elapsedMs) },
            )
            is Probe.Error -> CheckResult.of(
                id, label, CheckStatus.FAIL,
                "Health Connect call failed: ${granted.description}",
                remedy = "Open Health Connect once, update it, restart the phone, then run the self-test again.",
                action = CheckAction.OPEN_HEALTH_CONNECT,
                data = buildJsonObject {
                    put("exception", granted.error.javaClass.name)
                    put("message", granted.error.message)
                },
            )
            is Probe.TimedOut -> CheckResult.of(
                id, label, CheckStatus.FAIL,
                "Health Connect did not answer within ${granted.timeoutMs / 1000} s.",
                remedy = "Health Connect may be updating or stuck: open it once, restart the phone, then run the self-test again.",
                action = CheckAction.OPEN_HEALTH_CONNECT,
            )
        }
    }

    fun hcPermissions(granted: Set<String>?, enabled: List<SyncToggle>): CheckResult {
        val id = CheckIds.HC_PERMISSIONS
        val label = CheckLabels.HC_PERMISSIONS
        if (granted == null) return CheckResult.of(id, label, CheckStatus.SKIP, "Health Connect could not be asked.")
        if (enabled.isEmpty()) {
            return CheckResult.of(
                id, label, CheckStatus.WARN,
                "Every data type is switched off on the Sync screen, so nothing is synced.",
                remedy = "Switch on the types you want on the Sync screen.",
            )
        }
        val required = SyncToggle.permissionsFor(enabled, includeBackground = false)
        val missing = required.filter { it !in granted }
        val data = buildJsonObject {
            putJsonArray("missing") { missing.forEach { add(JsonPrimitive(it)) } }
            put("requiredCount", required.size)
        }
        val names = missing.map { perm -> HcDataType.entries.firstOrNull { it.permission == perm }?.label ?: perm.substringAfterLast('.') }
        return when {
            missing.isEmpty() -> CheckResult.of(id, label, CheckStatus.PASS, "All ${required.size} read permissions for the enabled types are granted.", data = data)
            missing.size == required.size -> CheckResult.of(
                id, label, CheckStatus.FAIL,
                "No read permission is granted for the enabled types.",
                remedy = "Grant the permissions in Health Connect (Connect screen), or Android Settings → Health Connect → App permissions → ${Brand.name}.",
                action = CheckAction.GRANT_PERMISSIONS,
                data = data,
            )
            else -> CheckResult.of(
                id, label, CheckStatus.WARN,
                "Missing ${missing.size} of ${required.size}: ${names.joinToString(", ")}.",
                remedy = "Grant them in Health Connect, or switch those types off on the Sync screen.",
                action = CheckAction.GRANT_PERMISSIONS,
                data = data,
            )
        }
    }

    fun hcBackground(available: Boolean, featureAvailable: Boolean, granted: Set<String>?): CheckResult {
        val id = CheckIds.HC_BACKGROUND
        val label = CheckLabels.HC_BACKGROUND
        if (!available || granted == null) return CheckResult.of(id, label, CheckStatus.SKIP, "Health Connect is not available.")
        return when {
            !featureAvailable -> CheckResult.of(
                id, label, CheckStatus.WARN,
                "This Health Connect version cannot read in the background.",
                remedy = "Update Health Connect. Until then the hourly sync won't run while the app is closed: open Health sync or tap Sync now to sync.",
                action = CheckAction.UPDATE_HEALTH_CONNECT,
            )
            HealthPermissions.READ_HEALTH_DATA_IN_BACKGROUND !in granted -> CheckResult.of(
                id, label, CheckStatus.WARN,
                "Background access is not allowed.",
                remedy = "Allow \"Access data in the background\" for ${Brand.name}. Without it the hourly sync won't run while the app is closed; only Sync now and opening Health sync read data.",
                action = CheckAction.GRANT_BACKGROUND,
            )
            else -> CheckResult.of(id, label, CheckStatus.PASS, "Allowed: the hourly sync can read while the app is closed.")
        }
    }

    fun hcSources(available: Boolean, inventory: List<InventoryEntry>?, sources: List<SourceSummary>, zone: ZoneId): CheckResult {
        val id = CheckIds.HC_SOURCES
        val label = CheckLabels.HC_SOURCES
        if (!available || inventory == null) return CheckResult.of(id, label, CheckStatus.SKIP, "Health Connect could not be read.")
        if (inventory.none { it.permission == InventoryEntry.GRANTED }) {
            return CheckResult.of(
                id, label, CheckStatus.SKIP,
                "No read permission is granted, so ${Brand.name} cannot see which apps write into Health Connect.",
                remedy = "Grant permissions first.",
                action = CheckAction.GRANT_PERMISSIONS,
            )
        }
        val data = buildJsonObject {
            putJsonArray("sources") {
                sources.forEach { s ->
                    add(buildJsonObject {
                        put("packageName", s.packageName)
                        put("appLabel", s.appLabel)
                        putJsonArray("dataTypes") { s.dataTypes.forEach { add(JsonPrimitive(it)) } }
                        put("recordCount", s.recordCount)
                    })
                }
            }
        }
        if (sources.isEmpty()) {
            return CheckResult.of(
                id, label, CheckStatus.WARN,
                "No app wrote anything readable into Health Connect in the last 30 days. $HISTORY_NOTE",
                remedy = "Turn on sharing to Health Connect in your source app (for example Samsung Health → Settings → Health Connect), then run the self-test again.",
                action = CheckAction.OPEN_HEALTH_CONNECT,
                data = data,
            )
        }
        val text = sources.joinToString("; ") { s ->
            "${s.appLabel}: ${s.dataTypes.joinToString(", ") { k -> HcDataType.fromKey(k)?.label ?: k }} (${s.recordCount} records, latest ${formatTime(s.latestRecordAt, zone)})"
        }
        return CheckResult.of(id, label, CheckStatus.PASS, "${sources.size} app${if (sources.size == 1) "" else "s"} in the last 30 days: $text.", data = data)
    }

    /** The app most likely to be the user's source, for remedies ("Open Samsung Health → …"). */
    fun likelySourceApp(sources: List<SourceSummary>): String =
        sources.firstOrNull { it.packageName !in HEALTH_CONNECT_PACKAGES }?.appLabel ?: "your source app (for example Samsung Health)"

    private val HEALTH_CONNECT_PACKAGES = setOf("com.google.android.apps.healthdata", "com.android.healthconnect.controller")

    fun hcData(
        type: HcDataType,
        enabled: Boolean,
        entry: InventoryEntry?,
        likelySource: String,
        zone: ZoneId,
    ): CheckResult {
        val id = CheckIds.hcData(type)
        val label = CheckLabels.hcData(type)
        val data = entry?.let {
            buildJsonObject {
                put("permission", it.permission)
                put("recordCount30d", it.recordCount30d)
                put("capped", it.capped)
                put("latestRecordAt", it.latestRecordAt)
            }
        }
        if (entry == null || entry.permission == InventoryEntry.UNKNOWN) {
            return CheckResult.of(id, label, CheckStatus.SKIP, "Health Connect could not be read.")
        }
        val sourcesText = entry.sources.joinToString(", ") { "${it.appLabel} (${it.recordCount})" }
        if (!enabled) {
            val counts = if (entry.permission == InventoryEntry.GRANTED && entry.error == null) " Health Connect holds ${entry.countText} records in 30 days." else ""
            return CheckResult.of(id, label, CheckStatus.SKIP, "Switched off on the Sync screen.$counts", data = data)
        }
        return when {
            entry.permission == InventoryEntry.DENIED -> CheckResult.of(
                id, label, CheckStatus.FAIL,
                "Permission denied: ${Brand.name} cannot read ${type.label.lowercase()}.",
                remedy = "Grant ${type.label} in the Health Connect permission prompt, or switch the type off on the Sync screen.",
                action = CheckAction.GRANT_PERMISSIONS,
                data = data,
            )
            entry.error != null -> CheckResult.of(
                id, label, CheckStatus.WARN,
                "Could not count records: ${entry.error}",
                remedy = "Run the self-test again with the app open; if it persists, open Health Connect once and restart the phone.",
                data = data,
            )
            entry.recordCount30d == 0 -> CheckResult.of(
                id, label, CheckStatus.WARN,
                "Permission granted but no ${type.label.lowercase()} records in the last 30 days: the source app is probably not sharing to Health Connect. $HISTORY_NOTE",
                remedy = "Open $likelySource → Settings → Health Connect and allow ${type.label} (or Android Settings → Health Connect → App permissions → $likelySource → allow ${type.label}), then Sync now.",
                action = CheckAction.OPEN_HEALTH_CONNECT,
                data = data,
            )
            else -> CheckResult.of(
                id, label, CheckStatus.PASS,
                "${entry.countText} records in the last 30 days, latest ${formatTime(entry.latestRecordAt, zone)}, from $sourcesText.",
                data = data,
            )
        }
    }

    // --- phone and scheduling --------------------------------------------------------------

    fun batteryOptimization(ignoring: Boolean?): CheckResult {
        val id = CheckIds.BATTERY
        val label = CheckLabels.BATTERY
        return when (ignoring) {
            null -> CheckResult.of(id, label, CheckStatus.SKIP, "Could not read the battery setting.")
            true -> CheckResult.of(id, label, CheckStatus.PASS, "${Brand.name} is not battery-optimized (unrestricted).")
            false -> CheckResult.of(
                id, label, CheckStatus.WARN,
                "Battery optimization is on for ${Brand.name}: Android may delay or skip the hourly sync.",
                remedy = "Android Settings → Apps → ${Brand.name} → Battery → Unrestricted.",
                action = CheckAction.BATTERY_SETTINGS,
            )
        }
    }

    fun notifications(sdkInt: Int, permissionGranted: Boolean, enabled: Boolean): CheckResult {
        val id = CheckIds.NOTIFICATIONS
        val label = CheckLabels.NOTIFICATIONS
        return when {
            sdkInt >= 33 && !permissionGranted -> CheckResult.of(
                id, label, CheckStatus.WARN,
                "The notification permission is not granted: you will miss \"Re-pair\" and background-access prompts.",
                remedy = "Allow notifications for ${Brand.name}.",
                action = CheckAction.NOTIFICATION_SETTINGS,
            )
            !enabled -> CheckResult.of(
                id, label, CheckStatus.WARN,
                "Notifications are turned off for ${Brand.name}: you will miss \"Re-pair\" prompts.",
                remedy = "Turn notifications on in Android Settings → Apps → ${Brand.name} → Notifications.",
                action = CheckAction.NOTIFICATION_SETTINGS,
            )
            else -> CheckResult.of(id, label, CheckStatus.PASS, "Notifications are allowed.")
        }
    }

    fun workScheduled(configured: Boolean, work: Probe<WorkSnapshot?>, zone: ZoneId): CheckResult {
        val id = CheckIds.WORK_SCHEDULED
        val label = CheckLabels.WORK_SCHEDULED
        if (!configured) return CheckResult.of(id, label, CheckStatus.SKIP, "Not paired (or pairing expired): the hourly sync runs only while paired.")
        val snapshot = work.valueOrNull()
        if (work !is Probe.Ok) {
            return CheckResult.of(id, label, CheckStatus.WARN, "Could not read WorkManager: ${probeFailure(work)}")
        }
        val next = snapshot?.nextRunAt?.let { ", next run around ${formatTime(it, zone)}" }.orEmpty()
        val data = buildJsonObject {
            put("state", snapshot?.state)
            put("nextRunAt", snapshot?.nextRunAt?.toString())
        }
        return when (snapshot?.state) {
            "ENQUEUED", "RUNNING" -> CheckResult.of(id, label, CheckStatus.PASS, "Scheduled hourly (${snapshot.state.lowercase()})$next.", data = data)
            "BLOCKED" -> CheckResult.of(
                id, label, CheckStatus.WARN,
                "Scheduled, but waiting for its constraints (network)$next.",
                remedy = "Connect to the internet.",
                data = data,
            )
            else -> CheckResult.of(
                id, label, CheckStatus.FAIL,
                if (snapshot?.state == null) "The hourly sync is not scheduled." else "The hourly sync is ${snapshot.state.lowercase()}.",
                remedy = "Open the app and tap Sync now (this schedules it again); re-pair if not paired.",
                action = CheckAction.SYNC_NOW,
                data = data,
            )
        }
    }

    fun syncLast(configured: Boolean, last: LocalSyncRun?, now: Instant): CheckResult {
        val id = CheckIds.SYNC_LAST
        val label = CheckLabels.SYNC_LAST
        if (last == null) {
            return if (configured) {
                CheckResult.of(id, label, CheckStatus.WARN, "No sync has run on this phone yet.", remedy = "Tap Sync now.", action = CheckAction.SYNC_NOW)
            } else {
                CheckResult.of(id, label, CheckStatus.SKIP, "Not paired: no sync has run.")
            }
        }
        val finished = runCatching { Instant.parse(last.finishedAt) }.getOrNull()
        val when_ = finished?.let { age(it, now) } ?: last.finishedAt
        val error = listOfNotNull(last.errorCode, last.errorMessage).joinToString(": ").ifEmpty { null }
        val data = buildJsonObject {
            put("finishedAt", last.finishedAt)
            put("status", last.status)
            put("trigger", last.trigger)
            put("delivered", last.delivered)
            put("errorCode", last.errorCode)
        }
        val background = last.errorCode == HealthSyncEngine.ERROR_BACKGROUND_PERMISSION_MISSING
        return when {
            !last.delivered || last.status == RunStatus.FAILED -> CheckResult.of(
                id, label, CheckStatus.WARN,
                "The last sync ($when_, ${last.trigger}) failed${if (!last.delivered) " and was not recorded by the server" else ""}: ${error ?: "no error recorded"}.",
                remedy = "Fix the failing checks above, then tap Sync now. The run's error is also on the web under Settings → Connected devices.",
                action = CheckAction.SYNC_NOW,
                data = data,
            )
            last.status == RunStatus.PARTIAL || last.status == RunStatus.SKIPPED -> CheckResult.of(
                id, label, CheckStatus.WARN,
                "The last sync ($when_, ${last.trigger}) was ${last.status}: ${error ?: "no error recorded"}.",
                remedy = if (background) {
                    "Allow background access so the hourly sync can read while the app is closed."
                } else {
                    "See the Health Connect checks above for the types that could not be read, then tap Sync now."
                },
                action = if (background) CheckAction.GRANT_BACKGROUND else CheckAction.SYNC_NOW,
                data = data,
            )
            finished != null && Duration.between(finished, now).toHours() >= DiagnosticsLimits.SYNC_STALE_HOURS -> CheckResult.of(
                id, label, CheckStatus.WARN,
                "The last sync was $when_ (${last.status}); hourly syncs are not running.",
                remedy = "Check ${CheckLabels.BATTERY}, ${CheckLabels.HC_BACKGROUND} and ${CheckLabels.WORK_SCHEDULED}, then tap Sync now.",
                action = CheckAction.SYNC_NOW,
                data = data,
            )
            else -> CheckResult.of(id, label, CheckStatus.PASS, "Last sync $when_: ${last.status} (${last.trigger}).", data = data)
        }
    }

    private val ACTIVITY_TYPES = setOf(HcDataType.STEPS.key, HcDataType.EXERCISE.key)
    private val SLEEP_TYPES = setOf(HcDataType.SLEEP.key)

    /**
     * Last run: per type `read` vs `sent` (dropped rows), then per table the rows sent vs what
     * the server accepted (`created + updated + unchanged`); `skipped` rows are flagged.
     */
    fun syncDelivery(last: LocalSyncRun?): CheckResult {
        val id = CheckIds.SYNC_DELIVERY
        val label = CheckLabels.SYNC_DELIVERY
        if (last == null) return CheckResult.of(id, label, CheckStatus.SKIP, "No sync has run yet.")
        if (!last.delivered || last.response == null) {
            return CheckResult.of(
                id, label, CheckStatus.WARN,
                "The last run was not accepted by the server${last.errorCode?.let { " ($it)" }.orEmpty()}: nothing from it was stored.",
                remedy = "Fix the failing checks, then tap Sync now.",
                action = CheckAction.SYNC_NOW,
            )
        }
        val attempted = last.perType.filter { (key, d) -> d.enabled && d.permission == "granted" && HcDataType.fromKey(key)?.isSyncedType == true }
        if (last.status == RunStatus.SKIPPED || attempted.isEmpty()) {
            return CheckResult.of(id, label, CheckStatus.SKIP, "The last run read nothing${last.errorCode?.let { " ($it)" }.orEmpty()}.")
        }
        val response = last.response
        fun sentFor(keys: (String) -> Boolean) = attempted.filterKeys(keys).values.sumOf { it.sent }
        val activitySent = sentFor { it in ACTIVITY_TYPES }
        val sleepSent = sentFor { it in SLEEP_TYPES }
        val measurementSent = sentFor { it !in ACTIVITY_TYPES && it !in SLEEP_TYPES }

        data class Table(val name: String, val sent: Int, val accepted: Int?, val skipped: Int)
        val tables = listOf(
            Table("activity entries", activitySent, response.created + response.updated + response.unchanged, response.skipped),
            Table("measurements", measurementSent, response.measurements?.let { it.created + it.updated + it.unchanged }, response.measurements?.skipped ?: 0),
            Table("sleep sessions", sleepSent, response.sleep?.let { it.created + it.updated + it.unchanged }, response.sleep?.skipped ?: 0),
        )
        val problems = mutableListOf<String>()
        attempted.filter { it.value.dropped > 0 || it.value.error != null }.forEach { (key, d) ->
            val name = HcDataType.fromKey(key)?.label ?: key
            if (d.error != null) problems += "$name: read failed (${d.error})"
            if (d.dropped > 0) problems += "$name: read ${d.read}, sent ${d.sent} (${d.dropped} dropped: out of window, out of range or unsupported kind)"
        }
        tables.forEach { t ->
            val accepted = t.accepted ?: if (t.sent == 0) 0 else null
            when {
                accepted == null -> problems += "${t.name}: sent ${t.sent}, the server reported no counts"
                accepted != t.sent && t.skipped > 0 && accepted + t.skipped == t.sent ->
                    problems += "${t.name}: the server skipped ${t.skipped} of ${t.sent} (rows you deleted or edited on the web are not overwritten)"
                accepted != t.sent -> problems += "${t.name}: sent ${t.sent}, the server accepted $accepted${if (t.skipped > 0) " and skipped ${t.skipped}" else ""}"
                t.skipped > 0 -> problems += "${t.name}: the server skipped ${t.skipped}"
            }
        }
        val data = buildJsonObject {
            putJsonObject("perType") {
                attempted.forEach { (key, d) ->
                    putJsonObject(key) {
                        put("read", d.read)
                        put("sent", d.sent)
                        put("dropped", d.dropped)
                    }
                }
            }
            putJsonObject("tables") {
                tables.forEach { t ->
                    putJsonObject(t.name.replace(' ', '_')) {
                        put("sent", t.sent)
                        put("accepted", t.accepted)
                        put("skipped", t.skipped)
                    }
                }
            }
        }
        val totalSent = tables.sumOf { it.sent }
        return if (problems.isEmpty()) {
            CheckResult.of(id, label, CheckStatus.PASS, "Every row read was sent and accepted ($totalSent rows: ${tables.joinToString(", ") { "${it.name} ${it.sent}" }}).", data = data)
        } else {
            CheckResult.of(
                id, label, CheckStatus.WARN,
                problems.joinToString("; ") + ".",
                remedy = "Dropped rows are values outside the sync window or the server's ranges, or exercise types ${Brand.name} does not import (yoga, strength…). Skipped rows are readings you deleted or edited on the web.",
                data = data,
            )
        }
    }

    // --- server-side settings ---------------------------------------------------------------

    fun timezone(phoneZone: ZoneId, device: HealthSyncDevice?, now: Instant): CheckResult {
        val id = CheckIds.TIMEZONE
        val label = CheckLabels.TIMEZONE
        if (device == null) return CheckResult.of(id, label, CheckStatus.SKIP, "The device record could not be read from the server.")
        val profile = device.userTimezone
        val data = buildJsonObject {
            put("phone", phoneZone.id)
            put("profile", profile)
        }
        if (profile.isNullOrBlank()) {
            return CheckResult.of(
                id, label, CheckStatus.WARN,
                "Your Health Profile has no time zone; the phone uses ${phoneZone.id}.",
                remedy = "Set the time zone at Settings → Health Profile on the web, so day boundaries match the phone.",
                data = data,
            )
        }
        val profileZone = runCatching { ZoneId.of(profile) }.getOrNull()
        return when {
            profileZone == null -> CheckResult.of(id, label, CheckStatus.WARN, "The Health Profile time zone \"$profile\" is not a valid zone.", remedy = "Set it again at Settings → Health Profile.", data = data)
            profileZone.normalized() == phoneZone.normalized() || profileZone.id == phoneZone.id ->
                CheckResult.of(id, label, CheckStatus.PASS, "Phone and Health Profile both use ${phoneZone.id}.", data = data)
            profileZone.rules.getOffset(now) == phoneZone.rules.getOffset(now) -> CheckResult.of(
                id, label, CheckStatus.PASS,
                "The phone uses ${phoneZone.id} and the Health Profile $profile; they currently share an offset.",
                data = data,
            )
            else -> CheckResult.of(
                id, label, CheckStatus.WARN,
                "The phone uses ${phoneZone.id} but your Health Profile uses $profile.",
                remedy = "Set the zone at Settings → Health Profile (or fix the phone's zone). A mismatch moves readings across day boundaries.",
                data = data,
            )
        }
    }

    fun twaVerification(url: String?, app: AppInfo, assetLinks: Probe<ApiResult<String>>?): CheckResult {
        val id = CheckIds.TWA_VERIFICATION
        val label = CheckLabels.TWA_VERIFICATION
        if (url == null || assetLinks == null) return CheckResult.of(id, label, CheckStatus.SKIP, "No server address is set.")
        val fingerprint = app.signingSha256
        val trustRemedy = "In ${Brand.name} open Admin → Settings → Android app → Trust this build (${app.packageName}, $fingerprint), then reopen the app."
        val failure = describe(assetLinks)
        if (failure != null) {
            return CheckResult.of(
                id, label, CheckStatus.WARN,
                "Could not fetch $url/.well-known/assetlinks.json: $failure. Without it the web app opens with a browser address bar.",
                remedy = trustRemedy,
                action = CheckAction.OPEN_ANDROID_APP_ADMIN,
            )
        }
        val body = ((assetLinks as Probe.Ok).value as ApiResult.Success).value
        val listed = AssetLinks.fingerprintsFor(body, app.packageName)
        val data = buildJsonObject {
            put("packageName", app.packageName)
            put("signingSha256", fingerprint)
            if (listed != null) putJsonArray("listedFingerprints") { listed.forEach { add(JsonPrimitive(it)) } }
        }
        return when {
            listed == null -> CheckResult.of(id, label, CheckStatus.WARN, "assetlinks.json is not a valid statement list.", remedy = trustRemedy, action = CheckAction.OPEN_ANDROID_APP_ADMIN, data = data)
            fingerprint == null -> CheckResult.of(id, label, CheckStatus.WARN, "This app's signing certificate could not be read, so the match cannot be checked.", data = data)
            listed.isEmpty() -> CheckResult.of(
                id, label, CheckStatus.WARN,
                "assetlinks.json does not list ${app.packageName}. Chrome opens the web app with an address bar. This build's fingerprint: $fingerprint.",
                remedy = trustRemedy,
                action = CheckAction.OPEN_ANDROID_APP_ADMIN,
                data = data,
            )
            listed.none { it.equals(fingerprint, ignoreCase = true) } -> CheckResult.of(
                id, label, CheckStatus.WARN,
                "assetlinks.json lists ${app.packageName} but not this build's fingerprint $fingerprint (it lists ${listed.joinToString(", ")}).",
                remedy = trustRemedy,
                action = CheckAction.OPEN_ANDROID_APP_ADMIN,
                data = data,
            )
            else -> CheckResult.of(id, label, CheckStatus.PASS, "assetlinks.json lists ${app.packageName} with this build's fingerprint.", data = data)
        }
    }
}

/** Digital Asset Links parsing (`/.well-known/assetlinks.json`). */
object AssetLinks {
    private const val RELATION = "delegate_permission/common.handle_all_urls"

    /**
     * Fingerprints the document grants [packageName] for `handle_all_urls`; empty when the
     * package is not listed; null when the body is not a JSON array of statements.
     */
    fun fingerprintsFor(body: String, packageName: String): List<String>? {
        val root = runCatching { kotlinx.serialization.json.Json.parseToJsonElement(body) }.getOrNull() as? JsonArray ?: return null
        val out = mutableListOf<String>()
        for (statement in root) {
            val obj = statement as? JsonObject ?: continue
            val relations = runCatching { obj["relation"]?.jsonArray?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull } }.getOrNull().orEmpty()
            if (RELATION !in relations) continue
            val target = runCatching { obj["target"]?.jsonObject }.getOrNull() ?: continue
            if ((target["namespace"] as? JsonPrimitive)?.contentOrNull != "android_app") continue
            if ((target["package_name"] as? JsonPrimitive)?.contentOrNull != packageName) continue
            runCatching { target["sha256_cert_fingerprints"]?.jsonArray }.getOrNull()
                ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
                ?.let { out += it }
        }
        return out
    }
}
