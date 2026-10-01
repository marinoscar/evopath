package com.enterpriseapp.android.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.enterpriseapp.android.config.ServerUrlResult
import com.enterpriseapp.android.config.ServerUrls
import com.enterpriseapp.android.net.ApiClient
import com.enterpriseapp.android.net.ApiResult
import kotlinx.coroutines.launch

private sealed interface CheckState {
    data object Idle : CheckState
    data object Checking : CheckState
    data class Ok(val url: String) : CheckState
    data class Failed(val message: String) : CheckState
}

/**
 * Server address field with "Test connection" (GET /api/health/live) and "Save".
 * Used by first-run setup and the Health sync hub. [onSave] receives the canonical URL.
 */
@Composable
fun ServerUrlEditor(
    initialValue: String,
    saveLabel: String,
    onSave: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var input by remember { mutableStateOf(initialValue) }
    var check by remember { mutableStateOf<CheckState>(CheckState.Idle) }
    val scope = rememberCoroutineScope()

    val validation = ServerUrls.normalize(input)
    val validationError = (validation as? ServerUrlResult.Invalid)?.reason?.takeIf { input.isNotBlank() }

    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        OutlinedTextField(
            value = input,
            onValueChange = {
                input = it
                check = CheckState.Idle
            },
            label = { Text("Server address") },
            placeholder = { Text("https://app.example.com") },
            singleLine = true,
            isError = validationError != null,
            supportingText = { validationError?.let { Text(it) } },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done),
            modifier = Modifier.fillMaxWidth(),
        )

        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedButton(
                enabled = validation is ServerUrlResult.Valid && check != CheckState.Checking,
                onClick = {
                    val url = (validation as ServerUrlResult.Valid).url
                    check = CheckState.Checking
                    scope.launch {
                        check = when (val result = ApiClient(baseUrlProvider = { url }).checkLive()) {
                            is ApiResult.Success -> CheckState.Ok(url)
                            is ApiResult.Failure -> CheckState.Failed(result.error.message)
                        }
                    }
                },
            ) { Text("Test connection") }

            Button(
                enabled = validation is ServerUrlResult.Valid && check != CheckState.Checking,
                onClick = { onSave((validation as ServerUrlResult.Valid).url) },
            ) { Text(saveLabel) }
        }

        when (val c = check) {
            CheckState.Idle -> Unit
            CheckState.Checking -> CircularProgressIndicator()
            is CheckState.Ok -> Text("Connected to ${c.url}.", color = MaterialTheme.colorScheme.primary)
            is CheckState.Failed -> Text(c.message, color = MaterialTheme.colorScheme.error)
        }
    }
}
