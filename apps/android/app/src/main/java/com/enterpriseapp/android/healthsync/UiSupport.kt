package com.enterpriseapp.android.healthsync

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

@Composable
internal fun SectionCard(title: String, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Card(modifier = modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            content()
        }
    }
}

/**
 * The Material "arrow back" glyph (auto-mirrored for right-to-left layouts), drawn here so the
 * app needs no icon library for one icon. Tinted by `Icon` (the app bar's navigation colour).
 */
internal val BackArrow: ImageVector by lazy {
    ImageVector.Builder(
        name = "BackArrow",
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
        autoMirror = true,
    ).apply {
        path(fill = SolidColor(Color.Black)) {
            moveTo(20f, 11f)
            horizontalLineTo(7.83f)
            lineToRelative(5.59f, -5.59f)
            lineTo(12f, 4f)
            lineToRelative(-8f, 8f)
            lineToRelative(8f, 8f)
            lineToRelative(1.41f, -1.41f)
            lineTo(7.83f, 13f)
            horizontalLineTo(20f)
            verticalLineToRelative(-2f)
            close()
        }
    }.build()
}

@Composable
internal fun Muted(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
internal fun ErrorText(text: String) {
    Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
}

internal object UiFormat {
    private val dateTime = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT)
    private val date = DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM)

    fun dateTime(instant: Instant?): String =
        instant?.let { dateTime.format(it.atZone(ZoneId.systemDefault())) } ?: "never"

    fun date(instant: Instant?): String = instant?.let { date.format(it.atZone(ZoneId.systemDefault())) } ?: "unknown"

    fun dateTime(iso: String?): String = dateTime(iso?.let { runCatching { Instant.parse(it) }.getOrNull() })

    /** "just now", "12 min ago", "3 h ago", else the date and time. */
    fun relative(instant: Instant?, now: Instant = Instant.now()): String {
        instant ?: return "never"
        val age = Duration.between(instant, now)
        return when {
            age.isNegative -> dateTime(instant)
            age.toMinutes() < 1 -> "just now"
            age.toMinutes() < 60 -> "${age.toMinutes()} min ago"
            age.toHours() < 24 -> "${age.toHours()} h ago"
            else -> dateTime(instant)
        }
    }

    fun minutes(seconds: Long): String = if (seconds >= 60) "${seconds / 60} min" else "$seconds s"
}

/** Opens [url] in a Chrome Custom Tab (the user's browser session), falling back to any browser. */
internal fun openInCustomTab(context: Context, url: String) {
    val uri = Uri.parse(url)
    try {
        CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(context, uri)
    } catch (_: ActivityNotFoundException) {
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (_: ActivityNotFoundException) {
            // No browser at all; the code and URL stay on screen.
        }
    }
}
