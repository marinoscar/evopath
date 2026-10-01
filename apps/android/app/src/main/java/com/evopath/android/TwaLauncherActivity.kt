package com.evopath.android

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import com.evopath.android.config.ServerUrls
import com.evopath.android.setup.SetupActivity
import com.google.androidbrowserhelper.trusted.LauncherActivity

/**
 * Launcher entry point: opens the PWA at `${server}/?source=twa` in a Trusted Web Activity.
 * When no server is configured yet it shows [SetupActivity] instead.
 *
 * The manifest's DEFAULT_URL is only a placeholder; the real URL comes from ServerConfig, so
 * one APK works against any EvoPath deployment (the server publishes assetlinks.json for it).
 */
class TwaLauncherActivity : LauncherActivity() {
    private val serverUrl: String? by lazy { EvoPathApplication.from(this).serverConfig.serverUrl }

    override fun shouldLaunchImmediately(): Boolean = serverUrl != null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // super.onCreate may already have finished (e.g. a duplicate launcher instance).
        if (serverUrl == null && !isFinishing) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
        }
    }

    override fun getLaunchingUrl(): Uri {
        val server = serverUrl ?: return super.getLaunchingUrl()
        return Uri.parse(ServerUrls.twaLaunchUrl(server))
    }
}
