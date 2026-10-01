@file:Suppress("DEPRECATION") // security-crypto 1.1.0 deprecates EncryptedSharedPreferences/MasterKey without a replacement.

package com.evopath.android.auth

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.time.Instant
import java.util.UUID

/**
 * Pairing credentials for this installation.
 *
 * - [token]: the personal access token (`pat_…`) obtained through the device flow. Never logged.
 * - [expiresAt]: when the server says the token expires (the app re-pairs after that).
 * - [deviceId]: the `health_sync_devices.id` returned by `POST /api/health-sync/devices`.
 * - [installationId]: random UUID generated once per install; survives [clear] so re-pairing
 *   updates the same device row instead of creating a new one.
 */
interface TokenStore {
    val token: String?
    val expiresAt: Instant?
    val deviceId: String?
    val installationId: String

    val isPaired: Boolean get() = !token.isNullOrEmpty()

    fun setToken(token: String, expiresAt: Instant?)
    fun setDeviceId(deviceId: String?)

    /** Forgets token, expiry and device id. Keeps [installationId]. */
    fun clear()
}

/** [TokenStore] over any [SharedPreferences]; production passes an EncryptedSharedPreferences. */
open class SharedPrefsTokenStore(private val prefs: SharedPreferences) : TokenStore {
    override val token: String? get() = prefs.getString(KEY_TOKEN, null)

    override val expiresAt: Instant?
        get() = prefs.getString(KEY_EXPIRES_AT, null)?.let { runCatching { Instant.parse(it) }.getOrNull() }

    override val deviceId: String? get() = prefs.getString(KEY_DEVICE_ID, null)

    override val installationId: String
        @Synchronized get() {
            prefs.getString(KEY_INSTALLATION_ID, null)?.let { return it }
            val generated = UUID.randomUUID().toString()
            prefs.edit().putString(KEY_INSTALLATION_ID, generated).commit()
            return generated
        }

    override fun setToken(token: String, expiresAt: Instant?) {
        prefs.edit()
            .putString(KEY_TOKEN, token)
            .apply { if (expiresAt != null) putString(KEY_EXPIRES_AT, expiresAt.toString()) else remove(KEY_EXPIRES_AT) }
            .commit()
    }

    override fun setDeviceId(deviceId: String?) {
        prefs.edit().apply { if (deviceId != null) putString(KEY_DEVICE_ID, deviceId) else remove(KEY_DEVICE_ID) }.commit()
    }

    override fun clear() {
        prefs.edit().remove(KEY_TOKEN).remove(KEY_EXPIRES_AT).remove(KEY_DEVICE_ID).commit()
    }

    companion object {
        const val KEY_TOKEN = "token"
        const val KEY_EXPIRES_AT = "expires_at"
        const val KEY_DEVICE_ID = "device_id"
        const val KEY_INSTALLATION_ID = "installation_id"
    }
}

/** Keystore-backed (AES-256 GCM) store. Excluded from backup and device transfer. */
class EncryptedTokenStore private constructor(prefs: SharedPreferences) : SharedPrefsTokenStore(prefs) {
    companion object {
        private const val TAG = "EvoPathTokenStore"
        const val PREFS_NAME = "evopath_secure"

        fun create(context: Context): TokenStore {
            val app = context.applicationContext
            return try {
                EncryptedTokenStore(open(app))
            } catch (e: Exception) {
                // A restored or corrupted keyset cannot be decrypted; start over (the user re-pairs).
                Log.w(TAG, "Encrypted prefs unreadable; resetting pairing state", e)
                app.deleteSharedPreferences(PREFS_NAME)
                EncryptedTokenStore(open(app))
            }
        }

        private fun open(context: Context): SharedPreferences {
            val masterKey = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            return EncryptedSharedPreferences.create(
                context,
                PREFS_NAME,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        }
    }
}
