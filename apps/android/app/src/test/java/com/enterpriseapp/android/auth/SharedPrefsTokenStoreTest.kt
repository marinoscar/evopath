package com.enterpriseapp.android.auth

import com.enterpriseapp.android.testing.FakeSharedPreferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.util.UUID

class SharedPrefsTokenStoreTest {
    @Test fun `stores and clears pairing state but keeps the installation id`() {
        val store = SharedPrefsTokenStore(FakeSharedPreferences())
        val installationId = store.installationId
        UUID.fromString(installationId) // valid UUID
        assertEquals(installationId, store.installationId)
        assertFalse(store.isPaired)

        val expiry = Instant.parse("2026-12-30T00:00:00Z")
        store.setToken("pat_abc", expiry)
        store.setDeviceId("dev-1")
        assertTrue(store.isPaired)
        assertEquals("pat_abc", store.token)
        assertEquals(expiry, store.expiresAt)
        assertEquals("dev-1", store.deviceId)

        store.clear()
        assertFalse(store.isPaired)
        assertNull(store.expiresAt)
        assertNull(store.deviceId)
        assertEquals(installationId, store.installationId)
    }
}
