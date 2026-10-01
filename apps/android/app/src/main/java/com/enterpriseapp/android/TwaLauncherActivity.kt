package com.enterpriseapp.android

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import com.enterpriseapp.android.config.ServerUrls
import com.enterpriseapp.android.setup.SetupActivity
import com.enterpriseapp.android.sync.WorkManagerSyncScheduler
import com.enterpriseapp.android.update.AppUpdates
import com.google.androidbrowserhelper.trusted.LauncherActivity

/**
 * Launcher entry point: opens the PWA at `${server}/?source=twa&appVersion=…&appVersionCode=…`
 * in a Trusted Web Activity.
 * When no server is configured yet it shows [SetupActivity] instead.
 *
 * The manifest's DEFAULT_URL is only a placeholder; the real URL comes from ServerConfig, so
 * one APK works against any deployment (the server publishes assetlinks.json for it).
 */
class TwaLauncherActivity : LauncherActivity() {
    private val serverUrl: String? by lazy { MobileApplication.from(this).serverConfig.serverUrl }

    override fun shouldLaunchImmediately(): Boolean = serverUrl != null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // super.onCreate may already have finished (e.g. a duplicate launcher instance).
        if (serverUrl == null && !isFinishing) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }
        // Opening the app syncs Health Connect (debounced to every 15 min; no-op unless paired)
        // and asks the server for a newer release (at most every 12 h; no-op unless paired).
        if (savedInstanceState == null) {
            WorkManagerSyncScheduler.onAppOpen(this)
            AppUpdates.onAppOpen(this)
        }
    }

    override fun getLaunchingUrl(): Uri {
        val server = serverUrl ?: return super.getLaunchingUrl()
        return Uri.parse(ServerUrls.twaLaunchUrl(server, BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE.toLong()))
    }
}
