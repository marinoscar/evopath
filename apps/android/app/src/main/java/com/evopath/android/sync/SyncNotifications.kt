package com.evopath.android.sync

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.evopath.android.R
import com.evopath.android.healthsync.HealthSyncActivity

/** Notification channels and the "Re-pair" alert. */
object SyncNotifications {
    const val CHANNEL_STATUS = "health_sync_status"
    const val CHANNEL_PROGRESS = "health_sync_progress"
    const val PAIRING_EXPIRED_ID = 2810
    const val PROGRESS_ID = 2811

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_STATUS, "Health sync alerts", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Problems that stop Health sync, such as an expired pairing."
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_PROGRESS, "Health sync in progress", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shown briefly while a sync runs on older Android versions."
            },
        )
    }

    fun canNotify(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
        return NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    fun notifyPairingExpired(context: Context) {
        ensureChannels(context)
        if (!canNotify(context)) return
        val notification = NotificationCompat.Builder(context, CHANNEL_STATUS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Re-pair EvoPath Health sync")
            .setContentText("Your EvoPath server no longer accepts this phone. Open Health sync to pair again.")
            .setStyle(
                NotificationCompat.BigTextStyle()
                    .bigText("Your EvoPath server no longer accepts this phone (the pairing expired or was revoked). Open Health sync to pair again."),
            )
            .setContentIntent(openHealthSync(context))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(PAIRING_EXPIRED_ID, notification)
        } catch (_: SecurityException) {
            // Notification permission revoked between the check and the call.
        }
    }

    fun cancelPairingExpired(context: Context) {
        NotificationManagerCompat.from(context).cancel(PAIRING_EXPIRED_ID)
    }

    fun progressNotification(context: Context): Notification =
        NotificationCompat.Builder(context, CHANNEL_PROGRESS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Syncing health data")
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

    private fun openHealthSync(context: Context): PendingIntent {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("evopath-android://health-sync"), context, HealthSyncActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
}
