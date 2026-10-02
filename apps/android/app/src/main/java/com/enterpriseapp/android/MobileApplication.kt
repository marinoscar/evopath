package com.enterpriseapp.android

import android.app.Application
import com.enterpriseapp.android.auth.EncryptedTokenStore
import com.enterpriseapp.android.auth.TokenStore
import com.enterpriseapp.android.config.ServerConfig
import com.enterpriseapp.android.diagnostics.AndroidDiagnosticsPlatform
import com.enterpriseapp.android.diagnostics.ApiServerProbe
import com.enterpriseapp.android.diagnostics.AppLog
import com.enterpriseapp.android.diagnostics.AutoDiagnostics
import com.enterpriseapp.android.diagnostics.DiagnosticsService
import com.enterpriseapp.android.diagnostics.SelfTest
import com.enterpriseapp.android.healthconnect.AndroidAppLabels
import com.enterpriseapp.android.healthconnect.AndroidHealthConnectGateway
import com.enterpriseapp.android.healthconnect.AppLabels
import com.enterpriseapp.android.healthconnect.HealthConnectGateway
import com.enterpriseapp.android.net.ApiClient
import com.enterpriseapp.android.net.HealthSyncApi
import com.enterpriseapp.android.net.HealthSyncBackend
import com.enterpriseapp.android.notifications.NotificationPromptStore
import com.enterpriseapp.android.notifications.PrefsNotificationPromptStore
import com.enterpriseapp.android.pairing.ApiDeviceFlowTransport
import com.enterpriseapp.android.pairing.DeviceFlowPoller
import com.enterpriseapp.android.pairing.DeviceInfo
import com.enterpriseapp.android.pairing.PairingManager
import com.enterpriseapp.android.sync.HealthSyncEngine
import com.enterpriseapp.android.sync.PrefsSyncHistoryStore
import com.enterpriseapp.android.sync.PrefsSyncStateStore
import com.enterpriseapp.android.sync.SyncHistoryStore
import com.enterpriseapp.android.sync.SyncNotifications
import com.enterpriseapp.android.sync.SyncScheduling
import com.enterpriseapp.android.sync.SyncStateStore
import com.enterpriseapp.android.sync.WorkManagerSyncScheduler
import com.enterpriseapp.android.update.AndroidReleaseApi
import com.enterpriseapp.android.update.AvailableUpdate
import com.enterpriseapp.android.update.BackgroundUpdateCheck
import com.enterpriseapp.android.update.PrefsUpdateStore
import com.enterpriseapp.android.update.ReleaseBackend
import com.enterpriseapp.android.update.UpdateChecker
import com.enterpriseapp.android.update.UpdateStore
import com.enterpriseapp.android.util.AppInfo
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Process-wide singletons. Kept deliberately small (no DI framework): screens and
 * workers reach shared state through [MobileApplication.from].
 */
class MobileApplication : Application() {
    val serverConfig: ServerConfig by lazy { ServerConfig.from(this) }
    val tokenStore: TokenStore by lazy { EncryptedTokenStore.create(this) }

    /** Authenticated client for the configured server; base URL and token are read per request. */
    val apiClient: ApiClient by lazy {
        ApiClient(
            baseUrlProvider = { serverConfig.serverUrl },
            tokenProvider = { tokenStore.token },
            userAgent = DeviceInfo.userAgent(AppInfo.read(this).versionName),
        )
    }

    val healthSyncApi: HealthSyncBackend by lazy { HealthSyncApi(apiClient) }
    val healthConnect: HealthConnectGateway by lazy { AndroidHealthConnectGateway(this) }
    val appLabels: AppLabels by lazy { AndroidAppLabels(this) }
    val syncState: SyncStateStore by lazy { PrefsSyncStateStore.from(this) }
    val syncHistory: SyncHistoryStore by lazy { PrefsSyncHistoryStore.from(this) }
    val syncScheduler: SyncScheduling by lazy { WorkManagerSyncScheduler(this) }
    val notificationPrompts: NotificationPromptStore by lazy { PrefsNotificationPromptStore.from(this) }

    /** Process-wide scope for short fire-and-forget calls (update check on app open). */
    val appScope: CoroutineScope by lazy { CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate) }

    val releaseApi: ReleaseBackend by lazy { AndroidReleaseApi(apiClient) }
    val updateStore: UpdateStore by lazy { PrefsUpdateStore.from(this) }
    val updateChecker: UpdateChecker by lazy {
        UpdateChecker(
            backend = releaseApi,
            store = updateStore,
            ownPackage = packageName,
            ownVersionCode = BuildConfig.VERSION_CODE.toLong(),
            isPaired = { tokenStore.isPaired && !syncState.pairingExpired },
        )
    }

    /** Run by the sync worker after each run: the 6 h update check and its notification. */
    val backgroundUpdateCheck: BackgroundUpdateCheck by lazy {
        BackgroundUpdateCheck(
            checker = updateChecker,
            store = updateStore,
            ownVersionCode = BuildConfig.VERSION_CODE.toLong(),
            notificationsAllowed = { SyncNotifications.canNotify(this) },
            notify = { SyncNotifications.notifyUpdateAvailable(this, it) },
        )
    }

    private val updateFlow = MutableStateFlow<AvailableUpdate?>(null)

    /** The newer release the Health sync hub offers, or null. */
    val availableUpdate: StateFlow<AvailableUpdate?> = updateFlow.asStateFlow()

    fun refreshAvailableUpdate() {
        updateFlow.value = runCatching { updateChecker.available }.getOrNull()
    }

    private val syncTicks = MutableStateFlow(0L)

    /** Bumps after every sync run, so open screens reload status and history. */
    val syncFinished: StateFlow<Long> = syncTicks.asStateFlow()

    /** Paired, registered and not expired: the state in which syncing runs. */
    val isSyncConfigured: Boolean
        get() = tokenStore.isPaired && !tokenStore.deviceId.isNullOrEmpty() && !syncState.pairingExpired

    override fun onCreate() {
        super.onCreate()
        AppLog.init(this)
        SyncNotifications.ensureChannels(this)
        runCatching {
            updateChecker.onLaunch()
            refreshAvailableUpdate()
            // Installed the announced version (or the offer is gone): drop a stale notice.
            if (updateChecker.available == null) SyncNotifications.cancelUpdateAvailable(this)
        }
        // Re-assert the hourly schedule (KEEP) in case it was lost, e.g. after an app data restore.
        if (isSyncConfigured) runCatching { syncScheduler.ensurePeriodic() }
    }

    fun newSyncEngine(): HealthSyncEngine = HealthSyncEngine(
        gateway = healthConnect,
        backend = healthSyncApi,
        tokens = tokenStore,
        state = syncState,
        history = syncHistory,
        labels = appLabels,
        notifier = { SyncNotifications.notifyPairingExpired(this) },
        backgroundNotifier = { available -> SyncNotifications.notifyBackgroundAccess(this, available) },
    )

    val diagnostics: DiagnosticsService by lazy {
        DiagnosticsService(
            selfTest = ::newSelfTest,
            backend = healthSyncApi,
            tokens = tokenStore,
            state = syncState,
            history = syncHistory,
        )
    }

    fun newSelfTest(): SelfTest = SelfTest(
        platform = AndroidDiagnosticsPlatform(this),
        serverUrl = { serverConfig.serverUrl },
        server = ApiServerProbe(apiClient),
        backend = healthSyncApi,
        gateway = healthConnect,
        labels = appLabels,
        tokens = tokenStore,
        state = syncState,
        history = syncHistory,
        releases = releaseApi,
    )

    fun newAutoDiagnostics(): AutoDiagnostics =
        AutoDiagnostics(tokens = tokenStore, state = syncState, server = ApiServerProbe(apiClient), service = diagnostics)

    fun newPairingManager(): PairingManager = PairingManager(
        transport = ApiDeviceFlowTransport(apiClient),
        poller = DeviceFlowPoller(ApiDeviceFlowTransport(apiClient)),
        backend = healthSyncApi,
        tokens = tokenStore,
        state = syncState,
        scheduler = syncScheduler,
        clientInfo = { DeviceInfo.clientInfo(this) },
        deviceRegistration = { installationId -> DeviceInfo.registration(this, installationId) },
    )

    fun onSyncFinished() {
        syncTicks.value = syncTicks.value + 1
    }

    companion object {
        fun from(context: android.content.Context): MobileApplication =
            context.applicationContext as MobileApplication
    }
}
