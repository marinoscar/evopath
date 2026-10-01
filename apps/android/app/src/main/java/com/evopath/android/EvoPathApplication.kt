package com.evopath.android

import android.app.Application
import com.evopath.android.auth.EncryptedTokenStore
import com.evopath.android.auth.TokenStore
import com.evopath.android.config.ServerConfig
import com.evopath.android.diagnostics.AndroidDiagnosticsPlatform
import com.evopath.android.diagnostics.ApiServerProbe
import com.evopath.android.diagnostics.AppLog
import com.evopath.android.diagnostics.AutoDiagnostics
import com.evopath.android.diagnostics.DiagnosticsService
import com.evopath.android.diagnostics.SelfTest
import com.evopath.android.healthconnect.AndroidAppLabels
import com.evopath.android.healthconnect.AndroidHealthConnectGateway
import com.evopath.android.healthconnect.AppLabels
import com.evopath.android.healthconnect.HealthConnectGateway
import com.evopath.android.net.ApiClient
import com.evopath.android.net.HealthSyncApi
import com.evopath.android.net.HealthSyncBackend
import com.evopath.android.pairing.ApiDeviceFlowTransport
import com.evopath.android.pairing.DeviceFlowPoller
import com.evopath.android.pairing.DeviceInfo
import com.evopath.android.pairing.PairingManager
import com.evopath.android.sync.HealthSyncEngine
import com.evopath.android.sync.PrefsSyncHistoryStore
import com.evopath.android.sync.PrefsSyncStateStore
import com.evopath.android.sync.SyncHistoryStore
import com.evopath.android.sync.SyncNotifications
import com.evopath.android.sync.SyncScheduling
import com.evopath.android.sync.SyncStateStore
import com.evopath.android.sync.WorkManagerSyncScheduler
import com.evopath.android.util.AppInfo
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Process-wide singletons. Kept deliberately small (no DI framework): screens and
 * workers reach shared state through [EvoPathApplication.from].
 */
class EvoPathApplication : Application() {
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
        fun from(context: android.content.Context): EvoPathApplication =
            context.applicationContext as EvoPathApplication
    }
}
