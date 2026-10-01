# Runbook: Set up and operate the Android Health Connect app

> **Audience:** operators and the people who use the app · **Spec:** [health-connect-sync.md](../specs/health-connect-sync.md) · **Admin UI:** `/admin/settings/android` · **Permission:** `system_settings:write` (trust a build); `goals:write` (pair a phone)

Use this to build and publish the signed Android APK, install it, trust it on the server so it opens full screen, pair a phone and get Health Connect data flowing. It also covers re-pairing and diagnosing a phone that does not sync. The app is optional; nothing on the server changes until a phone pairs. For the design, see the [spec](../specs/health-connect-sync.md).

## 1. Before you start

- A GitHub repository with Actions enabled. The workflow is `.github/workflows/android.yml`.
- A machine with a JDK (for `keytool`). The keystore is created once and reused for every build.
- An Android phone with Android 8 or later (minSdk 26) and Health Connect (built in from Android 14; a Google Play app before that).
- An Admin account to trust the build, and a user account to pair. Both need the deployment reachable over HTTPS from the phone.
- **Back up the keystore.** Every update must be signed with the same key. A lost keystore means a new signing key, a new trust entry and uninstalling the old app on every phone.
- **Never commit the keystore or its passwords.** `*.jks` and `*.keystore` are git-ignored.

## 2. Create the signing keystore

1. Generate the key (once):

   ```bash
   keytool -genkeypair -v -keystore evopath-release.jks -alias evopath \
     -keyalg RSA -keysize 2048 -validity 10000
   ```

   You choose a keystore password and a key password, and answer the name prompts. You should see `[Storing evopath-release.jks]`.

2. Read the certificate fingerprint, to compare later:

   ```bash
   keytool -list -v -keystore evopath-release.jks -alias evopath | grep 'SHA256:'
   ```

   You should see 32 colon-separated hex bytes. You do not type this anywhere: the app reports its own fingerprint when it pairs, and you trust it from the list ([section 6.3](#63-trust-the-build-on-the-server)).

3. Store the keystore and both passwords in a password manager, outside the repository.

## 3. Add the GitHub secrets

1. Encode the keystore on one line:

   ```bash
   base64 -w0 evopath-release.jks
   ```

   On macOS use `base64 -i evopath-release.jks`.

2. In the repository, open Settings, then Secrets and variables, then Actions, and add four repository secrets:

   | Secret | Value |
   |---|---|
   | `ANDROID_KEYSTORE_BASE64` | The base64 text from step 1 |
   | `ANDROID_KEYSTORE_PASSWORD` | The keystore password |
   | `ANDROID_KEY_ALIAS` | `evopath` (the alias from section 2) |
   | `ANDROID_KEY_PASSWORD` | The key password |

3. You should see all four listed under Repository secrets. Values cannot be read back.

## 4. Publish a build

CI publishes the APK; nothing is built by hand.

1. Push to `main` with a change under `apps/android/**` or `.github/workflows/android.yml`, or run the **Android** workflow from the Actions tab (`workflow_dispatch`, on `main`).
2. The `test` job runs the unit tests and builds the debug APK. The `release` job then builds the signed release APK (version `0.1.<run number>`), moves the tag `android-latest` to the commit and replaces the asset `evopath-android.apk` on the prerelease **EvoPath Android (latest)**.
3. You should see the release at `https://github.com/<owner>/<repo>/releases/tag/android-latest` (the web app shows the same link under Settings, then Connected devices, when no phone is paired).
4. Without the four secrets the `release` job prints a warning "Android release skipped" and publishes nothing. The debug APK stays available as the `evopath-android-debug` artifact of the `test` job.

The CI build leaves the Gradle property `evopath.serverUrl` empty, so the app asks for the server address on first run. A local build can bake one in with `-Pevopath.serverUrl=<address>`.

## 5. Install the APK

1. On the phone, open the release page in a browser and download `evopath-android.apk`.
2. Open the file. Android asks to allow installs from this source (the browser): allow it for the install.
3. Tap Install. You should see the **EvoPath** icon.
4. To update, install the newer `evopath-android.apk` over the old one. It keeps its pairing because the signing key is the same.

## 6. First run, trust and pairing

### 6.1 First run

1. Open the app. With no baked-in server it shows a setup screen: enter your deployment address, for example `https://evopath.example.com`.
2. The app opens the web app. Until the build is trusted it shows a browser address bar ([section 6.3](#63-trust-the-build-on-the-server)).

### 6.2 Pair the phone

1. In the app, open **Health sync** (the app shortcut, or **Open Health sync** on Settings, then Connected devices, when the web app runs inside the app).
2. Choose **Connect**. The app shows a code and opens the browser approval page.
3. Sign in if asked, check the code matches and approve. The app receives a token that lasts `DEVICE_PAT_EXPIRY_DAYS` (default 90 days).
4. You should see the phone under Settings, then Connected devices, with status active.

### 6.3 Trust the build on the server

1. As an Admin open `/admin/settings`, then **Android app**.
2. Under reported apps you should see `com.evopath.android` with a fingerprint and a device count. Compare the fingerprint with the one from section 2.
3. Choose **Trust**, then Save. The Digital Asset Links preview now lists the app.
4. Check the public file:

   ```bash
   curl -s https://<your-deployment>/.well-known/assetlinks.json
   ```

   You should see a JSON array with `package_name` `com.evopath.android` and your fingerprint.
5. Close and reopen the app. Chrome may cache the old answer for up to 5 minutes; if the address bar remains, clear the app's storage or wait, then reopen.

### 6.4 Grant Health Connect permissions

1. In **Health sync**, choose **Connect** (or open the permission prompt it offers). Health Connect lists what the app asks to read (steps, exercise, distance, heart rate, resting heart rate, heart rate variability, weight, body fat, blood pressure, sleep).
2. Allow every type you want. Turn on **Allow in the background** when Health Connect offers it, so hourly syncs run while the app is closed.
3. Back in the app, switch types on or off with the per-type toggles. A switched-off type is not read and its imported rows are left alone.
4. Choose **Sync now**. You should see a run with status ok under Connected devices, then your steps on the Goals page and your readings on Health.

**History.** Without the Health Connect history permission, only data from the 30 days before access was first granted is visible. The first sync reads the last 30 days.

## 7. Make your source apps share to Health Connect

The app can only read what other apps write into Health Connect. Check the app's **Data in Health Connect** panel (or `hc.data.<type>` in the self-test): a type with zero records means its source is not sharing.

| Source app | Where to enable sharing |
|---|---|
| Samsung Health | Settings, then Health Connect: allow each data type to write (steps, exercise, heart rate, sleep, weight, blood pressure). |
| Oura | Oura app, Settings, then Health Connect: connect and allow the types to write. |
| Fitbit | Fitbit app, profile, Settings, then Health Connect: allow the types to write. |
| Google Fit | Health Connect, then App permissions, then Fit: allow writing the types you want. |

In every case you can also open Android Settings, then Health Connect, then App permissions, pick the source app and allow it to write the types. After the source app has written something, run **Sync now**.

## 8. Read diagnostics on the web

1. On the phone open **Health sync**, then **Diagnostics**, run the self-test and choose **Upload report**.
2. On the web open Settings, then **Connected devices**, then the phone.
3. The sync history lists each run with trigger, status, counts and, when present, per-type read and sent counts. The latest report shows each check with an icon, the detail and the remedy, the Health Connect inventory (permission, count, latest record, sources) and the sources list.
4. Choose **Download JSON** to attach the report to a bug report.

A report is for your own account; an Admin cannot read another user's reports.

## 9. Unpair, re-pair and token expiry

- **Unpair.** On the web, Connected devices, then Unpair. Tick "also delete imported entries" to remove what the phone imported (measurements are soft-deleted). The token is revoked at once. Unpairing from the phone does the same.
- **Re-pair.** A token lasts `DEVICE_PAT_EXPIRY_DAYS` (default 90). Before it ends, the self-test check `pairing.token` warns at 14 days. At expiry, or after you revoke the token, the phone shows a notification "Re-pair EvoPath Health sync" and syncs stop. Open **Health sync** and re-pair (the same flow as pairing). The same device row is reused, so history stays.
- **Changed key.** If the app was reinstalled with a different signing key it is a different app: trust the new fingerprint ([section 6.3](#63-trust-the-build-on-the-server)) and remove the old one.

## 10. Troubleshooting

Start with the self-test under **Diagnostics** on the phone. Each failing or warning check names its remedy; this table adds the usual causes.

| Check id | Symptom | Cause | Fix |
|---|---|---|---|
| `app.version` | Warns the app is old | A newer `android-latest` exists | Install the newer APK ([section 5](#5-install-the-apk)). |
| `server.configured` | Fails | No server address stored | Enter it in the app's settings. |
| `server.reachable` | Fails | No network, wrong address, or the deployment is down | Open the address in the phone's browser; fix the URL or the deployment. `/api/health/live` must answer 200. |
| `api.connection` | Fails or slow | Server unreachable, or a proxy blocks `/api`; or the token is refused | Check the address and network first; if it says 401 treat as `auth.valid`. |
| `pairing.token` | Fails (none) or warns (under 14 days) | Not paired, or the token is close to expiry | Pair or re-pair ([section 9](#9-unpair-re-pair-and-token-expiry)). |
| `auth.valid` | Fails with 401 | The token expired or was revoked (unpaired on the web) | Re-pair. |
| `hc.availability` | Fails | Health Connect is not installed or needs an update | Install or update Health Connect from Google Play (built in from Android 14). |
| `hc.connection` | Fails with an exception | Health Connect is disabled, updating or the app lacks its provider | Open Health Connect once, update it, restart the phone, rerun. The exception class is in the detail. |
| `hc.permissions` | Warns or fails | Some read permissions are denied | Open the permission prompt from **Health sync** ([section 6.4](#64-grant-health-connect-permissions)); or Android Settings, then Health Connect, then App permissions, then EvoPath. |
| `hc.background` | Warns | The background-read permission is not granted, or the phone's Health Connect lacks the feature | Allow "Access in the background"; without it only foreground syncs read data. |
| `hc.sources` | Warns no source wrote in 30 days | No app writes into Health Connect | Enable sharing in your source apps ([section 7](#7-make-your-source-apps-share-to-health-connect)). |
| `hc.data.<type>` | Fails: permission denied | The type's permission is not granted | Grant it in the permission prompt. |
| `hc.data.<type>` | Warns: granted, no records | The source app is not sharing that type | Enable sharing for that type ([section 7](#7-make-your-source-apps-share-to-health-connect)); remember the 30-day history limit. |
| `battery.optimization` | Warns | Battery restrictions stop the hourly worker | Android Settings, then Apps, then EvoPath, then Battery: Unrestricted. |
| `notifications.permission` | Warns | Notifications are off | Allow notifications, or you will miss "Re-pair" prompts. |
| `work.scheduled` | Fails | The worker is not scheduled (not paired, or the app was force-stopped) | Open the app and **Sync now**; re-pair if not paired. |
| `sync.last` | Warns: older than 3 hours or failed | The worker is blocked (battery, no network) or the last run failed | Fix `battery.optimization`, then **Sync now**; read the run's error under Connected devices. |
| `sync.delivery` | Warns read, sent or accepted counts differ | Values were dropped (out of range, mapping skipped) or the server skipped rows the user deleted or edited | Open the run's per-type counts; `skipped` means the server did not overwrite a reading you deleted or edited. |
| `timezone.match` | Warns the phone zone differs from the Health Profile | Travel, or a stale Health Profile zone | Set the zone at Settings, then Health Profile. A mismatch moves readings across day boundaries. |
| `twa.verification` | Fails or warns | The server's `assetlinks.json` does not list this package and fingerprint, or Chrome cached an old answer | Trust the build ([section 6.3](#63-trust-the-build-on-the-server)), check the `curl` output, then reopen the app. The Doctor check `android.assetlinks` shows the same on the server. |

Server-side symptoms:

| Symptom | Cause | Fix |
|---|---|---|
| Sync answers 403 `HEALTH_DATA_SCOPE_REQUIRED` | The role lacks `health_data:write` | Grant it to the role; steps still sync without measurements only if the payload has none. |
| Sync answers 409 `DEVICE_REVOKED` | The device was unpaired | Re-pair. |
| Sync answers 400 `ENTRY_DATE_OUT_OF_RANGE` | The phone clock or zone is far off | Fix the phone clock and time zone. |
| A deleted row came back | Synced rows return while the phone still holds the record in its window | Delete the record in the source app. |
| The app opens with an address bar | The build is not trusted | [Section 6.3](#63-trust-the-build-on-the-server). |

## 11. Summary checklist

- [ ] Keystore created and backed up outside the repository
- [ ] Four GitHub secrets added
- [ ] `android-latest` release published by the **Android** workflow
- [ ] APK installed; server address entered
- [ ] Phone paired (device flow)
- [ ] Build trusted at `/admin/settings/android`; `assetlinks.json` lists it
- [ ] Health Connect permissions granted, including background
- [ ] Source apps share to Health Connect
- [ ] **Sync now** shows a run with status ok
- [ ] Self-test reports no failing check

## See also

- [Health Connect sync spec](../specs/health-connect-sync.md)
- [Personal access tokens](../personal-access-tokens.md) and [device authorization](../DEVICE-AUTH.md)
- [Doctor runbook](doctor.md) (`android.assetlinks`)
