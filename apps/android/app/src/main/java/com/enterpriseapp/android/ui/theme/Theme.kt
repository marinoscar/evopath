package com.enterpriseapp.android.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import com.enterpriseapp.android.BuildConfig

/**
 * Brand colours: `themeColor` and `backgroundColor` from packages/shared/identity.json (the PWA
 * manifest's colours), generated into [BuildConfig]. The other tones are mixed from them, so a
 * rebrand needs no change here.
 */
object BrandColors {
    val Primary = Color(BuildConfig.THEME_COLOR)
    val Background = Color(BuildConfig.BACKGROUND_COLOR)
    val PrimaryLight = lerp(Primary, Color.White, 0.4f)
    val PrimaryContainer = lerp(Primary, Color.White, 0.7f)
    val OnPrimaryContainer = lerp(Primary, Color.Black, 0.8f)
    val OnPrimaryDark = lerp(Primary, Color.Black, 0.65f)
    val Secondary = lerp(Primary, Color.Gray, 0.7f)
    val SecondaryDark = lerp(PrimaryLight, Color.LightGray, 0.6f)
}

private val LightColors = lightColorScheme(
    primary = BrandColors.Primary,
    onPrimary = Color.White,
    primaryContainer = BrandColors.PrimaryContainer,
    onPrimaryContainer = BrandColors.OnPrimaryContainer,
    secondary = BrandColors.Secondary,
    background = BrandColors.Background,
    surface = BrandColors.Background,
)

private val DarkColors = darkColorScheme(
    primary = BrandColors.PrimaryLight,
    onPrimary = BrandColors.OnPrimaryDark,
    primaryContainer = BrandColors.Primary,
    onPrimaryContainer = BrandColors.PrimaryContainer,
    secondary = BrandColors.SecondaryDark,
)

@Composable
fun AppTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (darkTheme) DarkColors else LightColors, content = content)
}
