package com.enterpriseapp.android.config

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.net.URLEncoder

/** Outcome of validating a user-entered server address. */
sealed interface ServerUrlResult {
    /** [url] is canonical: `https://host[:port]`, lowercase host, no trailing slash. */
    data class Valid(val url: String) : ServerUrlResult

    data class Invalid(val reason: String) : ServerUrlResult
}

/**
 * Pure (JVM-only) server URL rules, shared by first-run setup and the Health sync hub.
 *
 * The product is served same-origin (UI at `/`, API at `/api`), so a server is an origin:
 * scheme + host + optional port. HTTPS is required because a Trusted Web Activity and
 * Digital Asset Links only work over HTTPS.
 */
object ServerUrls {
    fun normalize(input: String?): ServerUrlResult {
        val trimmed = input?.trim().orEmpty()
        if (trimmed.isEmpty()) return ServerUrlResult.Invalid("Enter the server address.")
        if (trimmed.any { it.isWhitespace() }) return ServerUrlResult.Invalid("The address cannot contain spaces.")

        val schemeMatch = Regex("^([a-zA-Z][a-zA-Z0-9+.-]*)://").find(trimmed)
        val withScheme = when {
            schemeMatch == null -> "https://$trimmed"
            schemeMatch.groupValues[1].equals("https", ignoreCase = true) -> trimmed
            else -> return ServerUrlResult.Invalid("The address must use https://.")
        }

        val url = withScheme.toHttpUrlOrNull()
            ?: return ServerUrlResult.Invalid("That is not a valid web address.")
        if (url.username.isNotEmpty() || url.password.isNotEmpty()) {
            return ServerUrlResult.Invalid("The address cannot contain a user name or password.")
        }
        if (url.query != null || url.fragment != null) {
            return ServerUrlResult.Invalid("Enter the server address only, without ?query or #fragment.")
        }
        val path = url.encodedPath.trimEnd('/')
        if (path.isNotEmpty()) {
            return ServerUrlResult.Invalid("Enter the server address only, for example https://app.example.com.")
        }
        val host = url.host
        if (!host.contains('.') && !host.contains(':') && host != "localhost") {
            return ServerUrlResult.Invalid("Enter a full host name, for example app.example.com.")
        }

        val port = if (url.port == 443) "" else ":${url.port}"
        val hostPart = if (host.contains(':')) "[$host]" else host
        return ServerUrlResult.Valid("https://$hostPart$port")
    }

    /**
     * The URL the TWA opens. `source=twa` lets the web app know it runs inside the Android shell;
     * `appVersion`/`appVersionCode` tell it which build, so it can offer an update.
     */
    fun twaLaunchUrl(server: String, versionName: String, versionCode: Long): String =
        "${server.trimEnd('/')}/?source=twa" +
            "&appVersion=${URLEncoder.encode(versionName, Charsets.UTF_8.name())}" +
            "&appVersionCode=$versionCode"
}
