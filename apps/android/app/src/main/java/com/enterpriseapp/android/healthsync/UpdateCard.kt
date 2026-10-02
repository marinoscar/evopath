package com.enterpriseapp.android.healthsync

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Button
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.enterpriseapp.android.update.AppUpdates
import com.enterpriseapp.android.update.AvailableUpdate
import com.enterpriseapp.android.update.UpdatePolicy
import kotlinx.coroutines.launch

/**
 * "Update available: vX" on the hub: Download opens the signed link in the browser. [highlighted]
 * outlines the card when the "new version" notification opened the hub.
 */
@Composable
internal fun UpdateCard(update: AvailableUpdate, installedVersion: String, highlighted: Boolean = false) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var error by remember(update.releaseId) { mutableStateOf<String?>(null) }
    var showNotes by rememberSaveable { mutableStateOf(false) }

    val outline = if (highlighted) {
        Modifier.border(2.dp, MaterialTheme.colorScheme.primary, CardDefaults.shape)
    } else {
        Modifier
    }
    SectionCard(title = "Update available: v${update.versionName}", modifier = outline) {
        Text(
            listOfNotNull(
                "Installed $installedVersion → ${update.versionName} (${update.versionCode})",
                UpdatePolicy.formatSize(update.sizeBytes),
            ).joinToString(", ") + ".",
        )
        Muted("Your browser downloads the APK; open it to install (allow installs from this source if asked).")
        Button(
            onClick = {
                busy = true
                error = null
                scope.launch {
                    error = AppUpdates.download(context, update)
                    busy = false
                }
            },
            enabled = !busy,
            modifier = Modifier.fillMaxWidth(),
        ) { Text(if (busy) "Getting the download…" else "Download") }
        error?.let { ErrorText(it) }
        val notes = update.notes?.trim().orEmpty()
        if (notes.isNotEmpty()) {
            TextButton(onClick = { showNotes = !showNotes }) { Text(if (showNotes) "Hide what's new" else "What's new") }
            if (showNotes) Text(notes, style = MaterialTheme.typography.bodyMedium)
        }
    }
}
