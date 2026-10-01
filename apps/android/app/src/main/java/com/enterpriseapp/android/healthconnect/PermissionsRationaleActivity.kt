package com.enterpriseapp.android.healthconnect

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.enterpriseapp.android.MobileApplication
import com.enterpriseapp.android.ui.theme.AppTheme
import com.enterpriseapp.android.util.Brand

/**
 * Privacy explanation Health Connect shows from its permission screen
 * (`androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE`) and, through the
 * `ViewPermissionUsageActivity` alias, from Android 14+'s "permission usage" link
 * (`android.intent.action.VIEW_PERMISSION_USAGE` / `android.intent.category.HEALTH_PERMISSIONS`).
 */
class PermissionsRationaleActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val server = MobileApplication.from(this).serverConfig.serverUrl
        setContent { AppTheme { RationaleScreen(server = server, onClose = ::finish) } }
    }
}

/** What each data type is used for; shown on the rationale screen. */
internal val DATA_USE: List<Pair<String, String>> = listOf(
    "Steps" to "Daily step totals count towards your activity goals.",
    "Exercise and distance" to "Walks, runs and cardio sessions (with their distance) count towards your goals.",
    "Heart rate, resting heart rate and HRV" to "Shown with your vitals and used by your coach to gauge recovery.",
    "Weight and body fat" to "Added to your body measurements and trends.",
    "Blood pressure" to "Added to your vitals.",
    "Sleep" to "Shown as nightly sleep with stage minutes.",
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RationaleScreen(server: String?, onClose: () -> Unit) {
    Scaffold(topBar = { TopAppBar(title = { Text("How ${Brand.name} uses your health data") }) }) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(
                "${Brand.name} only reads from Health Connect. It never writes, changes or deletes your Health Connect data.",
                style = MaterialTheme.typography.bodyLarge,
            )
            Text(
                "What it reads is sent only to your own ${Brand.name} server" +
                    (server?.let { " ($it)" } ?: "") +
                    ", signed in as you. It is not shared with anyone else, sold or used for advertising.",
                style = MaterialTheme.typography.bodyLarge,
            )
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    DATA_USE.forEach { (title, use) ->
                        Column {
                            Text(title, style = MaterialTheme.typography.titleSmall)
                            Text(use, style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                }
            }
            Text(
                "Sync reads the last 7 days (30 on the first sync), about once an hour and when you open the app. " +
                    "Background access lets the hourly sync run while the app is closed.",
                style = MaterialTheme.typography.bodyMedium,
            )
            Text(
                "You can switch each type off in ${Brand.name} → Health sync, revoke access in Health Connect at any time, " +
                    "and unpair this phone to stop syncing. Data already imported stays on your server until you delete it there.",
                style = MaterialTheme.typography.bodyMedium,
            )
            Button(onClick = onClose, modifier = Modifier.fillMaxWidth()) { Text("Close") }
        }
    }
}
