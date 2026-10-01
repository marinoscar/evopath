package com.evopath.android.healthsync

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
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.evopath.android.EvoPathApplication
import com.evopath.android.TwaLauncherActivity
import com.evopath.android.ui.components.ServerUrlEditor
import com.evopath.android.ui.theme.EvoPathTheme
import com.evopath.android.sync.WorkManagerSyncScheduler
import com.evopath.android.util.AppInfo

/** Hub sections. Diagnostics is filled in by #282. */
enum class HealthSyncScreen(val title: String) {
    Hub("Health sync"),
    Connect("Connect"),
    Sync("Sync"),
    Diagnostics("Diagnostics"),
}

/**
 * Native Health sync hub. Reached from the "Health sync" app shortcut and the
 * `evopath-android://health-sync` deep link (the web app's "Open Health sync" button).
 */
class HealthSyncActivity : ComponentActivity() {
    private val pairingVm: PairingViewModel by viewModels()
    private val syncVm: SyncViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if (savedInstanceState == null) WorkManagerSyncScheduler.onAppOpen(this)
        setContent {
            EvoPathTheme { HealthSyncApp(pairingVm = pairingVm, syncVm = syncVm, onOpenWebApp = ::openWebApp) }
        }
    }

    override fun onResume() {
        super.onResume()
        // Permissions or pairing may have changed in Health Connect or the browser.
        pairingVm.refreshStatus()
        syncVm.refresh()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
    }

    private fun openWebApp() {
        startActivity(Intent(this, TwaLauncherActivity::class.java))
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HealthSyncApp(pairingVm: PairingViewModel, syncVm: SyncViewModel, onOpenWebApp: () -> Unit) {
    var screen by rememberSaveable { mutableStateOf(HealthSyncScreen.Hub) }
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
                HealthSyncScreen.Hub -> HubScreen(pairingVm = pairingVm, onNavigate = { screen = it }, onOpenWebApp = onOpenWebApp)
                HealthSyncScreen.Connect -> ConnectScreen(pairingVm = pairingVm, syncVm = syncVm)
                HealthSyncScreen.Sync -> SyncScreen(syncVm = syncVm, onOpenConnect = { screen = HealthSyncScreen.Connect })
                HealthSyncScreen.Diagnostics -> PlaceholderScreen(screen)
            }
        }
    }
}

@Composable
private fun HubScreen(pairingVm: PairingViewModel, onNavigate: (HealthSyncScreen) -> Unit, onOpenWebApp: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val app = EvoPathApplication.from(context)
    var serverUrl by rememberSaveable { mutableStateOf(app.serverConfig.serverUrl) }
    var editingServer by rememberSaveable { mutableStateOf(false) }
    val pairing by pairingVm.state.collectAsState()
    val appInfo = AppInfo.read(context)

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
            else -> Text("Not paired with your EvoPath account yet.")
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
    }

    OutlinedButton(onClick = onOpenWebApp, enabled = serverUrl != null, modifier = Modifier.fillMaxWidth()) {
        Text("Open EvoPath")
    }

    Text(
        "EvoPath ${appInfo.versionName} (${appInfo.versionCode})",
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

@Composable
private fun PlaceholderScreen(screen: HealthSyncScreen) {
    SectionCard(title = screen.title) {
        Text("Coming soon.", style = MaterialTheme.typography.bodyLarge)
    }
}
