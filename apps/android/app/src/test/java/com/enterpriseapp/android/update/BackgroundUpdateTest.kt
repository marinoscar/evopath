package com.enterpriseapp.android.update

import com.enterpriseapp.android.BuildConfig
import com.enterpriseapp.android.net.ApiError
import com.enterpriseapp.android.net.ApiResult
import com.enterpriseapp.android.sync.SyncOutcome
import com.enterpriseapp.android.sync.SyncResponse
import com.enterpriseapp.android.testing.FakeSharedPreferences
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Duration
import java.time.Instant

private val PKG = BuildConfig.APPLICATION_ID

private fun rel(code: Long, notes: String? = null) = AppRelease(
    id = "release-$code",
    packageName = PKG,
    versionName = "0.$code.0",
    versionCode = code,
    notes = notes,
)

private fun offer(code: Long, notes: String? = null) = AvailableUpdate("release-$code", "0.$code.0", code, notes, null)

class BackgroundUpdatePolicyTest {
    private val t0 = Instant.parse("2026-10-01T08:00:00Z")

    @Test fun `the background check runs at most every 6 hours`() {
        val six = UpdatePolicy.BACKGROUND_INTERVAL
        assertFalse(UpdatePolicy.checkDue(t0, t0.plus(Duration.ofHours(5).plusMinutes(59)), six))
        assertTrue(UpdatePolicy.checkDue(t0, t0.plus(Duration.ofHours(6)), six))
        assertTrue(UpdatePolicy.checkDue(null, t0, six))
    }

    @Test fun `notifies once per versionCode, newer than installed and newer than notified`() {
        assertTrue(UpdatePolicy.shouldNotify(offer(3), ownVersionCode = 2, notifiedVersionCode = null, notificationsAllowed = true))
        assertFalse(UpdatePolicy.shouldNotify(offer(3), 2, notifiedVersionCode = 3, notificationsAllowed = true))
        assertTrue(UpdatePolicy.shouldNotify(offer(4), 2, notifiedVersionCode = 3, notificationsAllowed = true))
        assertFalse(UpdatePolicy.shouldNotify(offer(2), 2, null, true))
        assertFalse(UpdatePolicy.shouldNotify(offer(1), 2, null, true))
        assertFalse(UpdatePolicy.shouldNotify(offer(3), 2, null, notificationsAllowed = false))
    }

    @Test fun `notification wording names the product and version`() {
        assertEquals("Acme 0.3.0 is available", UpdatePolicy.notificationTitle("Acme", offer(3)))
        assertEquals("Tap to download the update.", UpdatePolicy.notificationText(offer(3)))
        assertEquals(
            "Tap to download the update.\nFaster sync.",
            UpdatePolicy.notificationText(offer(3, notes = "\n  Faster sync.  \nMore details here")),
        )
        assertEquals("Tap to download the update.", UpdatePolicy.notificationText(offer(3, notes = "x".repeat(81))))
    }
}

class BackgroundUpdateCheckTest {
    private var now = Instant.parse("2026-10-01T08:00:00Z")
    private val backend = FakeReleaseBackend()
    private val store = PrefsUpdateStore(FakeSharedPreferences())
    private var paired = true
    private var allowed = true
    private var accepted = true
    private val posted = mutableListOf<Long>()
    private val completed = SyncOutcome.Completed("success", SyncResponse(runId = "r"))

    private fun background(own: Long = 2): BackgroundUpdateCheck {
        val checker = UpdateChecker(backend, store, PKG, own, isPaired = { paired }, clock = { now })
        return BackgroundUpdateCheck(checker, store, own, notificationsAllowed = { allowed }) {
            if (accepted) posted += it.versionCode
            accepted
        }
    }

    @Test fun `paired and reachable runs the check and notifies`() = runBlocking {
        backend.latestResult = ApiResult.Success(rel(3, notes = "Fixes"), 200)
        val result = background().afterSync(completed)
        assertTrue(result.outcome is UpdateCheckOutcome.Available)
        assertTrue(result.notified)
        assertEquals(1, backend.calls)
        assertEquals(listOf(3L), posted)
        assertEquals(3L, store.notifiedVersionCode)
        assertEquals(now, store.lastBackgroundCheckAt)
    }

    @Test fun `a refused payload still counts as the server being reachable`() = runBlocking {
        backend.latestResult = ApiResult.Success(rel(3), 200)
        assertTrue(background().afterSync(SyncOutcome.Failed("rejected")).notified)
    }

    @Test fun `unpaired, expired and retry-later runs skip the check`() = runBlocking {
        backend.latestResult = ApiResult.Success(rel(3), 200)
        for (outcome in listOf(SyncOutcome.Unpaired, SyncOutcome.NotPaired, SyncOutcome.PairingExpired, SyncOutcome.RetryLater("offline"))) {
            assertNull(background().afterSync(outcome).outcome)
        }
        assertEquals(0, backend.calls)
        assertTrue(posted.isEmpty())
    }

    @Test fun `not paired skips the server even after a completed run`() = runBlocking {
        paired = false
        assertEquals(UpdateCheckOutcome.NotPaired, background().afterSync(completed).outcome)
        assertEquals(0, backend.calls)
    }

    @Test fun `the same version twice notifies once, a newer one again`() = runBlocking {
        backend.latestResult = ApiResult.Success(rel(3), 200)
        background().afterSync(completed)
        now = now.plus(Duration.ofHours(7))
        assertFalse(background().afterSync(completed).notified)
        assertEquals(2, backend.calls)

        backend.latestResult = ApiResult.Success(rel(4), 200)
        now = now.plus(Duration.ofHours(7))
        assertTrue(background().afterSync(completed).notified)
        assertEquals(listOf(3L, 4L), posted)
    }

    @Test fun `asks the server at most every 6 hours`() = runBlocking {
        backend.latestResult = ApiResult.Success(rel(2), 200)
        background().afterSync(completed)
        now = now.plus(Duration.ofHours(1))
        assertEquals(UpdateCheckOutcome.Throttled, background().afterSync(completed).outcome)
        now = now.plus(Duration.ofHours(5))
        assertEquals(UpdateCheckOutcome.UpToDate, background().afterSync(completed).outcome)
        assertEquals(2, backend.calls)
    }

    @Test fun `the background window is separate from the app-open debounce`() = runBlocking {
        backend.latestResult = ApiResult.Success(rel(2), 200)
        val checker = UpdateChecker(backend, store, PKG, 2, isPaired = { paired }, clock = { now })
        checker.checkIfDue()
        assertNull(store.lastBackgroundCheckAt)
        assertEquals(UpdateCheckOutcome.UpToDate, background().afterSync(completed).outcome)
        now = now.plus(Duration.ofMinutes(10))
        assertEquals(UpdateCheckOutcome.UpToDate, checker.checkIfDue())
        assertEquals(UpdateCheckOutcome.Throttled, background().afterSync(completed).outcome)
    }

    @Test fun `the installed version is never announced`() = runBlocking {
        backend.latestResult = ApiResult.Success(rel(2), 200)
        assertFalse(background(own = 2).afterSync(completed).notified)
        assertTrue(posted.isEmpty())
    }

    @Test fun `notifications not allowed posts nothing and remembers nothing`() = runBlocking {
        allowed = false
        backend.latestResult = ApiResult.Success(rel(3), 200)
        assertFalse(background().afterSync(completed).notified)
        assertTrue(posted.isEmpty())
        assertNull(store.notifiedVersionCode)
    }

    @Test fun `a notification the system refused is retried next time`() = runBlocking {
        accepted = false
        backend.latestResult = ApiResult.Success(rel(3), 200)
        assertFalse(background().afterSync(completed).notified)
        assertNull(store.notifiedVersionCode)
    }

    @Test fun `a network failure leaves the background window open`() = runBlocking {
        backend.latestResult = ApiResult.Failure(ApiError(ApiError.Kind.NETWORK, message = "offline"))
        assertTrue(background().afterSync(completed).outcome is UpdateCheckOutcome.Failed)
        assertNull(store.lastBackgroundCheckAt)
        assertTrue(posted.isEmpty())
    }

    @Test fun `installing the announced version forgets it and reopens the window`() = runBlocking {
        backend.latestResult = ApiResult.Success(rel(3), 200)
        background(own = 2).afterSync(completed)
        assertEquals(3L, store.notifiedVersionCode)

        UpdateChecker(backend, store, PKG, 3, isPaired = { paired }, clock = { now }).onLaunch()
        assertNull(store.notifiedVersionCode)
        assertNull(store.lastBackgroundCheckAt)
        assertNull(store.available)
    }

    @Test fun `the store round-trips the background state`() {
        store.lastBackgroundCheckAt = Instant.ofEpochMilli(5_000)
        store.notifiedVersionCode = 7
        assertEquals(Instant.ofEpochMilli(5_000), store.lastBackgroundCheckAt)
        assertEquals(7L, store.notifiedVersionCode)
        store.notifiedVersionCode = null
        assertNull(store.notifiedVersionCode)
    }
}
