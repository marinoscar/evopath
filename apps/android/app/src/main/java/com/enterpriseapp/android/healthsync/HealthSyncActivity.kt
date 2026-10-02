package com.enterpriseapp.android.healthsync

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.enterpriseapp.android.BuildConfig
import com.enterpriseapp.android.MobileApplication
import com.enterpriseapp.android.TwaLauncherActivity
import com.enterpriseapp.android.notifications.FirstOpenNotificationPrompt
import com.enterpriseapp.android.notifications.NotificationAccess
import com.enterpriseapp.android.sync.WorkManagerSyncScheduler
import com.enterpriseapp.android.update.AppUpdates
import com.enterpriseapp.android.ui.components.ServerUrlEditor
import com.enterpriseapp.android.ui.theme.AppTheme
import com.enterpriseapp.android.util.AppInfo
import com.enterpriseapp.android.util.Brand
import kotlinx.coroutines.flow.MutableStateFlow

/** Hub sections. */
enum class HealthSyncScreen(val title: String) {
    Hub("Health sync"),
    Connect("Connect"),
    Sync("Sync"),
    Diagnostics("Diagnostics"),
}

/**
 * Native Health sync hub. Reached from the "Health sync" app shortcut and the
 * `<deep-link scheme>://health-sync` deep link (BuildConfig.DEEP_LINK_SCHEME) (the web app's "Open Health sync" button).
 */
class HealthSyncActivity : ComponentActivity() {
    private val pairingVm: PairingViewModel by viewModels()
    private val syncVm: SyncViewModel by viewModels()
    private val diagnosticsVm: DiagnosticsViewModel by viewModels()

    /** A destination requested by a notification (`EXTRA_OPEN`), consumed by the UI once. */
    private val pendingOpen = MutableStateFlow<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if (savedInstanceState == null) {
            WorkManagerSyncScheduler.onAppOpen(this)
            AppUpdates.onAppOpen(this)
            pendingOpen.value = intent?.getStringExtra(EXTRA_OPEN)
        }
        refreshNotificationState()
        setContent {
            AppTheme {
                HealthSyncApp(
                    pairingVm = pairingVm,
                    syncVm = syncVm,
                    diagnosticsVm = diagnosticsVm,
                    pendingOpen = pendingOpen,
                    onOpenWebApp = ::openWebApp,
                    onExit = ::finish,
                )
            }
        }
    }

    override fun onResume() {
        super.onResume()
        // Permissions or pairing may have changed in Health Connect or the browser.
        pairingVm.refreshStatus()
        syncVm.refresh()
        diagnosticsVm.onResume()
        refreshNotificationState()
        MobileApplication.from(this).refreshAvailableUpdate()
    }

    /** Notification permission may have changed in Android Settings or through the web app. */
    fun refreshNotificationState() {
        diagnosticsVm.refreshNotifications(NotificationAccess.state(this, MobileApplication.from(this).notificationPrompts))
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        intent.getStringExtra(EXTRA_OPEN)?.let { pendingOpen.value = it }
    }

    companion object {
        /** Intent extra: which part of Health sync to open. */
        const val EXTRA_OPEN = BuildConfig.APPLICATION_ID + ".extra.OPEN"

        /** Opens Connect and asks for the background-read permission. */
        const val OPEN_BACKGROUND_ACCESS = "background_access"
        const val OPEN_DIAGNOSTICS = "diagnostics"

        /** Opens the hub scrolled to (and highlighting) the update card ("new version" notification). */
        const val OPEN_UPDATE = "update"
    }

    private fun openWebApp() {
        startActivity(Intent(this, TwaLauncherActivity::class.java))
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HealthSyncApp(
    pairingVm: PairingViewModel,
    syncVm: SyncViewModel,
    diagnosticsVm: DiagnosticsViewModel,
    pendingOpen: MutableStateFlow<String?>,
    onOpenWebApp: () -> Unit,
    onExit: () -> Unit,
) {
    var screen by rememberSaveable { mutableStateOf(HealthSyncScreen.Hub) }
    var requestBackground by remember { mutableStateOf(false) }
    var highlightUpdate by rememberSaveable { mutableStateOf(false) }
    val scrollState = rememberScrollState()
    val context = androidx.compose.ui.platform.LocalContext.current
    val open by pendingOpen.collectAsState()
    LaunchedEffect(open) {
        when (open) {
            HealthSyncActivity.OPEN_UPDATE -> {
                screen = HealthSyncScreen.Hub
                highlightUpdate = true
                MobileApplication.from(context).refreshAvailableUpdate()
                scrollState.animateScrollTo(0)
            }
            HealthSyncActivity.OPEN_BACKGROUND_ACCESS -> {
                screen = HealthSyncScreen.Connect
                requestBackground = true
            }
            HealthSyncActivity.OPEN_DIAGNOSTICS -> screen = HealthSyncScreen.Diagnostics
        }
        if (open != null) pendingOpen.value = null
    }
    // Every sub-screen returns to the hub (system back and the app-bar arrow alike); on the hub,
    // back leaves Health sync (the system default, and the arrow calls [onExit]).
    val goBack: () -> Unit = { if (screen == HealthSyncScreen.Hub) onExit() else screen = HealthSyncScreen.Hub }
    BackHandler(enabled = screen != HealthSyncScreen.Hub) { screen = HealthSyncScreen.Hub }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(screen.title) },
                navigationIcon = {
                    IconButton(onClick = goBack) {
                        Icon(BackArrow, contentDescription = "Back")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.primary,
                    titleContentColor = MaterialTheme.colorScheme.onPrimary,
                    navigationIconContentColor = MaterialTheme.colorScheme.onPrimary,
                ),
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(scrollState)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            when (screen) {
                HealthSyncScreen.Hub -> HubScreen(
                    pairingVm = pairingVm,
                    diagnosticsVm = diagnosticsVm,
                    highlightUpdate = highlightUpdate,
                    onNavigate = { screen = it },
                    onOpenWebApp = onOpenWebApp,
                )
                HealthSyncScreen.Connect -> ConnectScreen(
                    pairingVm = pairingVm,
                    syncVm = syncVm,
                    requestBackground = requestBackground,
                    onBackgroundRequested = { requestBackground = false },
                )
                HealthSyncScreen.Sync -> SyncScreen(syncVm = syncVm, onOpenConnect = { screen = HealthSyncScreen.Connect })
                HealthSyncScreen.Diagnostics -> DiagnosticsScreen(
                    vm = diagnosticsVm,
                    syncVm = syncVm,
                    onNavigate = { screen = it },
                )
            }
        }
    }
}

@Composable
private fun HubScreen(
    pairingVm: PairingViewModel,
    diagnosticsVm: DiagnosticsViewModel,
    highlightUpdate: Boolean,
    onNavigate: (HealthSyncScreen) -> Unit,
    onOpenWebApp: () -> Unit,
) {
    val diagnostics by diagnosticsVm.state.collectAsState()
    val context = androidx.compose.ui.platform.LocalContext.current
    val app = MobileApplication.from(context)
    var serverUrl by rememberSaveable { mutableStateOf(app.serverConfig.serverUrl) }
    var editingServer by rememberSaveable { mutableStateOf(false) }
    val pairing by pairingVm.state.collectAsState()
    val appInfo = AppInfo.read(context)

    // Notifications: a once-only rationale card on the first open (Android 13+), then the hub row.
    val requestNotifications = rememberNotificationRequester()
    val firstOpenPrompt = FirstOpenNotificationPrompt(app.notificationPrompts)
    var showNotificationRationale by rememberSaveable {
        mutableStateOf(diagnostics.notifications?.let { firstOpenPrompt.shouldShow(android.os.Build.VERSION.SDK_INT, it) } ?: false)
    }
    LaunchedEffect(showNotificationRationale) {
        if (showNotificationRationale) firstOpenPrompt.markShown()
    }
    if (showNotificationRationale) {
        NotificationRationaleCard(
            onAllow = {
                showNotificationRationale = false
                requestNotifications(diagnostics.notifications)
            },
            onDismiss = { showNotificationRationale = false },
        )
    }

    val update by app.availableUpdate.collectAsState()
    update?.let { UpdateCard(it, installedVersion = "${appInfo.versionName} (${appInfo.versionCode})", highlighted = highlightUpdate) }

    SectionCard(title = "Server") {
        Text(serverUrl ?: "Not configured", style = MaterialTheme.typography.bodyLarge)
        OutlinedButton(onClick = { editingServer = true }) { Text(if (serverUrl == null) "Set server" else "Change") }
    }

    SectionCard(title = "Pairing") {
        val status = pairing.status
        when {
            status.expired -> ErrorText("Pairing expired: re-pair to resume syncing.")
            status.paired -> Text("Paired. Token expires ${UiFormat.date(status.tokenExpiresAt)}.")
            status.hasToken -> ErrorText("Signed in, but this phone is not registered yet.")
            else -> Text("Not paired with your ${Brand.name} account yet.")
        }
    }

    NotificationsCard(diagnostics.notifications, onAction = { requestNotifications(diagnostics.notifications) })

    SectionCard(title = "Health Connect") {
        Button(onClick = { onNavigate(HealthSyncScreen.Connect) }, modifier = Modifier.fillMaxWidth()) {
            Text(if (pairing.status.paired && !pairing.status.expired) "Pairing and permissions" else "Connect")
        }
        OutlinedButton(onClick = { onNavigate(HealthSyncScreen.Sync) }, modifier = Modifier.fillMaxWidth()) {
            Text("Sync now")
        }
        OutlinedButton(onClick = { onNavigate(HealthSyncScreen.Diagnostics) }, modifier = Modifier.fillMaxWidth()) {
            Text("Diagnostics")
        }
        HealthLine(diagnostics, onOpen = { onNavigate(HealthSyncScreen.Diagnostics) })
    }

    OutlinedButton(onClick = onOpenWebApp, enabled = serverUrl != null, modifier = Modifier.fillMaxWidth()) {
        Text("Open ${Brand.name}")
    }

    Text(
        "${Brand.name} ${appInfo.versionName} (${appInfo.versionCode})",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )

    if (editingServer) {
        AlertDialog(
            onDismissRequest = { editingServer = false },
            title = { Text("Server address") },
            text = {
                ServerUrlEditor(
                    initialValue = serverUrl.orEmpty(),
                    saveLabel = "Save",
                    onSave = { url ->
                        app.serverConfig.setServerUrl(url)
                        serverUrl = app.serverConfig.serverUrl
                        editingServer = false
                    },
                )
            },
            confirmButton = {},
            dismissButton = { TextButton(onClick = { editingServer = false }) { Text("Cancel") } },
        )
    }
}

/** Compact self-test result on the hub: "All checks pass" or "2 problems — open Diagnostics". */
@Composable
private fun HealthLine(state: DiagnosticsUiState, onOpen: () -> Unit) {
    val result = state.result
    when {
        result == null && state.running -> Muted("Checking this phone…")
        result == null -> Unit
        result.problemCount == 0 -> Muted("All checks pass")
        else -> {
            val n = result.problemCount
            TextButton(onClick = onOpen) {
                Text(
                    "$n problem${if (n == 1) "" else "s"} — open Diagnostics",
                    color = if (result.failCount > 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                )
            }
        }
    }
}
