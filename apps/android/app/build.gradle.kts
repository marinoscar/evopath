import java.net.URI
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// -----------------------------------------------------------------------------
// Product identity: packages/shared/identity.json is the single source of truth
// (see docs/RENAMING.md). Nothing in apps/android spells the product name: the
// label, applicationId, deep-link scheme and brand colours are all derived here.
// -----------------------------------------------------------------------------
val identityFile: File = rootProject.file("../../packages/shared/identity.json")
check(identityFile.isFile) { "Product identity not found at ${identityFile.path} (packages/shared/identity.json)." }

@Suppress("UNCHECKED_CAST")
val identity = groovy.json.JsonSlurper().parse(identityFile) as Map<String, Any?>

fun identityValue(key: String): String =
    (identity[key] as? String)?.trim()?.takeIf { it.isNotEmpty() }
        ?: throw GradleException("packages/shared/identity.json: \"$key\" is missing or empty.")

val productName = identityValue("productName")
val repoName = identityValue("repoSlug").substringAfter('/')

/** The repo name as a Java package segment / property prefix: lowercase letters and digits only. */
val identityToken = repoName.lowercase().replace(Regex("[^a-z0-9]"), "").ifEmpty { "app" }
    .let { if (it.first().isDigit()) "app$it" else it }

/** `#rrggbb` (identity.json) → `#FFRRGGBB` (Android colour resource). */
fun argb(hex: String): String {
    require(Regex("^#[0-9a-fA-F]{6}$").matches(hex)) { "identity.json colour \"$hex\" is not #rrggbb." }
    return "#FF" + hex.substring(1).uppercase()
}

fun stringProp(name: String): String? = (project.findProperty(name) as String?)?.takeIf { it.isNotBlank() }

/**
 * A build property under the neutral `app.` prefix, or under the repository's own prefix
 * (`<repo name>.versionName`), which is what older build scripts and the CLI pass.
 */
fun appProp(key: String): String? = stringProp("app.$key") ?: stringProp("$identityToken.$key")

val appApplicationId = stringProp("app.applicationId") ?: "com.$identityToken.android"
val appProductName = stringProp("app.productName") ?: productName
val deepLinkScheme = stringProp("app.deepLinkScheme")
    ?: (repoName.lowercase().replace(Regex("[^a-z0-9+.-]"), "").trimStart('+', '.', '-').ifEmpty { "app" } + "-android")
val themeColor = argb(identityValue("themeColor"))
val backgroundColor = argb(identityValue("backgroundColor"))

/** Kotlin package of the sources; identity-neutral on purpose (never renamed by a fork). */
val codeNamespace = "com.enterpriseapp.android"

// Version: apps/android/version.properties (committed; the CLI bumps it), overridable per build
// with -Papp.versionName / -Papp.versionCode (or the repository-prefixed form).
val versionProps = Properties().apply {
    val file = rootProject.file("version.properties")
    if (file.isFile) file.inputStream().use { load(it) }
}
fun versionProp(key: String): String? = versionProps.getProperty(key)?.trim()?.ifEmpty { null }
val appVersionName: String = appProp("versionName") ?: versionProp("versionName") ?: "0.1.0"
val appVersionCode: Int = (appProp("versionCode") ?: versionProp("versionCode") ?: "1").toIntOrNull()
    ?.takeIf { code -> code in 1..2_100_000_000 }
    ?: throw GradleException("versionCode must be a whole number from 1 to 2100000000 (version.properties or -Papp.versionCode).")
// Not blank-filtered: an empty value is meaningful (first-run setup screen).
val defaultServerUrl = ((project.findProperty("app.serverUrl") ?: project.findProperty("$identityToken.serverUrl")) as String?)
    ?.trim().orEmpty()

/**
 * The host the TWA launcher's https intent-filter claims (manifest placeholder `twaHost`).
 * Chrome delegates a site's Web Push notifications to this app only when the app has a
 * VIEW + BROWSABLE activity for that site's URLs, so the filter must name the server's host,
 * which is known only from `app.serverUrl` at build time. Without one the filter names a host
 * that never matches and notifications stay Chrome's own.
 */
val unsetTwaHost = "invalid.example"
val twaHost: String = defaultServerUrl.takeIf { it.isNotEmpty() }
    ?.let { url -> runCatching { URI(if ("://" in url) url else "https://$url").host }.getOrNull() }
    ?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }
    ?: unsetTwaHost
if (twaHost == unsetTwaHost) {
    logger.warn(
        "${project.path}: no usable app.serverUrl; the launcher's https intent-filter names $unsetTwaHost, " +
            "so the browser will not delegate the web app's notifications to this build. " +
            "Pass -Papp.serverUrl=https://<server> to enable notification delegation.",
    )
}

fun quoted(value: String): String = "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

// Release signing comes only from the environment (CI secrets, or a local shell).
// When any variable is missing the release build is produced unsigned instead of failing.
val signingStoreFile: String? = System.getenv("ANDROID_KEYSTORE_FILE")?.takeIf { it.isNotBlank() }
val signingStorePassword: String? = System.getenv("ANDROID_KEYSTORE_PASSWORD")?.takeIf { it.isNotEmpty() }
val signingKeyAlias: String? = System.getenv("ANDROID_KEY_ALIAS")?.takeIf { it.isNotBlank() }
val signingKeyPassword: String? = System.getenv("ANDROID_KEY_PASSWORD")?.takeIf { it.isNotEmpty() }
val hasReleaseSigning = signingStoreFile != null && file(signingStoreFile).exists() &&
    signingStorePassword != null && signingKeyAlias != null && signingKeyPassword != null

android {
    namespace = codeNamespace
    compileSdk = 36

    defaultConfig {
        applicationId = appApplicationId
        minSdk = 26
        targetSdk = 36
        versionCode = appVersionCode
        versionName = appVersionName

        buildConfigField("String", "DEFAULT_SERVER_URL", quoted(defaultServerUrl))
        buildConfigField("String", "PRODUCT_NAME", quoted(appProductName))
        buildConfigField("String", "DEEP_LINK_SCHEME", quoted(deepLinkScheme))
        // The host the launcher's https intent-filter claims (empty-server builds: "invalid.example").
        buildConfigField("String", "TWA_HOST", quoted(twaHost))
        // Prefix of SharedPreferences files and other on-device names. Equal to the applicationId's
        // middle segment, so it never changes for an installed app (renaming it would lose pairing).
        buildConfigField("String", "STORAGE_PREFIX", quoted(identityToken))
        buildConfigField("int", "THEME_COLOR", "0x" + themeColor.substring(1))
        buildConfigField("int", "BACKGROUND_COLOR", "0x" + backgroundColor.substring(1))

        resValue("string", "app_name", appProductName)
        resValue("color", "brand_primary", themeColor)
        resValue("color", "brand_background", backgroundColor)
        resValue("color", "ic_launcher_background", themeColor)
        manifestPlaceholders["deepLinkScheme"] = deepLinkScheme
        manifestPlaceholders["twaHost"] = twaHost
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                // Outer vals have distinct names: inside this block `keyAlias` would mean this.keyAlias.
                storeFile = file(signingStoreFile!!)
                storePassword = signingStorePassword
                keyAlias = signingKeyAlias
                keyPassword = signingKeyPassword
            }
        }
    }

    buildTypes {
        release {
            // R8 is on: kotlinx.serialization and androidbrowserhelper rules live in proguard-rules.pro.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }

    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "META-INF/versions/9/OSGI-INF/MANIFEST.MF")
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

if (!hasReleaseSigning) {
    gradle.taskGraph.whenReady {
        if (allTasks.any { it.name.contains("Release") && it.name.startsWith("assemble") }) {
            logger.warn(
                "${project.path}: ANDROID_KEYSTORE_FILE/ANDROID_KEYSTORE_PASSWORD/ANDROID_KEY_ALIAS/ANDROID_KEY_PASSWORD " +
                    "not all set; the release APK will be unsigned.",
            )
        }
    }
}

/**
 * res/xml/shortcuts.xml, generated: a static shortcut must name its target package and class
 * literally, and both derive from the product identity (applicationId) and [codeNamespace].
 */
abstract class GenerateShortcutsTask : DefaultTask() {
    @get:Input abstract val targetPackage: Property<String>
    @get:Input abstract val targetClass: Property<String>
    @get:Input abstract val deepLink: Property<String>

    @get:OutputDirectory abstract val outputDir: DirectoryProperty

    @TaskAction
    fun write() {
        val file = outputDir.file("xml/shortcuts.xml").get().asFile
        file.parentFile.mkdirs()
        file.writeText(
            """
            |<?xml version="1.0" encoding="utf-8"?>
            |<!-- Generated by app/build.gradle.kts (GenerateShortcutsTask); do not edit. -->
            |<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
            |    <shortcut
            |        android:shortcutId="health_sync"
            |        android:enabled="true"
            |        android:icon="@mipmap/ic_launcher"
            |        android:shortcutShortLabel="@string/shortcut_health_sync_short"
            |        android:shortcutLongLabel="@string/shortcut_health_sync_long"
            |        android:shortcutDisabledMessage="@string/shortcut_health_sync_disabled">
            |        <intent
            |            android:action="android.intent.action.VIEW"
            |            android:data="${deepLink.get()}"
            |            android:targetPackage="${targetPackage.get()}"
            |            android:targetClass="${targetClass.get()}" />
            |    </shortcut>
            |</shortcuts>
            |""".trimMargin(),
        )
    }
}

androidComponents {
    onVariants { variant ->
        val task = tasks.register<GenerateShortcutsTask>(
            "generate${variant.name.replaceFirstChar { it.uppercase() }}Shortcuts",
        ) {
            targetPackage.set(variant.applicationId)
            targetClass.set("$codeNamespace.healthsync.HealthSyncActivity")
            deepLink.set("$deepLinkScheme://health-sync")
            outputDir.set(layout.buildDirectory.dir("generated/identity/${variant.name}/res"))
        }
        variant.sources.res?.addGeneratedSourceDirectory(task, GenerateShortcutsTask::outputDir)
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    debugImplementation(libs.androidx.compose.ui.tooling)

    implementation(libs.androidbrowserhelper)
    implementation(libs.androidx.health.connect)
    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.androidx.security.crypto)

    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)

    testImplementation(libs.junit)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.kotlinx.coroutines.test)
}
