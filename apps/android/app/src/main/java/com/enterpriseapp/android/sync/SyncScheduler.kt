package com.enterpriseapp.android.sync

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import com.enterpriseapp.android.BuildConfig
import com.enterpriseapp.android.MobileApplication
import java.time.Duration
import java.time.Instant
import java.util.concurrent.TimeUnit

class WorkManagerSyncScheduler(context: Context) : SyncScheduling {
    private val appContext = context.applicationContext
    private val workManager get() = WorkManager.getInstance(appContext)

    override fun ensurePeriodic() {
        val request = PeriodicWorkRequestBuilder<HealthSyncWorker>(1, TimeUnit.HOURS)
            .setConstraints(networkConstraint())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, BACKOFF_SECONDS, TimeUnit.SECONDS)
            .setInputData(workDataOf(HealthSyncWorker.KEY_TRIGGER to SyncTrigger.PERIODIC.wire))
            .addTag(TAG)
            .build()
        workManager.enqueueUniquePeriodicWork(PERIODIC_WORK, periodicPolicy(), request)
    }

    /**
     * KEEP, except once per worker class: WorkManager stores the worker's class name, so work
     * scheduled by a build whose Kotlin package differed would never instantiate again. UPDATE
     * rewrites the stored spec (keeping its timing) to the current [HealthSyncWorker].
     */
    private fun periodicPolicy(): ExistingPeriodicWorkPolicy {
        val prefs = appContext.getSharedPreferences(WORK_PREFS, Context.MODE_PRIVATE)
        val current = HealthSyncWorker::class.java.name
        if (prefs.getString(KEY_WORKER_CLASS, null) == current) return ExistingPeriodicWorkPolicy.KEEP
        prefs.edit().putString(KEY_WORKER_CLASS, current).apply()
        return ExistingPeriodicWorkPolicy.UPDATE
    }

    override fun syncNow(trigger: SyncTrigger) {
        val request = OneTimeWorkRequestBuilder<HealthSyncWorker>()
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .setConstraints(networkConstraint())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, BACKOFF_SECONDS, TimeUnit.SECONDS)
            .setInputData(workDataOf(HealthSyncWorker.KEY_TRIGGER to trigger.wire))
            .addTag(TAG)
            .build()
        // A manual tap replaces a queued/backing-off run; an app-open sync never interrupts one.
        val policy = if (trigger == SyncTrigger.APP_OPEN) ExistingWorkPolicy.KEEP else ExistingWorkPolicy.REPLACE
        workManager.enqueueUniqueWork(NOW_WORK, policy, request)
    }

    override fun cancelAll() {
        workManager.cancelUniqueWork(PERIODIC_WORK)
        workManager.cancelUniqueWork(NOW_WORK)
    }

    private fun networkConstraint() = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    companion object {
        const val PERIODIC_WORK = "health-sync-periodic"
        const val NOW_WORK = "health-sync-now"
        const val TAG = "health-sync"
        private const val BACKOFF_SECONDS = 60L
        private const val WORK_PREFS = BuildConfig.STORAGE_PREFIX + "_work"
        private const val KEY_WORKER_CLASS = "periodic_worker_class"

        /** App-open syncs run at most this often. */
        val APP_OPEN_DEBOUNCE: Duration = Duration.ofMinutes(15)

        /** True when an app-open sync is due (never ran, or the last one is older than the debounce). */
        fun appOpenSyncDue(last: Instant?, now: Instant, debounce: Duration = APP_OPEN_DEBOUNCE): Boolean =
            last == null || !now.isBefore(last.plus(debounce)) || now.isBefore(last)

        /**
         * Called from the launcher and the Health sync screen: keeps the hourly schedule in place
         * and, at most every 15 minutes, starts an app-open sync. No-op unless paired and valid.
         */
        fun onAppOpen(context: Context, now: Instant = Instant.now()) {
            val app = MobileApplication.from(context)
            if (!app.isSyncConfigured) return
            app.syncScheduler.ensurePeriodic()
            val state = app.syncState
            if (appOpenSyncDue(state.lastAppOpenSyncAt, now)) {
                state.lastAppOpenSyncAt = now
                app.syncScheduler.syncNow(SyncTrigger.APP_OPEN)
            }
        }
    }
}
