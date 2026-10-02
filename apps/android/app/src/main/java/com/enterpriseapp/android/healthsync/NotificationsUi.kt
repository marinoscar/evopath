package com.enterpriseapp.android.healthsync

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.enterpriseapp.android.MobileApplication
import com.enterpriseapp.android.diagnostics.AppLog
import com.enterpriseapp.android.notifications.FirstOpenNotificationPrompt
import com.enterpriseapp.android.notifications.NotificationAction
import com.enterpriseapp.android.notifications.NotificationPermissionState
import com.enterpriseapp.android.notifications.NotificationPermissions
import com.enterpriseapp.android.sync.SyncNotifications
import com.enterpriseapp.android.util.Brand

/**
 * Returns "allow notifications" for [NotificationPermissionState]: the POST_NOTIFICATIONS dialog when
 * Android can still show it, otherwise the app's notification settings. [onResult] runs after the dialog
 * closes; [onSettingsOpened] when the user was sent to Android Settings (re-check on resume).
 */
@Composable
internal fun rememberNotificationRequester(
    onResult: (granted: Boolean) -> Unit = {},
    onSettingsOpened: () -> Unit = {},
): (NotificationPermissionState?) -> Unit {
    val context = LocalContext.current
    val app = MobileApplication.from(context)
    val latestOnResult by rememberUpdatedState(onResult)
    val latestOnSettings by rememberUpdatedState(onSettingsOpened)
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        AppLog.i("Notifications", "POST_NOTIFICATIONS ${if (granted) "granted" else "denied"}")
        if (granted) SyncNotifications.ensureChannels(context)
        (context as? HealthSyncActivity)?.refreshNotificationState()
        latestOnResult(granted)
    }
    return { state ->
        val action = state?.let(NotificationPermissions::action) ?: NotificationAction.OPEN_SETTINGS
        if (action == NotificationAction.REQUEST && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            FirstOpenNotificationPrompt(app.notificationPrompts).markRequested()
            launcher.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            DiagnosticsIntents.openNotificationSettings(context)
            latestOnSettings()
        }
    }
}

/** First open of the hub (Android 13+, once): why notifications matter, before the system dialog. */
@Composable
internal fun NotificationRationaleCard(onAllow: () -> Unit, onDismiss: () -> Unit) {
    SectionCard(title = "Turn on notifications") {
        Text("Allow notifications so ${Brand.name} can tell you about updates, re-pairing and reminders.")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = onAllow) { Text("Allow") }
            TextButton(onClick = onDismiss) { Text("Not now") }
        }
    }
}

/** The hub's Notifications row: status, and Allow or Open settings. */
@Composable
internal fun NotificationsCard(state: NotificationPermissionState?, onAction: () -> Unit) {
    if (state == null) return
    val row = NotificationPermissions.row(state, Brand.name)
    SectionCard(title = "Notifications") {
        Text(
            row.status,
            style = MaterialTheme.typography.bodyLarge,
            color = if (row.ok) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.error,
        )
        row.detail?.let { Muted(it) }
        row.actionLabel?.let { label -> OutlinedButton(onClick = onAction) { Text(label) } }
    }
}
