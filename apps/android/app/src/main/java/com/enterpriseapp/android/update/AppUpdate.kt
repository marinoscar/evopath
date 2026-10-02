package com.enterpriseapp.android.update

import android.content.Context
import android.content.SharedPreferences
import com.enterpriseapp.android.BuildConfig
import com.enterpriseapp.android.diagnostics.AppLog
import com.enterpriseapp.android.net.ApiClient
import com.enterpriseapp.android.net.ApiError
import com.enterpriseapp.android.net.ApiResult
import com.enterpriseapp.android.sync.SyncOutcome
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.time.Duration
import java.time.Instant

// =============================================================================
// App updates (issue #288): the server hosts the APK releases
// (`GET /api/android-app/releases/latest`); the app compares versionCodes and
// hands the signed download link to the browser, whose download ends in the
// system package installer.
// =============================================================================

/** `GET /api/android-app/releases/latest` (public fields of the current release). */
@Serializable
data class AppRelease(
    val id: String,
    val packageName: String,
    val versionName: String,
    val versionCode: Long,
    val fileSha256: String? = null,
    val sizeBytes: Long? = null,
    val notes: String? = null,
    val createdAt: String? = null,
)

/** `POST /api/android-app/releases/:id/download-link`: [url] is a same-origin path. */
@Serializable
data class DownloadLink(val url: String, val expiresAt: String? = null)

interface ReleaseBackend {
    suspend fun latest(): ApiResult<AppRelease>
    suspend fun downloadLink(releaseId: String): ApiResult<DownloadLink>
}

class AndroidReleaseApi(private val api: ApiClient) : ReleaseBackend {
    override suspend fun latest(): ApiResult<AppRelease> = api.get(LATEST, AppRelease.serializer())

    override suspend fun downloadLink(releaseId: String): ApiResult<DownloadLink> {
        require(releaseId.matches(Regex("^[A-Za-z0-9-]{1,64}$"))) { "Invalid release id" }
        return api.post(
            "$RELEASES/$releaseId/download-link",
            JsonObject(emptyMap()),
            JsonObject.serializer(),
            DownloadLink.serializer(),
        )
    }

    companion object {
        const val RELEASES = "/api/android-app/releases"
        const val LATEST = "$RELEASES/latest"
    }
}

/** A newer release the hub offers. */
data class AvailableUpdate(
    val releaseId: String,
    val versionName: String,
    val versionCode: Long,
    val notes: String?,
    val sizeBytes: Long?,
)

/** Pure update rules (unit-tested). */
object UpdatePolicy {
    /**
     * Every cold start asks the server (issue #299); this short debounce only collapses the
     * launcher and Health sync opening back to back into one request.
     */
    val APP_OPEN_DEBOUNCE: Duration = Duration.ofMinutes(5)

    /** The background sync asks the server at most this often (issue #299). */
    val BACKGROUND_INTERVAL: Duration = Duration.ofHours(6)

    /** A release-notes first line longer than this stays out of the notification. */
    const val NOTIFICATION_NOTES_MAX = 80

    /** `details.reason` of the 404 the server answers when it publishes no release. */
    const val NO_RELEASE = "NO_RELEASE"

    /** True when never checked, the last check is [interval] old, or the clock moved backwards. */
    fun checkDue(last: Instant?, now: Instant, interval: Duration = APP_OPEN_DEBOUNCE): Boolean =
        last == null || !now.isBefore(last.plus(interval)) || now.isBefore(last)

    /** A release is an update only for this package and with a strictly higher versionCode. */
    fun isUpdate(release: AppRelease, ownPackage: String, ownVersionCode: Long): Boolean =
        release.packageName == ownPackage && release.versionCode > ownVersionCode

    /**
     * The background check posts one notification per versionCode: only for a release newer than
     * the installed build and newer than the last one notified, and only when the phone allows it.
     */
    fun shouldNotify(
        update: AvailableUpdate,
        ownVersionCode: Long,
        notifiedVersionCode: Long?,
        notificationsAllowed: Boolean,
    ): Boolean =
        notificationsAllowed &&
            update.versionCode > ownVersionCode &&
            (notifiedVersionCode == null || update.versionCode > notifiedVersionCode)

    /** `<product> 0.2.0 is available`. */
    fun notificationTitle(productName: String, update: AvailableUpdate): String =
        "$productName ${update.versionName} is available"

    /** "Tap to download the update.", plus the first line of the release notes when it is short. */
    fun notificationText(update: AvailableUpdate): String {
        val base = "Tap to download the update."
        val firstLine = update.notes?.lineSequence()?.map { it.trim() }?.firstOrNull { it.isNotEmpty() }
        return if (firstLine != null && firstLine.length <= NOTIFICATION_NOTES_MAX) "$base\n$firstLine" else base
    }

    fun isNoRelease(error: ApiError): Boolean =
        error.httpStatus == 404 && (error.reason == null || error.reason == NO_RELEASE)

    /**
     * The absolute URL the browser opens for a download link: a same-origin path is resolved
     * against [server]; an absolute URL is accepted only on the server's own origin. Null
     * when the link points anywhere else.
     */
    fun downloadUrl(server: String, link: String): String? {
        val base = server.trimEnd('/').toHttpUrlOrNull() ?: return null
        if (link.startsWith("/") && !link.startsWith("//")) {
            return base.resolve(link)?.takeIf { sameOrigin(it, base) }?.toString()
        }
        val absolute = link.toHttpUrlOrNull() ?: return null
        return absolute.takeIf { sameOrigin(it, base) }?.toString()
    }

    private fun sameOrigin(a: okhttp3.HttpUrl, b: okhttp3.HttpUrl) =
        a.scheme == b.scheme && a.host == b.host && a.port == b.port

    /** `12.3 MB` (one decimal). */
    fun formatSize(bytes: Long?): String? = bytes?.takeIf { it > 0 }?.let { "%.1f MB".format(it / 1_000_000.0) }
}

/** Persisted update state (SharedPreferences on the phone, in memory in tests). */
interface UpdateStore {
    var lastCheckAt: Instant?
    var available: AvailableUpdate?

    /** The versionCode that last ran; a different one means the app was just updated. */
    var lastSeenVersionCode: Long?

    /** The server's current release as last seen, for diagnostics. */
    var latestVersionCode: Long?
    var latestVersionName: String?

    /** The last background check (separate from the app-open debounce). */
    var lastBackgroundCheckAt: Instant?

    /** The versionCode the last "new version" notification announced. */
    var notifiedVersionCode: Long?
}

class PrefsUpdateStore(private val prefs: SharedPreferences) : UpdateStore {
    override var lastCheckAt: Instant?
        get() = prefs.getLong(KEY_LAST_CHECK, 0L).takeIf { it > 0 }?.let(Instant::ofEpochMilli)
        set(value) = edit { if (value == null) remove(KEY_LAST_CHECK) else putLong(KEY_LAST_CHECK, value.toEpochMilli()) }

    override var available: AvailableUpdate?
        get() {
            val id = prefs.getString(KEY_ID, null) ?: return null
            val name = prefs.getString(KEY_NAME, null) ?: return null
            val code = prefs.getLong(KEY_CODE, 0L).takeIf { it > 0 } ?: return null
            return AvailableUpdate(
                releaseId = id,
                versionName = name,
                versionCode = code,
                notes = prefs.getString(KEY_NOTES, null),
                sizeBytes = prefs.getLong(KEY_SIZE, 0L).takeIf { it > 0 },
            )
        }
        set(value) = edit {
            if (value == null) {
                remove(KEY_ID); remove(KEY_NAME); remove(KEY_CODE); remove(KEY_NOTES); remove(KEY_SIZE)
            } else {
                putString(KEY_ID, value.releaseId)
                putString(KEY_NAME, value.versionName)
                putLong(KEY_CODE, value.versionCode)
                if (value.notes == null) remove(KEY_NOTES) else putString(KEY_NOTES, value.notes)
                if (value.sizeBytes == null) remove(KEY_SIZE) else putLong(KEY_SIZE, value.sizeBytes)
            }
        }

    override var lastSeenVersionCode: Long?
        get() = prefs.getLong(KEY_SEEN, 0L).takeIf { it > 0 }
        set(value) = edit { if (value == null) remove(KEY_SEEN) else putLong(KEY_SEEN, value) }

    override var latestVersionCode: Long?
        get() = prefs.getLong(KEY_LATEST_CODE, 0L).takeIf { it > 0 }
        set(value) = edit { if (value == null) remove(KEY_LATEST_CODE) else putLong(KEY_LATEST_CODE, value) }

    override var latestVersionName: String?
        get() = prefs.getString(KEY_LATEST_NAME, null)
        set(value) = edit { if (value == null) remove(KEY_LATEST_NAME) else putString(KEY_LATEST_NAME, value) }

    override var lastBackgroundCheckAt: Instant?
        get() = prefs.getLong(KEY_LAST_BACKGROUND_CHECK, 0L).takeIf { it > 0 }?.let(Instant::ofEpochMilli)
        set(value) = edit {
            if (value == null) remove(KEY_LAST_BACKGROUND_CHECK) else putLong(KEY_LAST_BACKGROUND_CHECK, value.toEpochMilli())
        }

    override var notifiedVersionCode: Long?
        get() = prefs.getLong(KEY_NOTIFIED_CODE, 0L).takeIf { it > 0 }
        set(value) = edit { if (value == null) remove(KEY_NOTIFIED_CODE) else putLong(KEY_NOTIFIED_CODE, value) }

    private inline fun edit(block: SharedPreferences.Editor.() -> Unit) = prefs.edit().apply(block).apply()

    companion object {
        const val PREFS_NAME = BuildConfig.STORAGE_PREFIX + "_app_update"
        private const val KEY_LAST_CHECK = "last_check_at"
        private const val KEY_ID = "available_release_id"
        private const val KEY_NAME = "available_version_name"
        private const val KEY_CODE = "available_version_code"
        private const val KEY_NOTES = "available_notes"
        private const val KEY_SIZE = "available_size_bytes"
        private const val KEY_SEEN = "last_seen_version_code"
        private const val KEY_LATEST_CODE = "latest_version_code"
        private const val KEY_LATEST_NAME = "latest_version_name"
        private const val KEY_LAST_BACKGROUND_CHECK = "last_background_check_at"
        private const val KEY_NOTIFIED_CODE = "notified_version_code"

        fun from(context: Context) =
            PrefsUpdateStore(context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE))
    }
}

sealed interface UpdateCheckOutcome {
    data object NotPaired : UpdateCheckOutcome
    data object Throttled : UpdateCheckOutcome
    data object NoRelease : UpdateCheckOutcome
    data object UpToDate : UpdateCheckOutcome
    data class Available(val update: AvailableUpdate) : UpdateCheckOutcome
    data class Failed(val error: ApiError) : UpdateCheckOutcome
}

/**
 * Asks the server for its current release on every app open (debounced by
 * [UpdatePolicy.APP_OPEN_DEBOUNCE]), only while paired (the endpoint needs the token), and
 * remembers a newer one for the hub.
 */
class UpdateChecker(
    private val backend: ReleaseBackend,
    private val store: UpdateStore,
    private val ownPackage: String,
    private val ownVersionCode: Long,
    private val isPaired: () -> Boolean,
    private val clock: () -> Instant = Instant::now,
) {
    /** The update the hub should offer, if any. */
    val available: AvailableUpdate?
        get() = store.available?.takeIf { it.versionCode > ownVersionCode }

    /**
     * First launch after an update (a different versionCode than last time): forget the
     * offered update and both check windows, so the next open asks the server again. A
     * notified versionCode the installed build has reached is forgotten too.
     */
    fun onLaunch() {
        if (store.lastSeenVersionCode != ownVersionCode) {
            store.available = null
            store.lastCheckAt = null
            store.lastBackgroundCheckAt = null
            store.lastSeenVersionCode = ownVersionCode
        } else if (store.available?.let { it.versionCode <= ownVersionCode } == true) {
            store.available = null
        }
        if (store.notifiedVersionCode?.let { it <= ownVersionCode } == true) store.notifiedVersionCode = null
    }

    suspend fun checkIfDue(): UpdateCheckOutcome {
        onLaunch()
        if (!isPaired()) return UpdateCheckOutcome.NotPaired
        val now = clock()
        if (!UpdatePolicy.checkDue(store.lastCheckAt, now)) return UpdateCheckOutcome.Throttled
        return check(now)
    }

    /**
     * The background sync's check: at most every [UpdatePolicy.BACKGROUND_INTERVAL] (its own
     * window); a network or server failure leaves the window open.
     */
    suspend fun checkInBackgroundIfDue(): UpdateCheckOutcome {
        onLaunch()
        if (!isPaired()) return UpdateCheckOutcome.NotPaired
        val now = clock()
        if (!UpdatePolicy.checkDue(store.lastBackgroundCheckAt, now, UpdatePolicy.BACKGROUND_INTERVAL)) {
            return UpdateCheckOutcome.Throttled
        }
        val outcome = check(now)
        if (outcome !is UpdateCheckOutcome.Failed && outcome != UpdateCheckOutcome.NotPaired) {
            store.lastBackgroundCheckAt = now
        }
        return outcome
    }

    /** Asks the server now. A network or server failure leaves the debounce alone (retry on next open). */
    suspend fun check(now: Instant = clock()): UpdateCheckOutcome {
        if (!isPaired()) return UpdateCheckOutcome.NotPaired
        return when (val result = backend.latest()) {
            is ApiResult.Success -> {
                val release = result.value
                store.lastCheckAt = now
                store.latestVersionCode = release.versionCode
                store.latestVersionName = release.versionName
                if (UpdatePolicy.isUpdate(release, ownPackage, ownVersionCode)) {
                    val update = AvailableUpdate(release.id, release.versionName, release.versionCode, release.notes, release.sizeBytes)
                    store.available = update
                    AppLog.i(TAG, "Update available: ${release.versionName} (${release.versionCode})")
                    UpdateCheckOutcome.Available(update)
                } else {
                    store.available = null
                    UpdateCheckOutcome.UpToDate
                }
            }
            is ApiResult.Failure -> if (UpdatePolicy.isNoRelease(result.error)) {
                store.lastCheckAt = now
                store.available = null
                store.latestVersionCode = null
                store.latestVersionName = null
                UpdateCheckOutcome.NoRelease
            } else {
                AppLog.w(TAG, "Update check failed: ${result.error.message}")
                UpdateCheckOutcome.Failed(result.error)
            }
        }
    }

    companion object {
        private const val TAG = "Update"
    }
}

/**
 * After each background sync run: when paired and the server answered the sync, check for a
 * newer release (every [UpdatePolicy.BACKGROUND_INTERVAL]) and announce it once per versionCode.
 */
class BackgroundUpdateCheck(
    private val checker: UpdateChecker,
    private val store: UpdateStore,
    private val ownVersionCode: Long,
    private val notificationsAllowed: () -> Boolean,
    /** Posts the notification; false when the system refused it. */
    private val notify: (AvailableUpdate) -> Boolean,
) {
    data class Result(val outcome: UpdateCheckOutcome?, val notified: Boolean)

    suspend fun afterSync(outcome: SyncOutcome): Result {
        if (!serverReachable(outcome)) return Result(null, notified = false)
        val check = checker.checkInBackgroundIfDue()
        if (check == UpdateCheckOutcome.NotPaired || check is UpdateCheckOutcome.Failed) return Result(check, notified = false)
        val update = checker.available ?: return Result(check, notified = false)
        if (!UpdatePolicy.shouldNotify(update, ownVersionCode, store.notifiedVersionCode, notificationsAllowed())) {
            return Result(check, notified = false)
        }
        if (!notify(update)) return Result(check, notified = false)
        store.notifiedVersionCode = update.versionCode
        AppLog.i(TAG, "Notified about ${update.versionName} (${update.versionCode})")
        return Result(check, notified = true)
    }

    companion object {
        private const val TAG = "Update"

        /**
         * The server answered this run: it recorded it ([SyncOutcome.Completed]) or refused it
         * ([SyncOutcome.Failed]). Unpaired, expired and retry-later runs skip the update check.
         */
        fun serverReachable(outcome: SyncOutcome): Boolean =
            outcome is SyncOutcome.Completed || outcome is SyncOutcome.Failed
    }
}
