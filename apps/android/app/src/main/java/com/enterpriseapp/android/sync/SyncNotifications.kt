package com.enterpriseapp.android.sync

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
import com.enterpriseapp.android.R
import com.enterpriseapp.android.healthsync.HealthSyncActivity
import com.enterpriseapp.android.update.AvailableUpdate
import com.enterpriseapp.android.update.UpdatePolicy
import com.enterpriseapp.android.util.Brand

/** Notification channels, the "Re-pair" alert and the "new version" notice. */
object SyncNotifications {
    const val CHANNEL_STATUS = "health_sync_status"
    const val CHANNEL_PROGRESS = "health_sync_progress"
    const val PAIRING_EXPIRED_ID = 2810
    const val PROGRESS_ID = 2811
    const val BACKGROUND_ACCESS_ID = 2812
    const val CHANNEL_UPDATES = "app_updates"
    const val UPDATE_AVAILABLE_ID = 2813

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
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_UPDATES, "App updates", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "A new version of the app is ready to download."
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
            .setContentTitle("Re-pair ${Brand.name} Health sync")
            .setContentText("Your ${Brand.name} server no longer accepts this phone. Open Health sync to pair again.")
            .setStyle(
                NotificationCompat.BigTextStyle()
                    .bigText("Your ${Brand.name} server no longer accepts this phone (the pairing expired or was revoked). Open Health sync to pair again."),
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

    /** "Allow background access so <product> can sync while closed" (throttled by the engine). */
    fun notifyBackgroundAccess(context: Context, featureAvailable: Boolean) {
        ensureChannels(context)
        if (!canNotify(context)) return
        val text = if (featureAvailable) {
            "The hourly sync cannot read Health Connect while ${Brand.name} is closed. Tap to allow background access."
        } else {
            "This phone's Health Connect cannot read in the background. Tap to open Health sync; updating Health Connect may help."
        }
        val notification = NotificationCompat.Builder(context, CHANNEL_STATUS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Allow background access so ${Brand.name} can sync while closed")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(openHealthSync(context, HealthSyncActivity.OPEN_BACKGROUND_ACCESS, requestCode = 1))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(BACKGROUND_ACCESS_ID, notification)
        } catch (_: SecurityException) {
            // Notification permission revoked between the check and the call.
        }
    }

    /**
     * "<product> 0.2.0 is available" (once per versionCode, see BackgroundUpdateCheck). Tapping it
     * opens the Health sync hub with the update card. False when notifications are not allowed.
     */
    fun notifyUpdateAvailable(context: Context, update: AvailableUpdate): Boolean {
        ensureChannels(context)
        if (!canNotify(context)) return false
        val text = UpdatePolicy.notificationText(update)
        val notification = NotificationCompat.Builder(context, CHANNEL_UPDATES)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(UpdatePolicy.notificationTitle(Brand.name, update))
            .setContentText(text.lineSequence().first())
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(openHealthSync(context, HealthSyncActivity.OPEN_UPDATE, requestCode = 2))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()
        return try {
            NotificationManagerCompat.from(context).notify(UPDATE_AVAILABLE_ID, notification)
            true
        } catch (_: SecurityException) {
            // Notification permission revoked between the check and the call.
            false
        }
    }

    fun cancelUpdateAvailable(context: Context) {
        NotificationManagerCompat.from(context).cancel(UPDATE_AVAILABLE_ID)
    }

    fun cancelBackgroundAccess(context: Context) {
        NotificationManagerCompat.from(context).cancel(BACKGROUND_ACCESS_ID)
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

    private fun openHealthSync(context: Context, open: String? = null, requestCode: Int = 0): PendingIntent {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(Brand.healthSyncUri), context, HealthSyncActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        open?.let { intent.putExtra(HealthSyncActivity.EXTRA_OPEN, it) }
        return PendingIntent.getActivity(context, requestCode, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
}
