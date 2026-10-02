# Runbook: Set up and operate the Android Health Connect app

> **Audience:** operators and the people who use the app · **Spec:** [health-connect-sync.md](../specs/health-connect-sync.md) · **Admin UI:** `/admin/settings/android` · **User UI:** `/settings/android-app`, `/settings/connected-devices` · **Permission:** `system_settings:write` (trust a build); `goals:write` (pair a phone)

Use this to install the Android app, trust it on the server so it opens full screen, pair a phone and get Health Connect data flowing. It also covers re-pairing and diagnosing a phone that does not sync. Building, signing and publishing the APK, and rolling a release back, are in the [Android release runbook](android-release.md). The app is optional; nothing on the server changes until a phone pairs. For the design, see the [spec](../specs/health-connect-sync.md).

**Names in this runbook.** The app's identity derives from `packages/shared/identity.json` ([RENAMING.md](../RENAMING.md)), so this runbook uses placeholders:

| Placeholder | Meaning |
|---|---|
| `<product>` | `productName`; also the app's label on the phone |
| `<repo>` | The repository name from `repoSlug` (the part after the slash), lowercased |
| `<app slug>` | `productName` lowercased and hyphenated (`APP_SLUG`) |
| `com.<repo>.android` | The application id (letters and digits of `<repo>` only) |
| `<repo>-android://health-sync` | The deep link into the native Health sync screen |

## 1. Before you start

- A published release: the server hosts the APK, or the GitHub prerelease `android-latest` exists. Publish one with the [Android release runbook](android-release.md) (CLI, terminal menu, deploy, admin page or CI).
- An Android phone with Android 8 or later (minSdk 26) and Health Connect (built in from Android 14; a Google Play app before that).
- An Admin account to trust the build, and a user account to pair. Both need the deployment reachable over HTTPS from the phone.

## 2. Create the signing keystore

The keystore signs every build, and every update must use the same key. Create or import it with `evopathcli android keystore init` or `import <file>`, and back it up outside the repository. Steps, the commands and the consequences of losing it: [release runbook, section 4](android-release.md#4-signing-keystore). To compare a fingerprint later, `evopathcli android keystore show` prints it; you do not type it anywhere, because the app reports its own fingerprint when it pairs and you trust it from the list ([section 6.3](#63-trust-the-build-on-the-server)).

## 3. Add the GitHub secrets

Only the CI build needs them. The four secrets and how to print them: [release runbook, section 10](android-release.md#10-ci-release-path).

## 4. Publish a build

Every published APK needs a higher `versionCode` than the last. The routes, the version rules and the errors are in the [Android release runbook](android-release.md).

### 4.1 Publish to your server with the CLI

`evopathcli android release --bump patch` publishes to your server, where users install and update from **Settings, then Android app** ([section 5](#5-install-the-apk)). The CLI, terminal menu, deploy and admin-page routes: [release runbook, sections 6 to 9](android-release.md#6-release-from-the-command-line). Making a release current also trusts its signing certificate ([section 6.3](#63-trust-the-build-on-the-server)) when the list has room.

### 4.2 Publish to the GitHub prerelease (CI)

The **Android** workflow publishes the rolling prerelease `android-latest`. The web app links to it when this server hosts no release. Setup and behaviour: [release runbook, section 10](android-release.md#10-ci-release-path).

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
| `hc.sources` | Warns no source wrote in 30 days | No app writes into Health Connect | Enable sharing in the source apps the remedy names (the installed ones it knows), or in yours ([section 7](#7-make-your-source-apps-share-to-health-connect)). |
| `hc.data.<type>` | Fails: permission denied | The type's permission is not granted | Grant it in the permission prompt, or switch the type off. |
| `hc.data.<type>` | Warns: granted, no records, remedy names an app ("Open Oura and allow …") | An app on the phone can write that type (it wrote it before, or the built-in capability table says it can) but is not sharing it | Follow the remedy: Health Connect, then App permissions, then the named app, then Allowed to write, then the type; then Sync now ([section 7](#7-make-your-source-apps-share-to-health-connect)). Remember the 30-day history limit. |
| `hc.data.<type>` | Warns: granted, no records, "None of the apps on this phone write …" | No installed app known to write that type (for example HRV with only Samsung Health, which does not write it) | Install an app that records it, or, if you do not track it, tap **Open Sync settings** and switch the type off. |
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
| Upload answers 409 `RELEASE_VERSION_EXISTS` or `RELEASE_VERSION_NOT_NEWER` | The `versionCode` was already published, or is not above the current release | Bump the version, rebuild and publish again ([release runbook](android-release.md#13-troubleshooting)). |
| Upload answers 503 `storage_not_configured` | Object storage is not configured | Configure it at Admin, then Settings, then Storage ([release runbook](android-release.md#13-troubleshooting)). |
| The Doctor warns `android.releases` | Phones are paired but no release is current | Publish one ([release runbook](android-release.md)). |

### Notifications

The app shows the deployment's Web Push notifications (announcements, coach
nudges, anything the user enabled at Settings, then Notifications). They reach
the phone only when all of these hold:

1. **Web Push is configured.** Admin, then Settings, then Push shows an enabled
   key pair. Without it nothing is sent anywhere.
2. **Android allows notifications for the app.** On Android 13 and later the
   app asks once, on the first visit to its Health sync screen; the
   **Notifications** row there shows the status and offers **Allow**, or
   **Open settings** when the permission was denied for good. The phone
   self-test reports the same under `notifications.permission`.
3. **The web view subscribed from inside the app.** Open the app, then
   Settings, then Notifications, and turn notifications on. A subscription made
   inside the app is tagged `android_app`; one made earlier in a browser tab on
   the same profile is re-tagged when the app subscribes again.

**Test from the server.** Admin, then Settings, then Android app shows how many
Android app subscriptions exist (and for how many users) and has **Send test
notification**. The answer lists each of the user's Android app subscriptions
as `sent`, `failed` or `gone` (the push service no longer knows it; it was
removed and the app must subscribe again). Two answers mean nothing was sent:

| Reason | Meaning | Fix |
|---|---|---|
| `NO_ANDROID_SUBSCRIPTION` | The user has no subscription registered from inside the app | On the phone: open the app, Settings, Notifications, enable, then allow notifications for the app when Android asks. |
| `PUSH_NOT_CONFIGURED` | No active VAPID key pair | Configure Web Push at Admin, then Settings, then Push. |

`sent` but nothing appears on the phone: the app's notifications are off in
Android Settings, then Apps, then `<product>`, then Notifications (or one of its
channels is set to off); the phone's self-test check `notifications.channels`
reports this. Battery restrictions can also delay delivery.

**Broadcasts.** The broadcast composer has an **Android app** channel: Web Push
to Android app subscriptions only. **Push** already includes phones, so
selecting both sends each device one notification, not two. The audience
estimate shows how many Android app subscriptions the broadcast would reach.

## 11. Summary checklist

- [ ] A release published and current ([release runbook](android-release.md), which covers the keystore backup)
- [ ] APK installed from Settings, then Android app; server address entered
- [ ] Phone paired (device flow)
- [ ] Build trusted at `/admin/settings/android`; `assetlinks.json` lists it
- [ ] Health Connect permissions granted, including background
- [ ] Source apps share to Health Connect
- [ ] **Sync now** shows a run with status ok
- [ ] Self-test reports no failing check

## See also

- [Android release runbook](android-release.md) (keystore, versioning, publishing, rollback)
- [Health Connect sync spec](../specs/health-connect-sync.md)
- [Native companion architecture](../specs/native-companion-architecture.md) (why the app is a TWA plus a native module)
- [`evopathcli android` reference](../../apps/cli/README.md#building-and-publishing-the-android-app)
- [Renaming a fork](../RENAMING.md) (the app's package, label and deep link follow `identity.json`)
- [Personal access tokens](../personal-access-tokens.md) and [device authorization](../DEVICE-AUTH.md)
- [Doctor runbook](doctor.md) (`android.assetlinks`, `android.releases`)
