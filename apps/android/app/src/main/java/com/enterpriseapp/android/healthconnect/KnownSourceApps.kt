package com.enterpriseapp.android.healthconnect

/** One app known to write into Health Connect, and the data types (HcDataType keys) it can write. */
data class KnownSourceApp(
    val packageName: String,
    val label: String,
    val writes: Set<String>,
)

/**
 * Which data types common source apps can write into Health Connect.
 *
 * Health Connect has no API that answers "which apps may write type X", so diagnostics combine
 * this table with the apps that actually wrote data (see `diagnostics/RemedyApps`). It is
 * best-effort, compiled from each vendor's published Health Connect support; an app can change
 * what it shares in any release, and a missing entry only means the remedy will not suggest it.
 *
 * To extend it: add a row (package name, label, keys from [HcDataType.key]), and add the package
 * to the manifest's `<queries>` so the PackageManager can see whether it is installed on
 * Android 11+. Phone-paired scales and watches usually write through their companion app (for
 * example a Samsung-paired scale through Samsung Health), so list the companion app.
 */
object KnownSourceApps {
    private const val STEPS = "steps"
    private const val EXERCISE = "exercise"
    private const val DISTANCE = "distance"
    private const val HEART_RATE = "heart_rate"
    private const val RESTING_HEART_RATE = "resting_heart_rate"
    private const val HRV = "hrv"
    private const val WEIGHT = "weight"
    private const val BODY_FAT = "body_fat"
    private const val BLOOD_PRESSURE = "blood_pressure"
    private const val SLEEP = "sleep"

    val ALL: List<KnownSourceApp> = listOf(
        // Writes no HRV and no resting heart rate to Health Connect.
        KnownSourceApp(
            "com.sec.android.app.shealth", "Samsung Health",
            setOf(STEPS, EXERCISE, DISTANCE, SLEEP, HEART_RATE, WEIGHT, BODY_FAT, BLOOD_PRESSURE),
        ),
        KnownSourceApp(
            "com.ouraring.oura", "Oura",
            setOf(SLEEP, HEART_RATE, RESTING_HEART_RATE, HRV, STEPS, EXERCISE),
        ),
        KnownSourceApp(
            "com.fitbit.FitbitMobile", "Fitbit",
            setOf(STEPS, EXERCISE, DISTANCE, SLEEP, HEART_RATE, RESTING_HEART_RATE, WEIGHT, BODY_FAT),
        ),
        KnownSourceApp(
            "com.google.android.apps.fitness", "Google Fit",
            setOf(STEPS, EXERCISE, DISTANCE, HEART_RATE, WEIGHT, SLEEP),
        ),
        KnownSourceApp(
            "com.garmin.android.apps.connectmobile", "Garmin Connect",
            setOf(STEPS, EXERCISE, DISTANCE, SLEEP, HEART_RATE, RESTING_HEART_RATE, HRV, WEIGHT, BODY_FAT),
        ),
        KnownSourceApp(
            "com.withings.wiscale2", "Withings",
            setOf(WEIGHT, BODY_FAT, BLOOD_PRESSURE, HEART_RATE, SLEEP, STEPS),
        ),
        KnownSourceApp(
            "fi.polar.polarflow", "Polar Flow",
            setOf(EXERCISE, HEART_RATE, SLEEP, STEPS),
        ),
    )

    val BY_PACKAGE: Map<String, KnownSourceApp> = ALL.associateBy { it.packageName }

    /** Every package in the table (what the PackageManager is asked about). */
    val PACKAGES: List<String> = ALL.map { it.packageName }
}
