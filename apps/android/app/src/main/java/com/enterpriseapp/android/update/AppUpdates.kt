package com.enterpriseapp.android.update

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import com.enterpriseapp.android.MobileApplication
import com.enterpriseapp.android.diagnostics.AppLog
import com.enterpriseapp.android.net.ApiResult
import kotlinx.coroutines.launch

/** Android glue for [UpdateChecker]: app-open checks and the browser download. */
object AppUpdates {
    private const val TAG = "Update"

    /** Called from the launcher and the Health sync screen; asks the server at most every 12 h. */
    fun onAppOpen(context: Context) {
        val app = MobileApplication.from(context)
        app.appScope.launch {
            runCatching { app.updateChecker.checkIfDue() }
                .onFailure { AppLog.w(TAG, "Update check crashed", it) }
            app.refreshAvailableUpdate()
        }
    }

    /** Asks the server now (Diagnostics → Get the update), so the hub shows the offer. */
    fun checkNow(context: Context) {
        val app = MobileApplication.from(context)
        app.appScope.launch {
            runCatching { app.updateChecker.check() }
                .onFailure { AppLog.w(TAG, "Update check crashed", it) }
            app.refreshAvailableUpdate()
        }
    }

    /**
     * Gets a signed download link and opens it in the browser, which downloads the APK and
     * hands it to the system installer. Returns an error message, or null when the browser opened.
     */
    suspend fun download(context: Context, update: AvailableUpdate): String? {
        val app = MobileApplication.from(context)
        val server = app.serverConfig.serverUrl ?: return "No server is configured."
        val link = when (val result = app.releaseApi.downloadLink(update.releaseId)) {
            is ApiResult.Success -> result.value
            is ApiResult.Failure -> {
                AppLog.w(TAG, "Download link failed: ${result.error.message}")
                if (result.error.httpStatus == 404) {
                    // The release was replaced or deleted: look again on the next open.
                    app.updateStore.lastCheckAt = null
                    app.updateStore.available = null
                    app.refreshAvailableUpdate()
                    return "This release is no longer offered. Reopen the app to check again."
                }
                return "Could not get the download link: ${result.error.message}"
            }
        }
        val url = UpdatePolicy.downloadUrl(server, link.url) ?: return "The server returned an unexpected download link."
        return try {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            AppLog.i(TAG, "Opened the download of ${update.versionName} (${update.versionCode})")
            null
        } catch (e: ActivityNotFoundException) {
            "No browser is installed to download the update."
        }
    }
}
