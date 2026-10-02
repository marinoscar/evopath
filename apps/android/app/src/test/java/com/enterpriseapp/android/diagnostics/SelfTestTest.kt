package com.enterpriseapp.android.diagnostics

import com.enterpriseapp.android.BuildConfig
import com.enterpriseapp.android.auth.SharedPrefsTokenStore
import com.enterpriseapp.android.healthconnect.HcAvailability
import com.enterpriseapp.android.healthconnect.HcDataType
import com.enterpriseapp.android.healthconnect.HcSourceCount
import com.enterpriseapp.android.healthconnect.HcTypeInventory
import com.enterpriseapp.android.healthconnect.HealthPermissions
import com.enterpriseapp.android.net.ApiResult
import com.enterpriseapp.android.net.HealthSyncDevice
import com.enterpriseapp.android.sync.LocalSyncRun
import com.enterpriseapp.android.sync.PrefsSyncHistoryStore
import com.enterpriseapp.android.sync.PrefsSyncStateStore
import com.enterpriseapp.android.sync.SyncResponse
import com.enterpriseapp.android.testing.FakeBackend
import com.enterpriseapp.android.testing.FakeHealthConnect
import com.enterpriseapp.android.testing.FakeSharedPreferences
import com.enterpriseapp.android.update.AppRelease
import com.enterpriseapp.android.update.FakeReleaseBackend
import com.enterpriseapp.android.util.AppInfo
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

class FakePlatform : DiagnosticsPlatform {
    var app = AppInfo(BuildConfig.APPLICATION_ID, "0.1.0", 1, (1..32).joinToString(":") { "%02X".format(it) })
    var battery: Boolean? = true
    var notificationPermission = true
    var notificationsOn = true
    var work: WorkSnapshot? = WorkSnapshot("ENQUEUED", Instant.parse("2026-10-01T19:00:00Z"))
    var workError: Exception? = null
    var installed: Set<String> = emptySet()
    var channels: List<NotificationChannelSnapshot> = listOf(NotificationChannelSnapshot("general", "General", 3))
    override fun appInfo() = app
    override fun device() = DeviceSnapshot("samsung", "SM-S921B", "16", 36, "America/Costa_Rica")
    override fun isIgnoringBatteryOptimizations() = battery
    override fun notificationPermissionGranted() = notificationPermission
    override fun notificationsEnabled() = notificationsOn
    override fun notificationChannels() = channels
    override suspend fun periodicWork(): WorkSnapshot? = workError?.let { throw it } ?: work
    override fun installedPackages(packages: Collection<String>) = installed.filterTo(linkedSetOf()) { it in packages }
}

class FakeServerProbe : ServerProbe {
    var liveResult: ApiResult<JsonElement> = ApiResult.Success(JsonNull, 200)
    var liveDelayMs = 0L
    var linksResult: ApiResult<String> = ApiResult.Success("[]", 200)
    var liveCalls = 0
    override suspend fun live(): ApiResult<JsonElement> {
        liveCalls++
        if (liveDelayMs > 0) Thread.sleep(liveDelayMs) // blocking, like OkHttp
        return liveResult
    }
    override suspend fun text(path: String) = linksResult
}

class SelfTestTest {
    private val zone = ZoneId.of("America/Costa_Rica")
    private val now = Instant.parse("2026-10-01T18:00:00Z")

    private lateinit var platform: FakePlatform
    private lateinit var server: FakeServerProbe
    private lateinit var backend: FakeBackend
    private lateinit var gateway: FakeHealthConnect
    private lateinit var tokens: SharedPrefsTokenStore
    private lateinit var state: PrefsSyncStateStore
    private lateinit var history: PrefsSyncHistoryStore
    private var serverUrl: String? = "https://app.example.com"

    @Before fun setUp() {
        platform = FakePlatform()
        server = FakeServerProbe()
        backend = FakeBackend().apply {
            deviceResult = ApiResult.Success(HealthSyncDevice("dev-1", status = "active", userTimezone = "America/Costa_Rica"), 200)
        }
        gateway = FakeHealthConnect().apply {
            inventories[HcDataType.STEPS] = HcTypeInventory(
                HcDataType.STEPS, 1000, true, Instant.parse("2026-10-01T15:00:00Z"),
                listOf(HcSourceCount("com.sec.android.app.shealth", 1000, Instant.parse("2026-10-01T15:00:00Z"))),
            )
            inventories[HcDataType.SLEEP] = HcTypeInventory(
                HcDataType.SLEEP, 20, false, Instant.parse("2026-10-01T12:00:00Z"),
                listOf(HcSourceCount("com.ouraring.oura", 20, Instant.parse("2026-10-01T12:00:00Z"))),
            )
        }
        tokens = SharedPrefsTokenStore(FakeSharedPreferences()).apply {
            setToken("pat_0123456789abcdef", Instant.parse("2026-12-30T00:00:00Z"))
            setDeviceId("dev-1")
        }
        state = PrefsSyncStateStore(FakeSharedPreferences())
        history = PrefsSyncHistoryStore(FakeSharedPreferences())
        history.add(
            LocalSyncRun(
                startedAt = "2026-10-01T17:30:00Z", finishedAt = "2026-10-01T17:30:05Z", trigger = "periodic",
                status = "ok", delivered = true, response = SyncResponse("run-1"),
            ),
        )
    }

    private val releases = FakeReleaseBackend()

    private fun selfTest(hcTimeoutMs: Long = 10_000, networkTimeoutMs: Long = 15_000) = SelfTest(
        platform = platform,
        serverUrl = { serverUrl },
        server = server,
        backend = backend,
        gateway = gateway,
        labels = { com.enterpriseapp.android.healthconnect.SourceApps.fallbackLabel(it) },
        tokens = tokens,
        state = state,
        history = history,
        releases = releases,
        clock = { now },
        zone = { zone },
        networkTimeoutMs = networkTimeoutMs,
        hcTimeoutMs = hcTimeoutMs,
    )

    private fun SelfTestResult.check(id: String) = checks.single { it.id == id }

    @Test fun `runs every check in a stable order with unique ids`() = runBlocking {
        val result = selfTest().run()
        val ids = result.checks.map { it.id }
        assertEquals(ids.toSet().size, ids.size)
        val expectedHead = listOf(
            "app.version", "app.update", "server.configured", "server.reachable", "pairing.token", "auth.valid", "api.connection",
            "hc.availability", "hc.connection", "hc.permissions", "hc.background", "hc.sources",
        )
        assertEquals(expectedHead, ids.take(expectedHead.size))
        assertEquals(HcDataType.SYNCED.map { "hc.data.${it.key}" }, ids.filter { it.startsWith("hc.data.") })
        assertEquals(
            listOf(
                "battery.optimization", "notifications.permission", "notifications.channels", "work.scheduled", "sync.last",
                "sync.delivery", "timezone.match", "twa.verification",
            ),
            ids.takeLast(8),
        )
        assertTrue(result.checks.all { it.label.isNotBlank() && it.detail.isNotBlank() })
    }

    @Test fun `notifications channels check reads the platform`() = runBlocking {
        assertEquals(CheckStatus.PASS, selfTest().run().check("notifications.channels").verdict)
        platform.channels = listOf(NotificationChannelSnapshot("general", "General", NotificationChannelSnapshot.IMPORTANCE_NONE))
        assertEquals(CheckStatus.WARN, selfTest().run().check("notifications.channels").verdict)
        platform.notificationPermission = false
        assertEquals(CheckStatus.SKIP, selfTest().run().check("notifications.channels").verdict)
        assertEquals(CheckAction.ALLOW_NOTIFICATIONS, selfTest().run().check("notifications.permission").action)
    }

    @Test fun `healthy phone with sources but empty types warns per empty type`() = runBlocking {
        val result = selfTest().run()
        assertEquals(CheckStatus.PASS, result.check("hc.data.steps").verdict)
        assertTrue(result.check("hc.data.steps").detail.startsWith("1000+ records"))
        assertEquals(CheckStatus.PASS, result.check("hc.data.sleep").verdict)
        val weight = result.check("hc.data.weight")
        assertEquals(CheckStatus.WARN, weight.verdict)
        assertTrue(weight.remedy!!, weight.remedy!!.startsWith("Open Samsung Health and allow Weight to be shared to Health Connect"))
        val sources = result.healthConnect.sources
        assertEquals(listOf("Samsung Health", "Oura"), sources.map { it.appLabel })
        assertEquals(CheckStatus.PASS, result.check("hc.sources").verdict)
        // Inventory covers every type, distance included.
        assertEquals(HcDataType.entries.size, result.healthConnect.inventory.size)
        assertEquals("available", result.healthConnect.status)
        assertTrue(result.healthConnect.backgroundAvailable)
        assertEquals(CheckStatus.PASS, result.check("api.connection").verdict)
        assertEquals(CheckStatus.PASS, result.check("timezone.match").verdict)
        assertEquals(CheckStatus.WARN, result.check("twa.verification").verdict) // "[]"
    }

    @Test fun `hc data remedies use evidence, installed capable apps and the capability table`() = runBlocking {
        platform.installed = setOf("com.sec.android.app.shealth", "com.ouraring.oura")
        val result = selfTest().run()
        // HRV: Samsung Health cannot write it, Oura (installed, feeding sleep) can.
        val hrv = result.check("hc.data.hrv")
        assertEquals(CheckStatus.WARN, hrv.verdict)
        assertTrue(hrv.remedy!!, hrv.remedy!!.startsWith("Open Oura and allow Heart rate variability"))
        val hrvApps = hrv.data!!["remedyApps"]!!.jsonArray.map { (it.jsonObject["packageName"] as JsonPrimitive).content }
        assertEquals(listOf("com.ouraring.oura"), hrvApps)
        // Steps: Samsung Health wrote them; Oura is installed and capable.
        val steps = result.check("hc.data.steps").data!!["remedyApps"]!!.jsonArray.map { it.jsonObject }
        assertEquals(listOf("com.sec.android.app.shealth", "com.ouraring.oura"), steps.map { (it["packageName"] as JsonPrimitive).content })
        assertEquals(listOf("wrote_data", "installed_capable"), steps.map { (it["reason"] as JsonPrimitive).content })
        // Blood pressure: only Samsung Health among them.
        assertTrue(result.check("hc.data.blood_pressure").remedy!!.startsWith("Open Samsung Health and allow Blood pressure"))
    }

    @Test fun `a type no app on the phone can write gets the none remedy`() = runBlocking {
        gateway.inventories.remove(HcDataType.SLEEP) // Oura feeds nothing now
        platform.installed = setOf("com.sec.android.app.shealth")
        val result = selfTest().run()
        val hrv = result.check("hc.data.hrv")
        assertEquals(CheckStatus.WARN, hrv.verdict)
        assertTrue(hrv.remedy!!, hrv.remedy!!.startsWith("None of the apps on this phone write heart rate variability"))
        assertEquals(CheckAction.OPEN_SYNC_SETTINGS, hrv.action)
    }

    @Test fun `Health Connect enabled but nothing shared is caught`() = runBlocking {
        gateway.inventories.clear()
        val result = selfTest().run()
        assertEquals(CheckStatus.PASS, result.check("hc.permissions").verdict)
        assertEquals(CheckStatus.WARN, result.check("hc.sources").verdict)
        HcDataType.SYNCED.forEach { assertEquals(it.key, CheckStatus.WARN, result.check("hc.data.${it.key}").verdict) }
    }

    @Test fun `denied permissions fail per type and are reported in the inventory`() = runBlocking {
        gateway.granted = gateway.granted - HealthPermissions.READ_STEPS
        val result = selfTest().run()
        assertEquals(CheckStatus.FAIL, result.check("hc.data.steps").verdict)
        assertEquals(CheckStatus.WARN, result.check("hc.permissions").verdict)
        assertEquals("denied", result.healthConnect.inventory.single { it.dataType == "steps" }.permission)
        assertFalse(HealthPermissions.READ_STEPS in result.healthConnect.grantedPermissions)
    }

    @Test fun `a hanging Health Connect call times out without blocking the other checks`() = runBlocking {
        gateway.grantedDelayMs = 5_000
        val started = System.nanoTime()
        val result = selfTest(hcTimeoutMs = 200).run()
        assertTrue("took too long", (System.nanoTime() - started) / 1_000_000 < 4_000)
        val connection = result.check("hc.connection")
        assertEquals(CheckStatus.FAIL, connection.verdict)
        assertTrue(connection.detail.contains("did not answer"))
        assertEquals(CheckStatus.SKIP, result.check("hc.permissions").verdict)
        assertEquals(CheckStatus.SKIP, result.check("hc.data.steps").verdict)
        assertEquals("unknown", result.healthConnect.inventory.first().permission)
        assertEquals(CheckStatus.PASS, result.check("server.reachable").verdict)
    }

    @Test fun `a blocking network call is cut off by the probe timeout`() = runBlocking {
        server.liveDelayMs = 3_000
        val started = System.nanoTime()
        val result = selfTest(networkTimeoutMs = 200).run()
        assertTrue((System.nanoTime() - started) / 1_000_000 < 2_500)
        assertEquals(CheckStatus.FAIL, result.check("server.reachable").verdict)
        assertEquals(CheckStatus.FAIL, result.check("api.connection").verdict)
    }

    @Test fun `exceptions from Health Connect become a failed connection check`() = runBlocking {
        gateway.grantedError = IllegalStateException("Service not bound")
        val result = selfTest().run()
        val connection = result.check("hc.connection")
        assertEquals(CheckStatus.FAIL, connection.verdict)
        assertTrue(connection.detail.contains("IllegalStateException: Service not bound"))
    }

    @Test fun `an inventory failure warns only that type`() = runBlocking {
        gateway.inventoryFailures[HcDataType.SLEEP] = SecurityException("background read")
        val result = selfTest().run()
        val sleep = result.check("hc.data.sleep")
        assertEquals(CheckStatus.WARN, sleep.verdict)
        assertTrue(sleep.detail.contains("SecurityException"))
        assertEquals(CheckStatus.PASS, result.check("hc.data.steps").verdict)
    }

    @Test fun `unavailable Health Connect skips the dependent checks`() = runBlocking {
        gateway.availability = HcAvailability.UPDATE_REQUIRED
        val result = selfTest().run()
        assertEquals(CheckStatus.FAIL, result.check("hc.availability").verdict)
        listOf("hc.connection", "hc.permissions", "hc.background", "hc.sources", "hc.data.steps").forEach {
            assertEquals(it, CheckStatus.SKIP, result.check(it).verdict)
        }
        assertEquals("update_required", result.healthConnect.status)
    }

    @Test fun `revoked device and expired token`() = runBlocking {
        backend.deviceResult = FakeBackend.httpError(409, "DEVICE_REVOKED")
        val result = selfTest().run()
        assertEquals(CheckStatus.FAIL, result.check("auth.valid").verdict)
        assertTrue(result.check("api.connection").detail.contains("Device revoked"))
        assertEquals(CheckStatus.SKIP, result.check("timezone.match").verdict)
        assertTrue(result.summary.startsWith("2 fail"))
    }

    @Test fun `not paired and no server`() = runBlocking {
        tokens.clear()
        serverUrl = null
        val result = selfTest().run()
        assertEquals(CheckStatus.FAIL, result.check("server.configured").verdict)
        assertEquals(CheckStatus.SKIP, result.check("server.reachable").verdict)
        assertEquals(CheckStatus.FAIL, result.check("pairing.token").verdict)
        assertEquals(CheckStatus.SKIP, result.check("work.scheduled").verdict)
        assertEquals(0, server.liveCalls)
        assertTrue(result.summary, result.summary.startsWith("2 fail, "))
        assertTrue(result.summary, result.summary.endsWith(": Server address"))
    }

    @Test fun `app update warns when the server offers a newer build and the report carries it`() = runBlocking {
        releases.latestResult = ApiResult.Success(
            AppRelease("r-2", platform.app.packageName, "0.3.0", platform.app.versionCode + 2, sizeBytes = 10),
            200,
        )
        val result = selfTest().run()
        val check = result.check("app.update")
        assertEquals(CheckStatus.WARN, check.verdict)
        assertTrue(check.remedy!!.contains("Download v0.3.0"))
        val app = DiagnosticReportBuilder.build(result, tokens, state, history.runs(), emptyList()).json["app"]!!.jsonObject
        assertEquals((platform.app.versionCode + 2).toString(), app["latestVersionCode"].toString())
        assertEquals("0.3.0", (app["latestVersionName"] as JsonPrimitive).content)
        assertEquals("true", app["updateAvailable"].toString())
    }

    @Test fun `app update skips without a release and leaves the report fields out`() = runBlocking {
        val result = selfTest().run()
        assertEquals(CheckStatus.SKIP, result.check("app.update").verdict)
        val app = DiagnosticReportBuilder.build(result, tokens, state, history.runs(), emptyList()).json["app"]!!.jsonObject
        assertFalse("latestVersionCode" in app)
    }

    @Test fun `app update is not asked when not paired`() = runBlocking {
        tokens.clear()
        val result = selfTest().run()
        assertEquals(CheckStatus.SKIP, result.check("app.update").verdict)
        assertEquals(0, releases.calls)
    }

    @Test fun `report never contains the token and respects the caps`() = runBlocking {
        val result = selfTest().run()
        repeat(30) { history.add(LocalSyncRun("2026-10-01T10:00:00Z", "2026-10-01T10:00:01Z", "manual", "ok", true)) }
        val log = (1..500).map { "2026-10-01T10:00:00Z I/T: line $it with Bearer pat_0123456789abcdef" }
        val built = DiagnosticReportBuilder.build(result, tokens, state, history.runs(), log)
        assertFalse(built.text.contains("0123456789abcdef"))
        assertFalse(built.json.toString().contains("0123456789abcdef"))
        val json = built.json
        assertEquals(DiagnosticsLimits.REPORT_RUNS, json["recentRuns"]!!.jsonArray.size)
        assertEquals(DiagnosticsLimits.REPORT_LOG_LINES, json["log"]!!.jsonArray.size)
        assertTrue((json["log"]!!.jsonArray.last() as JsonPrimitive).content.endsWith("line 500 with Bearer [REDACTED]"))
        // Contract shape.
        listOf("generatedAt", "summary", "app", "device", "server", "pairing", "healthConnect", "work", "checks", "recentRuns", "log")
            .forEach { assertTrue(it, it in json) }
        val app = json["app"]!!.jsonObject
        listOf("versionName", "versionCode", "packageName", "signingSha256").forEach { assertTrue(it, it in app) }
        val device = json["device"]!!.jsonObject
        listOf("manufacturer", "model", "androidVersion", "sdkInt", "timezone").forEach { assertTrue(it, it in device) }
        assertEquals("https://app.example.com", (json["server"]!!.jsonObject["url"] as JsonPrimitive).content)
        val pairing = json["pairing"]!!.jsonObject
        assertEquals("dev-1", (pairing["deviceId"] as JsonPrimitive).content)
        assertEquals("2026-12-30T00:00:00Z", (pairing["tokenExpiresAt"] as JsonPrimitive).content)
        assertEquals("false", pairing["expired"].toString())
        val hc = json["healthConnect"]!!.jsonObject
        listOf("status", "version", "grantedPermissions", "backgroundAvailable", "inventory", "sources").forEach { assertTrue(it, it in hc) }
        val steps = hc["inventory"]!!.jsonArray.map { it.jsonObject }.single { (it["dataType"] as JsonPrimitive).content == "steps" }
        listOf("permission", "recordCount30d", "capped", "latestRecordAt", "sources").forEach { assertTrue(it, it in steps) }
        assertEquals("true", steps["capped"].toString())
        val source = hc["sources"]!!.jsonArray.first().jsonObject
        listOf("packageName", "appLabel", "dataTypes", "recordCount", "latestRecordAt").forEach { assertTrue(it, it in source) }
        val work = json["work"]!!.jsonObject
        assertEquals("ENQUEUED", (work["state"] as JsonPrimitive).content)
        assertEquals("2026-10-01T19:00:00Z", (work["nextRunAt"] as JsonPrimitive).content)
        val weightCheck = json["checks"]!!.jsonArray.map { it.jsonObject }.single { (it["id"] as JsonPrimitive).content == "hc.data.weight" }
        assertTrue("remedyApps" in weightCheck["data"]!!.jsonObject)
        val check = json["checks"]!!.jsonArray.first().jsonObject
        assertEquals(setOf("id", "label", "status", "detail"), check.keys - setOf("remedy", "data"))
        assertNull("the phone-only action is not serialized", check["action"])
        assertEquals(result.summary, (json["summary"] as JsonPrimitive).content)
    }

    @Test fun `an oversized report is trimmed below the upload limit`() = runBlocking {
        val result = selfTest().run()
        val log = (1..300).map { "x".repeat(RollingLog.MAX_LINE_LENGTH) + it }
        val runs = (1..20).map {
            LocalSyncRun("2026-10-01T10:00:00Z", "2026-10-01T10:00:01Z", "manual", "failed", false, errorMessage = "e".repeat(2000))
        }
        val built = DiagnosticReportBuilder.build(result, tokens, state, runs, log)
        assertTrue(built.sizeBytes <= DiagnosticReportBuilder.MAX_BYTES)
        assertTrue(built.json["log"]!!.jsonArray.size < 300)
        assertTrue(built.json["checks"] is kotlinx.serialization.json.JsonArray)
        assertTrue(built.json is JsonObject)
    }
}
