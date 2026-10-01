package com.evopath.android.net

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonNull
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit

class ApiClientTest {
    @Serializable
    data class Thing(val id: String, val name: String)

    @Serializable
    data class NewThing(val name: String)

    private lateinit var server: MockWebServer
    private var token: String? = "pat_secret"

    private val http = OkHttpClient.Builder().readTimeout(2, TimeUnit.SECONDS).build()

    private fun client(base: String? = server.url("/").toString()) =
        ApiClient(baseUrlProvider = { base }, tokenProvider = { token }, http = http)

    @Before fun setUp() {
        server = MockWebServer().apply { start() }
    }

    @After fun tearDown() {
        server.shutdown()
    }

    private fun failure(result: ApiResult<*>): ApiError {
        assertTrue("expected failure, got $result", result is ApiResult.Failure)
        return (result as ApiResult.Failure).error
    }

    @Test fun `unwraps the data envelope and sends the bearer token`() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"data":{"id":"1","name":"a","extra":true},"meta":{"timestamp":"x"}}"""))
        val result = client().get("/api/things/1", Thing.serializer())
        assertEquals(Thing("1", "a"), result.getOrNull())
        val request = server.takeRequest()
        assertEquals("/api/things/1", request.path)
        assertEquals("Bearer pat_secret", request.getHeader("Authorization"))
        assertEquals("application/json", request.getHeader("Accept"))
    }

    @Test fun `passes through list bodies that already have a data key`() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"data":[{"id":"1","name":"a"},{"id":"2","name":"b"}]}"""))
        val result = client().get("/api/things", ListSerializer(Thing.serializer()))
        assertEquals(listOf(Thing("1", "a"), Thing("2", "b")), result.getOrNull())
    }

    @Test fun `posts json and omits the token for unauthenticated calls`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(201).setBody("""{"data":{"id":"9","name":"n"}}"""))
        val result = client().post("/api/things", NewThing("n"), NewThing.serializer(), Thing.serializer(), authenticated = false)
        assertEquals(201, (result as ApiResult.Success).httpStatus)
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("""{"name":"n"}""", request.body.readUtf8())
        assertTrue(request.getHeader("Content-Type")!!.startsWith("application/json"))
        assertNull(request.getHeader("Authorization"))
    }

    @Test fun `no token means no authorization header`() = runBlocking {
        token = null
        server.enqueue(MockResponse().setBody("""{"data":{"id":"1","name":"a"}}"""))
        client().get("/api/things/1", Thing.serializer())
        assertNull(server.takeRequest().getHeader("Authorization"))
    }

    @Test fun `delete with 204 succeeds with null`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(204))
        val result = client().delete("/api/things/1")
        assertEquals(JsonNull, result.getOrNull())
    }

    @Test fun `parses the api error body`() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(409).setBody(
                """{"statusCode":409,"code":"CONFLICT","message":"Device is revoked","details":{"reason":"DEVICE_REVOKED"},"timestamp":"t","path":"/api/x"}""",
            ),
        )
        val error = failure(client().get("/api/x", Thing.serializer()))
        assertEquals(ApiError.Kind.HTTP, error.kind)
        assertEquals(409, error.httpStatus)
        assertEquals("CONFLICT", error.code)
        assertEquals("Device is revoked", error.message)
        assertEquals("DEVICE_REVOKED", error.reason)
        assertNull(error.oauthError)
    }

    @Test fun `401 is flagged as unauthorized`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"statusCode":401,"code":"UNAUTHORIZED","message":"Unauthorized"}"""))
        val error = failure(client().get("/api/x", Thing.serializer()))
        assertTrue(error.isUnauthorized)
        assertEquals("UNAUTHORIZED", error.code)
    }

    @Test fun `parses the rfc 8628 device token error`() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(400)
                .setBody("""{"error":"authorization_pending","error_description":"The user has not yet approved"}"""),
        )
        val error = failure(client().get("/api/auth/device/token", Thing.serializer(), authenticated = false))
        assertEquals("authorization_pending", error.oauthError)
        assertEquals("BAD_REQUEST", error.code)
        assertEquals("The user has not yet approved", error.message)
    }

    @Test fun `parses a nested error object`() {
        val error = ApiClient.parseError(403, """{"error":{"code":"FORBIDDEN","message":"Nope","details":{"reason":"AI_DISABLED"}}}""")
        assertEquals("FORBIDDEN", error.code)
        assertEquals("Nope", error.message)
        assertEquals("AI_DISABLED", error.reason)
    }

    @Test fun `non json error bodies fall back to the status`() {
        val error = ApiClient.parseError(502, "<html>Bad gateway</html>")
        assertEquals(ApiError.Kind.HTTP, error.kind)
        assertEquals("ERROR", error.code)
        assertEquals("The server returned HTTP 502.", error.message)
        assertEquals("NOT_FOUND", ApiClient.parseError(404, "").code)
    }

    @Test fun `malformed success bodies are parse errors`() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"data":{"id":1}}"""))
        val error = failure(client().get("/api/x", Thing.serializer()))
        assertEquals(ApiError.Kind.PARSE, error.kind)
        assertEquals(200, error.httpStatus)
    }

    @Test fun `network failures are reported without throwing`() = runBlocking {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
        val error = failure(client().get("/api/x", Thing.serializer()))
        assertEquals(ApiError.Kind.NETWORK, error.kind)
        assertFalse(error.message.contains("pat_secret"))
    }

    @Test fun `missing server is not configured`() = runBlocking {
        val error = failure(client(base = null).get("/api/x", Thing.serializer()))
        assertEquals(ApiError.Kind.NOT_CONFIGURED, error.kind)
    }

    @Test fun `checkLive hits the unauthenticated liveness route`() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"data":{"status":"ok"}}"""))
        assertTrue(client().checkLive() is ApiResult.Success)
        val request = server.takeRequest()
        assertEquals("/api/health/live", request.path)
        assertNull(request.getHeader("Authorization"))
    }

    @Test fun `base url with trailing slash joins cleanly`() = runBlocking {
        server.enqueue(MockResponse().setBody("ok"))
        val result = client(base = server.url("/").toString()).getText("/.well-known/assetlinks.json")
        assertEquals("ok", result.getOrNull())
        assertEquals("/.well-known/assetlinks.json", server.takeRequest().path)
    }
}
