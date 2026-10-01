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
        setContent {
            AppTheme {
                HealthSyncApp(
                    pairingVm = pairingVm,
                    syncVm = syncVm,
                    diagnosticsVm = diagnosticsVm,
                    pendingOpen = pendingOpen,
                    onOpenWebApp = ::openWebApp,
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
        MobileApplication.from(this).refreshAvailableUpdate()
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
) {
    var screen by rememberSaveable { mutableStateOf(HealthSyncScreen.Hub) }
    var requestBackground by remember { mutableStateOf(false) }
    val open by pendingOpen.collectAsState()
    LaunchedEffect(open) {
        when (open) {
            HealthSyncActivity.OPEN_BACKGROUND_ACCESS -> {
                screen = HealthSyncScreen.Connect
                requestBackground = true
            }
            HealthSyncActivity.OPEN_DIAGNOSTICS -> screen = HealthSyncScreen.Diagnostics
        }
        if (open != null) pendingOpen.value = null
    }
    BackHandler(enabled = screen != HealthSyncScreen.Hub) { screen = HealthSyncScreen.Hub }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(screen.title) },
                navigationIcon = {
                    if (screen != HealthSyncScreen.Hub) {
                        TextButton(onClick = { screen = HealthSyncScreen.Hub }) { Text("Back") }
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
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            when (screen) {
                HealthSyncScreen.Hub -> HubScreen(
                    pairingVm = pairingVm,
                    diagnosticsVm = diagnosticsVm,
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

    val update by app.availableUpdate.collectAsState()
    update?.let { UpdateCard(it, installedVersion = "${appInfo.versionName} (${appInfo.versionCode})") }

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
