package com.evopath.android.diagnostics

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.time.Instant
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class AppLogTest {
    @get:Rule val tmp = TemporaryFolder()

    private val now = Instant.parse("2026-10-01T18:00:00Z")

    @Test fun `redacts personal access tokens and bearer headers`() {
        val text = "token pat_0123abcdef9876 and Authorization: Bearer pat_ffff00001111 or bearer eyJhbGciOi.x-y_z"
        val out = Redaction.redact(text)
        assertFalse(out.contains("0123abcdef9876"))
        assertFalse(out.contains("ffff00001111"))
        assertFalse(out.contains("eyJhbGciOi"))
        assertTrue(out.contains(Redaction.PAT_MASK))
        assertTrue(out.contains(Redaction.BEARER_MASK))
    }

    @Test fun `redact with a secret masks the exact stored value too`() {
        assertEquals("x [REDACTED] y", Redaction.redact("x s3cr3t-value y", "s3cr3t-value"))
        assertEquals("plain text", Redaction.redact("plain text", null))
    }

    @Test fun `lines carry timestamp, level and tag and are redacted before storage`() {
        val file = File(tmp.root, "log.txt")
        val log = RollingLog(file, clock = { now })
        log.log(LogLevel.WARN, "Api", "GET /x failed with pat_abc123def", IllegalStateException("boom\nsecond line"))
        val line = log.tail(10).single()
        assertEquals("2026-10-01T18:00:00Z W/Api: GET /x failed with pat_[REDACTED] | IllegalStateException: boom second line", line)
        assertFalse(file.readText().contains("abc123def"))
    }

    @Test fun `rotation keeps at most maxLines in memory and on disk`() {
        val file = File(tmp.root, "log.txt")
        val log = RollingLog(file, maxLines = 50, clock = { now })
        repeat(237) { log.log(LogLevel.INFO, "T", "line $it") }
        val tail = log.tail(1000)
        assertTrue(tail.size <= 50)
        assertTrue(tail.last().endsWith("line 236"))
        val onDisk = file.readLines().filter { it.isNotBlank() }
        assertTrue(onDisk.size <= 50)
        assertEquals(tail, onDisk)
        // A new instance over the same file reloads the newest lines.
        assertEquals(tail.takeLast(5), RollingLog(file, maxLines = 50).tail(5))
    }

    @Test fun `tail returns the newest lines, oldest first`() {
        val log = RollingLog(null, clock = { now })
        repeat(5) { log.log(LogLevel.DEBUG, "T", "n$it") }
        assertEquals(listOf("n3", "n4"), log.tail(2).map { it.substringAfter(": ") })
    }

    @Test fun `concurrent writers never lose or tear lines`() {
        val log = RollingLog(File(tmp.root, "c.txt"), maxLines = 1000, clock = { now })
        val pool = Executors.newFixedThreadPool(8)
        repeat(8) { t -> pool.execute { repeat(100) { log.log(LogLevel.INFO, "T$t", "m$it") } } }
        pool.shutdown()
        assertTrue(pool.awaitTermination(10, TimeUnit.SECONDS))
        val tail = log.tail(1000)
        assertEquals(800, tail.size)
        assertTrue(tail.all { Regex("""^\S+ I/T\d: m\d+$""").matches(it) })
    }

    @Test fun `clear empties memory and file`() {
        val file = File(tmp.root, "log.txt")
        val log = RollingLog(file, clock = { now })
        log.log(LogLevel.INFO, "T", "x")
        log.clear()
        assertTrue(log.tail().isEmpty())
        assertFalse(file.exists())
    }
}
