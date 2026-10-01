package com.enterpriseapp.android.healthconnect

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

/**
 * The app's only door into Health Connect (sync now, diagnostics in #282).
 *
 * Every type here is plain Kotlin, so the sync and diagnostics logic can be unit-tested with
 * a fake. Each reader returns the record's Health Connect id and the package that wrote it
 * (`metadata.dataOrigin.packageName`), which the diagnostics "sources" view groups on.
 *
 * Readers throw what Health Connect throws (`SecurityException` for a missing permission or a
 * background read without the background permission, `RemoteException`/`IOException`,
 * `IllegalStateException` for a rate limit); callers decide what a failure means.
 */
interface HealthConnectGateway {
    /** SDK status: available, not supported on this device, or the provider needs an update. */
    fun availability(): HcAvailability

    /**
     * Version of the Health Connect provider: the `versionName` of the APK
     * `com.google.android.apps.healthdata` when installed, else `"system"` (Android 14+ module).
     */
    fun providerVersion(): String

    /** Whether Health Connect on this device supports [HealthPermissions.READ_HEALTH_DATA_IN_BACKGROUND]. */
    fun isBackgroundReadAvailable(): Boolean

    /** Permissions currently granted to this app (a live IPC call). */
    suspend fun grantedPermissions(): Set<String>

    /** Daily step totals for local days [from]..[to] (inclusive), days without data omitted. */
    suspend fun dailySteps(from: LocalDate, to: LocalDate): List<DailyAggregate>

    /** Daily average heart rate (bpm) for local days [from]..[to] (inclusive). */
    suspend fun dailyHeartRateAvg(from: LocalDate, to: LocalDate): List<DailyAggregate>

    suspend fun exerciseSessions(from: Instant, to: Instant): List<HcExerciseSession>

    /** Total distance (meters) recorded in [from, to), or null when there is none. */
    suspend fun distanceMeters(from: Instant, to: Instant): Double?

    suspend fun restingHeartRate(from: Instant, to: Instant): List<HcSample>
    suspend fun heartRateVariability(from: Instant, to: Instant): List<HcSample>

    /** Weight samples, value in kilograms. */
    suspend fun weight(from: Instant, to: Instant): List<HcSample>

    /** Body fat samples, value in percent. */
    suspend fun bodyFat(from: Instant, to: Instant): List<HcSample>

    suspend fun bloodPressure(from: Instant, to: Instant): List<HcBloodPressure>
    suspend fun sleepSessions(from: Instant, to: Instant): List<HcSleepSession>

    /**
     * Counts records of [type] in [from, to), at most [cap] (then [HcTypeInventory.capped]),
     * grouped by source package. Used by diagnostics (`hc.data.<type>`, `hc.sources`).
     */
    suspend fun inventory(type: HcDataType, from: Instant, to: Instant, cap: Int = 1000): HcTypeInventory
}

enum class HcAvailability {
    AVAILABLE,

    /** `SDK_UNAVAILABLE`: Health Connect cannot run here (or is not installed on Android ≤ 13). */
    NOT_SUPPORTED,

    /** `SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED`: install/update the Health Connect app. */
    UPDATE_REQUIRED,
}

/** One local day's aggregate. [origins] are the packages that contributed. */
data class DailyAggregate(val date: LocalDate, val value: Double, val origins: Set<String>)

data class HcExerciseSession(
    val id: String,
    /** `ExerciseSessionRecord.EXERCISE_TYPE_*`. */
    val exerciseType: Int,
    val start: Instant,
    val end: Instant,
    val title: String?,
    val origin: String,
    val startZoneOffset: ZoneOffset? = null,
)

/** An instantaneous reading (resting HR, HRV, weight, body fat). */
data class HcSample(val id: String, val time: Instant, val value: Double, val origin: String)

data class HcBloodPressure(
    val id: String,
    val time: Instant,
    val systolicMmHg: Double,
    val diastolicMmHg: Double,
    val origin: String,
)

data class HcSleepStage(val start: Instant, val end: Instant, /** `SleepSessionRecord.STAGE_TYPE_*`. */ val stage: Int)

data class HcSleepSession(
    val id: String,
    val start: Instant,
    val end: Instant,
    val stages: List<HcSleepStage>,
    val origin: String,
    val title: String? = null,
)

data class HcSourceCount(val packageName: String, val recordCount: Int, val latestRecordAt: Instant?)

data class HcTypeInventory(
    val type: HcDataType,
    val recordCount: Int,
    val capped: Boolean,
    val latestRecordAt: Instant?,
    val sources: List<HcSourceCount>,
)

/** Thrown by a reader that hit its safety cap; the type is then reported partial. */
class TooManyRecordsException(val type: HcDataType, val cap: Int) :
    IllegalStateException("More than $cap ${type.key} records in the window")
