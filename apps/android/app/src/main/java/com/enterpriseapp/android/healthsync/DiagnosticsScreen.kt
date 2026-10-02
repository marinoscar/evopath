package com.enterpriseapp.android.healthsync

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PersistableBundle
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.health.connect.client.PermissionController
import com.enterpriseapp.android.MobileApplication
import com.enterpriseapp.android.diagnostics.CheckAction
import com.enterpriseapp.android.diagnostics.CheckResult
import com.enterpriseapp.android.diagnostics.CheckStatus
import com.enterpriseapp.android.diagnostics.Checks
import com.enterpriseapp.android.diagnostics.InventoryEntry
import com.enterpriseapp.android.diagnostics.SelfTestResult
import com.enterpriseapp.android.healthconnect.HcDataType
import com.enterpriseapp.android.healthconnect.HealthConnectIntents
import com.enterpriseapp.android.healthconnect.HealthPermissions
import com.enterpriseapp.android.healthconnect.SyncToggle
import com.enterpriseapp.android.sync.LocalSyncRun
import com.enterpriseapp.android.update.AppUpdates
import com.enterpriseapp.android.util.Brand
import java.time.Instant
import java.time.ZoneId

/** Self-test, Health Connect inventory, sources, recent runs, report actions and the log. */
@Composable
internal fun DiagnosticsScreen(
    vm: DiagnosticsViewModel,
    syncVm: SyncViewModel,
    onNavigate: (HealthSyncScreen) -> Unit,
) {
    val context = LocalContext.current
    val state by vm.state.collectAsState()
    val result = state.result
    var confirmReset by rememberSaveable { mutableStateOf(false) }

    LaunchedEffect(Unit) { vm.runSelfTest(ifOlderThan = DiagnosticsViewModel.AUTO_RERUN) }

    val permissionLauncher = rememberLauncherForActivityResult(PermissionController.createRequestPermissionResultContract()) {
        syncVm.onPermissionsResult(it)
        vm.runSelfTest()
    }

    val requestNotifications = rememberNotificationRequester(
        onResult = { vm.runSelfTest() },
        onSettingsOpened = vm::markActionTaken,
    )

    fun perform(action: CheckAction) {
        val server = MobileApplication.from(context).serverConfig.serverUrl
        when (action) {
            CheckAction.SET_SERVER -> onNavigate(HealthSyncScreen.Hub)
            CheckAction.REPAIR -> onNavigate(HealthSyncScreen.Connect)
            CheckAction.GRANT_PERMISSIONS -> permissionLauncher.launch(permissionsToRequest(context, result))
            CheckAction.GRANT_BACKGROUND -> permissionLauncher.launch(setOf(HealthPermissions.READ_HEALTH_DATA_IN_BACKGROUND))
            CheckAction.OPEN_HEALTH_CONNECT -> {
                vm.markActionTaken()
                HealthConnectIntents.openHealthConnectSettings(context)
            }
            CheckAction.UPDATE_HEALTH_CONNECT -> {
                vm.markActionTaken()
                HealthConnectIntents.openPlayStore(context)
            }
            CheckAction.BATTERY_SETTINGS -> {
                vm.markActionTaken()
                DiagnosticsIntents.openBatterySettings(context)
            }
            CheckAction.NOTIFICATION_SETTINGS -> {
                vm.markActionTaken()
                DiagnosticsIntents.openNotificationSettings(context)
            }
            CheckAction.ALLOW_NOTIFICATIONS -> requestNotifications(state.notifications)
            CheckAction.SYNC_NOW -> vm.syncNow()
            CheckAction.OPEN_CONNECTED_DEVICES -> server?.let { openInCustomTab(context, "$it$CONNECTED_DEVICES_PATH") }
            CheckAction.OPEN_ANDROID_APP_ADMIN -> server?.let { openInCustomTab(context, "$it$ANDROID_ADMIN_PATH") }
            CheckAction.OPEN_SYNC_SETTINGS -> onNavigate(HealthSyncScreen.Sync)
            CheckAction.GET_UPDATE -> {
                AppUpdates.checkNow(context)
                onNavigate(HealthSyncScreen.Hub)
            }
        }
    }

    SummaryCard(state = state, onRun = { vm.runSelfTest() })

    if (result != null) {
        SectionCard(title = "Checks") {
            val ordered = result.checks.sortedBy { severityOrder(it.verdict) }
            ordered.forEachIndexed { index, check ->
                if (index > 0) HorizontalDivider()
                CheckRow(check, onAction = ::perform)
            }
        }
        InventoryCard(result)
        SourcesCard(result)
    }

    RecentRunsCard(state.runs)

    SectionCard(title = "Actions") {
        Button(onClick = vm::syncNow, modifier = Modifier.fillMaxWidth()) { Text("Sync now") }
        OutlinedButton(
            onClick = vm::upload,
            enabled = state.report != null && !state.uploading,
            modifier = Modifier.fillMaxWidth(),
        ) { Text(if (state.uploading) "Uploading…" else "Upload report") }
        state.uploadedId?.let { id ->
            Text("Report uploaded (id ${id.take(8)}…).")
            Muted("View on the web: Settings → Connected devices.")
            TextButton(onClick = { perform(CheckAction.OPEN_CONNECTED_DEVICES) }) { Text("Open Connected devices") }
        }
        state.uploadError?.let { ErrorText(it) }
        OutlinedButton(
            onClick = { state.report?.let { shareReport(context, it.text, result?.generatedAt) } },
            enabled = state.report != null,
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Share report") }
        OutlinedButton(
            onClick = {
                state.report?.let {
                    copyToClipboard(context, it.text)
                    vm.showMessage("Report copied to the clipboard.")
                }
            },
            enabled = state.report != null,
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Copy to clipboard") }
        OutlinedButton(onClick = { confirmReset = true }, modifier = Modifier.fillMaxWidth()) { Text("Reset local sync state") }
        OutlinedButton(
            onClick = {
                vm.markActionTaken()
                HealthConnectIntents.openHealthConnectSettings(context)
            },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Open Health Connect settings") }
        state.message?.let { Muted(it) }
    }

    LogCard(state.log, onRefresh = vm::refreshLocal)

    if (confirmReset) {
        AlertDialog(
            onDismissRequest = { confirmReset = false },
            title = { Text("Reset local sync state?") },
            text = {
                Text(
                    "${Brand.name} forgets when it last synced on this phone, so the next sync reads the last 30 days " +
                        "again (as on the first sync). Nothing is deleted on the server or in Health Connect.",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmReset = false
                    vm.resetLocalSyncState()
                }) { Text("Reset") }
            },
            dismissButton = { TextButton(onClick = { confirmReset = false }) { Text("Cancel") } },
        )
    }
}

private const val CONNECTED_DEVICES_PATH = "/settings/connected-devices"
private const val ANDROID_ADMIN_PATH = "/admin/settings/android"

private fun severityOrder(status: CheckStatus) = when (status) {
    CheckStatus.FAIL -> 0
    CheckStatus.WARN -> 1
    CheckStatus.PASS -> 2
    CheckStatus.SKIP -> 3
}

/** Missing data permissions for the enabled types, plus background reading when offered. */
private fun permissionsToRequest(context: Context, result: SelfTestResult?): Set<String> {
    val app = MobileApplication.from(context)
    val granted = result?.healthConnect?.grantedPermissions?.toSet().orEmpty()
    val wanted = SyncToggle.permissionsFor(app.syncState.enabledToggles, includeBackground = result?.healthConnect?.backgroundAvailable == true)
    return (wanted - granted).ifEmpty { HealthPermissions.ALL_DATA.toSet() }
}

@Composable
private fun statusColor(status: CheckStatus): Color = when (status) {
    CheckStatus.PASS -> Color(0xFF2E7D32)
    CheckStatus.WARN -> Color(0xFFB26A00)
    CheckStatus.FAIL -> MaterialTheme.colorScheme.error
    CheckStatus.SKIP -> MaterialTheme.colorScheme.outline
}

private fun statusSymbol(status: CheckStatus) = when (status) {
    CheckStatus.PASS -> "✓"
    CheckStatus.WARN -> "!"
    CheckStatus.FAIL -> "✕"
    CheckStatus.SKIP -> "–"
}

@Composable
private fun StatusIcon(status: CheckStatus) {
    Box(
        modifier = Modifier
            .size(24.dp)
            .background(statusColor(status), CircleShape)
            .semantics { contentDescription = status.wire },
        contentAlignment = Alignment.Center,
    ) {
        Text(statusSymbol(status), color = Color.White, fontWeight = FontWeight.Bold, fontSize = 13.sp)
    }
}

@Composable
private fun SummaryCard(state: DiagnosticsUiState, onRun: () -> Unit) {
    val result = state.result
    SectionCard(title = "Self-test") {
        if (result != null) {
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
                Count(CheckStatus.PASS, result.passCount, "pass")
                Count(CheckStatus.WARN, result.warnCount, "warn")
                Count(CheckStatus.FAIL, result.failCount, "fail")
            }
            Text(result.summary, style = MaterialTheme.typography.bodyLarge)
            Muted("Ran ${UiFormat.relative(result.generatedAt)}.")
        } else if (!state.running) {
            Muted("Not run yet.")
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Button(onClick = onRun, enabled = !state.running) { Text("Run self-test") }
            if (state.running) {
                CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                Text("Checking…")
            }
        }
    }
}

@Composable
private fun Count(status: CheckStatus, n: Int, label: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        StatusIcon(status)
        Text("$n $label", style = MaterialTheme.typography.titleSmall)
    }
}

@Composable
private fun CheckRow(check: CheckResult, onAction: (CheckAction) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(vertical = 4.dp)) {
        StatusIcon(check.verdict)
        Column(verticalArrangement = Arrangement.spacedBy(2.dp), modifier = Modifier.weight(1f)) {
            Text(check.label, style = MaterialTheme.typography.titleSmall)
            Text(check.detail, style = MaterialTheme.typography.bodyMedium)
            check.remedy?.takeIf { check.verdict == CheckStatus.FAIL || check.verdict == CheckStatus.WARN }?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, fontStyle = FontStyle.Italic)
            }
            Text(check.id, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline, fontFamily = FontFamily.Monospace)
            val action = check.action
            if (action != null && (check.verdict == CheckStatus.FAIL || check.verdict == CheckStatus.WARN)) {
                OutlinedButton(onClick = { onAction(action) }) { Text(action.label) }
            }
        }
    }
}

@Composable
private fun InventoryCard(result: SelfTestResult) {
    val zone = ZoneId.systemDefault()
    SectionCard(title = "Data in Health Connect") {
        Muted("Last 30 days, as Health Connect shows it to ${Brand.name} (counts stop at 1000).")
        result.healthConnect.inventory.forEachIndexed { index, entry ->
            if (index > 0) HorizontalDivider()
            Column(verticalArrangement = Arrangement.spacedBy(2.dp), modifier = Modifier.padding(vertical = 4.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(entry.label, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                    PermissionLabel(entry.permission)
                }
                when {
                    entry.permission != InventoryEntry.GRANTED -> Unit
                    entry.error != null -> ErrorText("Could not count: ${entry.error}")
                    entry.recordCount30d == 0 -> Text(
                        "No records: the source app is probably not sharing this type.",
                        color = statusColor(CheckStatus.WARN),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    else -> {
                        Text("${entry.countText} records · latest ${Checks.formatTime(entry.latestRecordAt?.let(Instant::parse), zone)}")
                        Muted(entry.sources.joinToString(", ") { "${it.appLabel} (${it.recordCount})" })
                    }
                }
            }
        }
        Muted("Without the history permission Health Connect only exposes data from the 30 days before access was first granted.")
    }
}

@Composable
private fun PermissionLabel(permission: String) {
    val (text, status) = when (permission) {
        InventoryEntry.GRANTED -> "Granted" to CheckStatus.PASS
        InventoryEntry.DENIED -> "Denied" to CheckStatus.FAIL
        else -> "Unknown" to CheckStatus.SKIP
    }
    Text(text, color = statusColor(status), style = MaterialTheme.typography.labelLarge)
}

@Composable
private fun SourcesCard(result: SelfTestResult) {
    val zone = ZoneId.systemDefault()
    SectionCard(title = "Apps feeding Health Connect") {
        val sources = result.healthConnect.sources
        if (sources.isEmpty()) {
            Text(
                if (result.healthConnect.status == "available") {
                    "No app wrote readable data in the last 30 days."
                } else {
                    "Health Connect could not be read."
                },
            )
        }
        sources.forEach { s ->
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(s.appLabel, style = MaterialTheme.typography.titleSmall)
                Text(s.dataTypes.joinToString(", ") { HcDataType.fromKey(it)?.label ?: it })
                Muted("${s.recordCount} records · latest ${Checks.formatTime(s.latestRecordAt?.let(Instant::parse), zone)} · ${s.packageName}")
            }
        }
    }
}

@Composable
private fun RecentRunsCard(runs: List<LocalSyncRun>) {
    SectionCard(title = "Recent runs") {
        if (runs.isEmpty()) Muted("No sync has run on this phone yet.")
        runs.take(5).forEach { run ->
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    "${UiFormat.dateTime(run.finishedAt)} · ${run.trigger} · ${run.status}${if (!run.delivered) " (not recorded)" else ""}",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Muted("Read ${run.recordsRead}, sent ${run.rowsSent}" + run.response?.let { r -> ", server +${r.totalCreated} ~${r.totalUpdated} −${r.totalDeleted}" }.orEmpty())
                listOfNotNull(run.errorCode, run.errorMessage).joinToString(": ").takeIf { it.isNotEmpty() }?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                }
            }
        }
    }
}

@Composable
private fun LogCard(lines: List<String>, onRefresh: () -> Unit) {
    SectionCard(title = "Log") {
        Muted("Last ${lines.size} lines (newest at the bottom). Tokens are never written here.")
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = 320.dp)
                .background(MaterialTheme.colorScheme.surfaceVariant)
                .verticalScroll(rememberScrollState(Int.MAX_VALUE))
                .horizontalScroll(rememberScrollState())
                .padding(8.dp),
        ) {
            SelectionContainer {
                Text(
                    if (lines.isEmpty()) "(empty)" else lines.joinToString("\n"),
                    fontFamily = FontFamily.Monospace,
                    fontSize = 11.sp,
                    softWrap = false,
                )
            }
        }
        TextButton(onClick = onRefresh) { Text("Refresh log") }
    }
}

private fun shareReport(context: Context, text: String, generatedAt: Instant?) {
    val subject = "${Brand.name} Health sync diagnostics ${generatedAt?.let { Checks.formatTime(it, ZoneId.systemDefault()) }.orEmpty()}".trim()
    val send = Intent(Intent.ACTION_SEND)
        .setType("application/json")
        .putExtra(Intent.EXTRA_SUBJECT, subject)
        .putExtra(Intent.EXTRA_TEXT, text)
    try {
        context.startActivity(Intent.createChooser(send, "Share diagnostics report"))
    } catch (_: ActivityNotFoundException) {
        // Nothing can receive it; Copy remains.
    }
}

private fun copyToClipboard(context: Context, text: String) {
    val clipboard = context.getSystemService(ClipboardManager::class.java) ?: return
    val clip = ClipData.newPlainText("${Brand.name} diagnostics", text)
    // Health data: keep it out of the clipboard preview on Android 13+.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
    }
    clipboard.setPrimaryClip(clip)
}

/** Settings screens a check's action opens. */
internal object DiagnosticsIntents {
    fun openBatterySettings(context: Context) {
        val list = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
        if (!tryStart(context, list)) openAppDetails(context)
    }

    fun openNotificationSettings(context: Context) {
        val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
        if (!tryStart(context, intent)) openAppDetails(context)
    }

    private fun openAppDetails(context: Context) {
        tryStart(context, Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")))
    }

    private fun tryStart(context: Context, intent: Intent): Boolean = try {
        if (context !is android.app.Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        true
    } catch (_: ActivityNotFoundException) {
        false
    } catch (_: SecurityException) {
        false
    }
}
