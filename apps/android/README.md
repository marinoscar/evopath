# EvoPath Android

A small Android app for EvoPath:

- **Trusted Web Activity (TWA)**: the launcher icon opens the EvoPath PWA full screen
  (`<server>/?source=twa`) in the user's browser engine.
- **Health sync** (native, Jetpack Compose): pairs with the server and imports Health Connect
  activity. Reached from the app shortcut "Health sync" or the deep link
  `evopath-android://health-sync`.

Package `com.evopath.android`, minSdk 26, target/compile SDK 36. Sideloaded; CI publishes the signed
APK to the rolling GitHub prerelease `android-latest` (`.github/workflows/android.yml`).

## Build locally

Requirements: JDK 21 and the Android SDK (platform 36). Point Gradle at the SDK with
`ANDROID_HOME` (or `sdk.dir` in `local.properties`, which is git-ignored).

```bash
cd apps/android
export ANDROID_HOME=/path/to/android-sdk
./gradlew --no-daemon testDebugUnitTest assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk
```

Install on a connected phone: `adb install -r app/build/outputs/apk/debug/app-debug.apk`.

### Gradle properties

| Property | Default | Meaning |
|---|---|---|
| `evopath.versionName` | `0.1.0` | `versionName` |
| `evopath.versionCode` | `1` | `versionCode` |
| `evopath.serverUrl` | empty | Server baked into `BuildConfig.DEFAULT_SERVER_URL`. Empty shows a first-run setup screen. |

Example: `./gradlew assembleDebug -Pevopath.serverUrl=https://evopath.example.com`.

### Signed release

Release signing reads only environment variables; without all four the release APK is built
unsigned (`app-release-unsigned.apk`) and debug builds are unaffected.

```bash
export ANDROID_KEYSTORE_FILE=/secure/path/evopath-release.jks
export ANDROID_KEYSTORE_PASSWORD=…  ANDROID_KEY_ALIAS=evopath  ANDROID_KEY_PASSWORD=…
./gradlew --no-daemon assembleRelease -Pevopath.versionName=0.1.5 -Pevopath.versionCode=5
$ANDROID_HOME/build-tools/36.0.0/apksigner verify --print-certs app/build/outputs/apk/release/app-release.apk
```

Never commit a keystore or its passwords (`*.jks`, `*.keystore` are git-ignored). In CI the
keystore comes from the secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`.

Release builds run R8 (minify + resource shrinking); keep rules are in `app/proguard-rules.pro`.

For the TWA to open without a browser address bar, the server must publish this app's
signing certificate SHA-256 in `/.well-known/assetlinks.json` (Admin → Settings → Android app).

## Layout

```
app/src/main/java/com/evopath/android/
  TwaLauncherActivity.kt     launcher: TWA, or setup when no server is configured
  EvoPathApplication.kt      process-wide ServerConfig, TokenStore, ApiClient
  config/                    ServerConfig (prefs) + ServerUrls (pure validation)
  auth/TokenStore.kt         pairing token, expiry, device id, installation id (encrypted prefs)
  net/                       ApiClient (OkHttp + kotlinx.serialization), ApiResult/ApiError
  util/AppInfo.kt            version, package, signing certificate SHA-256
  setup/SetupActivity.kt     first-run server address screen
  healthsync/                Health sync hub (Compose)
  ui/                        theme and shared Compose components
```
