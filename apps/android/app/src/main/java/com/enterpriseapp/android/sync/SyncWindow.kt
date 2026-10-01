package com.enterpriseapp.android.sync

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit

/**
 * The local days one sync reads and reconciles, inclusive, in the phone's time zone:
 * `today-29..today` (30 days) until a sync has succeeded once, then `today-6..today`.
 * Always within the API's limits (≤ 31 days, from today-30 to today+1 in the user's zone).
 */
data class SyncWindow(val from: LocalDate, val to: LocalDate) {
    init {
        require(!from.isAfter(to)) { "from must not be after to" }
    }

    val days: Int get() = (ChronoUnit.DAYS.between(from, to) + 1).toInt()

    operator fun contains(date: LocalDate): Boolean = !date.isBefore(from) && !date.isAfter(to)

    /** First instant of [from] in [zone] (handles zones whose midnight is skipped by DST). */
    fun startInstant(zone: ZoneId): Instant = from.atStartOfDay(zone).toInstant()

    /** First instant after [to] in [zone] (exclusive end). */
    fun endInstant(zone: ZoneId): Instant = to.plusDays(1).atStartOfDay(zone).toInstant()

    fun toDto(): SyncWindowDto = SyncWindowDto(from.toString(), to.toString())

    companion object {
        const val INITIAL_DAYS = 30
        const val INCREMENTAL_DAYS = 7

        fun compute(today: LocalDate, initial: Boolean): SyncWindow {
            val days = if (initial) INITIAL_DAYS else INCREMENTAL_DAYS
            return SyncWindow(today.minusDays((days - 1).toLong()), today)
        }

        fun compute(now: Instant, zone: ZoneId, initial: Boolean): SyncWindow =
            compute(now.atZone(zone).toLocalDate(), initial)
    }
}

/** Formats instants the way the API's `z.iso.datetime({ offset: true })` accepts them. */
object Iso {
    fun instant(value: Instant): String = value.truncatedTo(ChronoUnit.MILLIS).toString()

    private val IANA = Regex("^[A-Za-z_]+(/[A-Za-z0-9_+\\-]+)*$")

    /**
     * [zoneId] when it looks like an IANA name the API accepts (`America/Costa_Rica`, `UTC`),
     * else null (a raw offset such as `GMT+05:00` would fail the API's validation).
     */
    fun ianaZone(zoneId: String): String? = zoneId.takeIf { it.matches(IANA) }
}
