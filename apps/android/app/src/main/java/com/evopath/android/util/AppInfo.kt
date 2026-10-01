package com.evopath.android.util

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.os.Build
import com.evopath.android.BuildConfig
import java.security.MessageDigest

/** Identity of this build, as reported to the server (device registration, diagnostics, assetlinks). */
data class AppInfo(
    val packageName: String,
    val versionName: String,
    val versionCode: Long,
    /** SHA-256 of the signing certificate as `AA:BB:…` (uppercase), or null if unavailable. */
    val signingSha256: String?,
) {
    companion object {
        fun read(context: Context): AppInfo = AppInfo(
            packageName = context.packageName,
            versionName = BuildConfig.VERSION_NAME,
            versionCode = BuildConfig.VERSION_CODE.toLong(),
            signingSha256 = signingSha256(context),
        )

        /**
         * Fingerprint of the (current) signing certificate. Uses GET_SIGNING_CERTIFICATES on
         * API 28+ (handles key rotation: reports the current signer) and GET_SIGNATURES below.
         */
        fun signingSha256(context: Context): String? = runCatching {
            val pm = context.packageManager
            val signatures: Array<Signature>? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                val info = packageInfo(pm, context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
                val signingInfo = info.signingInfo ?: return@runCatching null
                if (signingInfo.hasMultipleSigners()) signingInfo.apkContentsSigners
                else signingInfo.signingCertificateHistory
            } else {
                @Suppress("DEPRECATION")
                packageInfo(pm, context.packageName, PackageManager.GET_SIGNATURES).signatures
            }
            // signingCertificateHistory is oldest-first; the current signer is last.
            signatures?.lastOrNull()?.toByteArray()?.let(::sha256Fingerprint)
        }.getOrNull()

        private fun packageInfo(pm: PackageManager, pkg: String, flags: Int): PackageInfo =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                pm.getPackageInfo(pkg, PackageManager.PackageInfoFlags.of(flags.toLong()))
            } else {
                @Suppress("DEPRECATION")
                pm.getPackageInfo(pkg, flags)
            }

        /** SHA-256 of a DER-encoded certificate, formatted like `keytool`/assetlinks. */
        fun sha256Fingerprint(certificate: ByteArray): String =
            formatFingerprint(MessageDigest.getInstance("SHA-256").digest(certificate))

        /** `[0xab, 0x01]` → `AB:01`. */
        fun formatFingerprint(digest: ByteArray): String =
            digest.joinToString(":") { "%02X".format(it.toInt() and 0xFF) }
    }
}
