# Android app

Why it is built this way (a PWA in a TWA plus a small native module, coordinated through the server): [native companion architecture](../../docs/specs/native-companion-architecture.md).

A small Android app for the product (its name, package and colours come from
`packages/shared/identity.json`; see [Product identity](#product-identity)):

- **Trusted Web Activity (TWA)**: the launcher icon opens the PWA full screen
  (`<server>/?source=twa`) in the user's browser engine.
- **Health sync** (native, Jetpack Compose): pairs with the server and imports Health Connect
  data. Reached from the app shortcut "Health sync" or the deep link
  `<repo>-android://health-sync`.

Package `com.<repo>.android`, minSdk 26, target/compile SDK 36. Sideloaded; CI publishes the signed
APK to the rolling GitHub prerelease `android-latest` (`.github/workflows/android.yml`, with the
versionName in the release notes; `scripts/build-meta.sh` reads the name and version for it).

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

### Version

`version.properties` (committed) holds `versionName` and `versionCode`; Gradle reads it, and
`-Papp.versionName` / `-Papp.versionCode` override it for one build. CI builds it as committed
(no per-run numbering), so bump it (the CLI's `android version --bump patch`, or by hand) before a
release: `versionCode` must strictly increase for every published APK, because Android refuses to
install a lower code over a higher one.

### Product identity

Nothing under `apps/android` spells the product name. `app/build.gradle.kts` reads
`packages/shared/identity.json` (the template's single identity source, see `docs/RENAMING.md`)
and derives, with `<repo>` = the part of `repoSlug` after `/`:

| Value | Derived as | Where it lands |
|---|---|---|
| App label | `productName` | `@string/app_name` (resValue), `BuildConfig.PRODUCT_NAME` |
| applicationId | `com.<repo, lowercase, letters and digits only>.android` | the installed package |
| Deep-link scheme | `<repo, lowercase>-android` | manifest placeholder `${deepLinkScheme}`, `BuildConfig.DEEP_LINK_SCHEME`, the generated `res/xml/shortcuts.xml` |
| Brand colours | `themeColor`, `backgroundColor` | `@color/brand_primary`, `@color/brand_background`, `@color/ic_launcher_background`, `BuildConfig.THEME_COLOR`/`BACKGROUND_COLOR` (Compose theme) |
| Storage prefix | same token as the applicationId | `BuildConfig.STORAGE_PREFIX`: SharedPreferences file names |

User-facing text reads the name through `util/Brand.kt` (notifications, rationale, user agent
`<ProductName without spaces>-Android/<version>`, log tags). The Kotlin namespace
`com.enterpriseapp.android` is identity-neutral and is never renamed; only the applicationId
follows the product. A fork that renames with `scripts/rename.mjs` therefore gets a new package
(a separate app on the phone) with no Android source change. Keep the derived values stable for
a published app: changing `repoSlug` changes the applicationId, so phones would install it as a
new app and lose their pairing.

The launcher entry is an `activity-alias` named `${applicationId}.TwaLauncherActivity`, so the
launcher component (and home-screen icons) stay the same whatever the Kotlin package is.

### Gradle properties

Each property can be given with the neutral `app.` prefix or with the repository's own prefix
(`<repo>.versionName`, the form older scripts pass); `app.` wins.

| Property | Default | Meaning |
|---|---|---|
| `app.versionName` | `version.properties` | `versionName` |
| `app.versionCode` | `version.properties` | `versionCode` |
| `app.serverUrl` | empty | Server baked into `BuildConfig.DEFAULT_SERVER_URL`. Empty shows a first-run setup screen. |
| `app.applicationId`, `app.productName`, `app.deepLinkScheme` | from `identity.json` | Override one derived identity value (rarely needed). |

Example: `./gradlew assembleDebug -Papp.serverUrl=https://app.example.com`.

### Signed release

Release signing reads only environment variables; without all four the release APK is built
unsigned (`app-release-unsigned.apk`) and debug builds are unaffected.

```bash
export ANDROID_KEYSTORE_FILE=/secure/path/release.jks
export ANDROID_KEYSTORE_PASSWORD=…  ANDROID_KEY_ALIAS=release  ANDROID_KEY_PASSWORD=…
./gradlew --no-daemon assembleRelease
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
"Re-pair <product> Health sync" notification; on 409 `DEVICE_REVOKED` it forgets the pairing.
The last 20 runs are kept on the phone (Sync screen).

**Background access.** A periodic (hourly) run that lacks `READ_HEALTH_DATA_IN_BACKGROUND`, or
runs on a Health Connect without the background feature, reads nothing: it reports a `skipped` run
with `errorCode` `BACKGROUND_PERMISSION_MISSING` and posts at most one notification per 24 h
("Allow background access so <product> can sync while closed") that opens the permission prompt.
Sync now, app-open and initial syncs read normally.

## Updates

The server hosts the APK releases (Admin → Settings → Android app, or the CLI's
`android publish`). The app opens the PWA at
`<server>/?source=twa&appVersion=<versionName>&appVersionCode=<versionCode>` and registers its
`appVersionCode`, so the web app and Connected devices can tell which build a phone runs.

On app open (launcher or Health sync), at most every 12 hours and only while paired (the endpoint
needs the token), `update/UpdateChecker` asks `GET /api/android-app/releases/latest`. A release
for this package with a higher `versionCode` is remembered and the Health sync hub shows
**Update available: vX** with its size and What's new; **Download** posts
`/api/android-app/releases/:id/download-link` and opens the returned same-origin URL in the
browser (`ACTION_VIEW`), which downloads the APK and hands it to the system installer. A 404
`NO_RELEASE` clears the offer; a network failure retries on the next open. The first launch of
a new `versionCode` clears the offer and the 12 h throttle.

## Diagnostics

Health sync → **Diagnostics** runs a self-test on open (`diagnostics/SelfTest`). Each check is
independent, has its own timeout and never throws; it yields
`{ id, label, status: pass|warn|fail|skip, detail, remedy?, data? }` and, on the phone, an action
button (grant permissions, battery or notification settings, Play Store, Re-pair, the web's
Connected devices page…). Verdicts are pure functions in `diagnostics/Checks.kt`.

| Id | Label | Verifies |
|---|---|---|
| `app.version` | App version | version, package, signing SHA-256 |
| `app.update` | App update | the server's current release (`GET /api/android-app/releases/latest`): pass up to date, warn when a higher versionCode is offered, skip when not paired, no release, another package, or the call failed |
| `server.configured` | Server address | a server URL is set |
| `server.reachable` | Server reachable | `GET /api/health/live`, latency (warn over 3 s) |
| `pairing.token` | Pairing token | token and device id present; warn under 14 days, fail when expired |
| `auth.valid` | Token accepted | `GET /api/health-sync/devices/:id`: 401 → re-pair, 404/409 → revoked, connect again |
| `api.connection` | API connection | the two above folded, with both latencies |
| `hc.availability` | Health Connect installed | SDK status, provider version |
| `hc.connection` | Health Connect connection | live `getGrantedPermissions` within 10 s (exception class and message on failure) |
| `hc.permissions` | Health Connect permissions | every permission of the enabled types; lists the missing ones |
| `hc.background` | Background access | feature available and granted (else the hourly sync cannot read while closed) |
| `hc.sources` | Apps feeding Health Connect | union of source apps over every readable type, last 30 days; warn when none (the remedy names the installed known source apps) |
| `hc.data.<type>` | `<Type> in Health Connect` | per synced type: fail when denied, warn when granted but no record in 30 days, pass with count (`1000+` when capped), latest record and sources; `data.remedyApps` (see below) |
| `battery.optimization` | Battery optimization | `isIgnoringBatteryOptimizations` |
| `notifications.permission` | Notifications | POST_NOTIFICATIONS (Android 13+) and notifications enabled |
| `work.scheduled` | Hourly sync scheduled | the unique periodic work's state and next run |
| `sync.last` | Last sync | last local run: warn when older than 3 h, failed, partial or skipped |
| `sync.delivery` | Data delivery | last run: per type read vs sent (drops), per table sent vs accepted (`created + updated + unchanged`); flags `skipped` |
| `timezone.match` | Time zone | phone zone vs the Health Profile zone (`userTimezone`) |
| `twa.verification` | Full-screen web app (Digital Asset Links) | `<server>/.well-known/assetlinks.json` lists this package and signing SHA-256 |

**Source-aware remedies.** Health Connect offers no API to ask which apps may write a type, so
`diagnostics/RemedyApps.select` (pure) derives the candidates for each type: apps that wrote it
(the inventory's data origins), then installed apps whose entry in the capability table
`healthconnect/KnownSourceApps.kt` includes it (installed = visible to the PackageManager through
the manifest `<queries>`), then capable apps already feeding Health Connect other types. The
no-records remedy names up to three ("Open Oura and allow Heart rate variability to be shared to
Health Connect: Health Connect → App permissions → Oura → Allowed to write → Heart rate
variability. Then Sync now."); with none it says no app on the phone writes the type and its
action opens the Sync screen to switch it off. Every `hc.data.<type>` check reports them as
`data.remedyApps: [{ packageName, appLabel, reason: wrote_data | installed_capable }]`. The table
is best-effort; extend it with a row and a matching `<queries>` entry.

**Report** (`DiagnosticReport`, uploaded with `POST /api/health-sync/devices/:id/diagnostics`,
or shared/copied as JSON): `{ generatedAt, summary, app { versionName, versionCode, packageName, signingSha256,
latestVersionCode?, latestVersionName?, updateAvailable? }, device, server, pairing, healthConnect
{ status, version, grantedPermissions, backgroundAvailable, inventory[], sources[] }, work,
checks[], recentRuns[≤20], log[≤300] }`. `summary` is `"N fail, M warn: <first failing label>"`.
The serialized report is scrubbed of the token (and anything shaped like `pat_…` or
`Bearer …`) and trimmed below 200 KB.

**Automatic upload.** After a failed or partial run the worker uploads a report, at most once per
6 hours, when paired and the server answers `/api/health/live`.

**Log.** `AppLog` keeps a rolling file (`files/logs/health-sync.log`, at most 1000 lines,
`<instant> <level>/<tag>: <message>`), thread-safe and redacted before anything is stored.
Pairing, the sync engine, the worker and API failures (method, path, status and code only, never
a body) write to it; Diagnostics shows the last 200 lines.

## Layout

```
app/src/main/java/com/enterpriseapp/android/
  TwaLauncherActivity.kt     launcher: TWA, or setup when no server is configured
  MobileApplication.kt       process-wide ServerConfig, TokenStore, ApiClient
  config/                    ServerConfig (prefs) + ServerUrls (pure validation)
  auth/TokenStore.kt         pairing token, expiry, device id, installation id (encrypted prefs)
  net/                       ApiClient (OkHttp + kotlinx.serialization), ApiResult/ApiError
  util/AppInfo.kt            version, package, signing certificate SHA-256
  util/Brand.kt              product name, deep-link scheme (from BuildConfig)
  setup/SetupActivity.kt     first-run server address screen
  pairing/                   device flow (DeviceFlowPoller), registration, PairingManager
  healthconnect/             HealthConnectGateway (availability, permissions, per-type readers
                             with source packages, inventory), data types/toggles, rationale
  sync/                      HealthMapping, SyncPayloadBuilder, HealthSyncEngine, stores,
                             HealthSyncWorker + WorkManagerSyncScheduler, notifications
  diagnostics/               AppLog (rolling redacted log), Checks (verdicts), SelfTest (runner),
                             DiagnosticReport, AutoDiagnostics (upload after failed runs)
  healthsync/                Health sync hub, Connect, Sync and Diagnostics screens (Compose);
                             each sub-screen's app-bar arrow and system back return to the hub
  update/                    UpdateChecker (12 h, paired only), UpdatePolicy, release API, AppUpdates (download)
  ui/                        theme and shared Compose components
```
