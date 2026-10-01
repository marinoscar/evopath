package com.evopath.android.diagnostics

import android.content.Context
import android.util.Log
import java.io.File
import java.time.Instant

/** Scrubs credentials from anything written to the log or a diagnostics report. */
object Redaction {
    private val PAT = Regex("""pat_[A-Za-z0-9_-]+""")
    private val BEARER = Regex("""(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+""")
    const val PAT_MASK = "pat_[REDACTED]"
    const val BEARER_MASK = "Bearer [REDACTED]"

    fun redact(text: String): String = BEARER.replace(PAT.replace(text, PAT_MASK), BEARER_MASK)

    /** [redact], and also masks [secret] verbatim (the stored token) wherever it appears. */
    fun redact(text: String, secret: String?): String {
        val scrubbed = if (!secret.isNullOrEmpty() && secret.length >= 8) text.replace(secret, "[REDACTED]") else text
        return redact(scrubbed)
    }
}

enum class LogLevel(val letter: Char) { DEBUG('D'), INFO('I'), WARN('W'), ERROR('E') }

/**
 * A small rolling text log: at most [maxLines] lines, newest last, one event per line
 * (`<ISO instant> <level>/<tag>: <message>`). Thread-safe. Every line is redacted before it is
 * kept, so a token can never reach the file, the log viewer or an uploaded report.
 *
 * The file is optional (null in tests). When it outgrows [maxLines] it is rewritten with the
 * newest lines, trimming a tenth extra so the rewrite is not paid on every line.
 */
class RollingLog(
    private val file: File?,
    private val maxLines: Int = MAX_LINES,
    private val clock: () -> Instant = Instant::now,
    private val echo: (LogLevel, String, String) -> Unit = { _, _, _ -> },
) {
    private val lines = ArrayDeque<String>()
    private var loaded = false

    fun log(level: LogLevel, tag: String, message: String, error: Throwable? = null) {
        val text = buildString {
            append(message)
            if (error != null) append(" | ").append(error.javaClass.simpleName).append(error.message?.let { ": $it" }.orEmpty())
        }
        val safe = Redaction.redact(text).replace("\r", " ").replace('\n', ' ').take(MAX_LINE_LENGTH)
        val line = "${clock()} ${level.letter}/$tag: $safe"
        runCatching { echo(level, tag, safe) }
        synchronized(this) {
            ensureLoaded()
            lines.addLast(line)
            if (lines.size > maxLines) {
                val keep = (maxLines - maxLines / 10).coerceAtLeast(1)
                while (lines.size > keep) lines.removeFirst()
                rewrite()
            } else {
                append(line)
            }
        }
    }

    /** The newest [limit] lines, oldest first. */
    fun tail(limit: Int = maxLines): List<String> = synchronized(this) {
        ensureLoaded()
        lines.toList().takeLast(limit.coerceAtLeast(0))
    }

    fun clear() = synchronized(this) {
        lines.clear()
        loaded = true
        runCatching { file?.delete() }
    }

    private fun ensureLoaded() {
        if (loaded) return
        loaded = true
        val existing = runCatching { file?.takeIf { it.exists() }?.readLines() }.getOrNull().orEmpty()
        existing.takeLast(maxLines).forEach { lines.addLast(Redaction.redact(it)) }
    }

    private fun append(line: String) {
        val f = file ?: return
        runCatching { f.appendText(line + "\n") }
    }

    private fun rewrite() {
        val f = file ?: return
        runCatching {
            val tmp = File(f.parentFile, f.name + ".tmp")
            tmp.writeText(lines.joinToString(separator = "\n", postfix = "\n"))
            if (!tmp.renameTo(f)) {
                f.writeText(tmp.readText())
                tmp.delete()
            }
        }
    }

    companion object {
        const val MAX_LINES = 1000
        const val MAX_LINE_LENGTH = 600
    }
}

/**
 * Process-wide app log (Diagnostics → Log, and the `log` of a report). Call [init] once from
 * the Application; before that (and in JVM tests) lines are kept in memory only.
 * Also echoes to Logcat.
 */
object AppLog {
    private const val FILE_NAME = "health-sync.log"

    @Volatile
    private var sink: RollingLog = RollingLog(file = null, echo = ::logcat)

    fun init(context: Context) {
        val dir = File(context.applicationContext.filesDir, "logs").apply { mkdirs() }
        sink = RollingLog(File(dir, FILE_NAME), echo = ::logcat)
    }

    /** Replaces the sink (tests). */
    fun install(log: RollingLog) {
        sink = log
    }

    fun d(tag: String, message: String) = sink.log(LogLevel.DEBUG, tag, message)
    fun i(tag: String, message: String) = sink.log(LogLevel.INFO, tag, message)
    fun w(tag: String, message: String, error: Throwable? = null) = sink.log(LogLevel.WARN, tag, message, error)
    fun e(tag: String, message: String, error: Throwable? = null) = sink.log(LogLevel.ERROR, tag, message, error)

    fun tail(limit: Int): List<String> = sink.tail(limit)
    fun clear() = sink.clear()

    private fun logcat(level: LogLevel, tag: String, message: String) {
        val t = "EvoPath.$tag".take(23)
        when (level) {
            LogLevel.DEBUG -> Log.d(t, message)
            LogLevel.INFO -> Log.i(t, message)
            LogLevel.WARN -> Log.w(t, message)
            LogLevel.ERROR -> Log.e(t, message)
        }
    }
}
