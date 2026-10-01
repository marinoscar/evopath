package com.evopath.android.setup

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.evopath.android.EvoPathApplication
import com.evopath.android.TwaLauncherActivity
import com.evopath.android.ui.components.ServerUrlEditor
import com.evopath.android.ui.theme.EvoPathTheme

/** First-run screen: asks for the EvoPath server address, then opens the web app. */
class SetupActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val config = EvoPathApplication.from(this).serverConfig

        setContent {
            EvoPathTheme {
                Scaffold { padding ->
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(padding)
                            .verticalScroll(rememberScrollState())
                            .padding(24.dp),
                        verticalArrangement = Arrangement.spacedBy(16.dp),
                    ) {
                        Text("Welcome to EvoPath", style = MaterialTheme.typography.headlineMedium)
                        Text(
                            "Enter the address of your EvoPath server. It is the same address you open in the browser.",
                            style = MaterialTheme.typography.bodyLarge,
                        )
                        ServerUrlEditor(
                            initialValue = config.serverUrl.orEmpty(),
                            saveLabel = "Save and open",
                            onSave = { url ->
                                config.setServerUrl(url)
                                startActivity(
                                    Intent(this@SetupActivity, TwaLauncherActivity::class.java)
                                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
                                )
                                finish()
                            },
                        )
                    }
                }
            }
        }
    }
}
