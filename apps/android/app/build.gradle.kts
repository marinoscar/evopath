plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

fun stringProp(name: String, default: String): String =
    (project.findProperty(name) as String?)?.takeIf { it.isNotBlank() } ?: default

val appVersionName = stringProp("evopath.versionName", "0.1.0")
val appVersionCode = stringProp("evopath.versionCode", "1").toInt()
// Not blank-filtered: an empty value is meaningful (first-run setup screen).
val defaultServerUrl = (project.findProperty("evopath.serverUrl") as String?)?.trim().orEmpty()

// Release signing comes only from the environment (CI secrets, or a local shell).
// When any variable is missing the release build is produced unsigned instead of failing.
val signingStoreFile: String? = System.getenv("ANDROID_KEYSTORE_FILE")?.takeIf { it.isNotBlank() }
val signingStorePassword: String? = System.getenv("ANDROID_KEYSTORE_PASSWORD")?.takeIf { it.isNotEmpty() }
val signingKeyAlias: String? = System.getenv("ANDROID_KEY_ALIAS")?.takeIf { it.isNotBlank() }
val signingKeyPassword: String? = System.getenv("ANDROID_KEY_PASSWORD")?.takeIf { it.isNotEmpty() }
val hasReleaseSigning = signingStoreFile != null && file(signingStoreFile).exists() &&
    signingStorePassword != null && signingKeyAlias != null && signingKeyPassword != null

android {
    namespace = "com.evopath.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.evopath.android"
        minSdk = 26
        targetSdk = 36
        versionCode = appVersionCode
        versionName = appVersionName

        buildConfigField("String", "DEFAULT_SERVER_URL", "\"${defaultServerUrl.replace("\"", "")}\"")
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
                "evopath: ANDROID_KEYSTORE_FILE/ANDROID_KEYSTORE_PASSWORD/ANDROID_KEY_ALIAS/ANDROID_KEY_PASSWORD " +
                    "not all set; the release APK will be unsigned.",
            )
        }
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
