# EvoPath Android

A small Android app for EvoPath:

- **Trusted Web Activity (TWA)**: the launcher icon opens the EvoPath PWA full screen
  (`<server>/?source=twa`) in the user's browser engine.
- **Health sync** (native, Jetpack Compose): pairs with the server and imports Health Connect
  data. Reached from the app shortcut "Health sync" or the deep link
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

Release builds run R8 (minify + resource shrinking); keep rules are in `app/proguard-rules.pro`
(kotlinx.serialization DTOs, the WorkManager worker; Health Connect and WorkManager ship their
own consumer rules).

For the TWA to open without a browser address bar, the server must publish this app's
signing certificate SHA-256 in `/.well-known/assetlinks.json` (Admin → Settings → Android app).

## Health sync

**Pairing** (Health sync → Connect): the app starts the device flow
(`POST /api/auth/device/code`, `tokenType: "pat"`), shows the user code and opens the activation
page in a Chrome Custom Tab, where the user is already signed in to the PWA. It polls
`POST /api/auth/device/token` (RFC 8628: `slow_down` adds 5 s, `expired_token`/`access_denied`
stop), stores the PAT and its expiry in encrypted prefs, then registers the phone with
`POST /api/health-sync/devices` (installation id, model, Android/app/Health Connect versions,
package, signing SHA-256, time zone). Unpair calls `DELETE /api/health-sync/devices/:id`, which
revokes the token.

**Health Connect permissions** (read only): steps, exercise, distance, heart rate, resting heart
rate, HRV, weight, body fat, blood pressure, sleep, plus background reading when Health Connect
offers it. Each type has an on/off switch on the Sync screen (all on by default).
`PermissionsRationaleActivity` explains the use (also reached from Android 14+'s permission-usage
link through the `ViewPermissionUsageActivity` alias).

**Sync** (`sync/`): a `HealthSyncWorker` runs hourly (unique periodic work
`health-sync-periodic`, network required, exponential backoff) and as expedited one-shot work
(`health-sync-now`) for Sync now and when the app opens (at most every 15 minutes). Each run reads
the last 30 days (until a sync has succeeded once) or 7 days, in the phone's time zone:

| Type | Sent as |
|---|---|
| Steps | daily total → entry `steps`, id `steps:YYYY-MM-DD` |
| Exercise | walking/hiking → `walk`, running → `run`, other cardio → `cardio_any` (others skipped), with distance |
| Heart rate | daily average → `heart_rate_avg` at local noon, id `hr_avg:YYYY-MM-DD` |
| Resting HR, HRV, weight, body fat | `resting_hr`, `hrv_rmssd`, `weight` (kg), `body_fat_pct`, id = record id |
| Blood pressure | `bp_systolic` + `bp_diastolic`, ids `<id>:sys` / `<id>:dia`, `entryKey` = record id |
| Sleep | session with awake/light/deep/rem/unknown minutes, dated by wake-up |

`run.details.syncedTypes` lists only the types read in full, so the server reconciles (deletes
rows that disappeared) for those types only; a type that is off, not permitted or failed is
left alone and the run is `partial`. On 401 the app stops syncing and posts a
"Re-pair EvoPath Health sync" notification; on 409 `DEVICE_REVOKED` it forgets the pairing.
The last 20 runs are kept on the phone (Sync screen).

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
  pairing/                   device flow (DeviceFlowPoller), registration, PairingManager
  healthconnect/             HealthConnectGateway (availability, permissions, per-type readers
                             with source packages, inventory), data types/toggles, rationale
  sync/                      HealthMapping, SyncPayloadBuilder, HealthSyncEngine, stores,
                             HealthSyncWorker + WorkManagerSyncScheduler, notifications
  healthsync/                Health sync hub, Connect and Sync screens (Compose)
  ui/                        theme and shared Compose components
```
