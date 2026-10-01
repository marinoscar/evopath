package com.evopath.android.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/** Brand colours from the PWA manifest (theme #0f766e, background #f2f7f6). */
object EvoPathColors {
    val Primary = Color(0xFF0F766E)
    val PrimaryLight = Color(0xFF5EC4B6)
    val Background = Color(0xFFF2F7F6)
}

private val LightColors = lightColorScheme(
    primary = EvoPathColors.Primary,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFB2EBE3),
    onPrimaryContainer = Color(0xFF00201C),
    secondary = Color(0xFF4A635F),
    background = EvoPathColors.Background,
    surface = EvoPathColors.Background,
)

private val DarkColors = darkColorScheme(
    primary = EvoPathColors.PrimaryLight,
    onPrimary = Color(0xFF003731),
    primaryContainer = EvoPathColors.Primary,
    onPrimaryContainer = Color(0xFFB2EBE3),
    secondary = Color(0xFFB1CCC6),
)

@Composable
fun EvoPathTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (darkTheme) DarkColors else LightColors, content = content)
}
