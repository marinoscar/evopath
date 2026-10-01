package com.enterpriseapp.android.pairing

import com.enterpriseapp.android.net.ApiClient
import com.enterpriseapp.android.net.ApiError
import com.enterpriseapp.android.net.ApiResult
import com.enterpriseapp.android.util.Brand
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class DeviceFlowPollerTest {
    private val grant = DeviceCodeGrant(
        deviceCode = "dev-code",
        userCode = "ABCD-1234",
        verificationUri = "https://app.test/activate",
        verificationUriComplete = "https://app.test/activate?code=ABCD-1234",
        expiresIn = 900,
        interval = 5,
    )
    private val pat = DeviceCredential(
        accessToken = "pat_abc",
        expiresIn = 7_776_000,
        credentialType = "pat",
        expiresAt = "2026-12-30T12:00:00.000Z",
        tokenId = "t1",
    )

    /** Scripted transport plus a virtual clock advanced by the poller's sleeps. */
    private class Script(vararg results: ApiResult<DeviceCredential>) : DeviceFlowTransport {
        val queue = ArrayDeque(results.toList())
        var polls = 0
        override suspend fun requestCode(clientInfo: DeviceClientInfo): ApiResult<DeviceCodeGrant> = error("unused")
        override suspend fun pollToken(deviceCode: String): ApiResult<DeviceCredential> {
            polls++
            return queue.removeFirstOrNull() ?: oauth("authorization_pending")
        }
    }

    private var now = 0L
    private val sleeps = mutableListOf<Long>()
    private fun poller(transport: DeviceFlowTransport) =
        DeviceFlowPoller(transport, sleep = { sleeps += it; now += it }, nowMillis = { now })

    @Test fun `pending then slow_down then success`() = runBlocking {
        val script = Script(oauth("authorization_pending"), oauth("slow_down"), ApiResult.Success(pat, 200))
        val progress = mutableListOf<PollProgress>()
        val result = poller(script).poll(grant) { progress += it }
        assertEquals(PollResult.Approved(pat), result)
        assertEquals(3, script.polls)
        // 5 s after pending, then 10 s after slow_down; every sleep padded by 250 ms.
        assertEquals(listOf(5_250L, 10_250L), sleeps)
        assertTrue(progress.contains(PollProgress.SlowedDown(10)))
    }

    @Test fun `expired_token and access_denied end the flow`() = runBlocking {
        assertEquals(PollResult.Expired, poller(Script(oauth("expired_token"))).poll(grant))
        assertEquals(PollResult.Denied, poller(Script(oauth("authorization_pending"), oauth("access_denied"))).poll(grant))
    }

    @Test fun `invalid_grant fails`() = runBlocking {
        val result = poller(Script(oauth("invalid_grant", status = 401))).poll(grant)
        assertTrue(result is PollResult.Failed)
    }

    @Test fun `the local deadline expires a code that stays pending`() = runBlocking {
        val script = Script()
        val result = poller(script).poll(grant.copy(expiresIn = 12))
        assertEquals(PollResult.Expired, result)
        // Polls at 0, 5.25 and 10.5 s; the last sleep is cut to the deadline.
        assertEquals(3, script.polls)
        assertEquals(12_000L, sleeps.sum())
    }

    @Test fun `network errors and 5xx keep polling`() = runBlocking {
        val network = ApiResult.Failure(ApiError(ApiError.Kind.NETWORK, message = "reset"))
        val server = ApiResult.Failure(ApiError(ApiError.Kind.HTTP, 503, "ERROR", "down"))
        val progress = mutableListOf<PollProgress>()
        val result = poller(Script(network, server, ApiResult.Success(pat, 200))).poll(grant) { progress += it }
        assertEquals(PollResult.Approved(pat), result)
        assertEquals(2, progress.count { it is PollProgress.NetworkTrouble })
    }

    @Test fun `slow_down is capped at 60 seconds and a zero interval is clamped`() = runBlocking {
        val many = Array<ApiResult<DeviceCredential>>(20) { oauth("slow_down") }
        poller(Script(oauth("authorization_pending"), *many, ApiResult.Success(pat, 200)))
            .poll(grant.copy(expiresIn = 3600, interval = 0))
        assertEquals(1_250L, sleeps.first())
        assertEquals(60_250L, sleeps.last())
    }

    @Test fun `a session credential is refused`() = runBlocking {
        val session = DeviceCredential(accessToken = "eyJ...", credentialType = "session")
        assertTrue(poller(Script(ApiResult.Success(session, 200))).poll(grant) is PollResult.Failed)
    }

    @Test fun `expiry comes from expiresAt, else from expiresIn`() {
        val now = Instant.parse("2026-10-01T00:00:00Z")
        assertEquals(Instant.parse("2026-12-30T12:00:00Z"), pat.expiryInstant(now))
        assertEquals(now.plusSeconds(60), pat.copy(expiresAt = null, expiresIn = 60).expiryInstant(now))
        assertNull(pat.copy(expiresAt = null, expiresIn = null).expiryInstant(now))
    }

    @Test fun `transport parses RFC 8628 errors and the PAT envelope over HTTP`() = runBlocking {
        val server = MockWebServer().apply { start() }
        try {
            server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"authorization_pending","error_description":"wait"}"""))
            server.enqueue(
                MockResponse().setBody(
                    """{"data":{"accessToken":"pat_x","tokenType":"Bearer","expiresIn":100,"credentialType":"pat",""" +
                        """"expiresAt":"2026-12-30T12:00:00.000Z","tokenId":"t","tokenName":"Device: P"},"meta":{}}""",
                ),
            )
            val api = ApiClient(baseUrlProvider = { server.url("/").toString() }, tokenProvider = { "pat_old" })
            val transport = ApiDeviceFlowTransport(api)
            val result = DeviceFlowPoller(transport, sleep = {}).poll(grant)
            assertEquals("pat_x", (result as PollResult.Approved).credential.accessToken)
            val first = server.takeRequest()
            assertEquals("/api/auth/device/token", first.path)
            assertEquals("""{"deviceCode":"dev-code"}""", first.body.readUtf8())
            assertNull("device-flow calls are unauthenticated", first.getHeader("Authorization"))
        } finally {
            server.shutdown()
        }
    }

    @Test fun `code request asks for a PAT with the phone's name`() = runBlocking {
        val server = MockWebServer().apply { start() }
        try {
            server.enqueue(
                MockResponse().setBody(
                    """{"data":{"deviceCode":"d","userCode":"ABCD-1234","verificationUri":"https://e/activate",""" +
                        """"verificationUriComplete":"https://e/activate?code=ABCD-1234","expiresIn":900,"interval":5}}""",
                ),
            )
            val api = ApiClient(baseUrlProvider = { server.url("/").toString() })
            val info = DeviceClientInfo(DeviceInfo.deviceName("samsung", "SM-S918B"), DeviceInfo.userAgent("0.1.0"))
            val grant = (ApiDeviceFlowTransport(api).requestCode(info) as ApiResult.Success).value
            assertEquals("ABCD-1234", grant.userCode)
            assertEquals(
                """{"clientInfo":{"deviceName":"Samsung SM-S918B · Health sync","userAgent":"${Brand.compactName}-Android/0.1.0","tokenType":"pat"}}""",
                server.takeRequest().body.readUtf8(),
            )
        } finally {
            server.shutdown()
        }
    }

    @Test fun `device names do not repeat the manufacturer`() {
        assertEquals("Google Pixel 8 · Health sync", DeviceInfo.deviceName("Google", "Pixel 8"))
        assertEquals("OnePlus CPH2581 · Health sync", DeviceInfo.deviceName("OnePlus", "CPH2581"))
        assertEquals("motorola edge · Health sync", DeviceInfo.deviceName("motorola", "motorola edge"))
        assertEquals("Android phone · Health sync", DeviceInfo.deviceName(null, null))
        assertTrue(DeviceInfo.deviceName("X".repeat(80), "Y".repeat(80)).length <= 100)
    }

    private companion object {
        fun oauth(error: String, status: Int = 400): ApiResult.Failure =
            ApiResult.Failure(ApiError(ApiError.Kind.HTTP, status, "BAD_REQUEST", "x", oauthError = error))
    }
}
