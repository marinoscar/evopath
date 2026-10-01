package com.enterpriseapp.android.sync

import com.enterpriseapp.android.healthconnect.HcDataType
import com.enterpriseapp.android.net.ApiClient
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.LocalDate

class SyncPayloadBuilderTest {
    private val window = SyncWindow(LocalDate.parse("2026-09-25"), LocalDate.parse("2026-10-01"))
    private val started = Instant.parse("2026-10-01T12:00:00Z")
    private val finished = Instant.parse("2026-10-01T12:00:05Z")
    private val labels = com.enterpriseapp.android.healthconnect.AppLabels { pkg -> if (pkg == "com.sec.android.app.shealth") "Samsung Health" else pkg }

    private fun entry(id: String, day: String = "2026-09-30") = SyncEntry(id, day, activityKind = "steps", steps = 10)
    private fun measurement(id: String, key: String? = null) =
        SyncMeasurement(id, key, "weight", 80.0, "kg", "2026-09-30T08:00:00Z")
    private fun sleep(id: String) = SyncSleepSession(id, "2026-09-29T22:00:00Z", "2026-09-30T06:00:00Z", "2026-09-30", 480)

    private fun outcome(type: HcDataType, enabled: Boolean = true, granted: Boolean = true) = TypeOutcome(type, enabled, granted)

    private fun build(outcomes: List<TypeOutcome>, builder: SyncPayloadBuilder = SyncPayloadBuilder(labels)) =
        builder.build(SyncTrigger.MANUAL, started, finished, window, "America/Costa_Rica", outcomes)

    @Test fun `all attempted types read fine - ok, every one synced`() {
        val built = build(
            listOf(
                outcome(HcDataType.STEPS).copy(read = 2, entries = listOf(entry("steps:2026-09-30")), sources = mapOf("com.sec.android.app.shealth" to 2)),
                outcome(HcDataType.WEIGHT).copy(read = 1, measurements = listOf(measurement("w1")), sources = mapOf("com.withings.wiscale2" to 1)),
                outcome(HcDataType.SLEEP).copy(read = 1, sleepSessions = listOf(sleep("s1")), sources = mapOf("com.sec.android.app.shealth" to 1)),
                outcome(HcDataType.HRV, enabled = false),
                outcome(HcDataType.BLOOD_PRESSURE, granted = false),
            ),
        )
        assertEquals(RunStatus.OK, built.status)
        assertEquals(listOf("steps", "weight", "sleep"), built.syncedTypes)
        val run = built.request.run
        assertEquals("manual", run.trigger)
        assertEquals("2026-10-01T12:00:00Z", run.startedAt)
        assertEquals(4, run.recordsRead)
        assertNull(run.errorCode)
        assertEquals("America/Costa_Rica", run.timezone)
        assertEquals(SyncWindowDto("2026-09-25", "2026-10-01"), built.request.window)
        assertEquals(1, built.request.entries.size)
        assertEquals(1, built.request.measurements!!.size)
        assertEquals(1, built.request.sleepSessions!!.size)

        val details = run.details!!
        assertEquals(PerTypeDetail("denied", enabled = true, read = 0, sent = 0), details.perType["blood_pressure"])
        assertEquals(PerTypeDetail("granted", enabled = false, read = 0, sent = 0), details.perType["hrv"])
        assertEquals(PerTypeDetail("granted", enabled = true, read = 2, sent = 1), details.perType["steps"])
        val samsung = details.sources.first { it.packageName == "com.sec.android.app.shealth" }
        assertEquals("Samsung Health", samsung.appLabel)
        assertEquals(listOf("steps", "sleep"), samsung.dataTypes)
        assertEquals(3, samsung.recordCount)
    }

    @Test fun `a failed type makes the run partial and is left out of syncedTypes`() {
        val built = build(
            listOf(
                outcome(HcDataType.STEPS).copy(read = 1, entries = listOf(entry("steps:2026-09-30"))),
                outcome(HcDataType.SLEEP).copy(error = "SecurityException: denied"),
            ),
        )
        assertEquals(RunStatus.PARTIAL, built.status)
        assertEquals(listOf("steps"), built.syncedTypes)
        assertEquals("HC_PARTIAL_READ", built.request.run.errorCode)
        assertEquals("sleep: SecurityException: denied", built.request.run.errorMessage)
        assertEquals("SecurityException: denied", built.request.run.details!!.perType["sleep"]!!.error)
        assertNull(built.request.sleepSessions)
    }

    @Test fun `every attempted type failing is a failed run, nothing readable is skipped`() {
        val failed = build(listOf(outcome(HcDataType.STEPS).copy(error = "RemoteException")))
        assertEquals(RunStatus.FAILED, failed.status)
        assertEquals("HC_READ_FAILED", failed.request.run.errorCode)
        assertTrue(failed.syncedTypes.isEmpty())

        val skipped = build(listOf(outcome(HcDataType.STEPS, granted = false), outcome(HcDataType.SLEEP, enabled = false)))
        assertEquals(RunStatus.SKIPPED, skipped.status)
        assertEquals("NO_READABLE_TYPES", skipped.request.run.errorCode)
        assertTrue(skipped.request.entries.isEmpty())
    }

    @Test fun `distance never counts as a synced type`() {
        val built = build(
            listOf(
                outcome(HcDataType.EXERCISE).copy(read = 0),
                outcome(HcDataType.DISTANCE).copy(error = "SecurityException"),
            ),
        )
        assertEquals(RunStatus.OK, built.status)
        assertEquals(listOf("exercise"), built.syncedTypes)
        assertEquals("SecurityException", built.request.run.details!!.perType["distance"]!!.error)
    }

    @Test fun `rows over the API maxima are cut to the newest and the type is not synced`() {
        val builder = SyncPayloadBuilder(labels, maxEntries = 3, maxMeasurements = 3, maxSleep = 1)
        val built = build(
            listOf(
                outcome(HcDataType.STEPS).copy(entries = (1..2).map { entry("steps:$it") }),
                outcome(HcDataType.EXERCISE).copy(entries = (1..3).map { entry("ex$it") }),
                outcome(HcDataType.BLOOD_PRESSURE).copy(
                    measurements = listOf(
                        measurement("a:sys", "a"), measurement("a:dia", "a"),
                        measurement("b:sys", "b"), measurement("b:dia", "b"),
                    ),
                ),
                outcome(HcDataType.SLEEP).copy(sleepSessions = listOf(sleep("s1"), sleep("s2"))),
            ),
            builder,
        )
        assertEquals(listOf("steps:1", "steps:2", "ex3"), built.request.entries.map { it.externalId })
        // Whole blood-pressure pairs only: 3 slots hold one pair, the newest.
        assertEquals(listOf("b:sys", "b:dia"), built.request.measurements!!.map { it.externalId })
        assertEquals(listOf("s2"), built.request.sleepSessions!!.map { it.externalId })
        assertEquals(listOf("steps"), built.syncedTypes)
        assertEquals(RunStatus.PARTIAL, built.status)
        val exercise = built.request.run.details!!.perType["exercise"]!!
        assertEquals(1, exercise.sent)
        assertEquals(2, exercise.dropped)
        assertEquals("Payload limit: sent 1 of 3 rows", exercise.error)
    }

    @Test fun `default maxima match the API`() {
        assertEquals(1000, SyncPayloadBuilder.MAX_ENTRIES)
        assertEquals(3000, SyncPayloadBuilder.MAX_MEASUREMENTS)
        assertEquals(200, SyncPayloadBuilder.MAX_SLEEP)
    }

    @Test fun `details stay far below 32 KB even with many sources and long errors`() {
        val sources = (1..400).associate { "com.example.source$it.with.a.long.package.name" to it }
        val built = build(
            HcDataType.SYNCED.map { outcome(it).copy(error = "x".repeat(5000), sources = sources) },
        )
        val size = SyncPayloadBuilder.serializedSize(built.request.run.details!!)
        assertTrue("details is $size bytes", size <= SyncPayloadBuilder.DETAILS_BUDGET)
        assertTrue(built.request.run.errorMessage!!.length <= 2000)
    }

    @Test fun `serialized payload omits nulls and empty optional arrays`() {
        val built = build(listOf(outcome(HcDataType.STEPS).copy(entries = listOf(entry("steps:2026-09-30")))))
        val json = ApiClient.ApiJson.encodeToJsonElement(SyncRequest.serializer(), built.request).jsonObject
        assertFalse("measurements" in json)
        assertFalse("sleepSessions" in json)
        val run = json.getValue("run").jsonObject
        assertFalse("errorCode" in run)
        val entry = json.getValue("entries").jsonArray.single().jsonObject
        assertEquals(setOf("externalId", "occurredOn", "activityKind", "steps"), entry.keys)
        assertEquals("steps", entry.getValue("activityKind").jsonPrimitive.content)
        val details = run.getValue("details") as JsonObject
        assertEquals(listOf("steps"), details.getValue("syncedTypes").jsonArray.map { it.jsonPrimitive.content })
    }

    @Test fun `a non-IANA phone zone is not sent as the run timezone`() {
        val built = SyncPayloadBuilder(labels).build(SyncTrigger.PERIODIC, started, finished, window, "GMT+05:00", emptyList())
        assertNull(built.request.run.timezone)
        assertEquals("GMT+05:00", built.request.run.details!!.timezone)
    }
}
