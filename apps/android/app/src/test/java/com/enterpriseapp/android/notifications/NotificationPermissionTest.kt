package com.enterpriseapp.android.notifications

import com.enterpriseapp.android.testing.FakeSharedPreferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationPermissionTest {
    private fun state(sdk: Int = 34, granted: Boolean = false, enabled: Boolean = true, asked: Boolean = false, rationale: Boolean = false) =
        NotificationPermissions.state(sdk, granted, enabled, asked, rationale)

    // --- permission state -------------------------------------------------------------------

    @Test fun `granted on Android 13+`() {
        assertEquals(NotificationPermissionState.GRANTED, state(granted = true))
    }

    @Test fun `never asked shows the system dialog`() {
        assertEquals(NotificationPermissionState.NOT_ASKED, state())
    }

    @Test fun `denied once can be asked again`() {
        assertEquals(NotificationPermissionState.DENIED, state(asked = true, rationale = true))
        // Denied through the web app's request (our flag unset): still a plain denial.
        assertEquals(NotificationPermissionState.DENIED, state(asked = false, rationale = true))
    }

    @Test fun `asked before and no rationale is permanently denied`() {
        assertEquals(NotificationPermissionState.PERMANENTLY_DENIED, state(asked = true, rationale = false))
    }

    @Test fun `below Android 13 only the app switch matters`() {
        assertEquals(NotificationPermissionState.GRANTED, state(sdk = 32, granted = false, enabled = true))
        assertEquals(NotificationPermissionState.DISABLED, state(sdk = 26, granted = false, enabled = false, asked = true))
    }

    @Test fun `granted but switched off is disabled`() {
        assertEquals(NotificationPermissionState.DISABLED, state(granted = true, enabled = false))
    }

    @Test fun `only not asked and denied can show the dialog`() {
        assertEquals(
            setOf(NotificationPermissionState.NOT_ASKED, NotificationPermissionState.DENIED),
            NotificationPermissionState.entries.filter { it.canRequest }.toSet(),
        )
    }

    // --- UI mapping ---------------------------------------------------------------------------

    @Test fun `row for each state`() {
        val granted = NotificationPermissions.row(NotificationPermissionState.GRANTED, "Acme")
        assertTrue(granted.ok)
        assertNull(granted.action)
        assertNull(granted.actionLabel)
        assertEquals("Allowed", granted.status)

        listOf(NotificationPermissionState.NOT_ASKED, NotificationPermissionState.DENIED).forEach {
            val row = NotificationPermissions.row(it, "Acme")
            assertFalse(row.ok)
            assertEquals(NotificationAction.REQUEST, row.action)
            assertEquals("Allow", row.actionLabel)
        }

        listOf(NotificationPermissionState.PERMANENTLY_DENIED, NotificationPermissionState.DISABLED).forEach {
            val row = NotificationPermissions.row(it, "Acme")
            assertFalse(row.ok)
            assertEquals(NotificationAction.OPEN_SETTINGS, row.action)
            assertEquals("Open settings", row.actionLabel)
        }
        assertEquals("Blocked", NotificationPermissions.row(NotificationPermissionState.PERMANENTLY_DENIED, "Acme").status)
    }

    @Test fun `row action matches the action mapping and names the product`() {
        NotificationPermissionState.entries.forEach {
            val row = NotificationPermissions.row(it, "Acme")
            assertEquals(it.name, NotificationPermissions.action(it), row.action)
            row.detail?.let { detail -> assertTrue(detail, "Acme" in detail) }
        }
        assertEquals(
            "Allow notifications so Acme can tell you about updates, re-pairing and reminders.",
            NotificationPermissions.row(NotificationPermissionState.NOT_ASKED, "Acme").detail,
        )
    }

    // --- one-time first-open prompt -----------------------------------------------------------

    @Test fun `first-open prompt shows once on Android 13+`() {
        val store = PrefsNotificationPromptStore(FakeSharedPreferences())
        val prompt = FirstOpenNotificationPrompt(store)
        assertTrue(prompt.shouldShow(33, NotificationPermissionState.NOT_ASKED))
        prompt.markShown()
        assertTrue(store.firstOpenPromptShown)
        assertFalse(prompt.shouldShow(33, NotificationPermissionState.NOT_ASKED))
        // A new instance over the same preferences (next app start) remembers it.
        assertFalse(FirstOpenNotificationPrompt(store).shouldShow(36, NotificationPermissionState.DENIED))
    }

    @Test fun `first-open prompt is skipped when it cannot help`() {
        val prompt = FirstOpenNotificationPrompt(PrefsNotificationPromptStore(FakeSharedPreferences()))
        assertFalse(prompt.shouldShow(32, NotificationPermissionState.NOT_ASKED))
        assertFalse(prompt.shouldShow(34, NotificationPermissionState.GRANTED))
        assertFalse(prompt.shouldShow(34, NotificationPermissionState.PERMANENTLY_DENIED))
        assertFalse(prompt.shouldShow(34, NotificationPermissionState.DISABLED))
        assertTrue(prompt.shouldShow(34, NotificationPermissionState.DENIED))
    }

    @Test fun `requesting records the flag that tells permanent denial apart`() {
        val prefs = FakeSharedPreferences()
        val store = PrefsNotificationPromptStore(prefs)
        assertFalse(store.permissionRequested)
        FirstOpenNotificationPrompt(store).markRequested()
        assertTrue(PrefsNotificationPromptStore(prefs).permissionRequested)
        assertFalse(store.firstOpenPromptShown)
        assertEquals(
            NotificationPermissionState.PERMANENTLY_DENIED,
            NotificationPermissions.state(34, granted = false, enabled = false, askedBefore = store.permissionRequested, showRationale = false),
        )
    }
}
