package com.evopath.android.diagnostics

import com.evopath.android.healthconnect.AppLabels
import com.evopath.android.healthconnect.HcDataType
import com.evopath.android.healthconnect.HcTypeInventory
import kotlinx.serialization.Serializable

/** Report `healthConnect.inventory[].sources[]`. */
@Serializable
data class InventorySource(
    val packageName: String,
    val appLabel: String,
    val recordCount: Int,
    val latestRecordAt: String? = null,
)

/**
 * Report `healthConnect.inventory[]`: what Health Connect holds for one data type over the last
 * 30 days. [permission] is `granted`, `denied` or `unknown` (Health Connect not reachable).
 * Counts stop at [DiagnosticsLimits.INVENTORY_CAP] ([capped] = true).
 */
@Serializable
data class InventoryEntry(
    val dataType: String,
    val label: String,
    val permission: String,
    val recordCount30d: Int = 0,
    val capped: Boolean = false,
    val latestRecordAt: String? = null,
    val sources: List<InventorySource> = emptyList(),
    /** Why the count is missing (read failed or timed out). */
    val error: String? = null,
) {
    val type: HcDataType? get() = HcDataType.fromKey(dataType)

    /** `1000+` when capped. */
    val countText: String get() = if (capped) "$recordCount30d+" else recordCount30d.toString()

    companion object {
        const val GRANTED = "granted"
        const val DENIED = "denied"
        const val UNKNOWN = "unknown"

        fun from(inventory: HcTypeInventory, labels: AppLabels): InventoryEntry = InventoryEntry(
            dataType = inventory.type.key,
            label = inventory.type.label,
            permission = GRANTED,
            recordCount30d = inventory.recordCount,
            capped = inventory.capped,
            latestRecordAt = inventory.latestRecordAt?.toString(),
            sources = inventory.sources.map {
                InventorySource(it.packageName, safeLabel(labels, it.packageName), it.recordCount, it.latestRecordAt?.toString())
            },
        )

        fun denied(type: HcDataType) = InventoryEntry(type.key, type.label, DENIED)
        fun unknown(type: HcDataType) = InventoryEntry(type.key, type.label, UNKNOWN)
        fun failed(type: HcDataType, error: String) = InventoryEntry(type.key, type.label, GRANTED, error = error)

        internal fun safeLabel(labels: AppLabels, pkg: String): String =
            runCatching { labels.label(pkg) }.getOrNull()?.takeIf { it.isNotBlank() } ?: pkg
    }
}

/** Report `healthConnect.sources[]`: one app that wrote into Health Connect in the last 30 days. */
@Serializable
data class SourceSummary(
    val packageName: String,
    val appLabel: String,
    val dataTypes: List<String>,
    val recordCount: Int,
    val latestRecordAt: String? = null,
)

object SourceAggregation {
    /**
     * Union of every type's sources: per package, the data types it wrote, the total record
     * count and the latest record. Most records first.
     */
    fun aggregate(inventory: List<InventoryEntry>): List<SourceSummary> {
        data class Acc(val label: String, val types: LinkedHashSet<String>, var count: Int, var latest: String?)
        val byPackage = linkedMapOf<String, Acc>()
        inventory.forEach { entry ->
            entry.sources.forEach { source ->
                val acc = byPackage.getOrPut(source.packageName) { Acc(source.appLabel, linkedSetOf(), 0, null) }
                acc.types += entry.dataType
                acc.count += source.recordCount
                acc.latest = maxIso(acc.latest, source.latestRecordAt)
            }
        }
        return byPackage
            .map { (pkg, acc) -> SourceSummary(pkg, acc.label, acc.types.toList(), acc.count, acc.latest) }
            .sortedWith(compareByDescending<SourceSummary> { it.recordCount }.thenBy { it.appLabel })
    }

    /** Later of two ISO instants (either may be null or unparsable). */
    fun maxIso(a: String?, b: String?): String? {
        val ia = a?.let { runCatching { java.time.Instant.parse(it) }.getOrNull() }
        val ib = b?.let { runCatching { java.time.Instant.parse(it) }.getOrNull() }
        return when {
            ia == null -> b
            ib == null -> a
            ib.isAfter(ia) -> b
            else -> a
        }
    }
}

object DiagnosticsLimits {
    const val INVENTORY_CAP = 1000
    const val INVENTORY_DAYS = 30L
    const val NETWORK_TIMEOUT_MS = 15_000L
    const val HC_CONNECTION_TIMEOUT_MS = 10_000L
    const val HC_INVENTORY_TIMEOUT_MS = 10_000L
    const val LOCAL_TIMEOUT_MS = 5_000L
    const val SLOW_SERVER_MS = 3_000L
    const val TOKEN_WARN_DAYS = 14L
    const val SYNC_STALE_HOURS = 3L
    const val REPORT_RUNS = 20
    const val REPORT_LOG_LINES = 300
}
