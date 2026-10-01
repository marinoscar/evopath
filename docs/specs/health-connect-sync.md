# Health Connect Sync (Android app)

> **Status:** shipped · **Code:** `apps/api/src/health-sync/`, `apps/api/src/sleep/`, `apps/api/src/android-app/`, `apps/android/` · **API:** `/api/health-sync/*`, `/api/sleep`, `/api/admin/android-app`, `/api/well-known/assetlinks.json` (see `/api/docs`) · **UI:** `/settings/connected-devices`, `/settings/android-app` (download and update), `/admin/settings/android` (trust and Releases), Health page "Sleep" section · **Runbook:** [android-app.md](../runbooks/android-app.md), [android-release.md](../runbooks/android-release.md)

An optional Android app imports steps, exercise sessions, heart rate, weight, body fat, blood pressure and sleep from Android Health Connect into the app. The app is a Trusted Web Activity (TWA) around the web app plus a native Kotlin module that reads Health Connect and posts to `/api/health-sync`. A phone pairs once through the device flow, gets a personal access token (PAT), registers itself as a device, then uploads idempotent syncs. Imported rows carry the provider `health_connect:<deviceId>`, so a re-sent day replaces its earlier row and one phone never touches another's data.

## 1. Purpose

- **What it is.**
  - A source of measured data for activity goals ([activity-goals.md](activity-goals.md)) and the health store ([health-data.md](health-data.md)), fed by whatever apps write into Health Connect on the phone (Samsung Health, Oura, Fitbit, Google Fit and others).
  - A sideloaded personal-use APK built and published by GitHub Actions to the rolling prerelease `android-latest`.
  - A diagnostics surface: a phone self-test, uploaded reports and a web viewer, because "my data does not arrive" has many causes on a phone.
- **What it is not.**
  - Not a cloud integration. The server never holds a provider credential and never calls a provider.
  - Not on Google Play, not iOS, and not write-back: the app only reads Health Connect and writes nothing to it.
  - Not a way around the manual API. `POST /api/activity-entries/batch` still forces `source: manual`; `integration` rows enter only through the health-sync endpoint.
- **Problem it solves.** There is no usable cloud API to pull this data. The Google Health API is not onboarding new apps and holds no Health Connect phone data, and the Google Fit REST API is shut down. Health Connect data exists only on the phone, so a small native app has to read it there and push it.

## 2. How it works

### 2.1 Architecture

Why the app is a TWA plus a native module, the options rejected and the coordination channels between the halves: [native-companion-architecture.md](native-companion-architecture.md).

```
 Phone                                                     Server (same origin)
┌─────────────────────────────────────────────┐
│ com.<repo>.android                          │
│  ┌───────────────────┐  ┌─────────────────┐ │
│  │ TWA shell         │  │ Native Kotlin   │ │   Digital Asset Links
│  │ opens <server>/   │  │ Health sync     │ │   GET /.well-known/assetlinks.json
│  │ ?source=twa       │  │ (Compose UI,    │ │ ◄───────────────────────────────┐
│  │ (full screen PWA) │  │  WorkManager)   │ │                                 │
│  └───────────────────┘  └───────┬─────────┘ │                                 │
│            ▲ deep link          │ reads     │                                 │
│            │ <repo>-android://  ▼           │      Bearer pat_…               │
│            │ health-sync   Health Connect   │ ──────────────────────────────► │
└────────────┼────────────────────────────────┘  POST /api/health-sync/devices  │
             │                                    POST …/devices/:id/sync       │
   Web app: /settings/connected-devices           POST …/devices/:id/diagnostics│
   (devices, runs, diagnostics, Unpair)                                         │
                                          nginx ──► api (HealthSyncService) ────┘
                                                      │ one transaction per sync
                                                      ▼
                          activity_entries · measurements · sleep_sessions
                          health_sync_devices · health_sync_runs · health_sync_diagnostic_reports
```

- **TWA shell.** `TwaLauncherActivity` opens `<server>/?source=twa` full screen, but only when Chrome can verify the app against the server's Digital Asset Links (section 2.9). Without a verified link it opens with a URL bar.
- **Native module.** `HealthSyncActivity` (deep link `<repo>-android://health-sync`, plus a static shortcut "Health sync") holds pairing, per-type switches, the permission flow and diagnostics. A WorkManager worker syncs hourly under a network constraint; a manual sync or an app open runs an expedited one-shot.
- **Web app.** `/settings/connected-devices` lists the phones. Inside the TWA (the `?source=twa` launch flag remembered in `sessionStorage`, or an `android-app://` referrer) it offers "Open Health sync" with the deep link.
- **Package and build.** The application id is `com.<repo>.android`, minSdk 26, target and compile SDK 36. The id, the deep-link scheme `<repo>-android` and the app label (`productName`) derive from `packages/shared/identity.json` at build time, where `<repo>` is the repository name from `repoSlug`, lowercased; `@app/shared` exports the same values (`ANDROID_PACKAGE_NAME`, `ANDROID_DEEP_LINK_SCHEME`, `ANDROID_APK_STEM`) for the web app, the API and the CLI ([RENAMING.md](../RENAMING.md)). Build instructions: `apps/android/README.md`. CI: `.github/workflows/android.yml`.

### 2.2 Pairing

1. The app asks `POST /api/auth/device/code` with `clientInfo.tokenType: "pat"` and shows the code. The user approves it in the browser ([DEVICE-AUTH.md](../DEVICE-AUTH.md)).
2. The app polls `POST /api/auth/device/token` and receives a `pat_` token. Its lifetime is `DEVICE_PAT_EXPIRY_DAYS` (default 90, in `infra/compose/.env.example`).
3. The app stores the token as soon as it has it, then calls `POST /api/health-sync/devices` with the token. The body carries an `installationId` the app generated once per install, the phone's description and the app's package name and signing SHA-256.
4. The server upserts on `(userId, installationId)` and links the PAT: the guard stamps `request.authCredential = { kind: 'pat', tokenId }` and the device row stores that id as `patId`. A JWT caller leaves the link untouched. `tokenExpiresAt` in the device view comes from the linked token.
5. The app schedules the hourly worker and starts an initial sync.

**Re-pairing.** A token that expires or is revoked answers `401`. The app then marks pairing expired, stops syncing and posts a notification "Re-pair `<product>` Health sync". Pairing again runs the same flow; because the `installationId` is unchanged, registering reuses the same device row (and reactivates it if it was revoked), so history and provider stay the same. When the new PAT differs from the one the device linked, registering revokes the previously linked PAT in the same transaction (as unpairing does), so an old pairing never stays valid until it expires; the token authenticating the request is never revoked.

**Unpairing.** `DELETE /api/health-sync/devices/:id` sets the device `revoked` and revokes the linked PAT in one transaction. With `deleteEntries=true` it also deletes the device's activity entries and sleep sessions and soft-deletes its measurements. It is idempotent.

### 2.3 Data mapping

The phone reads each Health Connect record type and maps it to one store on the server. The wire names below (`syncedTypes`) are the contract with the server: `SYNCED_TYPE_SCOPES` in `apps/api/src/health-sync/health-sync.constants.ts`.

| Health Connect record | `syncedTypes` name | Server row | External id | Notes |
|---|---|---|---|---|
| `StepsRecord`, daily total | `steps` | `activity_entries`, kind `steps` | `steps:YYYY-MM-DD` | One row per local day; zero days are skipped. |
| `ExerciseSessionRecord` | `exercise` | `activity_entries`, kind `walk`, `run` or `cardio_any` | record id | Walking and hiking map to `walk`, running to `run`, other cardio types to `cardio_any`; other session types are skipped. `durationSeconds` is end minus start (capped at 86,400); `distanceMeters` sums the distance records inside the session (read permission `READ_DISTANCE`). |
| `HeartRateRecord`, daily average | `heart_rate` | `measurements`, `heart_rate_avg` (bpm) | `hr_avg:YYYY-MM-DD` | Measured at local noon of that day. |
| `RestingHeartRateRecord` | `resting_heart_rate` | `measurements`, `resting_hr` (bpm) | record id | |
| `HeartRateVariabilityRmssdRecord` | `hrv` | `measurements`, `hrv_rmssd` (ms) | record id | |
| `WeightRecord` | `weight` | `measurements`, `weight` (kg) | record id | |
| `BodyFatRecord` | `body_fat` | `measurements`, `body_fat_pct` (%) | record id | |
| `BloodPressureRecord` | `blood_pressure` | `measurements`, `bp_systolic` and `bp_diastolic` (mmHg) | `<id>:sys`, `<id>:dia` | Both share one `entryKey`, so they become one entry. |
| `SleepSessionRecord` | `sleep` | `sleep_sessions` | record id | Stage minutes are summed (awake and out-of-bed as awake; light; deep; REM; sleeping and unknown as unknown). `localDate` is the local date of waking. |

- **Entry kinds a phone may send:** `walk`, `run`, `cardio_any`, `steps`. `workout_any` and `custom` are refused by the schema.
- **Metric keys a phone may send:** `weight`, `body_fat_pct`, `resting_hr`, `heart_rate_avg`, `hrv_rmssd`, `bp_systolic`, `bp_diastolic`. When the phone names no `method`, the server uses `SYNC_METRIC_DEFAULT_METHOD` (`smart_scale` for weight and body fat, `wearable` for heart metrics, `bp_cuff` for blood pressure). A measurement's `unit` must be the registry's canonical unit and its value is checked against the registry bounds (`400 INVALID_MEASUREMENT`).
- **Source label.** Rows carry `source: integration` (activity entries) or `origin: device` with `externalProvider` (measurements and sleep). The web shows them as "Health Connect".
- **Window.** The first sync after pairing covers `today-29..today`, later syncs `today-6..today`, in the phone's time zone. Per-type on/off switches on the phone remove a type from `syncedTypes`.
- **Source apps.** Health Connect only holds what other apps write into it. The phone cannot read an app that does not share ([runbook](../runbooks/android-app.md#7-make-your-source-apps-share-to-health-connect)). Without the history permission, Health Connect exposes data from 30 days before access was first granted.

### 2.4 The sync request and its rules

`POST /api/health-sync/devices/:id/sync` carries a `run` (trigger, status, start and finish, optional error, `details`, time zone), an optional `window`, and up to 1,000 `entries`, 3,000 `measurements` and 200 `sleepSessions`. `run.details` is capped at 32 KB serialized.

| Rule | Behaviour |
|---|---|
| Ownership | A device the caller does not own is `404`. A revoked device is `409 DEVICE_REVOKED`. |
| Allowed days | Every local day lies in `[today-30, today+1]` in the user's Health Profile time zone, else `400 ENTRY_DATE_OUT_OF_RANGE` with `details.path`. |
| Window | At most 31 days (`400 WINDOW_TOO_LARGE`). With a window, activity entries and sleep sessions must fall inside it. |
| Measurement slack | A reading's local day is computed on the server in the user's zone while the phone built the window in its own zone, so a reading up to 1 day outside the window is accepted. It is never reconciled. |
| Steps | A `steps` entry requires `steps`. |
| Duplicates in a payload | The last occurrence of an external id wins. |
| Permissions | A payload carrying any measurement or sleep session needs `health_data:write`, else `403 HEALTH_DATA_SCOPE_REQUIRED`. |
| Always recorded | The run row is inserted even for a failed, skipped or empty sync. |

The response is `{ runId, created, updated, deleted, unchanged, skipped, measurements, sleep }`. The top-level counts describe activity entries. `measurements` and `sleep` each carry `created`, `updated`, `deleted`, `unchanged` and `skipped`. The server appends the same per-table counts to the stored run as `details.server`, next to the phone's own `details`.

### 2.5 Idempotency and ownership of a key

Every upsert is one SQL statement through a raw-SQL partial unique index. Prisma's `upsert` cannot target a partial index, and these indexes are intentional schema drift ([CLAUDE.md](../../CLAUDE.md)).

| Table | Index | Meaning |
|---|---|---|
| `activity_entries` | `activity_entries_provider_external_uniq_idx` | One entry per `(user_id, provider, external_id)` where a provider is set. |
| `measurements` | `measurements_provider_external_uniq_idx` | One reading per `(user_id, external_provider, external_id)` where `external_provider` is set. |
| `sleep_sessions` | `sleep_sessions_provider_external_uniq_idx` | One session per `(user_id, provider, external_id)` where `provider` is set. |

- **A sync only overwrites what it owns.** An activity entry must still be `source: integration` (a manual row that reused the key is skipped), a sleep session `origin: device`, and a measurement active. A reading the user deleted or edited is never resurrected or overwritten; it counts as `skipped`.
- **Unchanged rows are not touched.** A re-sent day bumps no `updated_at` and emits no event.
- **Device measurements have no revision chain.** The value, unit, time and local day are updated in place.
- **Provider per device.** The provider string is built on the server from the device id in the URL, never taken from the payload, so a phone cannot write under another device's provider.

### 2.6 Reconciliation

A phone deletes a record in Health Connect; the next sync must make the row disappear. With a `window` and `run.status === 'ok'`, the server deletes this device's rows inside the window whose external id is absent from the payload, but only for the types named in `run.details.syncedTypes`.

- An absent `syncedTypes` reconciles nothing. Unknown names are ignored. A type the user switched off, or whose permission is missing, is absent from the list, so an empty read is never mistaken for "everything was deleted".
- Scope per type: `steps` removes kind `steps`; `exercise` removes `walk`, `run` and `cardio_any`; `weight`, `body_fat`, `resting_heart_rate`, `heart_rate`, `hrv` and `blood_pressure` remove their metric keys; `sleep` removes every sleep row.
- Activity entries and sleep sessions are hard-deleted. Measurements are soft-deleted (`deleted_at`), like a user's own delete.
- Measurements are matched by their local day inside the window.
- A `partial`, `failed` or `skipped` run reconciles nothing.

### 2.7 Precedence and goals

Imported activity enters the existing goal rules unchanged: per goal and local day the highest source wins (integration over workout over manual), and steps count as a daily maximum ([activity-goals.md](activity-goals.md#25-counting-rules)). A manual 6,000 steps loses to an imported 8,200.

After a sync commits, the service emits `activity.entry.recorded` when activity entries were created, updated or deleted, and `health.data.changed` when measurements changed. The AI Coach listens to the first: its `goal_hit` planning counts `integration` entries as well as manual ones ([ai-coach.md](ai-coach.md)). One structured log line per sync (`event: health_sync.run`) carries ids and counts only, never values.

### 2.8 Retention

Enforced by the API on insert, in the same transaction:

| Data | Kept per device |
|---|---|
| `health_sync_runs` | newest 200 |
| `health_sync_diagnostic_reports` | newest 20 |

Imported entries, readings and sleep sessions follow the normal data rules. Deleting the user, the per-user data reset and the admin factory reset remove all of it ([user-data-reset.md](user-data-reset.md), [factory-reset.md](factory-reset.md)). Deleting a device sets `health_sync_device_id` to null on its measurements and sleep sessions.

### 2.9 Digital Asset Links and trust

Chrome opens a TWA full screen only if the server's `/.well-known/assetlinks.json` vouches for the app's package name and signing certificate SHA-256.

- **Trusted list.** The system setting `android_app` (its own `system_settings` row) holds `trustedApps: Array<{ packageName, sha256 }>`, at most 10. `PUT /api/admin/android-app` replaces the whole list (audited); fingerprints are stored uppercase.
- **Public document.** `GET /api/well-known/assetlinks.json` is `@Public()` and `@AllowDuringMaintenance()`. nginx maps `/.well-known/assetlinks.json` to it. The body is a **bare JSON array**, not the `{ data }` envelope, one statement per package, with `Cache-Control: public, max-age=300`. `[]` when nothing is trusted. It is maintenance-exempt because Chrome remembers a failed verification, so a 503 during a window would leave installed apps opening with a URL bar long after the window.
- **Reported apps.** Each device reports its package and signing SHA-256 when it registers. `GET /api/admin/android-app` returns `{ trustedApps, reportedApps, assetLinks }`; a reported app is `{ packageName, sha256, deviceCount, lastSeenAt, trusted }`, derived from active devices only.
- **Trust flow.** Install the app, pair a phone, open Admin, then Android app: the build appears under reported apps with a **Trust** button. Trusting adds it to the list and the document changes at once (clients cache it up to 5 minutes). The Doctor check `android.assetlinks` (category `android`) is `skip` when no device has reported a fingerprint and `warn` when a reported pair is not trusted ([doctor.md](doctor.md)).

### 2.10 Diagnostics

The phone runs a self-test and can upload the result. Reports are stored per device and shown on `/settings/connected-devices`.

| Check id | What it verifies |
|---|---|
| `app.version` | App version name and code, package and signing SHA-256. Warns only when the signing certificate cannot be read. |
| `app.update` | Compares the installed `versionCode` with the server's current release (`GET /api/android-app/releases/latest`, section 2.12). `pass` up to date; `warn` an update is available (download it from the app's Health sync screen or Settings, then Android app on the web); `skip` when the server has no release (`404 NO_RELEASE`) or one for another package, the phone is not paired, or the check fails. Data: `latestVersionCode`, `latestVersionName`, `updateAvailable`. |
| `server.configured` | A server URL is set. |
| `server.reachable` | `GET /api/health/live` answers; latency recorded; warns when slower than 3 s. |
| `api.connection` | Combines `server.reachable` and `auth.valid` (the authenticated `GET /api/health-sync/devices/:id`): fails when either fails, warns when slow, `skip` without a server. Data: both verdicts and both latencies (`liveLatencyMs`, `authLatencyMs`). |
| `pairing.token` | A token exists; warns under 14 days to expiry. |
| `auth.valid` | The token is accepted (`401` means re-pair). |
| `hc.availability` | Health Connect is installed and up to date. |
| `hc.connection` | A live Health Connect call (`getGrantedPermissions`) returns within 10 s. |
| `hc.permissions` | Which read permissions are granted. |
| `hc.background` | The background-read permission is granted. |
| `hc.sources` | Which apps wrote into Health Connect in the last 30 days (labels resolved from the manifest `<queries>` list, else the package name). Warns when none did. |
| `hc.data.<type>` | One check per synced type: `skip` if the type is switched off on the phone; `fail` if its permission is denied; `warn` if granted but no records in 30 days (the source app is probably not sharing) or the count failed; otherwise `pass` with count, latest record time and sources. |
| `battery.optimization` | The app is not battery-restricted. |
| `notifications.permission` | The notification permission is granted. |
| `work.scheduled` | The periodic worker is scheduled (`ENQUEUED` or `RUNNING`). Warns while it waits for its network constraint (`BLOCKED`); fails when it is not scheduled; `skip` when not paired. |
| `sync.last` | The last sync is under 3 hours old and was `ok`. Warns when it failed or was not recorded by the server, when it was `partial` or `skipped` (including a background skip, `BACKGROUND_PERMISSION_MISSING`, whose remedy is to allow background access), or when it is stale. |
| `sync.delivery` | The last run's per-type `read`, `sent` and server-accepted counts agree; warns on a mismatch. |
| `timezone.match` | The phone's time zone equals the Health Profile time zone (`userTimezone`). |
| `twa.verification` | `<server>/.well-known/assetlinks.json` lists this package and signing SHA-256. Never fails: an unfetchable or invalid document, a missing package or another fingerprint is a `warn` (the app still works, with an address bar). |

`sync.delivery` likewise only warns. Each check is `{ id, label, status: pass | warn | fail | skip, detail, remedy?, data? }`: `label` is the human name the phone shows, `data` an optional object of check-specific facts (latencies, counts, the missing permissions). Fixes for each: [runbook troubleshooting](../runbooks/android-app.md#10-troubleshooting).

**Background skip.** A periodic (worker) run without the Health Connect background-read permission reads nothing. It is still reported, as `status: skipped` with `errorCode: BACKGROUND_PERMISSION_MISSING`, no window and empty `syncedTypes`, so it reconciles nothing (section 2.6). The phone posts the notification "Allow background access so `<product>` can sync while closed" at most once every 24 hours. Manual and app-open syncs run in the foreground and read normally.

**Automatic upload.** After a `failed` or `partial` sync (or one the server never recorded), the phone runs the self-test and uploads a report on its own, at most once every 6 hours, only while it is paired and `GET /api/health/live` answers. The throttle counts from the attempt, so a failing upload does not rerun the self-test every hour.

**Report shape.** `{ generatedAt, summary, app, device, server, pairing, healthConnect, work, checks[], recentRuns[], log[] }`. `summary` is `"N fail, M warn: <first failing check label>"` or `"All checks pass"` (also sent as the upload's `summary`). `app` carries `versionName`, `versionCode`, `packageName`, `signingSha256` and, when the server's current release could be read, `latestVersionCode`, `latestVersionName` and `updateAvailable`. `pairing` carries `deviceId`, `tokenExpiresAt` and `expired`. `healthConnect` carries `status`, `version`, `grantedPermissions`, `backgroundAvailable` (whether this Health Connect supports background reads), an `inventory` (per data type: `label`, permission, 30-day record count capped at 1,000, latest record time, sources, and `error` when the count failed) and `sources`. The log is the app's rolling local log (at most 300 lines in a report, halved until the report fits under 200 KB) and never contains the token.

**Upload and viewing.** `POST /api/health-sync/devices/:id/diagnostics` (`goals:write`, report at most 256 KB serialized, summary at most 500 characters) answers `201 { id, createdAt }` and also works for a revoked device. The list endpoint omits the `report` body; the detail endpoint returns it. The web viewer shows the checks with status icons and remedies, the inventory table, the sources list and a Download JSON button; the runs table shows per-type read and sent counts when the run carries them.

### 2.11 Security notes

- The token lives in encrypted preferences on the phone (`androidx.security:security-crypto`). It is held in memory while a request runs and is never written to the log, to a report or to a Pino line.
- The PAT is the credential. It carries its owner's permissions ([SECURITY-ARCHITECTURE.md](../SECURITY-ARCHITECTURE.md)); revoking the device revokes it.
- Every route is owner-scoped. Another user's device or report is a `404`.
- The claimed source of a row is tied to a registered device: the provider is derived from the device id in the URL, and only an active device owned by the caller can sync.
- Health values are never logged on the server. Logs carry ids and counts.
- The package name and certificate fingerprint a device reports are informational; only an administrator's trust decision changes `assetlinks.json`.

### 2.12 APK releases

The deployment hosts the Android app's APK itself, so users install and update from their own server rather than from GitHub. Code: `apps/api/src/android-app/releases/`.

- **Model.** `android_app_releases`: `packageName`, `versionName` (at most 50 characters of `[0-9A-Za-z._+-]`), `versionCode` (1 to 2,100,000,000, unique per package), `signingSha256` (stored uppercase, colon-separated), `fileSha256` (lowercase hex), `sizeBytes`, `storageKey`, `notes` (at most 2,000 characters), `isCurrent`, `uploadedById` (set null when the user is deleted), `createdAt`. At most **one current release deployment-wide**, enforced by the raw-SQL partial unique index `android_app_releases_one_current_uniq_idx` (intentional schema drift; never a `@@unique`, never a `findFirst` pre-check).
- **Storage.** The APK lives in object storage under `android-releases/<releaseId>.apk` (`ANDROID_RELEASES_KEY_PREFIX`, on `STORAGE_KEY_PREFIXES`), never on local disk and never as a `storage_objects` row. With storage not configured, an upload answers the storage layer's own `503` (`details.reason: storage_not_configured`).
- **Upload.** `POST /api/admin/android-app/releases`, multipart: the file in field `apk`, text fields `packageName`, `versionName`, `versionCode`, `signingSha256`, optional `notes`, `makeCurrent` (default `true`) and `force` (default `false`). The file streams from the multipart parser through a check of the ZIP signature `PK\x03\x04`, the 150 MB limit and a SHA-256 straight into storage; it is never buffered. Text fields sent before the file are validated, and the version rules checked, before a byte is stored. Any refusal after the bytes are stored deletes them.
- **Version rules.** A `(packageName, versionCode)` that exists is `409 RELEASE_VERSION_EXISTS`. Uploading as current a `versionCode` not above the current release of the same package is `409 RELEASE_VERSION_NOT_NEWER` unless `force=true`, because Android refuses to install a lower `versionCode` over a higher one. `make-current` is the explicit rollback and has no such rule.
- **Make current.** Clears the old flag and sets the new one in one transaction. A concurrent make-current that loses the race is a unique violation on the partial index, answered `409 RELEASE_CURRENT_CONFLICT`. Making a release current (on upload or later) adds its `(packageName, signingSha256)` to the trusted apps (section 2.9) when absent and the list has room, through the same audited save as the settings page.
- **Delete.** Deletes the stored APK, then the row. The current release cannot be deleted (`409 RELEASE_IS_CURRENT`).
- **Latest and download.** `GET /api/android-app/releases/latest` returns the current release's public fields or `404 NO_RELEASE`. `POST /api/android-app/releases/:id/download-link` returns `{ url, expiresAt }`: a same-origin path `/api/android-app/download/<token>` valid for 10 minutes. The page or the phone **navigates** to it, so Chrome, the TWA or the system installer downloads natively without an `Authorization` header. The token is a binary payload (release id, user id, expiry) with an HMAC-SHA256 tag truncated to 192 bits, 83 characters so it fits Fastify's 100-character path parameter limit. Its key is derived from `SECRETS_ENCRYPTION_KEY` for the purpose `android-app-download` (`deriveSigningKey`); there is no new environment variable. The download route checks the signature first (`404 DOWNLOAD_LINK_INVALID`), then the expiry (`410 DOWNLOAD_LINK_EXPIRED`), then that the release exists and the user is active (`404`), and streams the object with `Content-Type: application/vnd.android.package-archive`, `Content-Disposition: attachment; filename="<app slug>-android-<versionName>.apk"`, `Content-Length` and `Cache-Control: private, no-store`. It is not exempt from maintenance mode.
- **Device updates.** Registration accepts `appVersionCode`, stored on `health_sync_devices.app_version_code`. Every device view adds `appVersionCode`, `latestVersionCode` (the current release's code when its package matches the device's, or the device reports none; else `null`) and `updateAvailable` (`appVersionCode` known and lower).
- **nginx.** An exact-match block for the upload path raises the body limit to 160m and streams the request; the download path is proxied unbuffered. Both have ten-minute timeouts. On a VPS deploy the edge proxy vhost rendered by `evopathcli deploy` (`apps/cli/src/deploy/proxy.ts`) carries the same two locations, with the upload limit never below the server-wide `MAX_FILE_SIZE` cap, so an APK above that cap is not refused with a bare 413 at the edge.
- **Operating it.** The end-to-end release procedure (CLI, terminal menu, deploy, admin page, CI, rollback) is the [Android release runbook](../runbooks/android-release.md).
- **Audit.** `android_app.release.uploaded`, `android_app.release.made_current`, `android_app.release.deleted` (target type `android_app_release`).
- **Resets.** Releases are deployment artifacts. The user data reset and the factory reset keep the rows and their APKs ([factory-reset.md](factory-reset.md)).
- **Doctor.** `android.releases` is `skip` with no paired device, `warn` when devices are paired but no release is current, `pass` otherwise ([doctor.md](doctor.md)).

**Release JSON.** The admin routes return `{ id, packageName, versionName, versionCode, fileSha256, sizeBytes, notes, createdAt, signingSha256, isCurrent, uploadedBy: { id, email, displayName } | null }`; the list is `{ data: Release[] }`, newest first. The user route returns only `{ id, packageName, versionName, versionCode, fileSha256, sizeBytes, notes, createdAt }`.

## 3. Configuration and permissions

- **Env vars:** `DEVICE_PAT_EXPIRY_DAYS` (the pairing token lifetime; see `infra/compose/.env.example`). The APK download links are signed with a key derived from the existing `SECRETS_ENCRYPTION_KEY`. **System setting:** `android_app` (`trustedApps`), edited at `/admin/settings/android`. No other setting; APK releases live in `android_app_releases` and object storage.
- **Android build inputs:** `apps/android/version.properties` (`versionName`, `versionCode`; `evopathcli android version` edits it), the optional Gradle property `app.serverUrl` (a baked-in server address), and `packages/shared/identity.json` for the identity; CI secrets in the [release runbook](../runbooks/android-release.md#10-ci-release-path).
- **Permissions:**

| Route | Method | Permission |
|---|---|---|
| `/api/health-sync/devices` | `GET` | `goals:read` |
| `/api/health-sync/devices` | `POST` | `goals:write` |
| `/api/health-sync/devices/:id` | `GET` / `DELETE` | `goals:read` / `goals:write` |
| `/api/health-sync/devices/:id/sync` | `POST` | `goals:write` (plus `health_data:write` when the payload has measurements or sleep) |
| `/api/health-sync/devices/:id/runs` | `GET` | `goals:read` |
| `/api/health-sync/devices/:id/diagnostics` | `POST` / `GET` | `goals:write` / `goals:read` |
| `/api/health-sync/devices/:id/diagnostics/:reportId` | `GET` | `goals:read` |
| `/api/sleep` | `GET` | `health_data:read` |
| `/api/sleep/:id` | `DELETE` | `health_data:write` |
| `/api/admin/android-app` | `GET` / `PUT` | `system_settings:read` / `system_settings:write` |
| `/api/well-known/assetlinks.json` | `GET` | public, maintenance-exempt |
| `/api/admin/android-app/releases` | `POST` / `GET` | `system_settings:write` / `system_settings:read` |
| `/api/admin/android-app/releases/:id/make-current` | `POST` | `system_settings:write` |
| `/api/admin/android-app/releases/:id` | `DELETE` | `system_settings:write` |
| `/api/android-app/releases/latest` | `GET` | any signed-in user |
| `/api/android-app/releases/:id/download-link` | `POST` | any signed-in user |
| `/api/android-app/download/:token` | `GET` | public, validated by the signed token |

`GET /api/sleep` takes `from` and `to` (at most 400 days) and returns sessions newest day first. A synced session the user deletes comes back on the next sync while the phone still holds it in its window. Per-endpoint detail lives in `/api/docs`.

## 4. Extending it in a fork

**Add a Health Connect data type.**

1. **API.** If it is a measurement, add the metric to `metric-registry.ts` (and its methods). Add the key to `SYNC_METRIC_DEFAULT_METHOD` and a `syncedTypes` name with its reconciliation scope to `SYNCED_TYPE_SCOPES` in `health-sync.constants.ts`. If it is a new table, add the upsert and the reconcile delete in `health-sync.service.ts` through a raw-SQL partial unique index, and the table's purge in `user-data/user-data-purge.ts`.
2. **Zod.** Extend the sync schema in `health-sync/dto/health-sync.dto.ts` and the planning rules in `health-sync-plan.ts`.
3. **Phone.** Add the read permission to the manifest and `HealthPermissions`, a `HcDataType` and toggle, the mapping in `HealthMapping`, and the payload builder. The `key` must equal the server's `syncedTypes` name.
4. **Diagnostics.** The `hc.data.<type>` check follows from the type list.
5. **Web.** Label the rows "Health Connect" and add a display if the type needs one.
6. **Docs.** Update the mapping table in section 2.3.

**Trust another build.** Add its package and fingerprint at `/admin/settings/android`; no code change.

## 5. Guardrails

- `apps/api/src/health-sync/health-sync-plan.spec.ts`: allowed days, window limits, measurement slack, last-wins de-duplication, blood-pressure entry grouping, reconciliation scope.
- `apps/api/src/health-sync/health-sync.service.spec.ts`: register and re-register, PAT link, unpair, sync counts, ownership of a key, `health_data:write` requirement, event emission.
- `apps/api/test/health-sync/health-sync.integration.spec.ts`: the HTTP contract through the real guards (permissions, `401`, `403`, owner scoping).
- `apps/api/test/health-sync/health-sync.db.spec.ts` and `health-sync-schema.db.spec.ts`: the partial-index upserts, reconcile deletes, retention and the schema constraints against real Postgres ([TESTING.md](../TESTING.md)).
- `apps/api/test/android-app/android-app.integration.spec.ts`: the admin routes and the public document.
- `apps/api/src/android-app/android-app.schema.spec.ts` and `android-app.service.spec.ts`: the trusted list rules, the document builder and the reported-app merge.
- `apps/api/src/android-app/doctor/android-assetlinks.doctor-check.spec.ts`: the `skip`, `warn` and `pass` verdicts.
- `apps/api/src/android-app/releases/*.spec.ts`: upload field and version rules, the streaming APK inspector (magic, size, SHA-256), download token signing, verification and expiry; `android-releases.doctor-check.spec.ts`: the `android.releases` verdicts.
- `apps/api/test/android-app/android-releases.integration.spec.ts`: RBAC on every release route, the multipart upload and its refusals, list, make current, delete, and a download that streams the exact bytes with its headers (404 and 410 for bad and expired tokens).
- `apps/api/test/android-app/android-releases.db.spec.ts`: the one-current partial index, concurrent make-current, the unique version per package and the uploader's SET NULL against real Postgres.
- `apps/api/test/android-app/android-release-nginx.spec.ts`: the upload body limit and the unbuffered download in `infra/nginx/nginx.conf`.
- `apps/api/test/health-data/measurements.db.spec.ts`: the measurements partial index is the one expected drift.
- `apps/api/test/docs-links.spec.ts`: this spec's links.
- Android JVM unit tests (`apps/android`, `./gradlew testDebugUnitTest`): mapping, window computation, payload building, server URL rules, token store, API client errors; diagnostics in `diagnostics/ChecksTest.kt` (every check's verdicts), `SelfTestTest.kt` (the runner, timeouts and the report), `AutoDiagnosticsTest.kt` (when a report is uploaded on its own and the 6-hour throttle) and `AppLogTest.kt` (redaction, rotation, concurrency).

## 6. Design decisions

- **TWA plus native module, not a native app.** The web app is already a PWA with every screen; a TWA reuses it and shares its sign-in. Only Health Connect access needs native code. The full comparison and the reusable pattern are in [native-companion-architecture.md](native-companion-architecture.md).
- **Device flow and a PAT, not a new credential type.** Pairing reuses RFC 8628 and `pat_` tokens, which already have expiry, revocation and a settings page. The cost is that expiry means re-pairing.
- **Push from the phone, not a server pull.** Health Connect has no cloud API, so the server cannot poll it. The phone reads and uploads.
- **Provider per device.** `health_connect:<deviceId>` lets reconciliation delete only that phone's rows. A shared provider would let a second phone erase the first's data.
- **Reconciliation only for `syncedTypes`.** An empty read can mean a revoked permission as easily as deleted data. Naming the types a phone actually read keeps a missing permission from wiping history.
- **Measurements soft-delete, sleep and entries hard-delete.** Measurements follow the store's existing delete rule; the others have no history to preserve.
- **The server hosts the APK.** A fork's users should not depend on a GitHub release page to install or update the app, and the server already knows which version each device runs. The `android-latest` prerelease stays as the fallback when no release is published.
- **A signed link, not an authenticated download.** The system downloader cannot send a bearer token, and a blob download inside the page breaks the native install flow. A ten-minute token bound to one release and one user is the smallest capability that works.
- **No queue job.** A sync is one request and one transaction that ends with the response, so the queue rules for long-running work do not apply.
- **Rejected: a server-side Google API integration.** No usable API exists (section 1).

## 7. Verification

```bash
npm test --workspace=api -- health-sync android-app
npm run test:db --workspace=api
npx jest --config apps/api/test/jest.config.js --rootDir apps/api test/docs-links
```

By hand:

1. Open Admin, then Android app, trust the build, and `curl -s <server>/.well-known/assetlinks.json` shows one statement.
2. Pair a phone, run **Sync now**, and see the run on `/settings/connected-devices`.
3. Delete a record in the source app, sync again, and see it removed (reconciliation).
4. Upload a diagnostics report and open it on the web.

## History

- Epic #276 (Android Health Connect sync): #277 added the database models and the measurement and sleep external-id columns; #278 added the health-sync API and sleep routes; #279 added the Android app trust setting, Digital Asset Links route and Doctor check; #280 scaffolded the Android project and CI; #281 added pairing, Health Connect reads and the sync engine; #282 added phone diagnostics; #283 added the Connected devices, Android app and Sleep web views; #284 wrote this spec and the runbook; #285 added hosted APK releases (section 2.12).
