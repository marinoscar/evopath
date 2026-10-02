package com.enterpriseapp.android.update

import com.enterpriseapp.android.BuildConfig
import com.enterpriseapp.android.net.ApiClient
import com.enterpriseapp.android.net.ApiError
import com.enterpriseapp.android.net.ApiResult
import com.enterpriseapp.android.testing.FakeSharedPreferences
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Duration
import java.time.Instant

private val PACKAGE = BuildConfig.APPLICATION_ID

private fun release(code: Long, name: String = "0.$code.0", pkg: String = PACKAGE) = AppRelease(
    id = "11111111-2222-3333-4444-55555555555$code".take(36),
    packageName = pkg,
    versionName = name,
    versionCode = code,
    sizeBytes = 12_345_678,
    notes = "Fixes",
)

class UpdatePolicyTest {
    private val t0 = Instant.parse("2026-10-01T08:00:00Z")

    @Test fun `a higher versionCode for this package is an update`() {
        assertTrue(UpdatePolicy.isUpdate(release(2), PACKAGE, 1))
        assertFalse(UpdatePolicy.isUpdate(release(1), PACKAGE, 1))
        assertFalse(UpdatePolicy.isUpdate(release(1), PACKAGE, 2))
    }

    @Test fun `a release for another package is never an update`() =
        assertFalse(UpdatePolicy.isUpdate(release(9, pkg = "com.other.android"), PACKAGE, 1))

    @Test fun `versionCode compares numerically, not by name`() =
        assertTrue(UpdatePolicy.isUpdate(release(10, name = "0.9.0"), PACKAGE, 9))

    @Test fun `check is due when never checked`() = assertTrue(UpdatePolicy.checkDue(null, t0))

    @Test fun `an app-open check is debounced for 5 minutes only`() {
        assertFalse(UpdatePolicy.checkDue(t0, t0.plus(Duration.ofMinutes(4).plusSeconds(59))))
        assertTrue(UpdatePolicy.checkDue(t0, t0.plus(Duration.ofMinutes(5))))
        assertTrue(UpdatePolicy.checkDue(t0, t0.plus(Duration.ofHours(1))))
    }

    @Test fun `check is due when the clock moved backwards`() =
        assertTrue(UpdatePolicy.checkDue(t0, t0.minus(Duration.ofMinutes(1))))

    @Test fun `a relative download link resolves against the server`() =
        assertEquals(
            "https://app.example.com/api/android-app/download/abc.def",
            UpdatePolicy.downloadUrl("https://app.example.com", "/api/android-app/download/abc.def"),
        )

    @Test fun `a download link keeps the server's port`() =
        assertEquals(
            "https://app.example.com:8443/api/android-app/download/t",
            UpdatePolicy.downloadUrl("https://app.example.com:8443/", "/api/android-app/download/t"),
        )

    @Test fun `an absolute same-origin download link is accepted`() =
        assertEquals(
            "https://app.example.com/api/android-app/download/t",
            UpdatePolicy.downloadUrl("https://app.example.com", "https://app.example.com/api/android-app/download/t"),
        )

    @Test fun `a download link to another origin is refused`() {
        assertNull(UpdatePolicy.downloadUrl("https://app.example.com", "https://evil.example.net/x.apk"))
        assertNull(UpdatePolicy.downloadUrl("https://app.example.com", "//evil.example.net/x.apk"))
        assertNull(UpdatePolicy.downloadUrl("https://app.example.com", "http://app.example.com/x.apk"))
        assertNull(UpdatePolicy.downloadUrl("https://app.example.com", "javascript:alert(1)"))
    }

    @Test fun `no release is a 404 with reason NO_RELEASE`() {
        assertTrue(UpdatePolicy.isNoRelease(ApiError(ApiError.Kind.HTTP, 404, message = "x", reason = "NO_RELEASE")))
        assertFalse(UpdatePolicy.isNoRelease(ApiError(ApiError.Kind.HTTP, 404, message = "x", reason = "OTHER")))
        assertFalse(UpdatePolicy.isNoRelease(ApiError(ApiError.Kind.HTTP, 500, message = "x")))
    }

    @Test fun `size is shown in MB`() {
        assertEquals("12.3 MB", UpdatePolicy.formatSize(12_345_678))
        assertNull(UpdatePolicy.formatSize(null))
    }
}

class FakeReleaseBackend : ReleaseBackend {
    var latestResult: ApiResult<AppRelease> = ApiResult.Failure(ApiError(ApiError.Kind.HTTP, 404, message = "none", reason = "NO_RELEASE"))
    var calls = 0

    override suspend fun latest(): ApiResult<AppRelease> {
        calls++
        return latestResult
    }

    override suspend fun downloadLink(releaseId: String): ApiResult<DownloadLink> =
        ApiResult.Success(DownloadLink("/api/android-app/download/t"), 200)
}

class UpdateCheckerTest {
    private var now = Instant.parse("2026-10-01T08:00:00Z")
    private val backend = FakeReleaseBackend()
    private val store = PrefsUpdateStore(FakeSharedPreferences())
    private var paired = true

    private fun checker(own: Long = 1) = UpdateChecker(backend, store, PACKAGE, own, isPaired = { paired }, clock = { now })

    @Test fun `stores a newer release`() = runBlocking {
        backend.latestResult = ApiResult.Success(release(2), 200)
        val outcome = checker().checkIfDue()
        assertTrue(outcome is UpdateCheckOutcome.Available)
        assertEquals(2L, checker().available?.versionCode)
        assertEquals("Fixes", store.available?.notes)
        assertEquals(2L, store.latestVersionCode)
        assertEquals(now, store.lastCheckAt)
    }

    @Test fun `same version is up to date`() = runBlocking {
        backend.latestResult = ApiResult.Success(release(1), 200)
        assertEquals(UpdateCheckOutcome.UpToDate, checker().checkIfDue())
        assertNull(store.available)
        assertEquals(1L, store.latestVersionCode)
    }

    @Test fun `skips the server when not paired`() = runBlocking {
        paired = false
        assertEquals(UpdateCheckOutcome.NotPaired, checker().checkIfDue())
        assertEquals(0, backend.calls)
    }

    @Test fun `asks on every cold start after the 5-minute debounce`() = runBlocking {
        backend.latestResult = ApiResult.Success(release(1), 200)
        val c = checker()
        c.checkIfDue()
        now = now.plus(Duration.ofMinutes(2))
        assertEquals(UpdateCheckOutcome.Throttled, c.checkIfDue())
        now = now.plus(Duration.ofMinutes(3))
        assertEquals(UpdateCheckOutcome.UpToDate, c.checkIfDue())
        now = now.plus(Duration.ofMinutes(10))
        assertEquals(UpdateCheckOutcome.UpToDate, c.checkIfDue())
        assertEquals(3, backend.calls)
    }

    @Test fun `no release clears a stale offer and throttles`() = runBlocking {
        backend.latestResult = ApiResult.Success(release(3), 200)
        checker().checkIfDue()
        backend.latestResult = ApiResult.Failure(ApiError(ApiError.Kind.HTTP, 404, message = "none", reason = "NO_RELEASE"))
        assertEquals(UpdateCheckOutcome.NoRelease, checker().check())
        assertNull(store.available)
        assertNull(store.latestVersionCode)
    }

    @Test fun `a network failure keeps the debounce open for the next open`() = runBlocking {
        backend.latestResult = ApiResult.Failure(ApiError(ApiError.Kind.NETWORK, message = "offline"))
        assertTrue(checker().checkIfDue() is UpdateCheckOutcome.Failed)
        assertNull(store.lastCheckAt)
        assertTrue(UpdatePolicy.checkDue(store.lastCheckAt, now))
    }

    @Test fun `first launch after an update clears the offer`() = runBlocking {
        backend.latestResult = ApiResult.Success(release(2), 200)
        checker(own = 1).checkIfDue()
        assertEquals(2L, store.available?.versionCode)

        val updated = checker(own = 2)
        updated.onLaunch()
        assertNull(store.available)
        assertNull(store.lastCheckAt)
        assertEquals(2L, store.lastSeenVersionCode)
        assertNull(updated.available)
    }

    @Test fun `an offer that is not newer than the installed build is hidden`() {
        store.lastSeenVersionCode = 5
        store.available = AvailableUpdate("r", "0.4.0", 4, null, null)
        val c = checker(own = 5)
        assertNull(c.available)
        c.onLaunch()
        assertNull(store.available)
    }
}

class PrefsUpdateStoreTest {
    @Test fun `round-trips the offered update`() {
        val store = PrefsUpdateStore(FakeSharedPreferences())
        val update = AvailableUpdate("r1", "0.2.0", 2, "notes", 100)
        store.available = update
        store.lastCheckAt = Instant.ofEpochMilli(1_000)
        assertEquals(update, store.available)
        assertEquals(Instant.ofEpochMilli(1_000), store.lastCheckAt)
        store.available = null
        assertNull(store.available)
    }
}

class AndroidReleaseApiTest {
    @Test fun `reads the latest release and posts for a download link`() = runBlocking {
        val server = MockWebServer()
        server.enqueue(
            MockResponse().setBody(
                """{"data":{"id":"r-1","packageName":"$PACKAGE","versionName":"0.2.0","versionCode":2,""" +
                    """"fileSha256":"ab","sizeBytes":10,"notes":null,"createdAt":"2026-10-01T00:00:00Z"}}""",
            ),
        )
        server.enqueue(MockResponse().setBody("""{"data":{"url":"/api/android-app/download/tok","expiresAt":"2026-10-01T00:10:00Z"}}"""))
        server.start()
        try {
            val api = AndroidReleaseApi(ApiClient(baseUrlProvider = { server.url("/").toString() }, tokenProvider = { "pat_x" }))
            val latest = (api.latest() as ApiResult.Success).value
            assertEquals(2L, latest.versionCode)
            assertEquals("/api/android-app/releases/latest", server.takeRequest().path)
            val link = (api.downloadLink(latest.id) as ApiResult.Success).value
            assertEquals("/api/android-app/download/tok", link.url)
            val post = server.takeRequest()
            assertEquals("POST", post.method)
            assertEquals("/api/android-app/releases/r-1/download-link", post.path)
        } finally {
            server.shutdown()
        }
    }
}
