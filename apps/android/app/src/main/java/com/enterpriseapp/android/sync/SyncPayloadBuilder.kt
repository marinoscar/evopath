package com.enterpriseapp.android.sync

import com.enterpriseapp.android.healthconnect.AppLabels
import com.enterpriseapp.android.healthconnect.HcDataType
import com.enterpriseapp.android.net.ApiClient
import java.time.Instant

/** What happened to one Health Connect data type during a run. */
data class TypeOutcome(
    val type: HcDataType,
    /** The user's toggle. */
    val enabled: Boolean,
    /** Health Connect read permission. */
    val granted: Boolean,
    val read: Int = 0,
    val entries: List<SyncEntry> = emptyList(),
    val measurements: List<SyncMeasurement> = emptyList(),
    val sleepSessions: List<SyncSleepSession> = emptyList(),
    val dropped: Int = 0,
    /** Set when the read failed: the type is then partial and absent from `syncedTypes`. */
    val error: String? = null,
    /** Source package → records (or daily aggregates) read from it. */
    val sources: Map<String, Int> = emptyMap(),
) {
    /** Enabled and permitted, so the engine tried to read it. */
    val attempted: Boolean get() = enabled && granted

    val rowCount: Int get() = entries.size + measurements.size + sleepSessions.size
}

/** The payload plus the decisions the engine and local history need. */
data class BuiltSync(
    val request: SyncRequest,
    val status: String,
    val syncedTypes: List<String>,
    val recordsRead: Int,
    val rowsSent: Int,
)

/**
 * Assembles `POST /devices/:id/sync` from per-type outcomes.
 *
 * - `syncedTypes` = attempted synced types read without error and sent in full (a truncated
 *   type is left out so the server never deletes rows it simply did not receive).
 * - status: `skipped` when nothing could be read, `failed` when every attempted type failed,
 *   `partial` when some did, else `ok`.
 * - Enforces the API's maxima (entries 1000, measurements 3000, sleep 200), keeping the newest
 *   rows and whole blood-pressure pairs, and keeps `details` well under 32 KB.
 */
class SyncPayloadBuilder(
    private val labels: AppLabels,
    private val maxEntries: Int = MAX_ENTRIES,
    private val maxMeasurements: Int = MAX_MEASUREMENTS,
    private val maxSleep: Int = MAX_SLEEP,
) {
    fun build(
        trigger: SyncTrigger,
        startedAt: Instant,
        finishedAt: Instant,
        window: SyncWindow,
        timezone: String,
        outcomes: List<TypeOutcome>,
    ): BuiltSync {
        var entriesLeft = maxEntries
        var measurementsLeft = maxMeasurements
        var sleepLeft = maxSleep
        val capped = outcomes.map { outcome ->
            if (!outcome.attempted || outcome.error != null) return@map outcome
            val entries = newest(outcome.entries, entriesLeft)
            val measurements = newestMeasurements(outcome.measurements, measurementsLeft)
            val sleep = newest(outcome.sleepSessions, sleepLeft)
            entriesLeft -= entries.size
            measurementsLeft -= measurements.size
            sleepLeft -= sleep.size
            val cut = outcome.rowCount - (entries.size + measurements.size + sleep.size)
            if (cut == 0) {
                outcome
            } else {
                outcome.copy(
                    entries = entries,
                    measurements = measurements,
                    sleepSessions = sleep,
                    dropped = outcome.dropped + cut,
                    error = "Payload limit: sent ${outcome.rowCount - cut} of ${outcome.rowCount} rows",
                )
            }
        }

        val attempted = capped.filter { it.attempted && it.type.isSyncedType }
        val failed = attempted.filter { it.error != null }
        val syncedTypes = attempted.filter { it.error == null }.map { it.type.key }
        val status = when {
            attempted.isEmpty() -> RunStatus.SKIPPED
            failed.isEmpty() -> RunStatus.OK
            failed.size == attempted.size -> RunStatus.FAILED
            else -> RunStatus.PARTIAL
        }
        val (errorCode, errorMessage) = when (status) {
            RunStatus.SKIPPED -> "NO_READABLE_TYPES" to "No enabled data type has Health Connect permission."
            RunStatus.FAILED -> "HC_READ_FAILED" to failed.joinToString("; ") { "${it.type.key}: ${it.error}" }
            RunStatus.PARTIAL -> "HC_PARTIAL_READ" to failed.joinToString("; ") { "${it.type.key}: ${it.error}" }
            else -> null to null
        }

        // A failed read carries no rows; a truncated type still sends what fit.
        val sent = capped.filter { it.attempted }
        val entries = sent.flatMap { it.entries }
        val measurements = sent.flatMap { it.measurements }
        val sleep = sent.flatMap { it.sleepSessions }
        val recordsRead = capped.sumOf { it.read }

        val details = fitDetails(
            RunDetails(
                syncedTypes = syncedTypes,
                perType = capped.associate { it.type.key to perType(it) },
                sources = sources(capped),
                timezone = timezone,
                window = window.toDto(),
            ),
        )

        val request = SyncRequest(
            run = SyncRun(
                trigger = trigger.wire,
                status = status,
                startedAt = Iso.instant(startedAt),
                finishedAt = Iso.instant(finishedAt),
                recordsRead = recordsRead,
                errorCode = errorCode,
                errorMessage = errorMessage?.take(MAX_ERROR_MESSAGE),
                details = details,
                timezone = Iso.ianaZone(timezone),
            ),
            window = window.toDto(),
            entries = entries,
            measurements = measurements.takeIf { it.isNotEmpty() },
            sleepSessions = sleep.takeIf { it.isNotEmpty() },
        )
        return BuiltSync(request, status, syncedTypes, recordsRead, entries.size + measurements.size + sleep.size)
    }

    private fun perType(outcome: TypeOutcome) = PerTypeDetail(
        permission = if (outcome.granted) "granted" else "denied",
        enabled = outcome.enabled,
        read = outcome.read,
        sent = outcome.rowCount,
        dropped = outcome.dropped,
        error = outcome.error?.take(MAX_TYPE_ERROR),
    )

    private fun sources(outcomes: List<TypeOutcome>): List<SourceDetail> {
        val types = linkedMapOf<String, MutableSet<String>>()
        val counts = mutableMapOf<String, Int>()
        outcomes.forEach { outcome ->
            outcome.sources.forEach { (pkg, n) ->
                types.getOrPut(pkg) { linkedSetOf() } += outcome.type.key
                counts[pkg] = (counts[pkg] ?: 0) + n
            }
        }
        return types.keys
            .map { pkg -> SourceDetail(pkg, labels.label(pkg), types.getValue(pkg).toList(), counts[pkg] ?: 0) }
            .sortedByDescending { it.recordCount }
            .take(MAX_SOURCES)
    }

    /** Keeps the serialized details far below the API's 32 KB limit. */
    private fun fitDetails(details: RunDetails): RunDetails {
        if (serializedSize(details) <= DETAILS_BUDGET) return details
        val fewerSources = details.copy(sources = details.sources.take(5))
        if (serializedSize(fewerSources) <= DETAILS_BUDGET) return fewerSources
        return fewerSources.copy(sources = emptyList(), perType = details.perType.mapValues { it.value.copy(error = it.value.error?.take(80)) })
    }

    companion object {
        const val MAX_ENTRIES = 1000
        const val MAX_MEASUREMENTS = 3000
        const val MAX_SLEEP = 200
        const val MAX_ERROR_MESSAGE = 2000
        const val MAX_TYPE_ERROR = 300
        const val MAX_SOURCES = 30
        const val DETAILS_BUDGET = 24 * 1024

        fun serializedSize(details: RunDetails): Int =
            ApiClient.ApiJson.encodeToString(RunDetails.serializer(), details).toByteArray(Charsets.UTF_8).size

        /** The last [limit] rows (rows are oldest-first). */
        private fun <T> newest(rows: List<T>, limit: Int): List<T> =
            if (rows.size <= limit) rows else rows.takeLast(limit.coerceAtLeast(0))

        /** Like [newest], but never splits rows that share an `entryKey` (a BP pair). */
        private fun newestMeasurements(rows: List<SyncMeasurement>, limit: Int): List<SyncMeasurement> {
            if (rows.size <= limit) return rows
            val groups = rows.groupBy { it.entryKey ?: it.externalId }.values.toList()
            val kept = ArrayDeque<List<SyncMeasurement>>()
            var size = 0
            for (group in groups.asReversed()) {
                if (size + group.size > limit) break
                kept.addFirst(group)
                size += group.size
            }
            return kept.flatten()
        }
    }
}
