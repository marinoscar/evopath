package com.enterpriseapp.android.net

/** Result of one API call. Never throws for HTTP/network problems; inspect [Failure.error]. */
sealed interface ApiResult<out T> {
    data class Success<T>(val value: T, val httpStatus: Int) : ApiResult<T>
    data class Failure(val error: ApiError) : ApiResult<Nothing>

    fun getOrNull(): T? = (this as? Success<T>)?.value
}

/**
 * A failed call.
 *
 * For HTTP errors the API's filter body is parsed (docs/API.md, "Errors"):
 * `{ "statusCode", "code", "message", "details": { "reason"?, "issues"? } }`.
 * `POST /api/auth/device/token` instead returns the RFC 8628 body
 * `{ "error", "error_description" }`, surfaced as [oauthError].
 */
data class ApiError(
    val kind: Kind,
    val httpStatus: Int? = null,
    /** API `code` (`BAD_REQUEST`, `UNAUTHORIZED`, `CONFLICT`, …), derived from the status. */
    val code: String? = null,
    val message: String,
    /** `details.reason` when present; branch on this, never on [message]. */
    val reason: String? = null,
    /** RFC 8628 `error` (`authorization_pending`, `slow_down`, `expired_token`, `access_denied`, …). */
    val oauthError: String? = null,
    val cause: Throwable? = null,
) {
    enum class Kind {
        /** No server URL configured, or it is invalid. */
        NOT_CONFIGURED,

        /** DNS, TLS, connect/read timeout, connection reset… */
        NETWORK,

        /** The server answered with a non-2xx status. */
        HTTP,

        /** A 2xx body that could not be decoded. */
        PARSE,
    }

    val isUnauthorized: Boolean get() = httpStatus == 401
}
