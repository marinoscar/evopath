package com.enterpriseapp.android.sync

import com.enterpriseapp.android.healthconnect.HealthPermissions
import com.enterpriseapp.android.healthconnect.SyncToggle
import com.enterpriseapp.android.testing.FakeSharedPreferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Duration
import java.time.Instant

class SyncStoresTest {
    @Test fun `every type is on by default and toggles persist`() {
        val prefs = FakeSharedPreferences()
        val store = PrefsSyncStateStore(prefs)
        assertEquals(SyncToggle.entries, store.enabledToggles)
        store.setEnabled(SyncToggle.SLEEP, false)
        assertFalse(PrefsSyncStateStore(prefs).isEnabled(SyncToggle.SLEEP))
        assertTrue(PrefsSyncStateStore(prefs).isEnabled(SyncToggle.STEPS))
    }

    @Test fun `resetting pairing state keeps toggles`() {
        val store = PrefsSyncStateStore(FakeSharedPreferences())
        store.setEnabled(SyncToggle.WEIGHT, false)
        store.pairingExpired = true
        store.lastSuccessfulSyncAt = Instant.EPOCH
        store.resetPairingState()
        assertFalse(store.pairingExpired)
        assertNull(store.lastSuccessfulSyncAt)
        assertFalse(store.isEnabled(SyncToggle.WEIGHT))
    }

    @Test fun `permissions follow the enabled toggles`() {
        val perms = SyncToggle.permissionsFor(listOf(SyncToggle.HEART_RATE, SyncToggle.EXERCISE), includeBackground = true)
        assertEquals(
            setOf(
                HealthPermissions.READ_HEART_RATE,
                HealthPermissions.READ_RESTING_HEART_RATE,
                HealthPermissions.READ_EXERCISE,
                HealthPermissions.READ_DISTANCE,
                HealthPermissions.READ_HEALTH_DATA_IN_BACKGROUND,
            ),
            perms,
        )
        assertFalse(HealthPermissions.READ_HEALTH_DATA_IN_BACKGROUND in SyncToggle.permissionsFor(SyncToggle.entries, false))
        assertEquals(10, HealthPermissions.ALL_DATA.size)
    }

    @Test fun `app-open sync is debounced to 15 minutes`() {
        val now = Instant.parse("2026-10-01T12:00:00Z")
        assertTrue(WorkManagerSyncScheduler.appOpenSyncDue(null, now))
        assertFalse(WorkManagerSyncScheduler.appOpenSyncDue(now.minus(Duration.ofMinutes(14)), now))
        assertTrue(WorkManagerSyncScheduler.appOpenSyncDue(now.minus(Duration.ofMinutes(15)), now))
        assertTrue("a clock set backwards does not block syncing", WorkManagerSyncScheduler.appOpenSyncDue(now.plusSeconds(3600), now))
    }

    @Test fun `corrupt history reads as empty`() {
        val prefs = FakeSharedPreferences()
        prefs.edit().putString("runs", "{not json").commit()
        assertTrue(PrefsSyncHistoryStore(prefs).runs().isEmpty())
    }
}
