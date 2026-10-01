package com.enterpriseapp.android.healthsync

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.health.connect.client.PermissionController
import com.enterpriseapp.android.healthconnect.HcAvailability
import com.enterpriseapp.android.healthconnect.HcDataType
import com.enterpriseapp.android.healthconnect.SyncToggle
import com.enterpriseapp.android.sync.LocalSyncRun
import com.enterpriseapp.android.sync.RunStatus

/** Last sync, per-type switches with permission state, Sync now and recent runs. */
@Composable
internal fun SyncScreen(syncVm: SyncViewModel, onOpenConnect: () -> Unit) {
    val state by syncVm.state.collectAsState()
    val permissionLauncher = rememberLauncherForActivityResult(
        PermissionController.createRequestPermissionResultContract(),
    ) { granted -> syncVm.onPermissionsResult(granted) }
    val hcAvailable = state.availability == HcAvailability.AVAILABLE

    SectionCard(title = "Status") {
        val last = state.runs.firstOrNull()
        when {
            state.pairingExpired -> ErrorText("Pairing expired. Re-pair to resume syncing.")
            !state.paired -> ErrorText("This phone is not paired yet.")
            state.availability != null && !hcAvailable -> ErrorText("Health Connect is not available.")
        }
        Text("Last successful sync: ${UiFormat.relative(state.lastSuccessAt)}")
        if (last != null) {
            Text("Last run: ${statusLabel(last)} · ${UiFormat.dateTime(last.finishedAt)}")
            last.errorMessage?.let { Muted(it) }
        }
        if (state.syncing || state.syncQueued) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                Text(if (state.syncing) "Syncing…" else "Sync queued (waits for a network connection)…")
            }
        }
        if (!state.paired || state.pairingExpired) {
            Button(onClick = onOpenConnect, modifier = Modifier.fillMaxWidth()) { Text("Pair this phone") }
        } else {
            Button(
                onClick = syncVm::syncNow,
                enabled = hcAvailable && !state.syncing,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Sync now") }
        }
        Muted("Syncs about every hour and when you open the app. Reads the last 7 days (30 on the first sync).")
    }

    SectionCard(title = "Data types") {
        val missing = state.missingPermissions
        SyncToggle.entries.forEachIndexed { index, toggle ->
            if (index > 0) HorizontalDivider()
            ToggleRow(
                toggle = toggle,
                enabled = state.toggles[toggle] ?: true,
                granted = state.granted,
                hcAvailable = hcAvailable,
                onChange = { syncVm.setToggle(toggle, it) },
            )
        }
        if (hcAvailable && missing.isNotEmpty()) {
            Button(onClick = { permissionLauncher.launch(missing) }, modifier = Modifier.fillMaxWidth()) {
                Text("Grant permissions")
            }
        }
    }

    SectionCard(title = "Recent runs") {
        if (state.runs.isEmpty()) {
            Muted("No sync has run on this phone yet.")
        } else {
            state.runs.forEachIndexed { index, run ->
                if (index > 0) HorizontalDivider()
                RunRow(run)
            }
        }
    }
}

@Composable
private fun ToggleRow(
    toggle: SyncToggle,
    enabled: Boolean,
    granted: Set<String>,
    hcAvailable: Boolean,
    onChange: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(toggle.label, style = MaterialTheme.typography.titleSmall)
            Muted(toggle.description)
            if (hcAvailable) {
                val parts = toggle.dataTypes.map { type ->
                    val ok = type.permission in granted
                    val label = if (toggle.dataTypes.size > 1) "${shortLabel(type)}: " else ""
                    label + if (ok) "allowed" else "not allowed"
                }
                Text(
                    parts.joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall,
                    color = if (toggle.dataTypes.all { it.permission in granted }) {
                        MaterialTheme.colorScheme.primary
                    } else {
                        MaterialTheme.colorScheme.error
                    },
                )
            }
        }
        Switch(checked = enabled, onCheckedChange = onChange)
    }
}

@Composable
private fun RunRow(run: LocalSyncRun) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text("${UiFormat.dateTime(run.finishedAt)} · ${triggerLabel(run.trigger)}", style = MaterialTheme.typography.bodyMedium)
        Text(statusLabel(run), style = MaterialTheme.typography.bodySmall, color = statusColor(run))
        val response = run.response
        val summary = buildString {
            append("Read ${run.recordsRead}, sent ${run.rowsSent}")
            if (response != null) {
                append(" · ${response.totalCreated} new, ${response.totalUpdated} updated, ${response.totalDeleted} removed")
            }
        }
        Muted(summary)
        run.errorMessage?.let { Muted(it) }
    }
}

@Composable
private fun statusColor(run: LocalSyncRun) = when {
    !run.delivered || run.status == RunStatus.FAILED -> MaterialTheme.colorScheme.error
    run.status == RunStatus.OK -> MaterialTheme.colorScheme.primary
    else -> MaterialTheme.colorScheme.onSurfaceVariant
}

private fun statusLabel(run: LocalSyncRun): String {
    val status = when (run.status) {
        RunStatus.OK -> "OK"
        RunStatus.PARTIAL -> "Partial"
        RunStatus.SKIPPED -> "Skipped"
        else -> "Failed"
    }
    return if (run.delivered) status else "$status (not delivered)"
}

private fun triggerLabel(trigger: String): String = when (trigger) {
    "manual" -> "Sync now"
    "initial" -> "first sync"
    "app_open" -> "app opened"
    else -> "hourly"
}

private fun shortLabel(type: HcDataType): String = when (type) {
    HcDataType.HEART_RATE -> "average"
    HcDataType.RESTING_HEART_RATE -> "resting"
    HcDataType.EXERCISE -> "sessions"
    HcDataType.DISTANCE -> "distance"
    else -> type.label
}
