package com.evopath.android.healthsync

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.health.connect.client.PermissionController
import com.evopath.android.healthconnect.HcAvailability
import com.evopath.android.healthconnect.HealthConnectIntents
import com.evopath.android.healthconnect.HealthPermissions
import com.evopath.android.healthconnect.PermissionsRationaleActivity

/** Pairing with the EvoPath account, then Health Connect availability and permissions. */
@Composable
internal fun ConnectScreen(pairingVm: PairingViewModel, syncVm: SyncViewModel) {
    val context = LocalContext.current
    val pairing by pairingVm.state.collectAsState()
    val sync by syncVm.state.collectAsState()
    var confirmUnpair by rememberSaveable { mutableStateOf(false) }

    LaunchedEffect(pairingVm) { pairingVm.openUrl.collect { openInCustomTab(context, it) } }
    LaunchedEffect(pairing.justPaired) { if (pairing.justPaired) syncVm.refresh() }

    val permissionLauncher = rememberLauncherForActivityResult(
        PermissionController.createRequestPermissionResultContract(),
    ) { granted -> syncVm.onPermissionsResult(granted) }
    var notificationsGranted by remember { mutableStateOf(notificationsAllowed(context)) }
    val notificationLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        notificationsGranted = it
    }

    PairingSection(
        pairing = pairing,
        onPair = pairingVm::startPairing,
        onCancel = pairingVm::cancel,
        onOpenPage = pairingVm::reopenActivationPage,
        onRetryRegistration = pairingVm::retryRegistration,
        onUnpair = { confirmUnpair = true },
    )

    SectionCard(title = "Health Connect") {
        when (sync.availability) {
            null -> Muted("Checking…")
            HcAvailability.NOT_SUPPORTED -> {
                ErrorText("Health Connect is not available on this phone.")
                Muted("On Android 13 and below, install the Health Connect app from the Play Store.")
                OutlinedButton(onClick = { HealthConnectIntents.openPlayStore(context) }) { Text("Open Play Store") }
            }
            HcAvailability.UPDATE_REQUIRED -> {
                ErrorText("Health Connect needs to be installed or updated.")
                Button(onClick = { HealthConnectIntents.openPlayStore(context) }) { Text("Install or update Health Connect") }
            }
            HcAvailability.AVAILABLE -> {
                Text("Available (version ${sync.providerVersion ?: "unknown"}).")
                val wanted = HealthPermissions.ALL_DATA
                val grantedCount = wanted.count { it in sync.granted }
                Text("$grantedCount of ${wanted.size} data permissions granted.")
                if (sync.backgroundReadAvailable) {
                    Text(if (sync.backgroundGranted) "Background access: allowed." else "Background access: not allowed (hourly sync only works while the app is open).")
                } else {
                    Muted("Background access is not offered by this Health Connect version; hourly syncs may skip types while the app is closed.")
                }
                sync.permissionsError?.let { ErrorText(it) }
                val missing = sync.missingPermissions
                Button(
                    onClick = { permissionLauncher.launch(missing.ifEmpty { HealthPermissions.ALL_DATA.toSet() }) },
                    modifier = Modifier.fillMaxWidth(),
                ) { Text(if (missing.isEmpty()) "Review permissions" else "Grant permissions") }
                OutlinedButton(
                    onClick = { HealthConnectIntents.openHealthConnectSettings(context) },
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("Open Health Connect settings") }
            }
        }
        TextButton(onClick = { context.startActivity(Intent(context, PermissionsRationaleActivity::class.java)) }) {
            Text("How EvoPath uses your health data")
        }
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !notificationsGranted) {
        SectionCard(title = "Notifications") {
            Text("Allow notifications so EvoPath can tell you when Health sync needs you to pair again.")
            OutlinedButton(onClick = { notificationLauncher.launch(Manifest.permission.POST_NOTIFICATIONS) }) {
                Text("Allow notifications")
            }
        }
    }

    if (confirmUnpair) {
        AlertDialog(
            onDismissRequest = { confirmUnpair = false },
            title = { Text("Unpair this phone?") },
            text = {
                Text(
                    "Health sync stops and this phone's access token is revoked. Data already imported stays " +
                        "in EvoPath (delete it from Settings → Connected devices if you want).",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmUnpair = false
                    pairingVm.unpair()
                }) { Text("Unpair") }
            },
            dismissButton = { TextButton(onClick = { confirmUnpair = false }) { Text("Cancel") } },
        )
    }

    pairing.unpairFailure?.let { message ->
        AlertDialog(
            onDismissRequest = pairingVm::dismissUnpairFailure,
            title = { Text("Could not reach the server") },
            text = {
                Text(
                    "$message\n\nYou can remove the pairing from this phone only. The device and its token then " +
                        "stay active on the server until you remove them in EvoPath → Settings → Connected devices.",
                )
            },
            confirmButton = { TextButton(onClick = { pairingVm.unpair(forgetLocallyOnFailure = true) }) { Text("Remove from this phone") } },
            dismissButton = { TextButton(onClick = pairingVm::dismissUnpairFailure) { Text("Cancel") } },
        )
    }
}

@Composable
private fun PairingSection(
    pairing: PairingUiState,
    onPair: () -> Unit,
    onCancel: () -> Unit,
    onOpenPage: () -> Unit,
    onRetryRegistration: () -> Unit,
    onUnpair: () -> Unit,
) {
    val status = pairing.status
    SectionCard(title = "EvoPath account") {
        if (!status.serverConfigured) {
            ErrorText("Set the server address on the Health sync screen first.")
            return@SectionCard
        }
        when (pairing.phase) {
            PairingPhase.REQUESTING_CODE -> Busy("Requesting a pairing code…")
            PairingPhase.REGISTERING -> Busy("Registering this phone…")
            PairingPhase.UNPAIRING -> Busy("Unpairing…")
            PairingPhase.WAITING_FOR_APPROVAL -> {
                Text("Approve this phone in the browser that just opened. Check that it shows this code:")
                Text(
                    pairing.userCode.orEmpty(),
                    style = MaterialTheme.typography.headlineMedium,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                )
                pairing.verificationUri?.let { Muted("Or open $it on any device signed in to EvoPath and enter the code.") }
                pairing.secondsRemaining?.let { Muted("The code expires in about ${UiFormat.minutes(it)}.") }
                pairing.note?.let { Muted(it) }
                Busy("Waiting for approval…")
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = onOpenPage) { Text("Open sign-in page") }
                    OutlinedButton(onClick = onCancel) { Text("Cancel") }
                }
            }
            PairingPhase.IDLE -> {
                when {
                    status.expired -> ErrorText("The server no longer accepts this phone's token. Pair again to resume syncing.")
                    status.paired -> {
                        Text("Paired with your EvoPath account.")
                        Muted("Device ${status.deviceId?.take(8)} · token expires ${UiFormat.date(status.tokenExpiresAt)}")
                    }
                    status.hasToken -> ErrorText("Signed in, but this phone is not registered yet.")
                    else -> Text("Pair this phone with your EvoPath account. You approve it in your browser, where you are already signed in.")
                }
                pairing.note?.let { Text(it) }
                pairing.error?.let { ErrorText(it) }
                if (pairing.canRetryRegistration || (status.hasToken && !status.paired && !status.expired)) {
                    Button(onClick = onRetryRegistration, modifier = Modifier.fillMaxWidth()) { Text("Retry registration") }
                }
                if (status.paired || status.expired) {
                    Button(onClick = onPair, modifier = Modifier.fillMaxWidth()) { Text("Re-pair") }
                    OutlinedButton(onClick = onUnpair, modifier = Modifier.fillMaxWidth()) { Text("Unpair") }
                } else {
                    Button(onClick = onPair, modifier = Modifier.fillMaxWidth()) { Text("Pair with EvoPath") }
                }
            }
        }
    }
}

@Composable
private fun Busy(label: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
        Text(label)
    }
}

private fun notificationsAllowed(context: android.content.Context): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
