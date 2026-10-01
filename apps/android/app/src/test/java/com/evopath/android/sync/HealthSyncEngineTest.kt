package com.evopath.android.sync

import androidx.health.connect.client.records.ExerciseSessionRecord
import com.evopath.android.auth.SharedPrefsTokenStore
import com.evopath.android.healthconnect.DailyAggregate
import com.evopath.android.healthconnect.HcAvailability
import com.evopath.android.healthconnect.HcDataType
import com.evopath.android.healthconnect.HcExerciseSession
import com.evopath.android.healthconnect.HcSample
import com.evopath.android.healthconnect.HcSleepSession
import com.evopath.android.healthconnect.HealthPermissions
import com.evopath.android.healthconnect.SyncToggle
import com.evopath.android.net.ApiResult
import com.evopath.android.testing.FakeBackend
import com.evopath.android.testing.FakeHealthConnect
import com.evopath.android.testing.FakeSharedPreferences
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

class HealthSyncEngineTest {
    private val zone = ZoneId.of("America/Costa_Rica")
    private val now = Instant.parse("2026-10-01T18:00:00Z") // noon local
    private val today = LocalDate.parse("2026-10-01")

    private lateinit var gateway: FakeHealthConnect
    private lateinit var backend: FakeBackend
    private lateinit var tokens: SharedPrefsTokenStore
    private lateinit var state: PrefsSyncStateStore
    private lateinit var history: PrefsSyncHistoryStore
    private var notified = 0

    @Before fun setUp() {
        gateway = FakeHealthConnect().apply {
            steps = listOf(DailyAggregate(today, 4321.0, setOf("com.sec.android.app.shealth")))
            sessions = listOf(
                HcExerciseSession("ex1", ExerciseSessionRecord.EXERCISE_TYPE_WALKING, now.minusSeconds(7200), now.minusSeconds(5400), null, "com.sec.android.app.shealth"),
                HcExerciseSession("ex2", ExerciseSessionRecord.EXERCISE_TYPE_YOGA, now.minusSeconds(4000), now.minusSeconds(3000), null, "com.sec.android.app.shealth"),
            )
            distance = 2500.0
            weight = listOf(HcSample("w1", now.minusSeconds(3600), 80.0, "com.withings.wiscale2"))
            sleep = listOf(HcSleepSession("s1", now.minusSeconds(14 * 3600), now.minusSeconds(6 * 3600), emptyList(), "com.ouraring.oura"))
        }
        backend = FakeBackend()
        tokens = SharedPrefsTokenStore(FakeSharedPreferences()).apply {
            setToken("pat_secret", Instant.parse("2026-12-30T00:00:00Z"))
            setDeviceId("dev-1")
        }
        state = PrefsSyncStateStore(FakeSharedPreferences())
        history = PrefsSyncHistoryStore(FakeSharedPreferences())
        notified = 0
    }

    private fun engine() = HealthSyncEngine(
        gateway = gateway,
        backend = backend,
        tokens = tokens,
        state = state,
        history = history,
        labels = { it },
        notifier = { notified++ },
        clock = { now },
        zone = { zone },
    )

    private fun run(trigger: SyncTrigger = SyncTrigger.PERIODIC) = runBlocking { engine().run(trigger) }

    @Test fun `a full sync posts every enabled type, records the run and switches to 7-day windows`() {
        val outcome = run(SyncTrigger.INITIAL)
        assertTrue(outcome is SyncOutcome.Completed)
        val request = backend.syncRequests.single()
        assertEquals("initial", request.run.trigger)
        assertEquals(RunStatus.OK, request.run.status)
        assertEquals(SyncWindowDto("2026-09-02", "2026-10-01"), request.window) // first sync: 30 days
        assertEquals(listOf("steps:2026-10-01", "ex1"), request.entries.map { it.externalId })
        assertEquals(2500.0, request.entries[1].distanceMeters!!, 0.0)
        assertEquals(listOf("w1"), request.measurements!!.map { it.externalId })
        assertEquals(listOf("s1"), request.sleepSessions!!.map { it.externalId })
        val synced = request.run.details!!.syncedTypes
        assertEquals(
            listOf("steps", "exercise", "heart_rate", "resting_heart_rate", "hrv", "weight", "body_fat", "blood_pressure", "sleep"),
            synced,
        )
        assertEquals("America/Costa_Rica", request.run.timezone)
        assertEquals(1, request.run.details!!.perType.getValue("exercise").dropped) // yoga

        assertEquals(now, state.lastSuccessfulSyncAt)
        val local = history.runs().single()
        assertTrue(local.delivered)
        assertEquals("run-1", local.response!!.runId)

        run()
        assertEquals(SyncWindowDto("2026-09-25", "2026-10-01"), backend.syncRequests[1].window)
    }

    @Test fun `switched-off or unpermitted types are not read and not reconciled`() {
        state.setEnabled(SyncToggle.SLEEP, false)
        gateway.granted = HealthPermissions.ALL_DATA.toSet() - HealthPermissions.READ_WEIGHT
        run()
        assertFalse(HcDataType.SLEEP in gateway.reads)
        assertFalse(HcDataType.WEIGHT in gateway.reads)
        val request = backend.syncRequests.single()
        val synced = request.run.details!!.syncedTypes
        assertFalse("sleep" in synced)
        assertFalse("weight" in synced)
        assertNull(request.sleepSessions)
        assertEquals("denied", request.run.details!!.perType.getValue("weight").permission)
        assertEquals(false, request.run.details!!.perType.getValue("sleep").enabled)
        assertEquals(RunStatus.OK, request.run.status)
    }

    @Test fun `a Health Connect failure on one type makes the run partial`() {
        gateway.failures[HcDataType.SLEEP] = SecurityException("background read not allowed")
        val outcome = run()
        assertEquals(RunStatus.PARTIAL, (outcome as SyncOutcome.Completed).status)
        val request = backend.syncRequests.single()
        assertFalse("sleep" in request.run.details!!.syncedTypes)
        assertTrue("steps" in request.run.details!!.syncedTypes)
        assertTrue(request.run.details!!.perType.getValue("sleep").error!!.startsWith("SecurityException"))
        assertNotNull(state.lastSuccessfulSyncAt)
    }

    @Test fun `a distance failure keeps exercise synced without distance`() {
        gateway.failures[HcDataType.DISTANCE] = IllegalStateException("rate limited")
        run()
        val request = backend.syncRequests.single()
        assertTrue("exercise" in request.run.details!!.syncedTypes)
        assertNull(request.entries.first { it.externalId == "ex1" }.distanceMeters)
        assertNotNull(request.run.details!!.perType.getValue("distance").error)
    }

    @Test fun `401 marks the pairing expired, notifies, and later runs do nothing`() {
        backend.syncResults += FakeBackend.httpError(401)
        assertEquals(SyncOutcome.PairingExpired, run())
        assertTrue(state.pairingExpired)
        assertEquals(1, notified)
        assertFalse(history.runs().single().delivered)
        assertEquals("UNAUTHORIZED", history.runs().single().errorCode)

        assertEquals(SyncOutcome.PairingExpired, run())
        assertEquals(1, backend.syncRequests.size)
        assertNull(state.lastSuccessfulSyncAt)
    }

    @Test fun `409 DEVICE_REVOKED forgets the pairing`() {
        backend.syncResults += FakeBackend.httpError(409, reason = "DEVICE_REVOKED")
        assertEquals(SyncOutcome.Unpaired, run())
        assertFalse(tokens.isPaired)
        assertNull(tokens.deviceId)
        assertEquals(SyncOutcome.NotPaired, run())
    }

    @Test fun `network failure is retried later and kept in local history`() {
        backend.syncResults += FakeBackend.networkError()
        val outcome = run()
        assertTrue(outcome is SyncOutcome.RetryLater)
        assertNull(state.lastSuccessfulSyncAt)
        val local = history.runs().single()
        assertFalse(local.delivered)
        assertEquals(RunStatus.FAILED, local.status)
        assertEquals("NETWORK", local.errorCode)
        assertTrue(tokens.isPaired)
    }

    @Test fun `5xx is retried later`() {
        backend.syncResults += FakeBackend.httpError(503)
        assertTrue(run() is SyncOutcome.RetryLater)
    }

    @Test fun `403 without health_data write resends activity only, once`() {
        backend.syncResults += FakeBackend.httpError(403, reason = "HEALTH_DATA_SCOPE_REQUIRED")
        val outcome = run()
        assertTrue(outcome is SyncOutcome.Completed)
        assertEquals(2, backend.syncRequests.size)
        val retry = backend.syncRequests[1]
        assertNull(retry.measurements)
        assertNull(retry.sleepSessions)
        assertEquals(2, retry.entries.size)
        assertEquals(RunStatus.PARTIAL, retry.run.status)
        assertEquals(listOf("steps", "exercise"), retry.run.details!!.syncedTypes)
        assertEquals("forbidden", retry.run.details!!.perType.getValue("weight").error)
        assertEquals("forbidden", retry.run.details!!.perType.getValue("sleep").error)
    }

    @Test fun `a refused payload is recorded and reported to the server without data`() {
        backend.syncResults += FakeBackend.httpError(400, reason = "ENTRY_DATE_OUT_OF_RANGE")
        val outcome = run()
        assertTrue(outcome is SyncOutcome.Failed)
        assertEquals(2, backend.syncRequests.size)
        val report = backend.syncRequests[1]
        assertEquals(RunStatus.FAILED, report.run.status)
        assertEquals("SERVER_REJECTED:ENTRY_DATE_OUT_OF_RANGE", report.run.errorCode)
        assertNull(report.window)
        assertTrue(report.entries.isEmpty())
        assertNull(report.measurements)
        assertTrue(report.run.details!!.syncedTypes.isEmpty())
    }

    @Test fun `Health Connect unavailable is reported as a failed run`() {
        gateway.availability = HcAvailability.UPDATE_REQUIRED
        val outcome = run()
        assertTrue(outcome is SyncOutcome.Failed)
        val request = backend.syncRequests.single()
        assertEquals(RunStatus.FAILED, request.run.status)
        assertEquals("HC_UPDATE_REQUIRED", request.run.errorCode)
        assertTrue(request.entries.isEmpty())
        assertTrue(gateway.reads.isEmpty())
    }

    @Test fun `a broken permission call is reported as a failed run`() {
        gateway.grantedError = java.io.IOException("binder died")
        assertTrue(run() is SyncOutcome.Failed)
        assertEquals("HC_ERROR", backend.syncRequests.single().run.errorCode)
    }

    @Test fun `no permission at all is reported as skipped`() {
        gateway.granted = emptySet()
        val outcome = run()
        assertEquals(RunStatus.SKIPPED, (outcome as SyncOutcome.Completed).status)
        assertNull("a skipped run is not a success", state.lastSuccessfulSyncAt)
    }

    @Test fun `not paired does nothing`() {
        tokens.clear()
        assertEquals(SyncOutcome.NotPaired, run())
        assertTrue(backend.syncRequests.isEmpty())
        assertTrue(gateway.reads.isEmpty())
    }

    @Test fun `local history keeps the newest 20 runs`() {
        repeat(25) { run() }
        assertEquals(PrefsSyncHistoryStore.MAX_RUNS, history.runs().size)
        assertEquals("run-25", history.runs().first().response!!.runId)
    }

    @Test fun `isUnpaired and isTransient classify API errors`() {
        fun err(r: ApiResult.Failure) = r.error
        assertTrue(HealthSyncEngine.isUnpaired(err(FakeBackend.httpError(409, "DEVICE_REVOKED"))))
        assertTrue(HealthSyncEngine.isUnpaired(err(FakeBackend.httpError(404))))
        assertFalse(HealthSyncEngine.isUnpaired(err(FakeBackend.httpError(409, "OTHER"))))
        assertTrue(HealthSyncEngine.isTransient(err(FakeBackend.networkError())))
        assertTrue(HealthSyncEngine.isTransient(err(FakeBackend.httpError(500))))
        assertTrue(HealthSyncEngine.isTransient(err(FakeBackend.httpError(429))))
        assertFalse(HealthSyncEngine.isTransient(err(FakeBackend.httpError(400))))
    }
}
