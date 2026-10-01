package com.enterpriseapp.android.healthconnect

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build

/**
 * Apps that commonly write into Health Connect, with a fallback label used when the package
 * is not installed or not visible. The manifest's `<queries>` lists the same packages so
 * [AndroidAppLabels] can read their real labels on Android 11+.
 */
object SourceApps {
    val KNOWN: Map<String, String> = linkedMapOf(
        "com.google.android.apps.healthdata" to "Health Connect",
        "com.android.healthconnect.controller" to "Health Connect",
        "com.sec.android.app.shealth" to "Samsung Health",
        "com.ouraring.oura" to "Oura",
        "com.fitbit.FitbitMobile" to "Fitbit",
        "com.google.android.apps.fitness" to "Google Fit",
        "com.google.android.apps.wearables.maestro.companion" to "Pixel Watch",
        "com.garmin.android.apps.connectmobile" to "Garmin Connect",
        "com.withings.wiscale2" to "Withings Health Mate",
        "com.strava" to "Strava",
        "fi.polar.polarflow" to "Polar Flow",
        "com.huawei.health" to "Huawei Health",
        "com.xiaomi.wearable" to "Mi Fitness",
        "com.mi.health" to "Mi Health",
        "com.xiaomi.hm.health" to "Zepp Life",
        "com.huami.watch.hmwatchmanager" to "Zepp",
        "com.whoop.android" to "WHOOP",
        "com.myfitnesspal.android" to "MyFitnessPal",
    )

    /** Best label without a PackageManager: known name, else the package name itself. */
    fun fallbackLabel(packageName: String): String = KNOWN[packageName] ?: packageName
}

/** Resolves a package name to a human label. */
fun interface AppLabels {
    fun label(packageName: String): String
}

/** [AppLabels] backed by the PackageManager, cached per process. */
class AndroidAppLabels(context: Context) : AppLabels {
    private val pm = context.applicationContext.packageManager
    private val cache = java.util.concurrent.ConcurrentHashMap<String, String>()

    override fun label(packageName: String): String = cache.getOrPut(packageName) {
        try {
            val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                pm.getApplicationInfo(packageName, PackageManager.ApplicationInfoFlags.of(0))
            } else {
                @Suppress("DEPRECATION")
                pm.getApplicationInfo(packageName, 0)
            }
            pm.getApplicationLabel(info).toString().takeIf { it.isNotBlank() } ?: SourceApps.fallbackLabel(packageName)
        } catch (_: PackageManager.NameNotFoundException) {
            SourceApps.fallbackLabel(packageName)
        }
    }
}
