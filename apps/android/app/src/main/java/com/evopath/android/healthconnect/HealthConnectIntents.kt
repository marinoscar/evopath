package com.evopath.android.healthconnect

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.health.connect.client.HealthConnectClient

/** Intents that leave the app for Health Connect or the Play Store. */
object HealthConnectIntents {
    private const val PLAY_STORE_PACKAGE = "com.android.vending"
    private const val ONBOARDING = "healthconnect%3A%2F%2Fonboarding"

    /** Opens the Play Store page of Health Connect (install or update), falling back to the web page. */
    fun openPlayStore(context: Context) {
        val pkg = AndroidHealthConnectGateway.PROVIDER_PACKAGE
        val market = Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$pkg&url=$ONBOARDING"))
            .setPackage(PLAY_STORE_PACKAGE)
            .putExtra("overlay", true)
            .putExtra("callerId", context.packageName)
        if (!tryStart(context, market)) {
            tryStart(context, Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=$pkg")))
        }
    }

    /** Opens Health Connect's data and access screen (permissions can be changed there). */
    fun openHealthConnectSettings(context: Context): Boolean {
        val manage = runCatching { HealthConnectClient.getHealthConnectManageDataIntent(context) }.getOrNull()
        if (manage != null && tryStart(context, manage)) return true
        return tryStart(context, Intent(HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS))
    }

    private fun tryStart(context: Context, intent: Intent): Boolean = try {
        if (context !is android.app.Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        true
    } catch (_: ActivityNotFoundException) {
        false
    } catch (_: SecurityException) {
        false
    }
}
