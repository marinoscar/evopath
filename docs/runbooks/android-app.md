# Runbook: Set up and operate the Android Health Connect app

> **Audience:** operators and the people who use the app · **Spec:** [health-connect-sync.md](../specs/health-connect-sync.md) · **Admin UI:** `/admin/settings/android` · **User UI:** `/settings/android-app`, `/settings/connected-devices` · **Permission:** `system_settings:write` (trust a build, publish a release); `goals:write` (pair a phone)

Use this to build and publish the signed Android APK, install it, trust it on the server so it opens full screen, pair a phone and get Health Connect data flowing. It also covers re-pairing and diagnosing a phone that does not sync. The app is optional; nothing on the server changes until a phone pairs. For the design, see the [spec](../specs/health-connect-sync.md).

**Names in this runbook.** The app's identity derives from `packages/shared/identity.json` ([RENAMING.md](../RENAMING.md)), so this runbook uses placeholders:

| Placeholder | Meaning |
|---|---|
| `<product>` | `productName`; also the app's label on the phone |
| `<repo>` | The repository name from `repoSlug` (the part after the slash), lowercased |
| `<app slug>` | `productName` lowercased and hyphenated (`APP_SLUG`) |
| `com.<repo>.android` | The application id (letters and digits of `<repo>` only) |
| `<repo>-android://health-sync` | The deep link into the native Health sync screen |

## 1. Before you start

- Either the CLI (`evopathcli android`, [section 4.1](#41-publish-to-your-server-with-the-cli)) on a machine with a JDK 17+, or a GitHub repository with Actions enabled (`.github/workflows/android.yml`, [section 4.2](#42-publish-to-the-github-prerelease-ci)). Both can be used together.
- A JDK (for `keytool`). The keystore is created once and reused for every build.
- An Android phone with Android 8 or later (minSdk 26) and Health Connect (built in from Android 14; a Google Play app before that).
- An Admin account to trust the build and publish releases, and a user account to pair. Both need the deployment reachable over HTTPS from the phone.
- **Back up the keystore.** Every update must be signed with the same key. A lost keystore means a new signing key, a new trust entry and uninstalling the old app on every phone.
- **Never commit the keystore or its passwords.** `*.jks` and `*.keystore` are git-ignored.

## 2. Create the signing keystore

**With the CLI (recommended).** `evopathcli android keystore init` creates `~/.evopathcli/android/release.jks` and stores its passwords beside it, outside every checkout. To reuse a keystore you already have, run `evopathcli android keystore import <file>`; the passwords are verified before anything is saved. `evopathcli android keystore show` prints the alias and the certificate SHA-256. Details: [CLI reference](../../apps/cli/README.md#building-and-publishing-the-android-app).

**By hand.**

1. Generate the key (once). Pick any alias; the CLI's default is `<app slug>`:

   ```bash
   keytool -genkeypair -v -keystore release.jks -alias <alias> \
     -keyalg RSA -keysize 2048 -validity 10000
   ```

   You choose a keystore password and a key password, and answer the name prompts. You should see `[Storing release.jks]`.

2. Read the certificate fingerprint, to compare later:

   ```bash
   keytool -list -v -keystore release.jks -alias <alias> | grep 'SHA256:'
   ```

   You should see 32 colon-separated hex bytes. You do not type this anywhere: the app reports its own fingerprint when it pairs, and you trust it from the list ([section 6.3](#63-trust-the-build-on-the-server)).

3. Store the keystore and both passwords in a password manager, outside the repository.

## 3. Add the GitHub secrets

Only needed for the CI build ([section 4.2](#42-publish-to-the-github-prerelease-ci)). With the CLI keystore, `evopathcli android keystore secrets` prints all four values (including the passwords, so run it on a trusted terminal).

1. Encode the keystore on one line:

   ```bash
   base64 -w0 release.jks
   ```

   On macOS use `base64 -i release.jks`.

2. In the repository, open Settings, then Secrets and variables, then Actions, and add four repository secrets:

   | Secret | Value |
   |---|---|
   | `ANDROID_KEYSTORE_BASE64` | The base64 text from step 1 |
   | `ANDROID_KEYSTORE_PASSWORD` | The keystore password |
   | `ANDROID_KEY_ALIAS` | The alias from section 2 |
   | `ANDROID_KEY_PASSWORD` | The key password |

3. You should see all four listed under Repository secrets. Values cannot be read back.

## 4. Publish a build

The version lives in `apps/android/version.properties` (`versionName`, `versionCode`). Every published APK needs a higher `versionCode`: Android refuses to install a lower one over a higher one. `evopathcli android version --bump patch` bumps both.

### 4.1 Publish to your server with the CLI

The deployment hosts the APK itself, so users install and update from **Settings, then Android app** ([section 5](#5-install-the-apk)).

1. `evopathcli android doctor --fix` checks the JDK, the Android SDK, the keystore and `version.properties`, and installs the missing SDK parts. You should see no ✗ rows (the JDK is never installed for you; doctor prints the command).
2. `evopathcli login` against the deployment, as an Admin (`system_settings:write`).
3. `evopathcli android release --bump patch --notes "What changed"` bumps the version, builds and signs the APK (`dist/android/<app slug>-android-<versionName>.apk` plus its `.json` metadata), uploads it as the current release, and commits `apps/android/version.properties`. To do the steps separately: `android version --bump patch`, `android build`, `android publish`.
4. You should see the release under Admin, then Settings, then **Android app**, section **Releases**, marked current. Making a release current also trusts its signing certificate ([section 6.3](#63-trust-the-build-on-the-server)) when the list has room.

**Without the CLI.** The **Releases** section of `/admin/settings/android` uploads an APK directly: drop the APK (with the `.json` the CLI writes next to it to fill in the fields), or type the package name, version name and code and the signing SHA-256. The same section makes another release current (a rollback asks first) and deletes a release that is not current. Rules and limits: [spec §2.12](../specs/health-connect-sync.md#212-apk-releases).

### 4.2 Publish to the GitHub prerelease (CI)

1. Push to `main` with a change under `apps/android/**` or `.github/workflows/android.yml`, or run the **Android** workflow from the Actions tab (`workflow_dispatch`, on `main`).
2. The `test` job runs the unit tests and builds the debug APK. The `release` job then builds the signed release APK at the version in `version.properties`, moves the tag `android-latest` to the commit and replaces the asset `<app slug>-android.apk` on the prerelease **<product> Android (latest)**.
3. You should see the release at `https://github.com/<owner>/<repo>/releases/tag/android-latest`. The web app links to it when this server hosts no release.
4. Without the four secrets the `release` job prints a warning "Android release skipped" and publishes nothing. The debug APK stays available as the `<app slug>-android-debug` artifact of the `test` job.

The CI build leaves the server address empty, so the app asks for it on first run. A local build can bake one in with `evopathcli android build --server-url <address>` (or the Gradle property `-Papp.serverUrl=<address>`).

## 5. Install the APK

1. On the phone, sign in to the web app and open Settings, then **Android app** (`/settings/android-app`). It shows the current release (version, size, notes and SHA-256), whether the installed app is up to date, and a **Download APK** button. When this server hosts no release, it links to the GitHub prerelease instead; download `<app slug>-android.apk` there.
2. Open the file. Android asks to allow installs from this source (the browser): allow it for the install.
3. Tap Install. You should see the app's icon, labelled `<product>`.
4. To update, install the newer APK over the old one from the same page. It keeps its pairing because the signing key is the same. Inside the app, a banner offers the update when the server holds a newer release; the Connected devices view also marks each phone that runs an older build.

## 6. First run, trust and pairing

### 6.1 First run

1. Open the app. With no baked-in server it shows a setup screen: enter your deployment address, for example `https://app.example.com`.
2. The app opens the web app. Until the build is trusted it shows a browser address bar ([section 6.3](#63-trust-the-build-on-the-server)).

### 6.2 Pair the phone

1. In the app, open **Health sync** (the app shortcut, or **Open Health sync** on Settings, then Connected devices, when the web app runs inside the app; it follows the deep link `<repo>-android://health-sync`).
2. Choose **Connect**. The app shows a code and opens the browser approval page.
3. Sign in if asked, check the code matches and approve. The app receives a token that lasts `DEVICE_PAT_EXPIRY_DAYS` (default 90 days).
4. You should see the phone under Settings, then Connected devices, with status active.

### 6.3 Trust the build on the server

Publishing a release as current ([section 4.1](#41-publish-to-your-server-with-the-cli)) trusts its certificate automatically. For a build installed from GitHub or built locally:

1. As an Admin open `/admin/settings`, then **Android app**.
2. Under reported apps you should see `com.<repo>.android` with a fingerprint and a device count. Compare the fingerprint with the one from section 2.
3. Choose **Trust**, then Save. The Digital Asset Links preview now lists the app.
4. Check the public file:

   ```bash
   curl -s https://<your-deployment>/.well-known/assetlinks.json
   ```

   You should see a JSON array with `package_name` `com.<repo>.android` and your fingerprint.
5. Close and reopen the app. Chrome may cache the old answer for up to 5 minutes; if the address bar remains, clear the app's storage or wait, then reopen.

### 6.4 Grant Health Connect permissions

1. In **Health sync**, choose **Connect** (or open the permission prompt it offers). Health Connect lists what the app asks to read (steps, exercise, distance, heart rate, resting heart rate, heart rate variability, weight, body fat, blood pressure, sleep).
2. Allow every type you want. Turn on **Allow in the background** when Health Connect offers it, so hourly syncs run while the app is closed.
3. Back in the app, switch types on or off with the per-type toggles. A switched-off type is not read and its imported rows are left alone.
4. Choose **Sync now**. You should see a run with status ok under Connected devices, then your steps on the Goals page and your readings on Health.

**History.** Without the Health Connect history permission, only data from the 30 days before access was first granted is visible. The first sync reads the last 30 days.

**Background access.** Without it, the hourly sync reads nothing while the app is closed: each such run is recorded as `skipped` with the error `BACKGROUND_PERMISSION_MISSING`, and at most once a day the phone posts the notification "Allow background access so `<product>` can sync while closed". Tap it to open the permission prompt. **Sync now** and opening Health sync still read data.

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

The phone also uploads a report on its own after a failed or partial sync, at most once every 6 hours, while it is paired and the server answers. So a recent report is usually waiting on the web when something breaks.

A report is for your own account; an Admin cannot read another user's reports.

## 9. Unpair, re-pair and token expiry

- **Unpair.** On the web, Connected devices, then Unpair. Tick "also delete imported entries" to remove what the phone imported (measurements are soft-deleted). The token is revoked at once. Unpairing from the phone does the same.
- **Re-pair.** A token lasts `DEVICE_PAT_EXPIRY_DAYS` (default 90). Before it ends, the self-test check `pairing.token` warns at 14 days. At expiry, or after you revoke the token, the phone shows a notification "Re-pair `<product>` Health sync" and syncs stop. Open **Health sync** and re-pair (the same flow as pairing). The same device row is reused, so history stays.
- **Changed key.** If the app was reinstalled with a different signing key it is a different app: trust the new fingerprint ([section 6.3](#63-trust-the-build-on-the-server)) and remove the old one.

## 10. Troubleshooting

Start with the self-test under **Diagnostics** on the phone. Each failing or warning check names its remedy; this table adds the usual causes.

| Check id | Symptom | Cause | Fix |
|---|---|---|---|
| `app.version` | Warns the signing certificate could not be read | The installed APK's signature is unreadable (a broken or repackaged install) | Reinstall the APK ([section 5](#5-install-the-apk)). Otherwise it passes and shows the version, package and fingerprint. |
| `app.update` | Pass: up to date. Warns: an update is available. Skip: the server hosts no release (or one for another package), the phone is not paired, or the check failed | The server's current release has a higher `versionCode` than the installed app | Download the update from the app's **Health sync** screen, or on the web from Settings, then **Android app** ([section 5](#5-install-the-apk)). |
| `server.configured` | Fails | No server address stored | Enter it in the app's settings. |
| `server.reachable` | Fails, or warns slow | No network, wrong address, or the deployment is down | Open the address in the phone's browser; fix the URL or the deployment. `/api/health/live` must answer 200. |
| `api.connection` | Fails or warns slow | Combines `server.reachable` and `auth.valid`, with both latencies (`liveLatencyMs`, `authLatencyMs`) | Fix the failing half first: the network or address for reachability, re-pairing for a refused token. |
| `pairing.token` | Fails (none) or warns (under 14 days) | Not paired, or the token is close to expiry | Pair or re-pair ([section 9](#9-unpair-re-pair-and-token-expiry)). |
| `auth.valid` | Fails with 401, or revoked | The token expired or was revoked (unpaired on the web) | Re-pair. |
| `hc.availability` | Fails | Health Connect is not installed or needs an update | Install or update Health Connect from Google Play (built in from Android 14). |
| `hc.connection` | Fails with an exception | Health Connect is disabled, updating or the app lacks its provider | Open Health Connect once, update it, restart the phone, rerun. The exception class is in the detail. |
| `hc.permissions` | Warns or fails | Some read permissions are denied, or every type is switched off | Open the permission prompt from **Health sync** ([section 6.4](#64-grant-health-connect-permissions)); or Android Settings, then Health Connect, then App permissions, then `<product>`. |
| `hc.background` | Warns | The background-read permission is not granted, or the phone's Health Connect lacks the feature | Allow "Access data in the background"; without it only foreground syncs read data. |
| `hc.sources` | Warns no source wrote in 30 days | No app writes into Health Connect | Enable sharing in your source apps ([section 7](#7-make-your-source-apps-share-to-health-connect)). |
| `hc.data.<type>` | Fails: permission denied | The type's permission is not granted | Grant it in the permission prompt, or switch the type off. |
| `hc.data.<type>` | Warns: granted, no records | The source app is not sharing that type | Enable sharing for that type ([section 7](#7-make-your-source-apps-share-to-health-connect)); remember the 30-day history limit. |
| `hc.data.<type>` | Skip: switched off | The type is switched off on the Sync screen | Nothing to fix; switch it on to sync it. |
| `battery.optimization` | Warns | Battery restrictions stop the hourly worker | Android Settings, then Apps, then `<product>`, then Battery: Unrestricted. |
| `notifications.permission` | Warns | Notifications are off | Allow notifications, or you will miss the "Re-pair" and background-access prompts. |
| `work.scheduled` | Warns: waiting for network | The worker is scheduled but blocked on its network constraint | Connect to the internet. |
| `work.scheduled` | Fails | The worker is not scheduled (the app was force-stopped, or its work was cancelled) | Open the app and **Sync now**; re-pair if not paired. |
| `sync.last` | Warns: older than 3 hours, failed, partial or skipped | The worker is blocked (battery, no network), the last run failed, or some types could not be read | Fix `battery.optimization`, then **Sync now**; read the run's error under Connected devices. |
| `sync.last` | Warns: skipped, `BACKGROUND_PERMISSION_MISSING` | A periodic run found no background access and read nothing; the phone posts "Allow background access so `<product>` can sync while closed" | Allow background access ([section 6.4](#64-grant-health-connect-permissions)). |
| `sync.delivery` | Warns read, sent or accepted counts differ | Values were dropped (out of range, mapping skipped) or the server skipped rows the user deleted or edited | Open the run's per-type counts; `skipped` means the server did not overwrite a reading you deleted or edited. |
| `timezone.match` | Warns the phone zone differs from the Health Profile | Travel, or a stale Health Profile zone | Set the zone at Settings, then Health Profile. A mismatch moves readings across day boundaries. |
| `twa.verification` | Warns | The server's `assetlinks.json` does not list this package and fingerprint, could not be fetched, or Chrome cached an old answer | Trust the build ([section 6.3](#63-trust-the-build-on-the-server)), check the `curl` output, then reopen the app. The Doctor check `android.assetlinks` shows the same on the server. |

Server-side symptoms:

| Symptom | Cause | Fix |
|---|---|---|
| Sync answers 403 `HEALTH_DATA_SCOPE_REQUIRED` | The role lacks `health_data:write` | Grant it to the role; steps still sync without measurements only if the payload has none. |
| Sync answers 409 `DEVICE_REVOKED` | The device was unpaired | Re-pair. |
| Sync answers 400 `ENTRY_DATE_OUT_OF_RANGE` | The phone clock or zone is far off | Fix the phone clock and time zone. |
| A deleted row came back | Synced rows return while the phone still holds the record in its window | Delete the record in the source app. |
| The app opens with an address bar | The build is not trusted | [Section 6.3](#63-trust-the-build-on-the-server). |
| Pairing fails and syncs answer 503 | A maintenance window is open: the device-flow code and token routes are not exempt, and sync routes are blocked | Close the window ([maintenance runbook](maintenance-mode.md)), then pair or sync again. `assetlinks.json` stays reachable. |
| Upload answers 409 `RELEASE_VERSION_EXISTS` or `RELEASE_VERSION_NOT_NEWER` | The `versionCode` was already published, or is not above the current release | `evopathcli android version --bump patch`, rebuild and publish again. |
| Upload answers 503 `storage_not_configured` | Object storage is not configured | Configure it at Admin, then Settings, then Storage. |
| The Doctor warns `android.releases` | Phones are paired but no release is current | Publish one ([section 4.1](#41-publish-to-your-server-with-the-cli)). |

## 11. Summary checklist

- [ ] Keystore created and backed up outside the repository
- [ ] A release published: current on the server (`evopathcli android release`) or on `android-latest` (four GitHub secrets, **Android** workflow)
- [ ] APK installed from Settings, then Android app; server address entered
- [ ] Phone paired (device flow)
- [ ] Build trusted at `/admin/settings/android`; `assetlinks.json` lists it
- [ ] Health Connect permissions granted, including background
- [ ] Source apps share to Health Connect
- [ ] **Sync now** shows a run with status ok
- [ ] Self-test reports no failing check

## See also

- [Health Connect sync spec](../specs/health-connect-sync.md)
- [`evopathcli android` reference](../../apps/cli/README.md#building-and-publishing-the-android-app)
- [Renaming a fork](../RENAMING.md) (the app's package, label and deep link follow `identity.json`)
- [Personal access tokens](../personal-access-tokens.md) and [device authorization](../DEVICE-AUTH.md)
- [Doctor runbook](doctor.md) (`android.assetlinks`, `android.releases`)
