# Native Companion Architecture (PWA in a TWA plus a native module)

> **Status:** shipped · **Code:** `apps/android/`, `apps/api/src/health-sync/`, `apps/api/src/android-app/`, `apps/api/src/device-auth/`, `apps/web/src/utils/twa.ts` · **API:** `/api/health-sync/*`, `/api/android-app/*`, `/api/well-known/assetlinks.json`, `/api/auth/device/*` (see `/api/docs`) · **Admin UI:** `/admin/settings/android` · **Runbook:** [android-app.md](../runbooks/android-app.md), [android-release.md](../runbooks/android-release.md) · **Recipe:** [section 4](#4-extending-it-in-a-fork)

The Android app is a web app in a Trusted Web Activity (TWA) plus a small native Kotlin module, coordinated through the server. The PWA stays the product. The native module exists only to reach an on-device API the web cannot (today, Health Connect). The two halves share no process-level bridge: they meet through a launch URL, a deep link, the server's REST API, a device-flow pairing and Digital Asset Links. This spec explains why it is built this way and how to add the next native capability. The feature itself (data mapping, sync rules, diagnostics checks) is in [health-connect-sync.md](health-connect-sync.md).

## 1. Purpose

- **What it is.**
  - The architectural pattern behind `apps/android/`, written so an engineer can replicate it for a new native capability.
  - The record of the options that were weighed and why a TWA plus native module won.
  - The inventory of the five coordination channels, their failure modes and where each surfaces in diagnostics.
- **What it is not.**
  - Not the Health Connect feature spec: see [health-connect-sync.md](health-connect-sync.md).
  - Not an operator guide: see the [Android app runbook](../runbooks/android-app.md) and the [release runbook](../runbooks/android-release.md).
  - Not a second client. The native module has no business logic of its own beyond reading the device API, shaping a payload and retrying.
- **Problem it solves.**
  - A PWA cannot reach on-device APIs. Health Connect has no web API and no cloud API: the data exists only on the phone. The Google Health API is not onboarding new apps and holds no Health Connect phone data, and the Google Fit REST API is shut down.
  - The product must still be a web app: one UI, one release path, Web Push and the same sign-in everywhere.
  - So the phone needs a small native piece that reads the API locally and pushes to the server, while the web app keeps every screen and every rule.

## 2. How it works

### 2.1 Options considered

| Option | Reaches Health Connect | Keeps the web app as the product | Sign-in | Verdict |
|---|---|---|---|---|
| Pure PWA | No: browsers expose no Health Connect API | Yes | Browser session | Impossible |
| Cloud API (server pulls) | No usable API exists (see section 1) | Yes | n/a | Unavailable |
| Capacitor or other WebView wrapper | Yes, through a plugin | Partly: the UI runs in an embedded WebView, not Chrome | Google blocks OAuth in embedded user agents (`disallowed_useragent`); a WebView also loses the real Chrome PWA features | Rejected |
| Standalone native companion app | Yes | Yes | Own login | Rejected: two installs, two logins, two icons |
| **TWA plus native module** | **Yes, in the native module** | **Yes, the TWA is the real Chrome PWA** | **Shared browser session; native side uses a paired token** | **Chosen** |

- **Capacitor and WebView wrappers.** Google's sign-in refuses embedded user agents ([modernizing OAuth in native apps](https://developers.googleblog.com/2016/08/modernizing-oauth-interactions-in-native-apps.html), [RFC 8252](https://datatracker.ietf.org/doc/html/rfc8252)), and the product signs in with Google. A WebView also has its own cookie jar and service-worker behaviour, so it is a second browser to test, and the Health Connect and background plugins are paid or lack background work. The wrapper would turn the PWA into an app that only resembles it.
- **Standalone companion.** It works, but the user installs and signs in to two things, and the native app needs its own UI for everything the user does around the data.
- **TWA versus WebView.**

| | TWA | WebView |
|---|---|---|
| Engine | The user's real Chrome (or another TWA-capable browser) | An embedded renderer inside the app |
| Cookies and storage | Shared with the browser | Private to the app |
| Service worker, Web Push, install state | The browser's own | Not the browser's |
| Trust | Verified by Digital Asset Links between the site and the app's signing key | None needed, and none given |
| Chrome UI | No URL bar once verified | App-defined |
| JavaScript bridge | None | Possible, and a larger attack surface |

The TWA is the web app, displayed full screen. That is what lets this architecture say "the PWA is the product" without qualification. The cost is that a TWA cannot call into Kotlin, which is why the coordination channels below exist ([section 2.4](#24-the-five-coordination-channels)).

### 2.2 Architecture

```
 Phone                                                       Server (same origin)
┌──────────────────────────────────────────────────┐
│ package com.<repo>.android                       │
│                                                  │
│  ┌────────────────────┐   ┌────────────────────┐ │
│  │ TwaLauncherActivity│   │ HealthSyncActivity │ │        GET /.well-known/assetlinks.json
│  │ (androidbrowser-   │   │ Compose UI: pair,  │ │ ◄───────────────────────────────────────┐
│  │  helper) opens     │   │ toggles, sync,     │ │                                         │
│  │ <server>/?source=  │   │ diagnostics        │ │                                         │
│  │ twa&appVersion=…   │   └─────────┬──────────┘ │        Authorization: Bearer pat_…      │
│  └─────────┬──────────┘             │            │ ───────────────────────────────────────►│
│            │ renders the PWA    ┌───▼──────────┐ │   POST /api/health-sync/devices         │
│            │ in Chrome          │ WorkManager  │ │   POST …/devices/:id/sync               │
│            ▼                    │ HealthSync-  │ │   POST …/devices/:id/diagnostics        │
│   ┌────────────────┐            │ Worker       │ │   GET  /api/android-app/releases/latest │
│   │ PWA (Chrome)   │ deep link  └───┬──────────┘ │                                         │
│   │ session cookie │ <repo>-android://   │ reads │                                         │
│   └──────┬─────────┘ health-sync         ▼       │                                         │
│          │ ───────────────────────► Health Connect│                                         │
└──────────┼───────────────────────────────────────┘                                         │
           │ REST with the browser session (JWT)                    nginx ──► api ───────────┘
           └──────────────────────────────────────────────────────────►  │ one transaction per sync
                                                                         ▼
                                                      activity_entries · measurements · sleep_sessions
                                                      health_sync_devices · runs · diagnostic reports
                                                      object storage: android-releases/<releaseId>.apk
```

| Component | Role | Code |
|---|---|---|
| TWA launcher | Opens the PWA at the configured server with the launch flags; shows a setup screen when no server is set | `apps/android/app/src/main/java/com/enterpriseapp/android/TwaLauncherActivity.kt` |
| Native Health sync activity | Pairing, per-type switches, permission flow, sync status, diagnostics, update card | `healthsync/HealthSyncActivity.kt` and the `healthsync/` screens |
| Pairing | RFC 8628 device flow, token storage, device registration | `pairing/PairingManager.kt`, `pairing/DeviceFlow.kt`, `auth/TokenStore.kt` |
| WorkManager worker | Hourly periodic and expedited one-shot sync, network constraint, exponential backoff | `sync/HealthSyncWorker.kt`, `sync/SyncScheduler.kt` |
| Sync engine | Reads the device API, maps, builds the payload, delivers, records the run | `sync/HealthSyncEngine.kt`, `sync/SyncPayloadBuilder.kt` |
| Diagnostics | Self-test, redacted rolling log, report upload | `diagnostics/SelfTest.kt`, `diagnostics/Checks.kt`, `diagnostics/AppLog.kt` |
| Update check | Asks the server for a newer release; opens a signed download link | `update/` |
| PWA | Every user-facing screen; detects the TWA; offers the deep link; reads devices and reports over REST | `apps/web/src/utils/twa.ts`, `apps/web/src/pages/ConnectedDevicesPage.tsx`, `apps/web/src/components/common/AndroidUpdateBanner.tsx` |
| API | Device registry, idempotent ingestion, assetlinks, hosted releases, device flow | `apps/api/src/health-sync/`, `apps/api/src/android-app/`, `apps/api/src/device-auth/` |
| Object storage | Holds the hosted APKs under `android-releases/` | [storage-providers.md](storage-providers.md) |
| CLI | Builds, signs and publishes releases, bumps the version, deploys with the APK | `apps/cli/src/android/`, `apps/cli/src/deploy/android-step.ts`, `apps/cli/src/tui/screens/android.tsx` |

Both Activities live in one package, so one install, one signing key and one Digital Asset Links statement cover the whole app.

### 2.3 Why there is no JavaScript to Kotlin bridge

The TWA has no `addJavascriptInterface`, no `postMessage` channel and no custom scheme the page can call synchronously; `apps/android/app/src/main` contains no `WebView`. This is deliberate:

- A TWA is Chrome. Chrome exposes no way to hand a page a native object, so a bridge would require abandoning the TWA for a WebView ([section 2.1](#21-options-considered)).
- A bridge turns every XSS in the web app into native code execution with the app's permissions. Without one, a compromised page can reach only what its own session can reach over REST.
- The two halves stay independently deployable. The web ships with every server deploy; the APK ships only when native code changes ([section 2.7](#27-lifecycle-and-releases)).
- The cost is that nothing is synchronous. The web asks, the server mediates, the phone answers later. Features that need a native answer inside one click do not fit this pattern ([section 2.9](#29-trade-offs-and-limits)).

### 2.4 The five coordination channels

| # | Channel | Direction | Carries |
|---|---|---|---|
| a | Launch URL query | native → web | "I am the app", the app version |
| b | Deep link | web → native | "open this native screen" |
| c | The server as hub | native ⇄ web, through REST | data, runs, diagnostics, releases |
| d | Device-flow pairing in a Custom Tab | web session → native credential | a `pat_` token |
| e | Digital Asset Links | server → Chrome | trust: full-screen mode, no URL bar |

**a. Launch URL (`?source=twa&appVersion=&appVersionCode=`).**

- **Mechanism.** `TwaLauncherActivity.getLaunchingUrl()` builds `<server>/?source=twa&appVersion=<versionName>&appVersionCode=<versionCode>` through `ServerUrls.twaLaunchUrl` (`config/ServerUrls.kt`). The manifest's `DEFAULT_URL` is only a placeholder, so one APK works against any deployment. The PWA calls `captureTwaLaunch()` once at startup (`main.tsx`) and keeps the flags in `sessionStorage` (`apps/web/src/utils/twa.ts`). `isRunningInTwa()` is true for the stored flag or an `android-app://` referrer; `getInstalledAppVersion()` returns the build.
- **Used for.** Offering the deep link ("Open Health sync on this phone" on `/settings/connected-devices`) and showing the update banner. Presentation only: it grants nothing.
- **Failure mode.** The query string disappears after the first navigation and `sessionStorage` can be blocked. The referrer check covers a missed flag; an older build that sends no `appVersionCode` simply shows no version. The flag can be forged by anyone, which is why it never gates an API.
- **Diagnostics.** The `app.version` check reports the build the phone runs; the Connected devices page shows `appVersionCode` from registration.

**b. Deep link (`<repo>-android://health-sync`).**

- **Mechanism.** `HealthSyncActivity` declares a `VIEW` intent filter with scheme `${deepLinkScheme}` and host `health-sync` (`AndroidManifest.xml`); the web app renders the link from `ANDROID_HEALTH_SYNC_DEEP_LINK` (`apps/web/src/utils/androidIdentity.ts`). A static launcher shortcut opens the same screen.
- **Failure mode.** Outside the app the link has no handler and nothing happens, so the web offers it only when `isRunningInTwa()`. The scheme derives from `identity.json`, so a renamed fork gets its own scheme.
- **Diagnostics.** None: it is a navigation. A screen the link reaches is the diagnostics surface for everything else.

**c. The server as hub.**

- **Mechanism.** The native module posts to `/api/health-sync/devices`, `…/devices/:id/sync` and `…/devices/:id/diagnostics` with its token. The PWA reads devices, runs and reports with the browser session. Neither half talks to the other.
- **Failure mode.** A phone offline or backing off leaves the server stale. A sync that arrives late is harmless because every write is idempotent ([section 2.6](#26-data-flow-and-correctness-patterns)).
- **Diagnostics.** `server.reachable`, `auth.valid`, `api.connection`, `sync.last` and `sync.delivery` cover reach, credentials and the last run; uploaded reports show up on `/settings/connected-devices`.

**d. Pairing through the device flow.**

- **Mechanism.** `PairingManager` requests a code (`POST /api/auth/device/code`, `clientInfo.tokenType: "pat"`), shows the user code and opens the activation page with `openInCustomTab` (`healthsync/UiSupport.kt`). A Custom Tab shares Chrome's cookie jar, the same jar the TWA uses, so the user is already signed in and only approves. The app polls `POST /api/auth/device/token` (RFC 8628) and receives a `pat_` token, then registers the phone with `POST /api/health-sync/devices`. The token is stored in encrypted preferences as soon as it arrives, so a failed registration retries without a second approval.
- **Re-pair.** Registering with a new PAT revokes the previously linked PAT in the same transaction and reuses the device row (same `installationId`). Unpairing revokes the PAT and marks the device `revoked`. See [health-connect-sync.md section 2.2](health-connect-sync.md#22-pairing).
- **Failure mode.** The user is signed out of Chrome: the Custom Tab shows the normal sign-in, then the approval. No browser at all: the code and URL stay on screen. A token that expires or is revoked answers `401`: the app stops syncing and posts a re-pair notification. A `409 DEVICE_REVOKED` makes it forget the pairing.
- **Diagnostics.** `pairing.token` (present, under 14 days to expiry warns, expired fails) and `auth.valid` (`401` means re-pair, `404`/`409` means connect again).

**e. Digital Asset Links trust.**

- **Mechanism.** Chrome opens the TWA without a URL bar only if `/.well-known/assetlinks.json` lists the app's package and signing SHA-256. The system setting `android_app` holds the trusted list; `GET /api/well-known/assetlinks.json` serves it as a bare array, public and exempt from the maintenance window, and nginx maps `/.well-known/assetlinks.json` to it. Each phone reports its package and fingerprint at registration; an admin trusts it at `/admin/settings/android`, and making a release current trusts its key automatically ([health-connect-sync.md section 2.9](health-connect-sync.md#29-digital-asset-links-and-trust)).
- **Failure mode.** An untrusted or mistyped fingerprint, or a key that changed, leaves the app working but with a URL bar. Chrome caches a failed verification, which is why the document survives maintenance windows.
- **Diagnostics.** The phone's `twa.verification` check (fetches the document and compares; only ever warns) and the server's Doctor check `android.assetlinks` ([doctor.md](doctor.md)).

### 2.5 Identity and security model

- **Two independent credentials.**

| | Browser (PWA) | Native module |
|---|---|---|
| Credential | Access JWT in memory plus HttpOnly `refresh_token` cookie | `pat_` token in `EncryptedSharedPreferences` (`auth/TokenStore.kt`) |
| Obtained by | Google sign-in in Chrome | Device flow approved in that same Chrome |
| Lifetime | 15 minutes, rotated refresh | `DEVICE_PAT_EXPIRY_DAYS`, default 90 |
| Revoked by | Sign out | Unpair, re-pair, or the Access Tokens page |
| Reaches | Everything the user may do | Whatever the PAT's owner may do, used only for the health-sync and release routes |

- **Revocation is per device.** A device row links its PAT; revoking the device revokes the token. A re-pair revokes the old token in the same transaction. Either way a lost or reset phone does not keep a valid credential.
- **Source claims are tied to a registered device.** The provider string `health_connect:<deviceId>` is built on the server from the device id in the URL, never taken from the payload, and only an active device owned by the caller can sync. A phone cannot write under another phone's provider.
- **No token in logs or reports.** `AppLog` redacts `pat_…` and `Bearer …` before storing (`diagnostics/AppLog.kt`); the serialized report is scrubbed and trimmed below 200 KB; the API client logs method, path, status and code, never a body. The server logs ids and counts, never values.
- **The signing key is the trust anchor.** Digital Asset Links bind the site to the key. Lose the keystore and installed copies can never be updated; leak it and someone else can ship an APK Chrome will open full screen against your server. Keep it out of every checkout ([android-release.md](../runbooks/android-release.md#4-signing-keystore)).
- **No bridge, smaller surface.** See [section 2.3](#23-why-there-is-no-javascript-to-kotlin-bridge): the page cannot call native code, and the native module never loads web content.
- **The reported fingerprint is informational.** Only an administrator's trust decision changes `assetlinks.json`.
- **Side channels the page cannot spoof.** The server never trusts `?source=twa` or the app version for authorization; both are presentation hints.

Details of credential kinds: [SECURITY-ARCHITECTURE.md](../SECURITY-ARCHITECTURE.md), [DEVICE-AUTH.md](../DEVICE-AUTH.md), [personal-access-tokens.md](../personal-access-tokens.md).

### 2.6 Data flow and correctness patterns

These are the patterns to copy for the next capability. The Health Connect specifics live in [health-connect-sync.md](health-connect-sync.md).

- **Idempotent upserts with an owned key.** Every row is keyed by `(user, provider = health_connect:<deviceId>, externalId)` through a raw-SQL partial unique index (`activity_entries_provider_external_uniq_idx`, `measurements_provider_external_uniq_idx`, `sleep_sessions_provider_external_uniq_idx`). A re-sent day replaces its earlier row and one phone never touches another's. Prisma cannot express these indexes; they are intentional schema drift ([CLAUDE.md](../../CLAUDE.md)). A sync only overwrites what it owns: a manual row or a row the user deleted is skipped, never resurrected.
- **Window-based reconciliation.** A sync carries a `window` (at most 31 days). With status `ok`, the server deletes the device's rows inside the window that the payload no longer holds, but only for the types named in `run.details.syncedTypes`. A type that is off, not permitted or failed is absent from the list, so an empty read is never mistaken for "everything was deleted".
- **Precedence.** Imported activity enters the existing goal rules: per goal and local day the highest source wins (integration over workout over manual) ([activity-goals.md](activity-goals.md)). A new capability decides its precedence in the server, never in the phone.
- **Run ledger.** The run row is inserted even for a failed, skipped or empty sync (newest 200 kept per device). The phone also keeps its last 20 runs. "What happened at 03:00?" has an answer on both sides.
- **Diagnostics upload.** The phone runs a self-test whose checks are independent, timed-out and never throw; the report is uploaded on demand and, after a failed or partial run, automatically at most every 6 hours (newest 20 kept per device). The web renders it. Pure verdict functions in `diagnostics/Checks.kt` keep the checks unit-testable on the JVM.
- **Background-permission skip.** A periodic run without `READ_HEALTH_DATA_IN_BACKGROUND` reads nothing and reports a `skipped` run with `errorCode: BACKGROUND_PERMISSION_MISSING` rather than failing silently or reading with a partial grant. At most one notification per 24 hours asks for the permission. It reconciles nothing. Copy this shape for any capability whose background access can be revoked.
- **One request, one transaction, no queue job.** A sync ends with its response, so the queue rules for long-running work do not apply ([job-queue.md](job-queue.md#all-long-running-work-is-a-job)). Work that outlives the request (thumbnails, transcoding) is a queue job.

### 2.7 Lifecycle and releases

| Change | Needs a new APK | Needs only a server deploy |
|---|---|---|
| Any PWA screen, copy, rule or API change | No | Yes |
| New or changed sync rules, server-side mapping, precedence, retention | No | Yes (if the payload contract is unchanged) |
| Trusting another build (`/admin/settings/android`) | No | No (a setting) |
| A new native permission, reader, worker or screen | Yes | Also, to accept the new payload |
| A new payload field the server must read | Yes | Yes, server first |
| Renaming the product (identity) | Yes: the package changes, so it is a new app | Yes |

- **Version.** `apps/android/version.properties` holds `versionName` and `versionCode`. `versionCode` must strictly increase for every published APK, because Android refuses to install a lower code over a higher one; the server refuses a duplicate (`409 RELEASE_VERSION_EXISTS`) or a non-newer current release (`409 RELEASE_VERSION_NOT_NEWER`, unless forced).
- **Release paths.** All run the same stages (bump, build and sign, upload, make current): `evopathcli android release`, the terminal menu's Android screen, `evopathcli deploy install|update --with-android`, the upload form at `/admin/settings/android`, and the CI workflow `.github/workflows/android.yml` (publishes to the rolling prerelease `android-latest`, not to the server). Procedures: [android-release.md](../runbooks/android-release.md).
- **Server-hosted releases.** The deployment stores the APK in object storage (`android-releases/<releaseId>.apk`), serves it through a signed 10-minute same-origin link (`POST /api/android-app/releases/:id/download-link`, then `GET /api/android-app/download/<token>`) so the system downloader needs no `Authorization` header, and tells each device whether it is behind. nginx has exact-match locations for the upload and download paths (`infra/nginx/nginx.conf`). Details: [health-connect-sync.md section 2.12](health-connect-sync.md#212-apk-releases).
- **In-app update check.** On every launch (5-minute debounce) and only while paired, `update/` asks `GET /api/android-app/releases/latest` and shows the card when `versionCode` is higher; after a background sync it checks at most every 6 hours and posts one notification per version. The PWA shows `AndroidUpdateBanner` inside the TWA when the launch URL's `appVersionCode` is behind the current release.
- **Identity from `identity.json`.** `apps/android/app/build.gradle.kts` reads `packages/shared/identity.json` and derives the applicationId (`com.<repo>.android`), the deep-link scheme (`<repo>-android`), the label, the brand colours and the storage prefix; `util/Brand.kt` carries them into user-facing text. The web app, API and CLI read the same values through `@app/shared` (`ANDROID_PACKAGE_NAME`, `ANDROID_DEEP_LINK_SCHEME`, `ANDROID_APK_STEM`). The Kotlin namespace stays identity-neutral, so a fork that renames with `scripts/rename.mjs` gets a new package with no Android source change ([RENAMING.md](../RENAMING.md)). Changing `repoSlug` after publishing changes the package and orphans installed copies.

### 2.8 Where each concern lives

| Concern | Native | Web | Server |
|---|---|---|---|
| Reads the device API | Yes | No | No |
| Business rules and precedence | No | No | Yes |
| User interface for the data | Pairing, toggles, diagnostics only | Everything else | n/a |
| Authorization | Presents a PAT | Presents a JWT | Decides |
| Retention and reconciliation | No | No | Yes |

### 2.9 Trade-offs and limits

- **Android only.** No iOS equivalent is built; a TWA is an Android concept.
- **A TWA-capable browser is required.** Chrome (or another browser that supports TWAs) must be installed and current. Without one the launcher falls back to a Custom Tab with a URL bar.
- **Two logins.** The browser session and the paired token are separate; the Custom Tab flow makes the second a single approval, but a user can still have one without the other. Expiry of the PAT means re-pairing.
- **No synchronous web to native calls.** The web cannot ask the phone anything and wait. Design features as "the phone pushes, the web reads".
- **Sideload versus Play.** The app is distributed from the deployment (or a GitHub prerelease), not Google Play. Publishing to Play would add declarations: Health Connect's data-use review and, for media access, Play's photo and video permission policy.
- **Background limits.** WorkManager's periodic work is best-effort: Doze, App Standby buckets and vendor battery savers delay or skip runs, hourly is a minimum interval rather than a guarantee, and the user can revoke background access. The app compensates with an app-open sync, an expedited "Sync now", skip reporting and diagnostics (`battery.optimization`, `work.scheduled`, `hc.background`).
- **No instant updates for native code.** Native changes ship only with an APK; users learn of one on their next app open.
- **Digital Asset Links are cached.** A newly trusted key takes up to about five minutes, and Chrome remembers a failed verification.

## 3. Configuration and permissions

- **Env vars:** `DEVICE_PAT_EXPIRY_DAYS` (pairing token lifetime). The signed download link key derives from the existing `SECRETS_ENCRYPTION_KEY`. No new variable belongs here: storage is configured at runtime ([storage-providers.md](storage-providers.md)).
- **System setting:** `android_app` (`trustedApps`, at most 10), edited at `/admin/settings/android`.
- **Build inputs:** `apps/android/version.properties`, `packages/shared/identity.json`, the optional Gradle property `app.serverUrl`, and the signing environment variables ([apps/android/README.md](../../apps/android/README.md)).
- **Permissions and routes:** owned by [health-connect-sync.md section 3](health-connect-sync.md#3-configuration-and-permissions); the generated reference is `/api/docs`.

| Channel | Route or artifact | Auth |
|---|---|---|
| a, b | none (launch URL, intent filter) | none |
| c | `/api/health-sync/devices/*` | PAT or JWT, `goals:read` / `goals:write` |
| d | `/api/auth/device/code`, `/api/auth/device/token`, activation page | device flow; activation needs the user's session |
| e | `/api/well-known/assetlinks.json` | public, maintenance-exempt |

## 4. Extending it in a fork

### 4.1 Recipe: adding a new native capability

Work through the layers in this order. Each step names where the existing capability does the same thing.

1. **Decide it needs native code.** If a web API (Web Push, File System Access, Web Share) can do it, use the PWA. Native code is for on-device APIs with no web or cloud equivalent. State the rule in the capability's spec.
2. **Manifest.** Add the `<uses-permission>` entries to `AndroidManifest.xml`, and a `<queries>` entry for any package you must resolve. Add an Activity or alias for the rationale screen the platform requires (see `PermissionsRationaleActivity` and the `ViewPermissionUsageActivity` alias). Request each permission at the moment the user enables the feature, with a switch per type, and write the rationale in the user's terms.
3. **Native reader and worker.** Put the platform API behind a gateway interface (see `healthconnect/HealthConnectGateway.kt`) so the engine is unit-testable on the JVM. Put background work in a `CoroutineWorker` with a unique work name, a network constraint, exponential backoff and an app-open trigger (`sync/SyncScheduler.kt`). Handle permission loss as a reported `skipped` run, not a crash.
4. **Payload contract.** Define the wire shape once, in a Zod schema on the server (`apps/api/src/health-sync/dto/`) and a matching `@Serializable` class on the phone (`sync/SyncPayload.kt`). Include a run envelope (trigger, status, window, `details.syncedTypes`-style scope list). Version it by adding optional fields; the server accepts the old shape while old APKs exist.
5. **API ingestion with idempotency.**
   - Register the phone as a device and derive the provider on the server from the device id.
   - Upsert through a raw-SQL partial unique index keyed by `(user, provider, externalId)`; write the migration SQL by hand and never add a `@@unique`.
   - Reconcile only inside a window and only for the scopes the run names.
   - Add the table to the user data purge (`user-data/user-data-purge.ts`) ([user-data-reset.md](user-data-reset.md#4-extending-it-in-a-fork)).
   - Emit domain events after commit, never inside the transaction.
   - Anything long-running is a queue job ([job-queue.md](job-queue.md)); AI work follows the AI platform rules.
6. **Web surfaces.** Reuse `isRunningInTwa()` to offer the deep link, add a card to the section registry for any settings page ([settings-ui.md](settings-ui.md)), and show imported rows with their source label. Extend the Connected devices page for run history and reports rather than adding a page.
7. **Diagnostics checks.** Add one pure check function per failure you can name (permission denied, background not granted, nothing to read, source app not sharing) to `diagnostics/Checks.kt`, register it in `SelfTest`, and list it in the spec's check table. Each check: `{ id, label, status, detail, remedy?, data? }`, own timeout, never throws.
8. **Trust and release.** A new capability ships in a new APK: bump `version.properties`, release it ([android-release.md](../runbooks/android-release.md)), and confirm the signing key is still the trusted one (`twa.verification`, `android.assetlinks`).
9. **Docs.** Write a feature spec in the repo's skeleton, add the check rows and the runbook troubleshooting entries, and link it from [docs/README.md](../README.md) and [CLAUDE.md](../../CLAUDE.md).
10. **Tests.**
    - Android JVM unit tests: mapping, window computation, payload building, check verdicts, redaction (`./gradlew testDebugUnitTest` in `apps/android`).
    - API: plan and service specs, an HTTP integration spec through the real guards, a `*.db.spec.ts` for the partial-index upserts and reconcile ([TESTING.md](../TESTING.md)).
    - Web: the component tests for the surfaces.

### 4.2 Worked example: automatic photo and video upload

This is a design sketch, not shipped code. It shows how the recipe maps onto a capability with very different constraints: large files, not small rows.

| Layer | Design |
|---|---|
| Permission | `READ_MEDIA_IMAGES` and `READ_MEDIA_VIDEO` on Android 13+ (`READ_EXTERNAL_STORAGE` below). Android 14 adds partial access ("Select photos and videos"): the app must work when the user grants only a subset, treating `READ_MEDIA_VISUAL_USER_SELECTED` as a degraded grant, and a diagnostics check must say which grant it holds ([partial photo and video access](https://developer.android.com/about/versions/14/changes/partial-photo-video-access)). |
| Discovery | A WorkManager worker with content-URI triggers on `MediaStore.Images` and `MediaStore.Video` for new items, plus a periodic catch-up that queries `MediaStore` by generation (`MediaStore.getGeneration`) to find everything added or modified since the last run, because content-URI triggers can be missed ([MediaStore](https://developer.android.com/training/data-storage/shared/media)). |
| Constraints | Unmetered network and optional charging constraints, user-configurable. Cellular upload is an explicit opt-in. |
| Transfer | Resumable chunked uploads: tus, or S3 multipart with presigned URLs the server mints per part, streamed straight to object storage and never buffered by the API ([storage-providers.md](storage-providers.md)). The phone stores the upload id and the confirmed part count so a retry resumes. |
| Foreground work | A long upload needs a foreground notification; on Android 14+ prefer a user-initiated data transfer job ([UIDT](https://developer.android.com/develop/background-work/background-tasks/uidt)) for user-triggered bulk uploads, and a foreground service type for the automatic path. The notification names the product and offers Pause. |
| Payload contract | Per item: device-local media id, `dateTaken`, mime type, size, SHA-256, and a run envelope with scope (`images`, `videos`). |
| Idempotency | Dedupe by `(user, provider = media:<deviceId>, externalId = <mediaId>)` plus content hash through a raw-SQL partial unique index; a re-sent id with the same hash is `unchanged`, a changed hash is an update. A copy of the same bytes from another device is a separate row unless the product decides to merge by hash. |
| Reconciliation | Default is off: deleting a photo on the phone must not delete it on the server unless the user opts in, and only inside a bounded window for scopes the run names. |
| Post-processing | Thumbnails, EXIF stripping and transcoding are queue jobs enqueued on upload completion, not inline ([job-queue.md](job-queue.md)); they are node-eligible unless they need a credential a node must not hold. |
| Web | A gallery page reads the server's rows; the TWA offers the deep link to the native settings (folders, Wi-Fi only, charging only). |
| Diagnostics | Checks for `media.permission` (full, partial, denied), `media.trigger` (work scheduled), `media.pending` (queued bytes and oldest item), `upload.resume` (last resumable session) and `battery.optimization`. |
| Play policy | Google Play restricts photo and video permissions to apps whose core purpose needs broad access and otherwise expects the system photo picker. A sideloaded deployment is not subject to the review; a Play listing would need the declaration or a picker-based design. |

## 5. Guardrails

- `apps/web/src/__tests__/pages/ConnectedDevicesPage.test.tsx` and `apps/web/src/__tests__/components/common/AndroidUpdateBanner.test.tsx`: the TWA-only surfaces render only inside the TWA and cost no request elsewhere.
- `apps/api/src/health-sync/health-sync-plan.spec.ts`, `health-sync.service.spec.ts` and `apps/api/test/health-sync/*.db.spec.ts`: idempotent upserts, ownership of a key, reconciliation scope, partial-index behaviour against real Postgres.
- `apps/api/src/android-app/android-app.schema.spec.ts` and `android-app.service.spec.ts`: the trusted list and the Digital Asset Links document.
- `apps/api/test/android-app/android-app.integration.spec.ts`: the public, bare-array document and the admin routes.
- `apps/api/src/android-app/releases/*.spec.ts`, `apps/api/test/android-app/android-releases.*.spec.ts` and `android-release-nginx.spec.ts`: version rules, streaming upload, signed download links, nginx locations.
- Android JVM unit tests (`apps/android`, `./gradlew testDebugUnitTest`): mapping, windows, payloads, token store, API client errors, check verdicts, log redaction.
- `apps/cli/src/template-identity.test.ts`: no literal product name or slug in the Android docs and sources, which keeps the identity derivation honest.
- `apps/api/test/docs-links.spec.ts`: this spec's links.

## 6. Design decisions

- **TWA plus native module, not a WebView wrapper.** Google's sign-in refuses embedded user agents and a wrapper replaces Chrome's PWA behaviour with its own. The TWA is the real PWA; only the device API needs Kotlin.
- **No JavaScript bridge.** A bridge needs a WebView and widens the XSS blast radius. Coordination through URLs, intents and REST keeps the halves independent and the page unable to call native code. Rejected: a bridge with an allowlist of methods (still needs a WebView).
- **The server is the hub.** The phone pushes, the web reads. This also gives multi-device support, history and diagnostics for free. Rejected: the phone writing to the page's storage (no shared storage exists between a Custom Tab, a TWA and a native process that the server does not mediate).
- **Pairing in a Custom Tab with the device flow.** It reuses an existing, audited flow and the user's signed-in Chrome. Rejected: embedded sign-in (blocked), a shared secret in the launch URL (leaks through logs and history), copying a token by hand.
- **A separate credential for the native side.** A PAT is scoped to its device, revocable on its own and carries no browser session. The cost is re-pairing on expiry.
- **Provider per device.** `health_connect:<deviceId>` lets reconciliation delete only that phone's rows. A shared provider would let a second phone erase the first's data.
- **The server hosts the APK.** A fork's users do not depend on a GitHub release page; the server already knows each device's version. The `android-latest` prerelease remains as the fallback when no release is published.
- **Identity derived at build time.** One `identity.json` feeds Gradle, the web, the API and the CLI, so a rename needs no Android source edit. The cost is that the applicationId follows `repoSlug`.

## 7. Verification

```bash
npx jest --config apps/api/test/jest.config.js --rootDir apps/api test/docs-links
cd apps/cli && npx vitest run src/template-identity.test.ts
npm test --workspace=api -- health-sync android-app
cd apps/android && ./gradlew --no-daemon testDebugUnitTest
```

By hand:

1. Install the app, open it, and confirm the PWA opens without a URL bar once the build is trusted (`curl -s <server>/.well-known/assetlinks.json` lists the package).
2. On `/settings/connected-devices` inside the app, choose "Open Health sync on this phone" and see the native screen (channel b); in an ordinary browser tab the button is absent.
3. Pair from the native screen, see the Custom Tab open already signed in, approve, and see the device appear on the web (channels c and d).
4. Run Diagnostics on the phone and see `twa.verification`, `auth.valid` and `app.version` pass.
5. Unpair, and see the device `revoked` and its token rejected.

## References

External:

- [Trusted Web Activity overview](https://developer.chrome.com/docs/android/trusted-web-activity)
- [Digital Asset Links](https://developers.google.com/digital-asset-links/v1/getting-started)
- [Custom Tabs](https://developer.chrome.com/docs/android/custom-tabs)
- [android-browser-helper](https://github.com/GoogleChrome/android-browser-helper) (the library `TwaLauncherActivity` extends)
- [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap)
- [Health Connect](https://developer.android.com/health-and-fitness/health-connect)
- [WorkManager](https://developer.android.com/topic/libraries/architecture/workmanager)
- [RFC 8628, OAuth 2.0 Device Authorization Grant](https://datatracker.ietf.org/doc/html/rfc8628)
- [RFC 8252, OAuth 2.0 for Native Apps](https://datatracker.ietf.org/doc/html/rfc8252)
- [Google: modernizing OAuth interactions in native apps](https://developers.googleblog.com/2016/08/modernizing-oauth-interactions-in-native-apps.html)
- [Google Health API](https://developers.google.com/health/about)
- [Capacitor](https://capacitorjs.com/)
- [MediaStore and shared media](https://developer.android.com/training/data-storage/shared/media)
- [Android 14 partial photo and video access](https://developer.android.com/about/versions/14/changes/partial-photo-video-access)
- [User-initiated data transfer jobs](https://developer.android.com/develop/background-work/background-tasks/uidt)

Internal:

- Docs: [health-connect-sync.md](health-connect-sync.md), [android-app.md](../runbooks/android-app.md), [android-release.md](../runbooks/android-release.md), [apps/android/README.md](../../apps/android/README.md), [`evopathcli android`](../../apps/cli/README.md#building-and-publishing-the-android-app), [DEVICE-AUTH.md](../DEVICE-AUTH.md), [personal-access-tokens.md](../personal-access-tokens.md), [SECURITY-ARCHITECTURE.md](../SECURITY-ARCHITECTURE.md), [job-queue.md](job-queue.md), [storage-providers.md](storage-providers.md), [doctor.md](doctor.md), [RENAMING.md](../RENAMING.md), [device-auth module README](../../apps/api/src/device-auth/README.md).
- Source: [`TwaLauncherActivity.kt`](../../apps/android/app/src/main/java/com/enterpriseapp/android/TwaLauncherActivity.kt), [`AndroidManifest.xml`](../../apps/android/app/src/main/AndroidManifest.xml), [`build.gradle.kts`](../../apps/android/app/build.gradle.kts), [`twa.ts`](../../apps/web/src/utils/twa.ts), [`androidIdentity.ts`](../../apps/web/src/utils/androidIdentity.ts), [`asset-links.controller.ts`](../../apps/api/src/android-app/asset-links.controller.ts), [`android-step.ts`](../../apps/cli/src/deploy/android-step.ts), [`nginx.conf`](../../infra/nginx/nginx.conf), [`android.yml`](../../.github/workflows/android.yml).

## History

- Epic #276 (Android Health Connect sync) built the app, the server side and the release path this spec describes; its design record is [health-connect-sync.md](health-connect-sync.md).
- This document extracts the architecture and the reusable pattern from that work.
