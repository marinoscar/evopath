package com.evopath.android

import android.app.Application
import com.evopath.android.auth.EncryptedTokenStore
import com.evopath.android.auth.TokenStore
import com.evopath.android.config.ServerConfig
import com.evopath.android.net.ApiClient

/**
 * Process-wide singletons. Kept deliberately small (no DI framework): screens and
 * workers reach shared state through [EvoPathApplication.from].
 */
class EvoPathApplication : Application() {
    val serverConfig: ServerConfig by lazy { ServerConfig.from(this) }
    val tokenStore: TokenStore by lazy { EncryptedTokenStore.create(this) }

    /** Authenticated client for the configured server; base URL and token are read per request. */
    val apiClient: ApiClient by lazy {
        ApiClient(
            baseUrlProvider = { serverConfig.serverUrl },
            tokenProvider = { tokenStore.token },
        )
    }

    companion object {
        fun from(context: android.content.Context): EvoPathApplication =
            context.applicationContext as EvoPathApplication
    }
}
