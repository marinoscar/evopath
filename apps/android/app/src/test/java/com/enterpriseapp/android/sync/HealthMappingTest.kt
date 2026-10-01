package com.enterpriseapp.android.sync

import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.SleepSessionRecord
import com.enterpriseapp.android.healthconnect.DailyAggregate
import com.enterpriseapp.android.healthconnect.HcBloodPressure
import com.enterpriseapp.android.healthconnect.HcExerciseSession
import com.enterpriseapp.android.healthconnect.HcSample
import com.enterpriseapp.android.healthconnect.HcSleepSession
import com.enterpriseapp.android.healthconnect.HcSleepStage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

class HealthMappingTest {
    private val zone = ZoneId.of("America/Costa_Rica") // UTC-6, no DST
    private val window = SyncWindow(LocalDate.parse("2026-09-24"), LocalDate.parse("2026-09-30"))

    private fun at(local: String): Instant = java.time.LocalDateTime.parse(local).atZone(zone).toInstant()

    // --- exercise types -------------------------------------------------------------------------

    @Test fun `exercise type table`() {
        val expected = mapOf(
            ExerciseSessionRecord.EXERCISE_TYPE_WALKING to "walk",
            ExerciseSessionRecord.EXERCISE_TYPE_HIKING to "walk",
            ExerciseSessionRecord.EXERCISE_TYPE_RUNNING to "run",
            ExerciseSessionRecord.EXERCISE_TYPE_RUNNING_TREADMILL to "run",
            ExerciseSessionRecord.EXERCISE_TYPE_BIKING to "cardio_any",
            ExerciseSessionRecord.EXERCISE_TYPE_BIKING_STATIONARY to "cardio_any",
            ExerciseSessionRecord.EXERCISE_TYPE_ELLIPTICAL to "cardio_any",
            ExerciseSessionRecord.EXERCISE_TYPE_ROWING_MACHINE to "cardio_any",
            ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_POOL to "cardio_any",
            ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_OPEN_WATER to "cardio_any",
            ExerciseSessionRecord.EXERCISE_TYPE_STAIR_CLIMBING_MACHINE to "cardio_any",
            ExerciseSessionRecord.EXERCISE_TYPE_HIGH_INTENSITY_INTERVAL_TRAINING to "cardio_any",
            ExerciseSessionRecord.EXERCISE_TYPE_STRENGTH_TRAINING to null,
            ExerciseSessionRecord.EXERCISE_TYPE_WEIGHTLIFTING to null,
            ExerciseSessionRecord.EXERCISE_TYPE_YOGA to null,
            ExerciseSessionRecord.EXERCISE_TYPE_SOCCER to null,
            ExerciseSessionRecord.EXERCISE_TYPE_OTHER_WORKOUT to null,
        )
        expected.forEach { (type, kind) -> assertEquals("type $type", kind, HealthMapping.exerciseKind(type)) }
    }

    @Test fun `exercise session maps to an entry with duration, distance and note`() {
        val session = HcExerciseSession(
            id = "rec-1",
            exerciseType = ExerciseSessionRecord.EXERCISE_TYPE_RUNNING,
            start = at("2026-09-28T23:30:00"),
            end = at("2026-09-29T00:15:30"),
            title = "Night run",
            origin = "com.strava",
        )
        val entry = HealthMapping.exercise(session, 5432.1049, zone, window, "Strava")!!
        assertEquals("rec-1", entry.externalId)
        assertEquals("2026-09-28", entry.occurredOn) // local date of the start
        assertEquals("2026-09-29T05:30:00Z", entry.occurredAt)
        assertEquals("run", entry.activityKind)
        assertEquals(2730, entry.durationSeconds)
        assertEquals(5432.1, entry.distanceMeters!!, 0.0)
        assertEquals("via Strava", entry.note)
        assertNull(entry.steps)
    }

    @Test fun `exercise caps duration and distance and skips unusable sessions`() {
        val long = HcExerciseSession("x", ExerciseSessionRecord.EXERCISE_TYPE_WALKING, at("2026-09-25T00:00:00"), at("2026-09-26T06:00:00"), null, "p")
        val entry = HealthMapping.exercise(long, 2_000_000.0, zone, window, "p")!!
        assertEquals(86_400, entry.durationSeconds)
        assertEquals(1_000_000.0, entry.distanceMeters!!, 0.0)

        val zero = long.copy(end = long.start)
        assertNull(HealthMapping.exercise(zero, null, zone, window, "p"))
        val strength = long.copy(exerciseType = ExerciseSessionRecord.EXERCISE_TYPE_STRENGTH_TRAINING)
        assertNull(HealthMapping.exercise(strength, null, zone, window, "p"))
        val before = long.copy(start = at("2026-09-23T23:59:00"), end = at("2026-09-24T00:30:00"))
        assertNull(HealthMapping.exercise(before, null, zone, window, "p"))
        assertNull(HealthMapping.exercise(long, 0.0, zone, window, "p")!!.distanceMeters)
    }

    // --- steps ----------------------------------------------------------------------------------

    @Test fun `daily steps become steps entries, zero days skipped, capped`() {
        val days = listOf(
            DailyAggregate(LocalDate.parse("2026-09-29"), 8123.0, setOf("com.sec.android.app.shealth")),
            DailyAggregate(LocalDate.parse("2026-09-28"), 0.0, emptySet()),
            DailyAggregate(LocalDate.parse("2026-09-30"), 250_000.0, setOf("x")),
            DailyAggregate(LocalDate.parse("2026-09-01"), 100.0, setOf("x")),
        )
        val mapped = HealthMapping.steps(days, window)
        assertEquals(listOf("steps:2026-09-29", "steps:2026-09-30"), mapped.rows.map { it.externalId })
        assertEquals(listOf(8123, 200_000), mapped.rows.map { it.steps })
        assertTrue(mapped.rows.all { it.activityKind == "steps" && it.occurredAt == null })
        assertEquals("2026-09-29", mapped.rows[0].occurredOn)
        assertEquals(1, mapped.dropped)
    }

    // --- heart rate -----------------------------------------------------------------------------

    @Test fun `daily heart rate average is measured at local noon with a day key`() {
        val mapped = HealthMapping.heartRateAverage(
            listOf(
                DailyAggregate(LocalDate.parse("2026-09-27"), 71.6, setOf("o")),
                DailyAggregate(LocalDate.parse("2026-09-28"), 300.0, setOf("o")),
            ),
            zone,
            window,
        )
        assertEquals(1, mapped.rows.size)
        val row = mapped.rows.single()
        assertEquals("hr_avg:2026-09-27", row.externalId)
        assertEquals("heart_rate_avg", row.metricKey)
        assertEquals(72.0, row.value, 0.0)
        assertEquals("bpm", row.unit)
        assertEquals("2026-09-27T18:00:00Z", row.measuredAt) // noon in UTC-6
        assertEquals(1, mapped.dropped)
    }

    @Test fun `samples use record ids, canonical units and bounds`() {
        val samples = listOf(
            HcSample("w1", at("2026-09-25T07:00:00"), 81.234, "com.withings.wiscale2"),
            HcSample("w2", at("2026-09-26T07:00:00"), 5.0, "x"), // below 20 kg
            HcSample("w3", at("2026-09-10T07:00:00"), 80.0, "x"), // outside window
        )
        val mapped = HealthMapping.samples(samples, HealthMapping.Metric.WEIGHT, zone, window)
        assertEquals(listOf("w1"), mapped.rows.map { it.externalId })
        assertEquals(81.2, mapped.rows[0].value, 0.0)
        assertEquals("kg", mapped.rows[0].unit)
        assertEquals(2, mapped.dropped)
        assertEquals("ms", HealthMapping.Metric.HRV.unit)
        assertEquals("%", HealthMapping.Metric.BODY_FAT.unit)
        assertEquals("resting_hr", HealthMapping.Metric.RESTING_HR.key)
    }

    // --- blood pressure -------------------------------------------------------------------------

    @Test fun `blood pressure becomes a systolic and diastolic pair sharing the entry key`() {
        val mapped = HealthMapping.bloodPressure(
            listOf(
                HcBloodPressure("bp1", at("2026-09-27T08:00:00"), 121.6, 79.4, "o"),
                HcBloodPressure("bp2", at("2026-09-27T09:00:00"), 70.0, 90.0, "o"), // systolic not above diastolic
                HcBloodPressure("bp3", at("2026-09-27T10:00:00"), 300.0, 90.0, "o"), // out of bounds
            ),
            zone,
            window,
        )
        assertEquals(listOf("bp1:sys", "bp1:dia"), mapped.rows.map { it.externalId })
        assertTrue(mapped.rows.all { it.entryKey == "bp1" && it.unit == "mmHg" })
        assertEquals(listOf("bp_systolic", "bp_diastolic"), mapped.rows.map { it.metricKey })
        assertEquals(listOf(122.0, 79.0), mapped.rows.map { it.value })
        assertEquals(2, mapped.dropped)
    }

    // --- sleep ----------------------------------------------------------------------------------

    @Test fun `sleep stages are summed into buckets and asleep excludes awake`() {
        val start = at("2026-09-28T22:00:00")
        fun stage(fromMin: Long, toMin: Long, type: Int) =
            HcSleepStage(start.plusSeconds(fromMin * 60), start.plusSeconds(toMin * 60), type)
        val session = HcSleepSession(
            id = "s1",
            start = start,
            end = start.plusSeconds(8 * 3600),
            stages = listOf(
                stage(0, 20, SleepSessionRecord.STAGE_TYPE_AWAKE),
                stage(20, 140, SleepSessionRecord.STAGE_TYPE_LIGHT),
                stage(140, 230, SleepSessionRecord.STAGE_TYPE_DEEP),
                stage(230, 330, SleepSessionRecord.STAGE_TYPE_REM),
                stage(330, 360, SleepSessionRecord.STAGE_TYPE_OUT_OF_BED),
                stage(360, 400, SleepSessionRecord.STAGE_TYPE_SLEEPING),
                stage(400, 420, SleepSessionRecord.STAGE_TYPE_UNKNOWN),
                stage(420, 450, SleepSessionRecord.STAGE_TYPE_AWAKE_IN_BED),
                stage(470, 600, SleepSessionRecord.STAGE_TYPE_LIGHT), // clipped to the session end (480)
            ),
            origin = "com.ouraring.oura",
        )
        val row = HealthMapping.sleep(session, zone, window, "Oura")!!
        assertEquals("2026-09-29", row.localDate) // local date of waking
        assertEquals(20 + 30 + 30, row.awakeMinutes)
        assertEquals(120 + 10, row.lightMinutes)
        assertEquals(90, row.deepMinutes)
        assertEquals(100, row.remMinutes)
        assertEquals(60, row.unknownMinutes)
        assertEquals(480 - 80, row.durationMinutes)
        assertEquals("2026-09-29T04:00:00Z", row.startAt)
        assertEquals("via Oura", row.note)
    }

    @Test fun `sleep without stages uses end minus start and skips implausible sessions`() {
        val start = at("2026-09-29T23:00:00")
        val plain = HcSleepSession("s2", start, start.plusSeconds(7 * 3600 + 20), emptyList(), "o")
        val row = HealthMapping.sleep(plain, zone, window, "o")!!
        assertEquals(420, row.durationMinutes)
        assertNull(row.awakeMinutes)
        assertNull(row.lightMinutes)

        assertNull(HealthMapping.sleep(plain.copy(end = start.plusSeconds(25 * 3600)), zone, window, "o"))
        assertNull(HealthMapping.sleep(plain.copy(end = start.plusSeconds(20)), zone, window, "o"))
        // Woke up after the window.
        assertNull(HealthMapping.sleep(plain.copy(start = at("2026-09-30T23:00:00"), end = at("2026-10-01T06:00:00")), zone, window, "o"))
        assertNotNull(HealthMapping.sleep(plain.copy(start = at("2026-09-23T23:00:00"), end = at("2026-09-24T06:00:00")), zone, window, "o"))
    }
}
