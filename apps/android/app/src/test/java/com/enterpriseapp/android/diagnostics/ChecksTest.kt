package com.enterpriseapp.android.diagnostics

import com.enterpriseapp.android.BuildConfig
import com.enterpriseapp.android.healthconnect.HcAvailability
import com.enterpriseapp.android.healthconnect.HcDataType
import com.enterpriseapp.android.healthconnect.HealthPermissions
import com.enterpriseapp.android.healthconnect.SyncToggle
import com.enterpriseapp.android.net.ApiError
import com.enterpriseapp.android.net.ApiResult
import com.enterpriseapp.android.net.HealthSyncDevice
import com.enterpriseapp.android.sync.LocalSyncRun
import com.enterpriseapp.android.sync.PerTypeDetail
import com.enterpriseapp.android.sync.SyncCounts
import com.enterpriseapp.android.sync.SyncResponse
import com.enterpriseapp.android.testing.FakeBackend
import com.enterpriseapp.android.update.AppRelease
import com.enterpriseapp.android.util.AppInfo
import com.enterpriseapp.android.util.Brand
import kotlinx.serialization.json.JsonNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

class ChecksTest {
    private val zone = ZoneId.of("America/Costa_Rica")
    private val now = Instant.parse("2026-10-01T18:00:00Z")
    private val fp = (1..32).joinToString(":") { "%02X".format(it) }
    private val app = AppInfo(BuildConfig.APPLICATION_ID, "0.1.0", 1, fp)

    private fun assertStatus(expected: CheckStatus, check: CheckResult) =
        assertEquals("${check.id}: ${check.detail}", expected, check.verdict)

    // --- pairing.token --------------------------------------------------------------------

    @Test fun `pairing token thresholds`() {
        fun check(expiresAt: Instant?, expiredFlag: Boolean = false, token: Boolean = true, device: String? = "d1") =
            Checks.pairingToken(token, device, expiresAt, expiredFlag, now, zone)
        assertStatus(CheckStatus.FAIL, check(null, token = false))
        assertEquals(CheckAction.REPAIR, check(null, token = false).action)
        assertStatus(CheckStatus.FAIL, check(null, device = null))
        assertStatus(CheckStatus.FAIL, check(now.plusSeconds(86400 * 60), expiredFlag = true))
        assertStatus(CheckStatus.FAIL, check(now.minusSeconds(1)))
        assertStatus(CheckStatus.FAIL, check(now))
        assertStatus(CheckStatus.WARN, check(now.plusSeconds(86400 * 13)))
        assertTrue(check(now.plusSeconds(86400 * 13)).detail.contains("13 days"))
        assertStatus(CheckStatus.PASS, check(now.plusSeconds(86400 * 14)))
        assertStatus(CheckStatus.PASS, check(now.plusSeconds(86400 * 90)))
        assertStatus(CheckStatus.PASS, check(null))
    }

    // --- app.update -----------------------------------------------------------------------

    @Test fun `app update verdicts`() {
        fun release(code: Long, pkg: String = app.packageName) = AppRelease("r", pkg, "0.$code.0", code)
        fun ok(r: ApiResult<AppRelease>) = Probe.Ok(r, 50)
        val noRelease = ApiResult.Failure(ApiError(ApiError.Kind.HTTP, 404, message = "none", reason = "NO_RELEASE"))

        assertStatus(CheckStatus.SKIP, Checks.appUpdate(false, app, ok(ApiResult.Success(release(2), 200))))
        assertStatus(CheckStatus.SKIP, Checks.appUpdate(true, app, null))
        assertStatus(CheckStatus.SKIP, Checks.appUpdate(true, app, ok(noRelease)))
        assertTrue(Checks.appUpdate(true, app, ok(noRelease)).detail.contains("no Android app release"))
        assertStatus(CheckStatus.SKIP, Checks.appUpdate(true, app, Probe.TimedOut(15_000)))
        assertStatus(CheckStatus.SKIP, Checks.appUpdate(true, app, Probe.Error(IllegalStateException("boom"), 3)))
        assertStatus(
            CheckStatus.SKIP,
            Checks.appUpdate(true, app, ok(ApiResult.Failure(ApiError(ApiError.Kind.HTTP, 500, message = "down")))),
        )
        assertStatus(CheckStatus.SKIP, Checks.appUpdate(true, app, ok(ApiResult.Success(release(9, pkg = "com.other.android"), 200))))
        assertStatus(CheckStatus.PASS, Checks.appUpdate(true, app, ok(ApiResult.Success(release(1), 200))))
        assertStatus(CheckStatus.PASS, Checks.appUpdate(true, app.copy(versionCode = 3), ok(ApiResult.Success(release(2), 200))))

        val warn = Checks.appUpdate(true, app, ok(ApiResult.Success(release(2), 200)))
        assertStatus(CheckStatus.WARN, warn)
        assertEquals("Download v0.2.0 from the Hub or Settings → Android app on the web.", warn.remedy)
        assertEquals(CheckAction.GET_UPDATE, warn.action)
        assertEquals("2", warn.data!!["latestVersionCode"].toString())
        assertEquals("true", warn.data!!["updateAvailable"].toString())
    }

    // --- server and auth ------------------------------------------------------------------

    @Test fun `server reachable reports latency, slowness and failures`() {
        assertStatus(CheckStatus.SKIP, Checks.serverReachable(null, null))
        val ok = Checks.serverReachable("https://e.x", Probe.Ok(ApiResult.Success(JsonNull, 200), 120))
        assertStatus(CheckStatus.PASS, ok)
        assertTrue(ok.detail.contains("120 ms"))
        assertStatus(CheckStatus.WARN, Checks.serverReachable("https://e.x", Probe.Ok(ApiResult.Success(JsonNull, 200), 4000)))
        assertStatus(CheckStatus.FAIL, Checks.serverReachable("https://e.x", Probe.Ok(FakeBackend.networkError(), 10)))
        assertStatus(CheckStatus.FAIL, Checks.serverReachable("https://e.x", Probe.TimedOut(15000)))
    }

    @Test fun `auth valid maps 401 to re-pair and 404 or 409 to revoked`() {
        fun auth(result: ApiResult<HealthSyncDevice>) = Checks.authValid("https://e.x", true, Probe.Ok(result, 50))
        assertStatus(CheckStatus.PASS, auth(ApiResult.Success(HealthSyncDevice("d1", status = "active"), 200)))
        val expired = auth(FakeBackend.httpError(401))
        assertStatus(CheckStatus.FAIL, expired)
        assertTrue(expired.detail.startsWith("Pairing expired"))
        assertEquals(CheckAction.REPAIR, expired.action)
        for (r in listOf(FakeBackend.httpError(409, "DEVICE_REVOKED"), FakeBackend.httpError(404), FakeBackend.httpError(409))) {
            val revoked = auth(r)
            assertStatus(CheckStatus.FAIL, revoked)
            assertTrue(revoked.detail, revoked.detail.startsWith("Device revoked"))
            assertTrue(revoked.remedy!!.startsWith("Connect again"))
        }
        assertStatus(CheckStatus.FAIL, auth(ApiResult.Success(HealthSyncDevice("d1", status = "revoked"), 200)))
        assertStatus(CheckStatus.FAIL, auth(FakeBackend.networkError()))
        assertStatus(CheckStatus.SKIP, Checks.authValid("https://e.x", false, null))
    }

    @Test fun `api connection folds reachability and authentication with both latencies`() {
        val live = Checks.serverReachable("https://e.x", Probe.Ok(ApiResult.Success(JsonNull, 200), 80))
        val auth = Checks.authValid("https://e.x", true, Probe.Ok(ApiResult.Success(HealthSyncDevice("d1"), 200), 140))
        val ok = Checks.apiConnection(live, auth)
        assertStatus(CheckStatus.PASS, ok)
        assertTrue(ok.detail, ok.detail.contains("80 ms") && ok.detail.contains("140 ms"))
        assertEquals("140", ok.data!!["authLatencyMs"].toString())

        val refused = Checks.apiConnection(live, Checks.authValid("https://e.x", true, Probe.Ok(FakeBackend.httpError(401), 30)))
        assertStatus(CheckStatus.FAIL, refused)
        assertEquals(CheckAction.REPAIR, refused.action)

        val down = Checks.apiConnection(Checks.serverReachable("https://e.x", Probe.TimedOut(15000)), auth)
        assertStatus(CheckStatus.FAIL, down)

        val unpaired = Checks.apiConnection(live, Checks.authValid("https://e.x", false, null))
        assertStatus(CheckStatus.PASS, unpaired)
        assertTrue(unpaired.detail.contains("not tested"))
    }

    // --- Health Connect -------------------------------------------------------------------

    @Test fun `hc availability and connection`() {
        assertStatus(CheckStatus.PASS, Checks.hcAvailability(Probe.Ok(HcAvailability.AVAILABLE, 1), "1.2"))
        val update = Checks.hcAvailability(Probe.Ok(HcAvailability.UPDATE_REQUIRED, 1), null)
        assertStatus(CheckStatus.FAIL, update)
        assertEquals(CheckAction.UPDATE_HEALTH_CONNECT, update.action)
        assertStatus(CheckStatus.FAIL, Checks.hcAvailability(Probe.Ok(HcAvailability.NOT_SUPPORTED, 1), null))
        assertStatus(CheckStatus.FAIL, Checks.hcAvailability(Probe.Error(IllegalStateException("x"), 1), null))

        assertStatus(CheckStatus.SKIP, Checks.hcConnection(false, null))
        assertStatus(CheckStatus.PASS, Checks.hcConnection(true, Probe.Ok(setOf("a"), 40)))
        val broken = Checks.hcConnection(true, Probe.Error(java.io.IOException("binder died"), 40))
        assertStatus(CheckStatus.FAIL, broken)
        assertTrue(broken.detail, broken.detail.contains("IOException: binder died"))
        assertEquals("java.io.IOException", broken.data!!["exception"].toString().trim('"'))
        val slow = Checks.hcConnection(true, Probe.TimedOut(10_000))
        assertStatus(CheckStatus.FAIL, slow)
        assertTrue(slow.detail.contains("10 s"))
    }

    @Test fun `hc permissions lists the missing ones for enabled toggles only`() {
        val all = HealthPermissions.ALL_DATA.toSet()
        assertStatus(CheckStatus.PASS, Checks.hcPermissions(all, SyncToggle.entries))
        val missing = Checks.hcPermissions(all - HealthPermissions.READ_WEIGHT - HealthPermissions.READ_SLEEP, SyncToggle.entries)
        assertStatus(CheckStatus.WARN, missing)
        assertTrue(missing.detail, missing.detail.contains("Weight") && missing.detail.contains("Sleep"))
        assertEquals(CheckAction.GRANT_PERMISSIONS, missing.action)
        // Weight switched off: its missing permission does not matter.
        assertStatus(
            CheckStatus.PASS,
            Checks.hcPermissions(all - HealthPermissions.READ_WEIGHT, SyncToggle.entries - SyncToggle.WEIGHT),
        )
        assertStatus(CheckStatus.FAIL, Checks.hcPermissions(emptySet(), SyncToggle.entries))
        assertStatus(CheckStatus.WARN, Checks.hcPermissions(all, emptyList()))
        assertStatus(CheckStatus.SKIP, Checks.hcPermissions(null, SyncToggle.entries))
    }

    @Test fun `hc background warns with the hourly-sync remedy`() {
        val bg = HealthPermissions.READ_HEALTH_DATA_IN_BACKGROUND
        assertStatus(CheckStatus.PASS, Checks.hcBackground(true, true, setOf(bg)))
        val notGranted = Checks.hcBackground(true, true, emptySet())
        assertStatus(CheckStatus.WARN, notGranted)
        assertTrue(notGranted.remedy!!.contains("hourly sync won't run while the app is closed"))
        assertEquals(CheckAction.GRANT_BACKGROUND, notGranted.action)
        val unavailable = Checks.hcBackground(true, false, setOf(bg))
        assertStatus(CheckStatus.WARN, unavailable)
        assertTrue(unavailable.remedy!!.contains("hourly sync won't run while the app is closed"))
        assertStatus(CheckStatus.SKIP, Checks.hcBackground(false, false, null))
    }

    private fun entry(
        type: HcDataType,
        count: Int,
        permission: String = InventoryEntry.GRANTED,
        sources: List<InventorySource> = emptyList(),
        latest: String? = null,
        capped: Boolean = false,
        error: String? = null,
    ) = InventoryEntry(type.key, type.label, permission, count, capped, latest, sources, error)

    private val samsung = RemedyApp("com.sec.android.app.shealth", "Samsung Health", RemedyApp.INSTALLED_CAPABLE)

    @Test fun `hc data fails when denied, warns on zero records naming the source app, passes with counts`() {
        val denied = Checks.hcData(HcDataType.STEPS, true, entry(HcDataType.STEPS, 0, InventoryEntry.DENIED), listOf(samsung), zone)
        assertStatus(CheckStatus.FAIL, denied)
        assertEquals("hc.data.steps", denied.id)
        assertEquals(CheckAction.GRANT_PERMISSIONS, denied.action)

        val empty = Checks.hcData(HcDataType.WEIGHT, true, entry(HcDataType.WEIGHT, 0), listOf(samsung), zone)
        assertStatus(CheckStatus.WARN, empty)
        assertTrue(empty.detail, empty.detail.startsWith("Permission granted but no weight records in the last 30 days"))
        assertTrue(empty.detail.contains("30 days before ${Brand.name} was first granted access"))
        assertEquals(
            "Open Samsung Health and allow Weight to be shared to Health Connect: " +
                "Health Connect → App permissions → Samsung Health → Allowed to write → Weight. Then Sync now.",
            empty.remedy,
        )
        assertEquals(CheckAction.OPEN_HEALTH_CONNECT, empty.action)

        val full = Checks.hcData(
            HcDataType.STEPS, true,
            entry(
                HcDataType.STEPS, 1000, capped = true, latest = "2026-10-01T12:30:00Z",
                sources = listOf(InventorySource("com.sec.android.app.shealth", "Samsung Health", 1000, "2026-10-01T12:30:00Z")),
            ),
            listOf(samsung), zone,
        )
        assertStatus(CheckStatus.PASS, full)
        assertTrue(full.detail, full.detail.startsWith("1000+ records in the last 30 days, latest 2026-10-01 06:30, from Samsung Health (1000)"))

        assertStatus(CheckStatus.WARN, Checks.hcData(HcDataType.SLEEP, true, entry(HcDataType.SLEEP, 0, error = "SecurityException: x"), emptyList(), zone))
        assertStatus(CheckStatus.SKIP, Checks.hcData(HcDataType.SLEEP, false, entry(HcDataType.SLEEP, 0, InventoryEntry.DENIED), emptyList(), zone))
        assertStatus(CheckStatus.SKIP, Checks.hcData(HcDataType.SLEEP, true, null, emptyList(), zone))
    }

    @Test fun `source aggregation unions packages across types`() {
        val inventory = listOf(
            entry(HcDataType.STEPS, 30, sources = listOf(
                InventorySource("com.sec.android.app.shealth", "Samsung Health", 25, "2026-10-01T10:00:00Z"),
                InventorySource("com.google.android.apps.fitness", "Google Fit", 5, "2026-09-20T10:00:00Z"),
            )),
            entry(HcDataType.SLEEP, 12, sources = listOf(InventorySource("com.ouraring.oura", "Oura", 12, "2026-10-01T13:00:00Z"))),
            entry(HcDataType.HEART_RATE, 400, sources = listOf(InventorySource("com.sec.android.app.shealth", "Samsung Health", 400, "2026-10-01T11:00:00Z"))),
            entry(HcDataType.WEIGHT, 0, InventoryEntry.DENIED),
        )
        val sources = SourceAggregation.aggregate(inventory)
        assertEquals(listOf("com.sec.android.app.shealth", "com.ouraring.oura", "com.google.android.apps.fitness"), sources.map { it.packageName })
        val samsung = sources.first()
        assertEquals(listOf("steps", "heart_rate"), samsung.dataTypes)
        assertEquals(425, samsung.recordCount)
        assertEquals("2026-10-01T11:00:00Z", samsung.latestRecordAt)

        val check = Checks.hcSources(true, inventory, sources, zone)
        assertStatus(CheckStatus.PASS, check)
        assertTrue(check.detail, check.detail.startsWith("3 apps in the last 30 days: Samsung Health: Steps, Heart rate (daily average) (425 records"))
    }

    @Test fun `hc sources warns when no app wrote anything`() {
        val inventory = listOf(entry(HcDataType.STEPS, 0), entry(HcDataType.WEIGHT, 0, InventoryEntry.DENIED))
        val check = Checks.hcSources(true, inventory, emptyList(), zone)
        assertStatus(CheckStatus.WARN, check)
        assertTrue(check.detail.startsWith("No app wrote anything"))
        assertStatus(CheckStatus.SKIP, Checks.hcSources(true, listOf(entry(HcDataType.STEPS, 0, InventoryEntry.DENIED)), emptyList(), zone))
        assertStatus(CheckStatus.SKIP, Checks.hcSources(false, null, emptyList(), zone))
    }

    // --- phone ----------------------------------------------------------------------------

    @Test fun `battery and notifications`() {
        assertStatus(CheckStatus.PASS, Checks.batteryOptimization(true))
        assertEquals(CheckAction.BATTERY_SETTINGS, Checks.batteryOptimization(false).action)
        assertStatus(CheckStatus.WARN, Checks.batteryOptimization(false))
        assertStatus(CheckStatus.SKIP, Checks.batteryOptimization(null))
        assertStatus(CheckStatus.WARN, Checks.notifications(34, permissionGranted = false, enabled = true))
        assertStatus(CheckStatus.PASS, Checks.notifications(30, permissionGranted = false, enabled = true))
        assertStatus(CheckStatus.WARN, Checks.notifications(30, permissionGranted = true, enabled = false))
        assertStatus(CheckStatus.PASS, Checks.notifications(34, permissionGranted = true, enabled = true))
    }

    @Test fun `work scheduled`() {
        val next = Instant.parse("2026-10-01T19:00:00Z")
        val ok = Checks.workScheduled(true, Probe.Ok(WorkSnapshot("ENQUEUED", next), 1), zone)
        assertStatus(CheckStatus.PASS, ok)
        assertTrue(ok.detail.contains("2026-10-01 13:00"))
        assertStatus(CheckStatus.WARN, Checks.workScheduled(true, Probe.Ok(WorkSnapshot("BLOCKED"), 1), zone))
        assertStatus(CheckStatus.FAIL, Checks.workScheduled(true, Probe.Ok(null, 1), zone))
        assertStatus(CheckStatus.FAIL, Checks.workScheduled(true, Probe.Ok(WorkSnapshot("CANCELLED"), 1), zone))
        assertStatus(CheckStatus.SKIP, Checks.workScheduled(false, Probe.Ok(null, 1), zone))
    }

    // --- sync history ---------------------------------------------------------------------

    private fun run(
        finishedAt: Instant = now.minusSeconds(600),
        status: String = "ok",
        delivered: Boolean = true,
        perType: Map<String, PerTypeDetail> = emptyMap(),
        response: SyncResponse? = SyncResponse("r1"),
        errorCode: String? = null,
        errorMessage: String? = null,
    ) = LocalSyncRun(
        startedAt = finishedAt.minusSeconds(5).toString(),
        finishedAt = finishedAt.toString(),
        trigger = "periodic",
        status = status,
        delivered = delivered,
        perType = perType,
        response = response,
        errorCode = errorCode,
        errorMessage = errorMessage,
    )

    @Test fun `sync last warns when stale, failed, partial or skipped`() {
        assertStatus(CheckStatus.PASS, Checks.syncLast(true, run(), now))
        assertStatus(CheckStatus.WARN, Checks.syncLast(true, run(finishedAt = now.minusSeconds(3 * 3600 + 1)), now))
        assertStatus(CheckStatus.PASS, Checks.syncLast(true, run(finishedAt = now.minusSeconds(2 * 3600)), now))
        val failed = Checks.syncLast(true, run(status = "failed", errorCode = "HC_READ_FAILED", errorMessage = "steps: boom"), now)
        assertStatus(CheckStatus.WARN, failed)
        assertTrue(failed.detail, failed.detail.contains("HC_READ_FAILED: steps: boom"))
        assertStatus(CheckStatus.WARN, Checks.syncLast(true, run(status = "partial", errorCode = "HC_PARTIAL_READ"), now))
        val bg = Checks.syncLast(true, run(status = "skipped", errorCode = "BACKGROUND_PERMISSION_MISSING"), now)
        assertStatus(CheckStatus.WARN, bg)
        assertEquals(CheckAction.GRANT_BACKGROUND, bg.action)
        assertStatus(CheckStatus.WARN, Checks.syncLast(true, run(delivered = false), now))
        assertStatus(CheckStatus.WARN, Checks.syncLast(true, null, now))
        assertStatus(CheckStatus.SKIP, Checks.syncLast(false, null, now))
    }

    private fun detail(read: Int, sent: Int, dropped: Int = 0, permission: String = "granted", enabled: Boolean = true) =
        PerTypeDetail(permission = permission, enabled = enabled, read = read, sent = sent, dropped = dropped)

    @Test fun `sync delivery passes when read, sent and accepted agree`() {
        val check = Checks.syncDelivery(
            run(
                perType = mapOf(
                    "steps" to detail(7, 7),
                    "weight" to detail(2, 2),
                    "blood_pressure" to detail(1, 2), // one reading → two rows
                    "sleep" to detail(3, 3),
                    "hrv" to detail(0, 0, permission = "denied"),
                    "distance" to detail(4, 0),
                ),
                response = SyncResponse(
                    "r1", created = 2, updated = 1, unchanged = 4,
                    measurements = SyncCounts(created = 1, unchanged = 3),
                    sleep = SyncCounts(updated = 3),
                ),
            ),
        )
        assertStatus(CheckStatus.PASS, check)
        assertTrue(check.detail, check.detail.contains("14 rows"))
    }

    @Test fun `sync delivery warns on dropped rows, server mismatch and skipped rows`() {
        val dropped = Checks.syncDelivery(
            run(perType = mapOf("exercise" to detail(5, 3, dropped = 2)), response = SyncResponse("r1", created = 3)),
        )
        assertStatus(CheckStatus.WARN, dropped)
        assertTrue(dropped.detail, dropped.detail.contains("Exercise sessions: read 5, sent 3 (2 dropped"))

        val mismatch = Checks.syncDelivery(
            run(perType = mapOf("steps" to detail(7, 7)), response = SyncResponse("r1", created = 5)),
        )
        assertStatus(CheckStatus.WARN, mismatch)
        assertTrue(mismatch.detail, mismatch.detail.contains("activity entries: sent 7, the server accepted 5"))

        val skipped = Checks.syncDelivery(
            run(perType = mapOf("weight" to detail(4, 4)), response = SyncResponse("r1", measurements = SyncCounts(updated = 3, skipped = 1))),
        )
        assertStatus(CheckStatus.WARN, skipped)
        assertTrue(skipped.detail, skipped.detail.contains("measurements: the server skipped 1 of 4"))

        val noCounts = Checks.syncDelivery(run(perType = mapOf("sleep" to detail(2, 2)), response = SyncResponse("r1")))
        assertStatus(CheckStatus.WARN, noCounts)
        assertTrue(noCounts.detail.contains("sleep sessions: sent 2, the server reported no counts"))
    }

    @Test fun `sync delivery on undelivered, skipped or missing runs`() {
        assertStatus(CheckStatus.SKIP, Checks.syncDelivery(null))
        assertStatus(CheckStatus.WARN, Checks.syncDelivery(run(delivered = false, response = null, errorCode = "SERVER_REJECTED")))
        assertStatus(CheckStatus.SKIP, Checks.syncDelivery(run(status = "skipped", perType = mapOf("steps" to detail(0, 0)))))
    }

    // --- server-side settings ---------------------------------------------------------------

    @Test fun `timezone match`() {
        fun device(tz: String?) = HealthSyncDevice("d1", userTimezone = tz)
        assertStatus(CheckStatus.PASS, Checks.timezone(zone, device("America/Costa_Rica"), now))
        val mismatch = Checks.timezone(zone, device("Europe/Madrid"), now)
        assertStatus(CheckStatus.WARN, mismatch)
        assertTrue(mismatch.detail.contains("America/Costa_Rica") && mismatch.detail.contains("Europe/Madrid"))
        // Same offset today (both UTC-6): not a day-boundary problem.
        assertStatus(CheckStatus.PASS, Checks.timezone(zone, device("America/Guatemala"), now))
        assertStatus(CheckStatus.WARN, Checks.timezone(zone, device(null), now))
        assertStatus(CheckStatus.WARN, Checks.timezone(zone, device("Not/AZone"), now))
        assertStatus(CheckStatus.SKIP, Checks.timezone(zone, null, now))
    }

    private fun links(pkg: String, vararg fps: String) = """
        [{"relation":["delegate_permission/common.handle_all_urls"],
          "target":{"namespace":"android_app","package_name":"$pkg","sha256_cert_fingerprints":[${fps.joinToString(",") { "\"$it\"" }}]}},
         {"relation":["delegate_permission/common.get_login_creds"],
          "target":{"namespace":"web","site":"https://e.x"}}]
    """.trimIndent()

    @Test fun `asset links parsing`() {
        assertEquals(listOf(fp), AssetLinks.fingerprintsFor(links(BuildConfig.APPLICATION_ID, fp), BuildConfig.APPLICATION_ID))
        assertEquals(emptyList<String>(), AssetLinks.fingerprintsFor(links("com.other", fp), BuildConfig.APPLICATION_ID))
        assertEquals(emptyList<String>(), AssetLinks.fingerprintsFor("[]", BuildConfig.APPLICATION_ID))
        assertNull(AssetLinks.fingerprintsFor("{\"not\":\"a list\"}", BuildConfig.APPLICATION_ID))
        assertNull(AssetLinks.fingerprintsFor("<html>", BuildConfig.APPLICATION_ID))
    }

    @Test fun `twa verification passes on own package and fingerprint, warns with the trust remedy otherwise`() {
        fun twa(body: String) = Checks.twaVerification("https://e.x", app, Probe.Ok(ApiResult.Success(body, 200), 10))
        assertStatus(CheckStatus.PASS, twa(links(BuildConfig.APPLICATION_ID, fp.lowercase())))
        val missing = twa("[]")
        assertStatus(CheckStatus.WARN, missing)
        assertTrue(missing.remedy!!.contains("Admin → Settings → Android app → Trust"))
        assertTrue(missing.detail.contains(fp))
        assertEquals(CheckAction.OPEN_ANDROID_APP_ADMIN, missing.action)
        val otherKey = twa(links(BuildConfig.APPLICATION_ID, "AA:BB"))
        assertStatus(CheckStatus.WARN, otherKey)
        assertTrue(otherKey.detail.contains("not this build's fingerprint"))
        assertStatus(CheckStatus.WARN, twa("not json"))
        val unreachable = Checks.twaVerification(
            "https://e.x", app,
            Probe.Ok(ApiResult.Failure(ApiError(ApiError.Kind.HTTP, 404, "NOT_FOUND", "nope")), 10),
        )
        assertStatus(CheckStatus.WARN, unreachable)
        assertStatus(CheckStatus.SKIP, Checks.twaVerification(null, app, null))
    }

    @Test fun `app version and server configured`() {
        assertStatus(CheckStatus.PASS, Checks.appVersion(app))
        assertStatus(CheckStatus.WARN, Checks.appVersion(app.copy(signingSha256 = null)))
        assertStatus(CheckStatus.FAIL, Checks.serverConfigured(null))
        assertEquals(CheckAction.SET_SERVER, Checks.serverConfigured(null).action)
        assertStatus(CheckStatus.PASS, Checks.serverConfigured("https://e.x"))
    }

    @Test fun `summary text`() {
        val pass = CheckResult.of("a", "A", CheckStatus.PASS, "")
        val warn = CheckResult.of("b", "Background access", CheckStatus.WARN, "")
        val fail1 = CheckResult.of("c", "Token accepted", CheckStatus.FAIL, "")
        val fail2 = CheckResult.of("d", "D", CheckStatus.FAIL, "")
        assertEquals("All checks pass", DiagnosticSummary.of(listOf(pass, CheckResult.of("s", "S", CheckStatus.SKIP, ""))))
        assertEquals("2 fail, 1 warn: Token accepted", DiagnosticSummary.of(listOf(pass, warn, fail1, fail2)))
        assertEquals("0 fail, 1 warn: Background access", DiagnosticSummary.of(listOf(pass, warn)))
    }
}
