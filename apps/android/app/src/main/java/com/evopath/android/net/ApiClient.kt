package com.evopath.android.net

import com.evopath.android.diagnostics.AppLog
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.cancellation.CancellationException

/**
 * Minimal JSON client for the EvoPath API.
 *
 * - Base URL is read per request from [baseUrlProvider] (so editing the server takes effect at once).
 * - `Authorization: Bearer <token>` is added when [tokenProvider] returns a token and the call is
 *   authenticated. The token is never logged or included in an [ApiError].
 * - Successful bodies are unwrapped from the `{ "data": …, "meta": … }` envelope (docs/API.md).
 *   A body whose top-level `data` already is the payload (e.g. `{ "data": [ … ] }` lists) unwraps
 *   to that same payload.
 *
 * Inject [http] in tests (MockWebServer).
 */
class ApiClient(
    private val baseUrlProvider: () -> String?,
    private val tokenProvider: () -> String? = { null },
    private val http: OkHttpClient = defaultHttpClient(),
    val json: Json = ApiJson,
    private val userAgent: String? = null,
) {
    suspend fun <T> get(
        path: String,
        deserializer: KSerializer<T>,
        authenticated: Boolean = true,
        unwrapEnvelope: Boolean = true,
    ): ApiResult<T> = execute("GET", path, null, deserializer, authenticated, unwrapEnvelope)

    suspend fun <B, T> post(
        path: String,
        body: B,
        bodySerializer: KSerializer<B>,
        deserializer: KSerializer<T>,
        authenticated: Boolean = true,
        unwrapEnvelope: Boolean = true,
    ): ApiResult<T> =
        execute("POST", path, json.encodeToString(bodySerializer, body), deserializer, authenticated, unwrapEnvelope)

    suspend fun <B, T> put(
        path: String,
        body: B,
        bodySerializer: KSerializer<B>,
        deserializer: KSerializer<T>,
        authenticated: Boolean = true,
    ): ApiResult<T> = execute("PUT", path, json.encodeToString(bodySerializer, body), deserializer, authenticated, true)

    /** DELETE; a `204` succeeds with [JsonNull]. */
    suspend fun delete(path: String, authenticated: Boolean = true): ApiResult<JsonElement> =
        execute("DELETE", path, null, JsonElement.serializer(), authenticated, true)

    /** Unauthenticated liveness probe: `GET /api/health/live`. */
    suspend fun checkLive(): ApiResult<JsonElement> =
        get("/api/health/live", JsonElement.serializer(), authenticated = false)

    /** Fetches an arbitrary path on the server as text (e.g. `/.well-known/assetlinks.json`). */
    suspend fun getText(path: String): ApiResult<String> = withContext(Dispatchers.IO) {
        val url = resolve(path) ?: return@withContext notConfigured()
        try {
            http.newCall(baseRequest(url, authenticated = false).get().build()).execute().use { response ->
                val text = response.body?.string().orEmpty()
                if (response.isSuccessful) ApiResult.Success(text, response.code)
                else ApiResult.Failure(parseError(response.code, text, json).also { logFailure("GET", url, it) })
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: IOException) {
            ApiResult.Failure(networkError(e).also { logFailure("GET", url, it) })
        }
    }

    private suspend fun <T> execute(
        method: String,
        path: String,
        jsonBody: String?,
        deserializer: KSerializer<T>,
        authenticated: Boolean,
        unwrapEnvelope: Boolean,
    ): ApiResult<T> = withContext(Dispatchers.IO) {
        val url = resolve(path) ?: return@withContext notConfigured()
        val request = baseRequest(url, authenticated)
            .method(method, jsonBody?.toRequestBody(JSON_MEDIA_TYPE) ?: if (method == "POST" || method == "PUT") EMPTY_BODY else null)
            .build()
        try {
            http.newCall(request).execute().use { response -> handle(response, deserializer, unwrapEnvelope) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: IOException) {
            ApiResult.Failure(networkError(e))
        }.also { result -> if (result is ApiResult.Failure) logFailure(method, url, result.error) }
    }

    /**
     * One log line per failed call: method, path, status and API code only. Never the query,
     * a body (they carry health data) or a header. Device-flow polling noise is left out.
     */
    private fun logFailure(method: String, url: HttpUrl, error: ApiError) {
        if (error.oauthError == "authorization_pending" || error.oauthError == "slow_down") return
        val what = when (error.kind) {
            ApiError.Kind.HTTP -> "HTTP ${error.httpStatus} ${error.code.orEmpty()}${error.reason?.let { " ($it)" }.orEmpty()}${error.oauthError?.let { " ($it)" }.orEmpty()}"
            ApiError.Kind.NETWORK -> "network error ${error.cause?.javaClass?.simpleName.orEmpty()}"
            ApiError.Kind.PARSE -> "unreadable response (HTTP ${error.httpStatus})"
            ApiError.Kind.NOT_CONFIGURED -> "no server configured"
        }
        AppLog.w("Api", "$method ${url.encodedPath} failed: $what")
    }

    private fun <T> handle(response: Response, deserializer: KSerializer<T>, unwrapEnvelope: Boolean): ApiResult<T> {
        val text = response.body?.string().orEmpty()
        if (!response.isSuccessful) return ApiResult.Failure(parseError(response.code, text, json))
        return try {
            val element = if (text.isBlank()) JsonNull else json.parseToJsonElement(text)
            val payload = if (unwrapEnvelope) unwrap(element) else element
            ApiResult.Success(json.decodeFromJsonElement(deserializer, payload), response.code)
        } catch (e: Exception) {
            ApiResult.Failure(
                ApiError(ApiError.Kind.PARSE, response.code, message = "Unexpected response from the server.", cause = e),
            )
        }
    }

    private fun resolve(path: String): HttpUrl? {
        val base = baseUrlProvider()?.trimEnd('/')?.takeIf { it.isNotEmpty() } ?: return null
        val suffix = if (path.startsWith("/")) path else "/$path"
        return "$base$suffix".toHttpUrlOrNull()
    }

    private fun baseRequest(url: HttpUrl, authenticated: Boolean): Request.Builder {
        val builder = Request.Builder().url(url).header("Accept", "application/json")
        userAgent?.let { builder.header("User-Agent", it) }
        if (authenticated) {
            tokenProvider()?.takeIf { it.isNotEmpty() }?.let { builder.header("Authorization", "Bearer $it") }
        }
        return builder
    }

    private fun notConfigured() =
        ApiResult.Failure(ApiError(ApiError.Kind.NOT_CONFIGURED, message = "No EvoPath server is configured."))

    private fun networkError(e: IOException) = ApiError(
        ApiError.Kind.NETWORK,
        message = "Could not reach the server (${e.javaClass.simpleName}${e.message?.let { ": $it" } ?: ""}).",
        cause = e,
    )

    companion object {
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        private val EMPTY_BODY = "{}".toRequestBody(JSON_MEDIA_TYPE)

        /** Lenient: the API may add fields at any time. */
        val ApiJson: Json = Json {
            ignoreUnknownKeys = true
            explicitNulls = false
            encodeDefaults = true
            isLenient = false
        }

        fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .callTimeout(60, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()

        /** Unwraps `{ "data": X, … }` to X; anything else is returned unchanged. */
        fun unwrap(element: JsonElement): JsonElement =
            if (element is JsonObject && "data" in element) element.getValue("data") else element

        /** Builds an [ApiError] from a non-2xx response body (any shape, including HTML or empty). */
        fun parseError(status: Int, body: String, json: Json = ApiJson): ApiError {
            val obj = runCatching { json.parseToJsonElement(body) as? JsonObject }.getOrNull()
            var code: String? = null
            var message: String? = null
            var reason: String? = null
            var oauthError: String? = null
            if (obj != null) {
                code = obj.string("code")
                message = obj.string("message")
                reason = (obj["details"] as? JsonObject)?.string("reason")
                when (val err = obj["error"]) {
                    // RFC 8628: { "error": "authorization_pending", "error_description": "…" }
                    is JsonPrimitive -> if (err.isString) {
                        oauthError = err.content
                        message = message ?: obj.string("error_description")
                    }
                    // Nested variant: { "error": { "code", "message", "details" } }
                    is JsonObject -> {
                        code = code ?: err.string("code")
                        message = message ?: err.string("message")
                        reason = reason ?: (err["details"] as? JsonObject)?.string("reason")
                    }
                    else -> Unit
                }
                if (code == null && obj["statusCode"] is JsonPrimitive) {
                    (obj["statusCode"] as JsonPrimitive).intOrNull?.let { code = codeForStatus(it) }
                }
            }
            return ApiError(
                kind = ApiError.Kind.HTTP,
                httpStatus = status,
                code = code ?: codeForStatus(status),
                message = message?.takeIf { it.isNotBlank() } ?: "The server returned HTTP $status.",
                reason = reason,
                oauthError = oauthError,
            )
        }

        /** Mirrors the API filter's status → code mapping. */
        fun codeForStatus(status: Int): String = when (status) {
            400 -> "BAD_REQUEST"
            401 -> "UNAUTHORIZED"
            403 -> "FORBIDDEN"
            404 -> "NOT_FOUND"
            409 -> "CONFLICT"
            412 -> "PRECONDITION_FAILED"
            413 -> "PAYLOAD_TOO_LARGE"
            422 -> "UNPROCESSABLE_ENTITY"
            429 -> "TOO_MANY_REQUESTS"
            500 -> "INTERNAL_ERROR"
            else -> "ERROR"
        }

        private fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
    }
}
