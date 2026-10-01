package com.enterpriseapp.android.healthconnect

/**
 * Health Connect read permissions this app declares (manifest `<uses-permission>`).
 *
 * Plain strings (identical to `HealthPermission.getReadPermission(XRecord::class)`) so the
 * pure sync layer and its JVM tests need no Health Connect classes.
 */
object HealthPermissions {
    private const val PREFIX = "android.permission.health."
    const val READ_STEPS = PREFIX + "READ_STEPS"
    const val READ_EXERCISE = PREFIX + "READ_EXERCISE"
    const val READ_DISTANCE = PREFIX + "READ_DISTANCE"
    const val READ_HEART_RATE = PREFIX + "READ_HEART_RATE"
    const val READ_RESTING_HEART_RATE = PREFIX + "READ_RESTING_HEART_RATE"
    const val READ_HEART_RATE_VARIABILITY = PREFIX + "READ_HEART_RATE_VARIABILITY"
    const val READ_WEIGHT = PREFIX + "READ_WEIGHT"
    const val READ_BODY_FAT = PREFIX + "READ_BODY_FAT"
    const val READ_BLOOD_PRESSURE = PREFIX + "READ_BLOOD_PRESSURE"
    const val READ_SLEEP = PREFIX + "READ_SLEEP"

    /** Lets the periodic worker read while the app is not in the foreground (feature-checked). */
    const val READ_HEALTH_DATA_IN_BACKGROUND = PREFIX + "READ_HEALTH_DATA_IN_BACKGROUND"

    /** Every data permission (no background), in display order. */
    val ALL_DATA: List<String> = HcDataType.entries.map { it.permission }
}

/**
 * One Health Connect data type the app reads.
 *
 * [key] is the name used on the wire in `run.details.syncedTypes` / `perType` and must match
 * the API's `SYNCED_TYPE_SCOPES` (apps/api/src/health-sync/health-sync.constants.ts).
 * [DISTANCE] is auxiliary: it only enriches exercise sessions and is never a synced type.
 */
enum class HcDataType(val key: String, val label: String, val permission: String) {
    STEPS("steps", "Steps", HealthPermissions.READ_STEPS),
    EXERCISE("exercise", "Exercise sessions", HealthPermissions.READ_EXERCISE),
    DISTANCE("distance", "Distance", HealthPermissions.READ_DISTANCE),
    HEART_RATE("heart_rate", "Heart rate (daily average)", HealthPermissions.READ_HEART_RATE),
    RESTING_HEART_RATE("resting_heart_rate", "Resting heart rate", HealthPermissions.READ_RESTING_HEART_RATE),
    HRV("hrv", "Heart rate variability", HealthPermissions.READ_HEART_RATE_VARIABILITY),
    WEIGHT("weight", "Weight", HealthPermissions.READ_WEIGHT),
    BODY_FAT("body_fat", "Body fat", HealthPermissions.READ_BODY_FAT),
    BLOOD_PRESSURE("blood_pressure", "Blood pressure", HealthPermissions.READ_BLOOD_PRESSURE),
    SLEEP("sleep", "Sleep", HealthPermissions.READ_SLEEP),
    ;

    /** True for every type that can appear in `syncedTypes`. */
    val isSyncedType: Boolean get() = this != DISTANCE

    companion object {
        val SYNCED: List<HcDataType> = entries.filter { it.isSyncedType }
        fun fromKey(key: String): HcDataType? = entries.firstOrNull { it.key == key }
    }
}

/**
 * A user-facing on/off switch on the Sync screen (all on by default). One toggle can cover
 * several Health Connect types: "Heart rate" reads both the daily average and resting HR,
 * "Exercise" also reads distance for those sessions.
 */
enum class SyncToggle(
    val key: String,
    val label: String,
    val description: String,
    val dataTypes: List<HcDataType>,
) {
    STEPS("steps", "Steps", "Daily step totals", listOf(HcDataType.STEPS)),
    EXERCISE(
        "exercise",
        "Exercise",
        "Walks, runs and cardio sessions, with their distance",
        listOf(HcDataType.EXERCISE, HcDataType.DISTANCE),
    ),
    HEART_RATE(
        "heart_rate",
        "Heart rate",
        "Daily average and resting heart rate",
        listOf(HcDataType.HEART_RATE, HcDataType.RESTING_HEART_RATE),
    ),
    HRV("hrv", "Heart rate variability", "HRV (RMSSD) readings", listOf(HcDataType.HRV)),
    WEIGHT("weight", "Weight", "Weight readings in kg", listOf(HcDataType.WEIGHT)),
    BODY_FAT("body_fat", "Body fat", "Body fat percentage", listOf(HcDataType.BODY_FAT)),
    BLOOD_PRESSURE("blood_pressure", "Blood pressure", "Systolic and diastolic readings", listOf(HcDataType.BLOOD_PRESSURE)),
    SLEEP("sleep", "Sleep", "Sleep sessions with stage minutes", listOf(HcDataType.SLEEP)),
    ;

    /** Permissions to request for this toggle. */
    val permissions: Set<String> get() = dataTypes.mapTo(linkedSetOf()) { it.permission }

    companion object {
        fun forType(type: HcDataType): SyncToggle = entries.first { type in it.dataTypes }

        /** Permissions for the enabled toggles, plus background reading when [includeBackground]. */
        fun permissionsFor(enabled: Collection<SyncToggle>, includeBackground: Boolean): Set<String> {
            val result = linkedSetOf<String>()
            enabled.forEach { result += it.permissions }
            if (includeBackground) result += HealthPermissions.READ_HEALTH_DATA_IN_BACKGROUND
            return result
        }
    }
}
