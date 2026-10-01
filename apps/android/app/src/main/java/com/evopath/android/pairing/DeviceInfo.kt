package com.evopath.android.pairing

import android.content.Context
import android.os.Build
import com.evopath.android.healthconnect.AndroidHealthConnectGateway
import com.evopath.android.net.RegisterDeviceRequest
import com.evopath.android.sync.Iso
import com.evopath.android.util.AppInfo
import java.time.ZoneId
import java.util.Locale

/** What the phone tells the server about itself. */
object DeviceInfo {
    private const val MAX = 100
    private val SHA256 = Regex("^([0-9A-F]{2}:){31}[0-9A-F]{2}$")

    /** `"Samsung SM-S918B · Health sync"` (manufacturer not repeated when the model already starts with it). */
    fun deviceName(manufacturer: String?, model: String?): String {
        val maker = manufacturer?.trim().orEmpty().replaceFirstChar { it.titlecase(Locale.ROOT) }
        val mdl = model?.trim().orEmpty()
        val base = when {
            mdl.isEmpty() -> maker
            maker.isEmpty() || mdl.lowercase(Locale.ROOT).startsWith(maker.lowercase(Locale.ROOT)) -> mdl
            else -> "$maker $mdl"
        }.ifEmpty { "Android phone" }
        return "$base · Health sync".take(MAX)
    }

    fun userAgent(versionName: String): String = "EvoPath-Android/$versionName"

    fun clientInfo(context: Context): DeviceClientInfo = DeviceClientInfo(
        deviceName = deviceName(Build.MANUFACTURER, Build.MODEL),
        userAgent = userAgent(AppInfo.read(context).versionName),
        tokenType = "pat",
    )

    fun registration(context: Context, installationId: String): RegisterDeviceRequest {
        val app = AppInfo.read(context)
        return RegisterDeviceRequest(
            installationId = installationId,
            name = deviceName(Build.MANUFACTURER, Build.MODEL),
            manufacturer = Build.MANUFACTURER?.take(MAX),
            model = Build.MODEL?.take(MAX),
            androidVersion = Build.VERSION.RELEASE?.take(MAX),
            sdkInt = Build.VERSION.SDK_INT,
            appVersion = app.versionName.take(MAX),
            healthConnectVersion = healthConnectVersion(context),
            packageName = app.packageName.take(MAX),
            signingSha256 = app.signingSha256?.takeIf { SHA256.matches(it) },
            timezone = Iso.ianaZone(ZoneId.systemDefault().id),
        )
    }

    /** Version of the Health Connect APK, or `"system"` (Android 14+ framework module). */
    fun healthConnectVersion(context: Context): String =
        (AndroidHealthConnectGateway.providerApkVersion(context) ?: "system").take(MAX)
}
