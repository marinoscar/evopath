package com.enterpriseapp.android.notifications

import android.content.Context
import android.content.SharedPreferences
import com.enterpriseapp.android.BuildConfig

/** Where the app stands on posting notifications (both its own and the web app's delegated Web Push). */
enum class NotificationPermissionState {
    /** Notifications can be shown. */
    GRANTED,

    /** Android 13+: POST_NOTIFICATIONS was never requested by this app; the system dialog will show. */
    NOT_ASKED,

    /** Android 13+: denied once; the system dialog can still be shown again. */
    DENIED,

    /** Android 13+: denied for good (or the dialog no longer appears); only Android Settings can allow it. */
    PERMANENTLY_DENIED,

    /** The permission is granted (or not needed), but notifications are switched off for the app. */
    DISABLED,
    ;

    /** True when the system permission dialog can be shown. */
    val canRequest: Boolean get() = this == NOT_ASKED || this == DENIED
}

/** What tapping the Notifications row (or the diagnostics action) does. */
enum class NotificationAction {
    /** Show the POST_NOTIFICATIONS dialog. */
    REQUEST,

    /** Open the app's notification settings (Settings.ACTION_APP_NOTIFICATION_SETTINGS). */
    OPEN_SETTINGS,
}

/** The Notifications row on the Health sync hub. */
data class NotificationRowUi(
    val status: String,
    val detail: String?,
    val action: NotificationAction?,
    val actionLabel: String?,
    val ok: Boolean,
)

/** Pure mapping from what Android reports to a state and to the hub row; unit-tested. */
object NotificationPermissions {
    const val POST_NOTIFICATIONS_SDK = 33

    /**
     * @param sdkInt Build.VERSION.SDK_INT
     * @param granted POST_NOTIFICATIONS granted (ignored below Android 13, where it is implicit)
     * @param enabled NotificationManagerCompat.areNotificationsEnabled
     * @param askedBefore this app already showed the permission dialog ([NotificationPromptStore.permissionRequested])
     * @param showRationale Activity.shouldShowRequestPermissionRationale(POST_NOTIFICATIONS)
     */
    fun state(sdkInt: Int, granted: Boolean, enabled: Boolean, askedBefore: Boolean, showRationale: Boolean): NotificationPermissionState {
        if (sdkInt >= POST_NOTIFICATIONS_SDK && !granted) {
            return when {
                // Denied once: Android shows the dialog again and asks the app to explain first.
                showRationale -> NotificationPermissionState.DENIED
                // Asked before and Android no longer offers the dialog: denied for good.
                askedBefore -> NotificationPermissionState.PERMANENTLY_DENIED
                else -> NotificationPermissionState.NOT_ASKED
            }
        }
        return if (enabled) NotificationPermissionState.GRANTED else NotificationPermissionState.DISABLED
    }

    fun action(state: NotificationPermissionState): NotificationAction? = when (state) {
        NotificationPermissionState.GRANTED -> null
        NotificationPermissionState.NOT_ASKED, NotificationPermissionState.DENIED -> NotificationAction.REQUEST
        NotificationPermissionState.PERMANENTLY_DENIED, NotificationPermissionState.DISABLED -> NotificationAction.OPEN_SETTINGS
    }

    fun row(state: NotificationPermissionState, productName: String): NotificationRowUi = when (state) {
        NotificationPermissionState.GRANTED -> NotificationRowUi(
            status = "Allowed",
            detail = null,
            action = null,
            actionLabel = null,
            ok = true,
        )
        NotificationPermissionState.NOT_ASKED -> NotificationRowUi(
            status = "Not allowed yet",
            detail = "Allow notifications so $productName can tell you about updates, re-pairing and reminders.",
            action = NotificationAction.REQUEST,
            actionLabel = "Allow",
            ok = false,
        )
        NotificationPermissionState.DENIED -> NotificationRowUi(
            status = "Not allowed",
            detail = "You will miss updates, re-pairing prompts and reminders from $productName.",
            action = NotificationAction.REQUEST,
            actionLabel = "Allow",
            ok = false,
        )
        NotificationPermissionState.PERMANENTLY_DENIED -> NotificationRowUi(
            status = "Blocked",
            detail = "Android no longer asks. Allow notifications for $productName in its notification settings.",
            action = NotificationAction.OPEN_SETTINGS,
            actionLabel = "Open settings",
            ok = false,
        )
        NotificationPermissionState.DISABLED -> NotificationRowUi(
            status = "Turned off",
            detail = "Notifications are switched off for $productName in Android Settings.",
            action = NotificationAction.OPEN_SETTINGS,
            actionLabel = "Open settings",
            ok = false,
        )
    }
}

/** Persisted flags of the contextual notification request. */
interface NotificationPromptStore {
    /** The first-open rationale card on the Health sync hub was shown (it is shown once). */
    var firstOpenPromptShown: Boolean

    /** This app launched the POST_NOTIFICATIONS dialog at least once (tells "denied for good" from "never asked"). */
    var permissionRequested: Boolean
}

class PrefsNotificationPromptStore(private val prefs: SharedPreferences) : NotificationPromptStore {
    override var firstOpenPromptShown: Boolean
        get() = prefs.getBoolean(KEY_FIRST_OPEN_SHOWN, false)
        set(value) = prefs.edit().putBoolean(KEY_FIRST_OPEN_SHOWN, value).apply()

    override var permissionRequested: Boolean
        get() = prefs.getBoolean(KEY_REQUESTED, false)
        set(value) = prefs.edit().putBoolean(KEY_REQUESTED, value).apply()

    companion object {
        const val PREFS_NAME = BuildConfig.STORAGE_PREFIX + "_notifications"
        private const val KEY_FIRST_OPEN_SHOWN = "first_open_prompt_shown"
        private const val KEY_REQUESTED = "permission_requested"

        fun from(context: Context) =
            PrefsNotificationPromptStore(context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE))
    }
}

/** The once-only rationale card shown before the system dialog on the first open of the hub. */
class FirstOpenNotificationPrompt(private val store: NotificationPromptStore) {
    /** Show the card: Android 13+, never shown before, and the system dialog can still appear. */
    fun shouldShow(sdkInt: Int, state: NotificationPermissionState): Boolean =
        sdkInt >= NotificationPermissions.POST_NOTIFICATIONS_SDK && !store.firstOpenPromptShown && state.canRequest

    /** Called as soon as the card is shown, so it never comes back (whatever the user chooses). */
    fun markShown() {
        store.firstOpenPromptShown = true
    }

    /** Called right before the system dialog is launched. */
    fun markRequested() {
        store.permissionRequested = true
    }
}
