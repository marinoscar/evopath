package com.enterpriseapp.android.notifications

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/** Reads [NotificationPermissionState] from the phone (the decision itself is [NotificationPermissions]). */
object NotificationAccess {
    fun state(activity: Activity, store: NotificationPromptStore): NotificationPermissionState {
        val sdk = Build.VERSION.SDK_INT
        val granted = sdk < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        val showRationale = sdk >= Build.VERSION_CODES.TIRAMISU &&
            activity.shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)
        return NotificationPermissions.state(
            sdkInt = sdk,
            granted = granted,
            enabled = enabled(activity),
            askedBefore = store.permissionRequested,
            showRationale = showRationale,
        )
    }

    fun enabled(context: Context): Boolean = NotificationManagerCompat.from(context).areNotificationsEnabled()
}
