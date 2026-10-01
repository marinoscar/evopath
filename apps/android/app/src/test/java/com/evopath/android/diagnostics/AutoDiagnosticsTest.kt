package com.evopath.android.diagnostics

import com.evopath.android.auth.SharedPrefsTokenStore
import com.evopath.android.net.ApiResult
import com.evopath.android.net.HealthSyncDevice
import com.evopath.android.sync.PrefsSyncHistoryStore
import com.evopath.android.sync.PrefsSyncStateStore
import com.evopath.android.sync.RunStatus
import com.evopath.android.sync.SyncOutcome
import com.evopath.android.sync.SyncResponse
import com.evopath.android.testing.FakeBackend
import com.evopath.android.testing.FakeHealthConnect
import com.evopath.android.testing.FakeSharedPreferences
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

class AutoDiagnosticsTest {
    private val start = Instant.parse("2026-10-01T18:00:00Z")
    private var now = start
    private lateinit var backend: FakeBackend
    private lateinit var server: FakeServerProbe
    private lateinit var tokens: SharedPrefsTokenStore
    private lateinit var state: PrefsSyncStateStore
    private lateinit var auto: AutoDiagnostics

    private val failed = SyncOutcome.Completed(RunStatus.FAILED, SyncResponse("r"))
    private val partial = SyncOutcome.Completed(RunStatus.PARTIAL, SyncResponse("r"))

    @Before fun setUp() {
        now = start
        backend = FakeBackend().apply { deviceResult = ApiResult.Success(HealthSyncDevice("dev-1"), 200) }
        server = FakeServerProbe()
        tokens = SharedPrefsTokenStore(FakeSharedPreferences()).apply {
            setToken("pat_0123456789abcdef", Instant.parse("2026-12-30T00:00:00Z"))
            setDeviceId("dev-1")
        }
        state = PrefsSyncStateStore(FakeSharedPreferences())
        val history = PrefsSyncHistoryStore(FakeSharedPreferences())
        val service = DiagnosticsService(
            selfTest = {
                SelfTest(
                    FakePlatform(), { "https://e.x" }, server, backend, FakeHealthConnect(), { it }, tokens, state, history,
                    clock = { now }, zone = { ZoneId.of("UTC") },
                )
            },
            backend = backend,
            tokens = tokens,
            state = state,
            history = history,
            log = { emptyList() },
        )
        auto = AutoDiagnostics(tokens, state, server, service, clock = { now })
    }

    private fun after(outcome: SyncOutcome) = runBlocking { auto.afterRun(outcome) }

    @Test fun `only failed or partial runs need a report`() {
        assertTrue(AutoDiagnostics.needsReport(failed))
        assertTrue(AutoDiagnostics.needsReport(partial))
        assertTrue(AutoDiagnostics.needsReport(SyncOutcome.Failed("x")))
        assertTrue(AutoDiagnostics.needsReport(SyncOutcome.RetryLater("x")))
        assertFalse(AutoDiagnostics.needsReport(SyncOutcome.Completed(RunStatus.OK, SyncResponse("r"))))
        assertFalse(AutoDiagnostics.needsReport(SyncOutcome.Completed(RunStatus.SKIPPED, SyncResponse("r"))))
        assertFalse(AutoDiagnostics.needsReport(SyncOutcome.PairingExpired))
        assertFalse(AutoDiagnostics.needsReport(SyncOutcome.Unpaired))
        assertFalse(AutoDiagnostics.needsReport(SyncOutcome.NotPaired))
        assertEquals(AutoDiagnostics.Result.NOT_NEEDED, after(SyncOutcome.Completed(RunStatus.OK, SyncResponse("r"))))
        assertTrue(backend.uploads.isEmpty())
    }

    @Test fun `uploads at most once per 6 hours`() {
        assertEquals(AutoDiagnostics.Result.UPLOADED, after(failed))
        assertEquals(1, backend.uploads.size)
        val upload = backend.uploads.single()
        assertTrue(upload.summary!!.isNotBlank())
        assertFalse(upload.report.toString().contains("0123456789abcdef"))

        now = start.plusSeconds(5 * 3600 + 3599)
        assertEquals(AutoDiagnostics.Result.THROTTLED, after(partial))
        assertEquals(1, backend.uploads.size)

        now = start.plusSeconds(6 * 3600)
        assertEquals(AutoDiagnostics.Result.UPLOADED, after(partial))
        assertEquals(2, backend.uploads.size)
    }

    @Test fun `a failed upload attempt still counts against the throttle`() {
        backend.uploadResult = FakeBackend.httpError(500)
        assertEquals(AutoDiagnostics.Result.UPLOAD_FAILED, after(failed))
        now = start.plusSeconds(3600)
        assertEquals(AutoDiagnostics.Result.THROTTLED, after(failed))
    }

    @Test fun `skips when the server is unreachable without spending the throttle`() {
        server.liveResult = FakeBackend.networkError()
        assertEquals(AutoDiagnostics.Result.UNREACHABLE, after(failed))
        assertTrue(backend.uploads.isEmpty())
        server.liveResult = ApiResult.Success(kotlinx.serialization.json.JsonNull, 200)
        assertEquals(AutoDiagnostics.Result.UPLOADED, after(failed))
    }

    @Test fun `skips when the pairing is not valid`() {
        state.pairingExpired = true
        assertEquals(AutoDiagnostics.Result.NOT_PAIRED, after(failed))
        state.pairingExpired = false
        tokens.clear()
        assertEquals(AutoDiagnostics.Result.NOT_PAIRED, after(failed))
        assertEquals(0, server.liveCalls)
    }

    @Test fun `due tolerates a clock moved backwards`() {
        assertTrue(AutoDiagnostics.due(null, start))
        assertFalse(AutoDiagnostics.due(start.minusSeconds(60), start))
        assertTrue(AutoDiagnostics.due(start.plusSeconds(60), start))
    }
}
