package com.evopath.android.sync

import kotlinx.serialization.Serializable

// `POST /api/health-sync/devices/:id/sync` (HS contract, REST item 3 + SCOPE UPDATE).
// The API's Zod schemas are strict: no unknown keys and no `null` for optional fields. ApiJson
// has `explicitNulls = false`, so a null property below is simply omitted.

/** Wire values of `HealthSyncTrigger`. */
enum class SyncTrigger(val wire: String) {
    PERIODIC("periodic"),
    MANUAL("manual"),
    INITIAL("initial"),
    APP_OPEN("app_open"),
    ;

    companion object {
        fun fromWire(value: String?): SyncTrigger = entries.firstOrNull { it.wire == value } ?: PERIODIC
    }
}

/** Wire values of `HealthSyncRunStatus`. */
object RunStatus {
    const val OK = "ok"
    const val PARTIAL = "partial"
    const val FAILED = "failed"
    const val SKIPPED = "skipped"
}

@Serializable
data class SyncRequest(
    val run: SyncRun,
    val window: SyncWindowDto? = null,
    val entries: List<SyncEntry> = emptyList(),
    val measurements: List<SyncMeasurement>? = null,
    val sleepSessions: List<SyncSleepSession>? = null,
)

@Serializable
data class SyncRun(
    val trigger: String,
    val status: String,
    val startedAt: String,
    val finishedAt: String,
    val recordsRead: Int? = null,
    val errorCode: String? = null,
    val errorMessage: String? = null,
    val details: RunDetails? = null,
    val timezone: String? = null,
)

@Serializable
data class SyncWindowDto(val from: String, val to: String)

@Serializable
data class SyncEntry(
    val externalId: String,
    val occurredOn: String,
    val occurredAt: String? = null,
    val activityKind: String,
    val durationSeconds: Int? = null,
    val distanceMeters: Double? = null,
    val steps: Int? = null,
    val note: String? = null,
)

@Serializable
data class SyncMeasurement(
    val externalId: String,
    val entryKey: String? = null,
    val metricKey: String,
    val value: Double,
    val unit: String,
    val measuredAt: String,
    val method: String? = null,
)

@Serializable
data class SyncSleepSession(
    val externalId: String,
    val startAt: String,
    val endAt: String,
    val localDate: String,
    val durationMinutes: Int,
    val awakeMinutes: Int? = null,
    val lightMinutes: Int? = null,
    val deepMinutes: Int? = null,
    val remMinutes: Int? = null,
    val unknownMinutes: Int? = null,
    val note: String? = null,
)

/**
 * `run.details`. [syncedTypes] scopes the server's reconciliation: only types read in full
 * this run are listed, so a type that is off, not permitted or failed is never "emptied".
 */
@Serializable
data class RunDetails(
    val syncedTypes: List<String>,
    val perType: Map<String, PerTypeDetail>,
    val sources: List<SourceDetail>,
    val timezone: String,
    val window: SyncWindowDto? = null,
)

@Serializable
data class PerTypeDetail(
    /** `granted` | `denied`. */
    val permission: String,
    /** The user's toggle for this type. */
    val enabled: Boolean,
    /** Records (or daily aggregates) read from Health Connect. */
    val read: Int,
    /** Rows put in this payload. */
    val sent: Int,
    /** Rows read but not sent (out of window, out of bounds, unsupported kind, over the cap). */
    val dropped: Int = 0,
    val error: String? = null,
)

@Serializable
data class SourceDetail(
    val packageName: String,
    val appLabel: String,
    val dataTypes: List<String>,
    val recordCount: Int,
)

@Serializable
data class SyncCounts(
    val created: Int = 0,
    val updated: Int = 0,
    val deleted: Int = 0,
    val unchanged: Int = 0,
    val skipped: Int = 0,
)

/** Response of the sync route: activity entry counts at the top level, then per table. */
@Serializable
data class SyncResponse(
    val runId: String,
    val created: Int = 0,
    val updated: Int = 0,
    val deleted: Int = 0,
    val unchanged: Int = 0,
    val skipped: Int = 0,
    val measurements: SyncCounts? = null,
    val sleep: SyncCounts? = null,
) {
    val totalCreated: Int get() = created + (measurements?.created ?: 0) + (sleep?.created ?: 0)
    val totalUpdated: Int get() = updated + (measurements?.updated ?: 0) + (sleep?.updated ?: 0)
    val totalDeleted: Int get() = deleted + (measurements?.deleted ?: 0) + (sleep?.deleted ?: 0)
}
