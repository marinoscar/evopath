package com.enterpriseapp.android.diagnostics

import com.enterpriseapp.android.healthconnect.KnownSourceApp
import com.enterpriseapp.android.healthconnect.KnownSourceApps
import com.enterpriseapp.android.healthconnect.SourceApps
import kotlinx.serialization.Serializable

/** An app that wrote records of one type (from the inventory's data origins). */
data class SourceEvidence(val packageName: String, val appLabel: String? = null)

/**
 * An app a remedy names for a data type: report `checks[].data.remedyApps[]` of `hc.data.<type>`.
 * [reason] is [WROTE_DATA] (Health Connect holds its records of the type) or [INSTALLED_CAPABLE]
 * (installed, and [KnownSourceApps] says it can write the type).
 */
@Serializable
data class RemedyApp(
    val packageName: String,
    val appLabel: String,
    val reason: String,
) {
    companion object {
        const val WROTE_DATA = "wrote_data"
        const val INSTALLED_CAPABLE = "installed_capable"
    }
}

/**
 * Which apps could supply a data type. Health Connect cannot say which apps may write a type,
 * so this derives it: pure (no Android types), so the JVM tests cover every case.
 */
object RemedyApps {
    /** Health Connect itself (manual entries): never a useful "open this app" suggestion. */
    val HEALTH_CONNECT_PACKAGES = setOf("com.google.android.apps.healthdata", "com.android.healthconnect.controller")

    /**
     * Candidates for [typeKey], in order and without duplicates:
     * 1. apps with [evidence] for this type (they wrote it, so they are the surest answer);
     * 2. [installed] apps whose [known] capabilities include the type (table order);
     * 3. apps already [feeding] Health Connect other types whose capabilities include it (an app
     *    that writes data is installed even when the PackageManager could not see it).
     */
    fun select(
        typeKey: String,
        evidence: List<SourceEvidence>,
        installed: Set<String>,
        feeding: Set<String> = emptySet(),
        known: List<KnownSourceApp> = KnownSourceApps.ALL,
    ): List<RemedyApp> {
        val byPackage = known.associateBy { it.packageName }
        val result = linkedMapOf<String, RemedyApp>()
        evidence.forEach { e ->
            if (e.packageName in HEALTH_CONNECT_PACKAGES || e.packageName in result) return@forEach
            result[e.packageName] = RemedyApp(e.packageName, label(e.packageName, e.appLabel, byPackage), RemedyApp.WROTE_DATA)
        }
        val capable = known.filter { typeKey in it.writes && it.packageName !in HEALTH_CONNECT_PACKAGES }
        capable.filter { it.packageName in installed }.forEach { app ->
            result.putIfAbsent(app.packageName, RemedyApp(app.packageName, app.label, RemedyApp.INSTALLED_CAPABLE))
        }
        capable.filter { it.packageName in feeding }.forEach { app ->
            result.putIfAbsent(app.packageName, RemedyApp(app.packageName, app.label, RemedyApp.INSTALLED_CAPABLE))
        }
        return result.values.toList()
    }

    /** Labels of the [installed] (or [feeding]) apps in [known], table order: for the `hc.sources` remedy. */
    fun installedKnown(
        installed: Set<String>,
        feeding: Set<String> = emptySet(),
        known: List<KnownSourceApp> = KnownSourceApps.ALL,
    ): List<String> = known.filter { it.packageName in installed || it.packageName in feeding }.map { it.label }

    /** The evidence's label, else the table's, else the general fallback (known name or package). */
    private fun label(pkg: String, given: String?, known: Map<String, KnownSourceApp>): String =
        given?.takeIf { it.isNotBlank() && it != pkg } ?: known[pkg]?.label ?: SourceApps.fallbackLabel(pkg)

    /** "A", "A (or B)", "A (or B, or C)". */
    fun orList(labels: List<String>): String = when (labels.size) {
        0 -> ""
        1 -> labels[0]
        else -> labels[0] + " (or " + labels.drop(1).joinToString(", or ") + ")"
    }
}
