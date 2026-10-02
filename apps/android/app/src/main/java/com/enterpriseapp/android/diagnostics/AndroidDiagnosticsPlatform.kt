package com.enterpriseapp.android.diagnostics

import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.WorkInfo
import androidx.work.WorkManager
import com.enterpriseapp.android.sync.WorkManagerSyncScheduler
import com.enterpriseapp.android.util.AppInfo
import kotlinx.coroutines.flow.first
import java.time.Instant
import java.time.ZoneId

/** [DiagnosticsPlatform] over the real phone. */
class AndroidDiagnosticsPlatform(context: Context) : DiagnosticsPlatform {
    private val appContext = context.applicationContext

    override fun appInfo(): AppInfo = AppInfo.read(appContext)

    override fun device() = DeviceSnapshot(
        manufacturer = Build.MANUFACTURER,
        model = Build.MODEL,
        androidVersion = Build.VERSION.RELEASE,
        sdkInt = Build.VERSION.SDK_INT,
        timezone = ZoneId.systemDefault().id,
    )

    override fun isIgnoringBatteryOptimizations(): Boolean? =
        appContext.getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(appContext.packageName)

    override fun notificationPermissionGranted(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(appContext, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    override fun notificationsEnabled(): Boolean = NotificationManagerCompat.from(appContext).areNotificationsEnabled()

    override fun notificationChannels(): List<NotificationChannelSnapshot> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return emptyList()
        val manager = appContext.getSystemService(NotificationManager::class.java) ?: return emptyList()
        return manager.notificationChannels.map { NotificationChannelSnapshot(it.id, it.name?.toString() ?: it.id, it.importance) }
    }

    override fun opensBrowsableUrl(url: String): Boolean {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
            .addCategory(Intent.CATEGORY_BROWSABLE)
            .setPackage(appContext.packageName)
        val pm = appContext.packageManager
        val matches = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            pm.queryIntentActivities(intent, PackageManager.ResolveInfoFlags.of(0))
        } else {
            @Suppress("DEPRECATION")
            pm.queryIntentActivities(intent, 0)
        }
        return matches.isNotEmpty()
    }

    override fun installedPackages(packages: Collection<String>): Set<String> {
        val pm = appContext.packageManager
        return packages.filterTo(linkedSetOf()) { pkg ->
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    pm.getApplicationInfo(pkg, PackageManager.ApplicationInfoFlags.of(0))
                } else {
                    @Suppress("DEPRECATION")
                    pm.getApplicationInfo(pkg, 0)
                }
                true
            } catch (_: PackageManager.NameNotFoundException) {
                false
            }
        }
    }

    override suspend fun periodicWork(): WorkSnapshot? {
        val infos = WorkManager.getInstance(appContext)
            .getWorkInfosForUniqueWorkFlow(WorkManagerSyncScheduler.PERIODIC_WORK)
            .first()
        val info = infos.firstOrNull { !it.state.isFinished } ?: infos.firstOrNull() ?: return null
        val next = info.nextScheduleTimeMillis.takeIf { it in 1 until Long.MAX_VALUE && info.state == WorkInfo.State.ENQUEUED }
        return WorkSnapshot(info.state.name, next?.let(Instant::ofEpochMilli))
    }
}
