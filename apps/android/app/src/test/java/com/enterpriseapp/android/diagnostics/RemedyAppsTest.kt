package com.enterpriseapp.android.diagnostics

import com.enterpriseapp.android.healthconnect.HcDataType
import com.enterpriseapp.android.healthconnect.KnownSourceApps
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RemedyAppsTest {
    private val samsung = "com.sec.android.app.shealth"
    private val oura = "com.ouraring.oura"
    private val garmin = "com.garmin.android.apps.connectmobile"
    private val fit = "com.google.android.apps.fitness"

    private fun select(
        type: HcDataType,
        evidence: List<SourceEvidence> = emptyList(),
        installed: Set<String> = emptySet(),
        feeding: Set<String> = emptySet(),
    ) = RemedyApps.select(type.key, evidence, installed, feeding)

    @Test fun `HRV with Samsung Health and Oura installed names Oura only`() {
        val apps = select(HcDataType.HRV, installed = setOf(samsung, oura))
        assertEquals(listOf(RemedyApp(oura, "Oura", RemedyApp.INSTALLED_CAPABLE)), apps)
    }

    @Test fun `HRV with only Samsung Health installed has no candidate and the none remedy`() {
        val apps = select(HcDataType.HRV, installed = setOf(samsung))
        assertTrue(apps.isEmpty())
        assertEquals(
            "None of the apps on this phone write heart rate variability to Health Connect. " +
                "If you don't track it, turn Heart rate variability off on the Sync screen.",
            Checks.missingDataRemedy(HcDataType.HRV, apps),
        )
    }

    @Test fun `resting heart rate is not suggested from Samsung Health`() {
        assertTrue(select(HcDataType.RESTING_HEART_RATE, installed = setOf(samsung)).isEmpty())
        assertEquals(listOf(garmin), select(HcDataType.RESTING_HEART_RATE, installed = setOf(samsung, garmin)).map { it.packageName })
    }

    @Test fun `steps with both installed names both, evidence first`() {
        val apps = select(
            HcDataType.STEPS,
            evidence = listOf(SourceEvidence(oura, "Oura")),
            installed = setOf(samsung, oura),
        )
        assertEquals(
            listOf(RemedyApp(oura, "Oura", RemedyApp.WROTE_DATA), RemedyApp(samsung, "Samsung Health", RemedyApp.INSTALLED_CAPABLE)),
            apps,
        )
    }

    @Test fun `steps with both installed and no evidence follow the table order`() {
        assertEquals(listOf(samsung, oura), select(HcDataType.STEPS, installed = setOf(oura, samsung)).map { it.packageName })
    }

    @Test fun `an unknown package with evidence is included with its label or a fallback`() {
        val labelled = select(HcDataType.WEIGHT, evidence = listOf(SourceEvidence("com.example.scale", "Example Scale")))
        assertEquals(listOf(RemedyApp("com.example.scale", "Example Scale", RemedyApp.WROTE_DATA)), labelled)

        val unlabelled = select(HcDataType.WEIGHT, evidence = listOf(SourceEvidence("com.example.scale", null)))
        assertEquals("com.example.scale", unlabelled.single().appLabel)

        // A label that is only the package name falls back to the known name.
        val known = select(HcDataType.STEPS, evidence = listOf(SourceEvidence("com.strava", "com.strava")))
        assertEquals("Strava", known.single().appLabel)
    }

    @Test fun `evidence is kept even when the table says the app cannot write the type`() {
        val apps = select(HcDataType.HRV, evidence = listOf(SourceEvidence(samsung, "Samsung Health")), installed = setOf(samsung))
        assertEquals(listOf(RemedyApp(samsung, "Samsung Health", RemedyApp.WROTE_DATA)), apps)
    }

    @Test fun `a capable app already feeding other types outranks an installed one feeding nothing`() {
        // Table order is Oura before Garmin; Garmin feeds sleep, Oura feeds nothing.
        val apps = select(HcDataType.HRV, installed = setOf(oura, garmin), feeding = setOf(garmin, samsung))
        assertEquals(
            listOf(RemedyApp(garmin, "Garmin Connect", RemedyApp.INSTALLED_CAPABLE), RemedyApp(oura, "Oura", RemedyApp.INSTALLED_CAPABLE)),
            apps,
        )
    }

    @Test fun `order is wrote this type, then capable feeding apps, then capable installed apps`() {
        val apps = select(
            HcDataType.STEPS,
            evidence = listOf(SourceEvidence(fit, "Google Fit")),
            installed = setOf(samsung, oura, fit),
            feeding = setOf(fit, oura),
        )
        assertEquals(listOf(fit, oura, samsung), apps.map { it.packageName })
        assertEquals(RemedyApp.WROTE_DATA, apps.first().reason)
    }

    @Test fun `a feeding app the PackageManager cannot see is still a candidate`() {
        val apps = select(HcDataType.HRV, installed = setOf(oura), feeding = setOf(garmin))
        assertEquals(listOf(garmin, oura), apps.map { it.packageName })
    }

    @Test fun `Health Connect itself is never a candidate and duplicates collapse`() {
        val apps = select(
            HcDataType.WEIGHT,
            evidence = listOf(
                SourceEvidence("com.google.android.apps.healthdata", "Health Connect"),
                SourceEvidence(fit, "Google Fit"),
                SourceEvidence(fit, "Google Fit"),
            ),
            installed = setOf(fit),
            feeding = setOf(fit),
        )
        assertEquals(listOf(RemedyApp(fit, "Google Fit", RemedyApp.WROTE_DATA)), apps)
    }

    @Test fun `nothing installed and no evidence gives no candidate`() {
        HcDataType.SYNCED.forEach { assertTrue(it.key, select(it).isEmpty()) }
    }

    @Test fun `the capability table uses real data type keys and the required apps`() {
        val keys = HcDataType.entries.map { it.key }.toSet()
        KnownSourceApps.ALL.forEach { app -> assertTrue(app.packageName, keys.containsAll(app.writes)) }
        assertEquals(KnownSourceApps.ALL.size, KnownSourceApps.PACKAGES.toSet().size)
        listOf(samsung, oura, "com.fitbit.FitbitMobile", fit, garmin, "com.withings.wiscale2", "fi.polar.polarflow")
            .forEach { assertTrue(it, it in KnownSourceApps.BY_PACKAGE) }
        val shealth = KnownSourceApps.BY_PACKAGE.getValue(samsung).writes
        assertTrue("hrv" !in shealth && "resting_heart_rate" !in shealth)
    }

    @Test fun `installed known lists table labels for installed or feeding apps`() {
        assertEquals(listOf("Samsung Health", "Oura"), RemedyApps.installedKnown(setOf(oura), feeding = setOf(samsung, "com.strava")))
        assertTrue(RemedyApps.installedKnown(emptySet()).isEmpty())
    }

    @Test fun `or list`() {
        assertEquals("", RemedyApps.orList(emptyList()))
        assertEquals("A", RemedyApps.orList(listOf("A")))
        assertEquals("A (or B)", RemedyApps.orList(listOf("A", "B")))
        assertEquals("A (or B, or C)", RemedyApps.orList(listOf("A", "B", "C")))
    }
}
