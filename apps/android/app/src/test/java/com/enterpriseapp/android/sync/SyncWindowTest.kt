package com.enterpriseapp.android.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

class SyncWindowTest {
    @Test fun `first sync reads 30 days, later syncs 7, both ending today`() {
        val today = LocalDate.parse("2026-10-01")
        val initial = SyncWindow.compute(today, initial = true)
        assertEquals(LocalDate.parse("2026-09-02"), initial.from)
        assertEquals(today, initial.to)
        assertEquals(30, initial.days)

        val incremental = SyncWindow.compute(today, initial = false)
        assertEquals(LocalDate.parse("2026-09-25"), incremental.from)
        assertEquals(7, incremental.days)
        assertEquals(SyncWindowDto("2026-09-25", "2026-10-01"), incremental.toDto())
    }

    @Test fun `today is the phone's local date, not UTC`() {
        val instant = Instant.parse("2026-10-01T03:30:00Z")
        // Still Sept 30 in Costa Rica (UTC-6), already Oct 1 in Tokyo.
        assertEquals(LocalDate.parse("2026-09-30"), SyncWindow.compute(instant, ZoneId.of("America/Costa_Rica"), false).to)
        assertEquals(LocalDate.parse("2026-10-01"), SyncWindow.compute(instant, ZoneId.of("Asia/Tokyo"), false).to)
    }

    @Test fun `window bounds are local midnights, exclusive end`() {
        val zone = ZoneId.of("America/Costa_Rica")
        val window = SyncWindow(LocalDate.parse("2026-09-25"), LocalDate.parse("2026-10-01"))
        assertEquals(Instant.parse("2026-09-25T06:00:00Z"), window.startInstant(zone))
        assertEquals(Instant.parse("2026-10-02T06:00:00Z"), window.endInstant(zone))
        assertTrue(LocalDate.parse("2026-09-25") in window)
        assertTrue(LocalDate.parse("2026-10-01") in window)
        assertFalse(LocalDate.parse("2026-10-02") in window)
        assertFalse(LocalDate.parse("2026-09-24") in window)
    }

    @Test fun `a DST change inside the window shortens that day, not the window`() {
        val zone = ZoneId.of("America/New_York") // springs forward on 2026-03-08
        val window = SyncWindow.compute(LocalDate.parse("2026-03-10"), initial = false)
        assertEquals(7, window.days)
        val span = Duration.between(window.startInstant(zone), window.endInstant(zone))
        assertEquals(Duration.ofHours(7 * 24 - 1), span)

        val dstDay = SyncWindow(LocalDate.parse("2026-03-08"), LocalDate.parse("2026-03-08"))
        assertEquals(Duration.ofHours(23), Duration.between(dstDay.startInstant(zone), dstDay.endInstant(zone)))
    }

    @Test fun `a zone whose midnight is skipped starts at the first valid instant`() {
        // Cuba moves clocks from 00:00 to 01:00 on its spring-forward day (2026-03-08).
        val zone = ZoneId.of("America/Havana")
        val day = SyncWindow(LocalDate.parse("2026-03-08"), LocalDate.parse("2026-03-08"))
        val start = day.startInstant(zone).atZone(zone)
        assertEquals(LocalDate.parse("2026-03-08"), start.toLocalDate())
        assertEquals(1, start.hour)
    }

    @Test fun `iso instants are millisecond precision UTC`() {
        assertEquals("2026-09-29T05:30:00Z", Iso.instant(Instant.parse("2026-09-29T05:30:00Z")))
        assertEquals("2026-09-29T05:30:00.123Z", Iso.instant(Instant.parse("2026-09-29T05:30:00.123456Z")))
    }

    @Test fun `only IANA-looking zone ids are sent as the run timezone`() {
        assertEquals("America/Costa_Rica", Iso.ianaZone("America/Costa_Rica"))
        assertEquals("UTC", Iso.ianaZone("UTC"))
        assertEquals("Etc/GMT+5", Iso.ianaZone("Etc/GMT+5"))
        assertEquals("America/Argentina/Buenos_Aires", Iso.ianaZone("America/Argentina/Buenos_Aires"))
        assertNull(Iso.ianaZone("GMT+05:00"))
        assertNull(Iso.ianaZone("+02:00"))
    }
}
