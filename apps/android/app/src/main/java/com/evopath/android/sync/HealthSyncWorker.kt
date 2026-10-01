package com.evopath.android.sync

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import com.evopath.android.EvoPathApplication
import com.evopath.android.diagnostics.AppLog

/**
 * Runs one [HealthSyncEngine] pass. Network failures and server errors retry with WorkManager's
 * exponential backoff (a few attempts); anything else ends the attempt. The periodic schedule
 * keeps running either way, so a failure never stops the next hourly sync.
 */
class HealthSyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val app = EvoPathApplication.from(applicationContext)
        val trigger = SyncTrigger.fromWire(inputData.getString(KEY_TRIGGER))
        AppLog.i(TAG, "Worker started (${trigger.wire}, attempt ${runAttemptCount + 1})")
        val outcome = app.newSyncEngine().run(trigger)
        AppLog.i(TAG, "Worker finished: ${describe(outcome)}")
        return when (outcome) {
            is SyncOutcome.Completed, SyncOutcome.NotPaired, SyncOutcome.PairingExpired -> Result.success()
            SyncOutcome.Unpaired -> {
                app.syncScheduler.cancelAll()
                Result.success()
            }
            is SyncOutcome.RetryLater -> if (runAttemptCount < MAX_RETRIES) Result.retry() else Result.failure()
            is SyncOutcome.Failed -> Result.failure()
        }.also { app.onSyncFinished() }
    }

    /**
     * Expedited work runs as a short foreground service only below Android 12 (API 31+ uses
     * expedited jobs), where a foreground-service type is not required.
     */
    override suspend fun getForegroundInfo(): ForegroundInfo {
        SyncNotifications.ensureChannels(applicationContext)
        return ForegroundInfo(SyncNotifications.PROGRESS_ID, SyncNotifications.progressNotification(applicationContext))
    }

    companion object {
        private const val TAG = "Worker"
        const val KEY_TRIGGER = "trigger"
        const val MAX_RETRIES = 4

        fun describe(outcome: SyncOutcome): String = when (outcome) {
            is SyncOutcome.Completed -> "completed (${outcome.status})"
            SyncOutcome.NotPaired -> "not paired"
            SyncOutcome.PairingExpired -> "pairing expired"
            SyncOutcome.Unpaired -> "device unpaired on the server"
            is SyncOutcome.RetryLater -> "will retry (${outcome.message})"
            is SyncOutcome.Failed -> "failed (${outcome.message})"
        }
    }
}
