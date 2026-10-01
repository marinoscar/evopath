package com.enterpriseapp.android.sync

/** Scheduling seam (WorkManager in the app, a fake in tests). */
interface SyncScheduling {
    /** Hourly sync (KEEP: an existing schedule is left alone). */
    fun ensurePeriodic()

    /** One expedited sync now. */
    fun syncNow(trigger: SyncTrigger)

    fun cancelAll()
}
