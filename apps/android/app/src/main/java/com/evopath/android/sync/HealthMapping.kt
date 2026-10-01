package com.evopath.android.sync

import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.SleepSessionRecord
import com.evopath.android.healthconnect.DailyAggregate
import com.evopath.android.healthconnect.HcBloodPressure
import com.evopath.android.healthconnect.HcExerciseSession
import com.evopath.android.healthconnect.HcSample
import com.evopath.android.healthconnect.HcSleepSession
import java.math.BigDecimal
import java.math.RoundingMode
import java.time.Duration
import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId

/** Rows mapped from one data type, and how many records were read but not mapped. */
data class Mapped<T>(val rows: List<T>, val dropped: Int)

/**
 * Pure Health Connect → EvoPath mapping (HS contract, "Sync engine" + SCOPE UPDATE).
 *
 * Uses only plain values and `const` record constants (inlined at compile time), so it runs in
 * JVM unit tests. Values outside the API's bounds are dropped here: one bad reading must not
 * make the server refuse the whole sync.
 */
object HealthMapping {
    // --- activity kinds ---------------------------------------------------------------------

    const val KIND_WALK = "walk"
    const val KIND_RUN = "run"
    const val KIND_CARDIO = "cardio_any"
    const val KIND_STEPS = "steps"

    private val WALK_TYPES = setOf(
        ExerciseSessionRecord.EXERCISE_TYPE_WALKING,
        ExerciseSessionRecord.EXERCISE_TYPE_HIKING,
    )
    private val RUN_TYPES = setOf(
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING,
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING_TREADMILL,
    )
    private val CARDIO_TYPES = setOf(
        ExerciseSessionRecord.EXERCISE_TYPE_BIKING,
        ExerciseSessionRecord.EXERCISE_TYPE_BIKING_STATIONARY,
        ExerciseSessionRecord.EXERCISE_TYPE_ELLIPTICAL,
        ExerciseSessionRecord.EXERCISE_TYPE_ROWING,
        ExerciseSessionRecord.EXERCISE_TYPE_ROWING_MACHINE,
        ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_OPEN_WATER,
        ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_POOL,
        ExerciseSessionRecord.EXERCISE_TYPE_STAIR_CLIMBING,
        ExerciseSessionRecord.EXERCISE_TYPE_STAIR_CLIMBING_MACHINE,
        ExerciseSessionRecord.EXERCISE_TYPE_HIGH_INTENSITY_INTERVAL_TRAINING,
        ExerciseSessionRecord.EXERCISE_TYPE_BOOT_CAMP,
        ExerciseSessionRecord.EXERCISE_TYPE_DANCING,
        ExerciseSessionRecord.EXERCISE_TYPE_PADDLING,
        ExerciseSessionRecord.EXERCISE_TYPE_SKATING,
        ExerciseSessionRecord.EXERCISE_TYPE_ICE_SKATING,
        ExerciseSessionRecord.EXERCISE_TYPE_SKIING,
        ExerciseSessionRecord.EXERCISE_TYPE_SNOWSHOEING,
        ExerciseSessionRecord.EXERCISE_TYPE_WHEELCHAIR,
    )

    /** `walk` / `run` / `cardio_any`, or null for a type EvoPath does not import (strength, yoga, sports…). */
    fun exerciseKind(exerciseType: Int): String? = when (exerciseType) {
        in WALK_TYPES -> KIND_WALK
        in RUN_TYPES -> KIND_RUN
        in CARDIO_TYPES -> KIND_CARDIO
        else -> null
    }

    // --- API bounds (apps/api: activity.constants ENTRY_BOUNDS, metric-registry) ---------------

    const val MAX_STEPS = 200_000
    const val MAX_DURATION_SECONDS = 86_400
    const val MAX_DISTANCE_METERS = 1_000_000.0
    const val MAX_NOTE = 280
    const val MAX_EXTERNAL_ID = 200
    const val MAX_SLEEP_MINUTES = 1440

    /** Metric keys the sync sends, with canonical unit, bounds and display decimals. */
    enum class Metric(val key: String, val unit: String, val min: Double, val max: Double, val decimals: Int) {
        WEIGHT("weight", "kg", 20.0, 500.0, 1),
        BODY_FAT("body_fat_pct", "%", 2.0, 70.0, 1),
        RESTING_HR("resting_hr", "bpm", 25.0, 220.0, 0),
        HEART_RATE_AVG("heart_rate_avg", "bpm", 25.0, 250.0, 0),
        HRV("hrv_rmssd", "ms", 1.0, 300.0, 0),
        BP_SYSTOLIC("bp_systolic", "mmHg", 60.0, 260.0, 0),
        BP_DIASTOLIC("bp_diastolic", "mmHg", 30.0, 160.0, 0),
        ;

        fun round(value: Double): Double = BigDecimal.valueOf(value).setScale(decimals, RoundingMode.HALF_UP).toDouble()

        /** The rounded value when within bounds, else null. */
        fun accept(value: Double): Double? {
            if (!value.isFinite()) return null
            val rounded = round(value)
            return rounded.takeIf { it in min..max }
        }
    }

    // --- activity entries ---------------------------------------------------------------------

    /** Daily step totals → `steps` entries (`steps:YYYY-MM-DD`), zero days skipped. */
    fun steps(days: List<DailyAggregate>, window: SyncWindow): Mapped<SyncEntry> {
        var dropped = 0
        val rows = days.sortedBy { it.date }.mapNotNull { day ->
            val count = day.value.toLong()
            if (day.date !in window || count <= 0) {
                if (day.date !in window) dropped++
                return@mapNotNull null
            }
            SyncEntry(
                externalId = "steps:${day.date}",
                occurredOn = day.date.toString(),
                activityKind = KIND_STEPS,
                steps = count.coerceAtMost(MAX_STEPS.toLong()).toInt(),
            )
        }
        return Mapped(rows, dropped)
    }

    /**
     * One exercise session → an entry, or null when its type is not imported, it has no
     * positive duration, or it started outside the window (local date in [zone]).
     */
    fun exercise(
        session: HcExerciseSession,
        distanceMeters: Double?,
        zone: ZoneId,
        window: SyncWindow,
        appLabel: String,
    ): SyncEntry? {
        val kind = exerciseKind(session.exerciseType) ?: return null
        val seconds = Duration.between(session.start, session.end).seconds
        if (seconds <= 0) return null
        val day = session.start.atZone(zone).toLocalDate()
        if (day !in window) return null
        if (session.id.isBlank() || session.id.length > MAX_EXTERNAL_ID) return null
        return SyncEntry(
            externalId = session.id,
            occurredOn = day.toString(),
            occurredAt = Iso.instant(session.start),
            activityKind = kind,
            durationSeconds = seconds.coerceAtMost(MAX_DURATION_SECONDS.toLong()).toInt(),
            distanceMeters = distanceMeters
                ?.takeIf { it.isFinite() && it > 0 }
                ?.coerceAtMost(MAX_DISTANCE_METERS)
                ?.let { BigDecimal.valueOf(it).setScale(2, RoundingMode.HALF_UP).toDouble() },
            note = note(appLabel),
        )
    }

    fun note(appLabel: String): String = "via $appLabel".take(MAX_NOTE)

    // --- measurements -------------------------------------------------------------------------

    /** Daily average heart rate → `heart_rate_avg` at local noon (`hr_avg:YYYY-MM-DD`). */
    fun heartRateAverage(days: List<DailyAggregate>, zone: ZoneId, window: SyncWindow): Mapped<SyncMeasurement> {
        var dropped = 0
        val rows = days.sortedBy { it.date }.mapNotNull { day ->
            val value = Metric.HEART_RATE_AVG.accept(day.value)
            if (day.date !in window || value == null) {
                dropped++
                return@mapNotNull null
            }
            SyncMeasurement(
                externalId = "hr_avg:${day.date}",
                metricKey = Metric.HEART_RATE_AVG.key,
                value = value,
                unit = Metric.HEART_RATE_AVG.unit,
                measuredAt = Iso.instant(day.date.atTime(LocalTime.NOON).atZone(zone).toInstant()),
            )
        }
        return Mapped(rows, dropped)
    }

    /** Instantaneous readings (resting HR, HRV, weight, body fat) → measurements keyed by record id. */
    fun samples(samples: List<HcSample>, metric: Metric, zone: ZoneId, window: SyncWindow): Mapped<SyncMeasurement> {
        var dropped = 0
        val rows = samples.sortedBy { it.time }.mapNotNull { sample ->
            val value = metric.accept(sample.value)
            if (value == null || !inWindow(sample.time, zone, window) || !validId(sample.id)) {
                dropped++
                return@mapNotNull null
            }
            SyncMeasurement(
                externalId = sample.id,
                metricKey = metric.key,
                value = value,
                unit = metric.unit,
                measuredAt = Iso.instant(sample.time),
            )
        }
        return Mapped(rows, dropped)
    }

    /**
     * Blood pressure → a systolic and a diastolic reading sharing `entryKey` = record id,
     * with external ids `<id>:sys` / `<id>:dia`. A pair out of bounds, or with systolic not
     * above diastolic, is dropped whole. [Mapped.dropped] counts records, not rows.
     */
    fun bloodPressure(readings: List<HcBloodPressure>, zone: ZoneId, window: SyncWindow): Mapped<SyncMeasurement> {
        var dropped = 0
        val rows = mutableListOf<SyncMeasurement>()
        readings.sortedBy { it.time }.forEach { reading ->
            val sys = Metric.BP_SYSTOLIC.accept(reading.systolicMmHg)
            val dia = Metric.BP_DIASTOLIC.accept(reading.diastolicMmHg)
            if (sys == null || dia == null || sys <= dia || !inWindow(reading.time, zone, window) ||
                !validId(reading.id + ":sys")
            ) {
                dropped++
                return@forEach
            }
            val at = Iso.instant(reading.time)
            rows += SyncMeasurement("${reading.id}:sys", reading.id, Metric.BP_SYSTOLIC.key, sys, Metric.BP_SYSTOLIC.unit, at)
            rows += SyncMeasurement("${reading.id}:dia", reading.id, Metric.BP_DIASTOLIC.key, dia, Metric.BP_DIASTOLIC.unit, at)
        }
        return Mapped(rows, dropped)
    }

    // --- sleep --------------------------------------------------------------------------------

    /** Stage minutes of one session, by EvoPath bucket. */
    data class StageMinutes(val awake: Int, val light: Int, val deep: Int, val rem: Int, val unknown: Int)

    /** Sums stage durations (clipped to the session) into awake/light/deep/rem/unknown minutes. */
    fun stageMinutes(session: HcSleepSession): StageMinutes? {
        if (session.stages.isEmpty()) return null
        val seconds = LongArray(5)
        session.stages.forEach { stage ->
            val start = maxOf(stage.start, session.start)
            val end = minOf(stage.end, session.end)
            if (!end.isAfter(start)) return@forEach
            val bucket = when (stage.stage) {
                SleepSessionRecord.STAGE_TYPE_AWAKE,
                SleepSessionRecord.STAGE_TYPE_AWAKE_IN_BED,
                SleepSessionRecord.STAGE_TYPE_OUT_OF_BED,
                -> 0
                SleepSessionRecord.STAGE_TYPE_LIGHT -> 1
                SleepSessionRecord.STAGE_TYPE_DEEP -> 2
                SleepSessionRecord.STAGE_TYPE_REM -> 3
                else -> 4 // SLEEPING, UNKNOWN
            }
            seconds[bucket] += Duration.between(start, end).seconds
        }
        fun min(i: Int) = ((seconds[i] + 30) / 60).toInt().coerceAtMost(MAX_SLEEP_MINUTES)
        return StageMinutes(min(0), min(1), min(2), min(3), min(4))
    }

    /**
     * One sleep session → a row, or null when it is shorter than a minute, longer than a day,
     * or woke up outside the window. `localDate` is the local date of waking (end) in [zone];
     * `durationMinutes` is asleep time (total minus awake) when stages exist, else end − start.
     */
    fun sleep(session: HcSleepSession, zone: ZoneId, window: SyncWindow, appLabel: String): SyncSleepSession? {
        if (!validId(session.id)) return null
        val totalSeconds = Duration.between(session.start, session.end).seconds
        val totalMinutes = ((totalSeconds + 30) / 60).toInt()
        if (totalMinutes < 1 || totalMinutes > MAX_SLEEP_MINUTES) return null
        val day = session.end.atZone(zone).toLocalDate()
        if (day !in window) return null
        val stages = stageMinutes(session)
        val asleep = if (stages != null) (totalMinutes - stages.awake).coerceAtLeast(0) else totalMinutes
        return SyncSleepSession(
            externalId = session.id,
            startAt = Iso.instant(session.start),
            endAt = Iso.instant(session.end),
            localDate = day.toString(),
            durationMinutes = asleep,
            awakeMinutes = stages?.awake,
            lightMinutes = stages?.light,
            deepMinutes = stages?.deep,
            remMinutes = stages?.rem,
            unknownMinutes = stages?.unknown,
            note = note(appLabel),
        )
    }

    private fun inWindow(time: Instant, zone: ZoneId, window: SyncWindow): Boolean = time.atZone(zone).toLocalDate() in window

    private fun validId(id: String): Boolean = id.isNotBlank() && id.length <= MAX_EXTERNAL_ID
}
