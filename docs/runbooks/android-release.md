# Runbook: Release a new Android APK

> **Audience:** operators · **Spec:** [health-connect-sync.md §2.12](../specs/health-connect-sync.md#212-apk-releases) · **Admin UI:** `/admin/settings/android` (section **Releases**) · **User UI:** `/settings/android-app` · **Permission:** `system_settings:write` (publish, make current, delete); `system_settings:read` (list)

Use this to ship a new version of the Android app to your users, by any route: the CLI, the terminal menu, a deploy, the admin page or CI. It also covers rolling back and every error the release path can raise. To install the app, pair a phone and trust a build, see the [Android app runbook](android-app.md).

**Names in this runbook.** The app's identity derives from `packages/shared/identity.json` ([RENAMING.md](../RENAMING.md)), so this runbook uses the same placeholders as the [Android app runbook](android-app.md): `<product>`, `<app slug>` and `com.<repo>.android`. `evopathcli` is the CLI's command name.

## 1. Overview

A release moves one APK through five stages. Every route below runs the same stages; they differ in who presses the button.

```
 apps/android/version.properties      versionName + versionCode (must rise)
            |
            v
   build + sign (Gradle, your release keystore)
            |      dist/android/<app slug>-android-<versionName>.apk  + .json
            v
   publish: POST /api/admin/android-app/releases   (system_settings:write, max 150 MB)
            |
            v
   object storage  android-releases/<releaseId>.apk
            |
            v
   current release  (one per deployment; its signing key is trusted automatically)
        |                         |
        v                         v
 users: Settings -> Android app   phones: update card, banner, Connected devices chip
 (signed 10-minute download link)  (learn on next app open; no push notification)
```

| Route | Use it when | Section |
|---|---|---|
| `evopathcli android release` | You have a checkout, a JDK and the keystore | [6](#6-release-from-the-command-line) |
| The terminal menu, **Android app** | You want status and confirmations on one screen | [7](#7-release-from-the-terminal-menu) |
| `deploy update --with-android` | You publish the app whenever you deploy the server | [8](#8-release-during-a-deploy) |
| Admin page upload | You already have a signed APK and no toolchain | [9](#9-release-from-the-web-admin-page) |
| The **Android** GitHub workflow | You want a rolling prerelease on GitHub | [10](#10-ci-release-path) |

The keystore, `version.properties` and the version rules ([section 5](#5-versioning-rules)) apply to every route.

## 2. Prerequisites

- **A JDK 17 or later** for the CLI routes. The CLI never installs it; `android doctor` prints the command for your OS.
- **The Android SDK.** Run `evopathcli android doctor --fix`. It installs the command-line tools, accepts the licences and installs platform-tools, `platforms;android-36` and `build-tools;36.0.0` into `~/.evopathcli/android-sdk` unless `ANDROID_HOME` or `ANDROID_SDK_ROOT` names one. You should see no red rows.
- **Run the CLI from inside the repository** (it walks up to the directory holding `apps/android`), or set `EVOPATHCLI_REPO_ROOT` to its root.
- **Object storage configured on the server.** The APK lives in object storage, never on local disk. Configure it at Admin, then Settings, then Storage ([storage runbook](storage-configuration.md)). Without it an upload answers 503 `storage_not_configured`.
- **An account with `system_settings:write`.** Only the Admin role holds it.
- **The deployment reachable over HTTPS** from your machine and from the phones.

`doctor` checks, in order: the `apps/android` checkout, whether that checkout is up to date with its upstream branch or `origin/main` (`repo.fresh`), the Gradle wrapper, `version.properties`, the JDK, the SDK and its parts, the release keystore and its SHA-256. It exits 6 when any check fails. `--json` prints the report on stdout.

**Build from the latest `main`.** An APK contains only what your checkout holds: built from a checkout behind `origin/main`, it leaves out the commits you have not pulled, and publishing it makes that the current release. `repo.fresh` runs `git fetch` (10-second timeout) and compares. It warns when you are behind, with `git pull` as the fix (`git checkout main && git pull` when you are on another branch without an upstream). It also warns when the fetch failed (it then compares with the last-known remote ref, which may be stale), on a detached HEAD, and outside a git clone. It never fails and never changes your files. `android build` makes the same check before Gradle runs and prints `⚠ Your checkout is N commit(s) behind origin/main — the APK will not include them. Run: git pull`. Pass `--require-up-to-date` to `android build` or `android release` to stop instead of warning; `release` checks it before bumping the version. The deploy step builds from the deployment's checkout, which the deploy has just updated, so there the check normally passes.

## 3. Log in the CLI

Publishing needs a stored login for the server you are publishing to.

1. Run:

   ```bash
   evopathcli login --server https://app.example.com
   ```

   Without `--server` it prompts, offering the stored URL as the default.
2. The CLI prints a code and the address `https://app.example.com/activate`, and opens your browser (`--no-browser` only prints it). Sign in as an Admin, check that the code matches and approve. `--device-name <name>` labels the machine on the Access Tokens page.
3. You should see `Logged in to https://app.example.com as <you>` with your roles and the path of the file holding the token.

What the login is:

- **Token.** A personal access token stored in `~/.evopathcli/config.json`, written with restricted permissions. It is never printed. It lasts `DEVICE_PAT_EXPIRY_DAYS` (default 90; see `infra/compose/.env.example`). Revoke it any time from the **Access Tokens** page.
- **Permission.** It carries your account's permissions. Releases need `system_settings:write`; an account without it can log in but cannot publish.
- **Inspect it.** `evopathcli config` shows the server, a masked token, its expiry and whether it came from the file or the environment. It never prints the token.
- **Headless.** `evopathcli login --server <url> --token <pat>` skips the device flow with a token you created on the Access Tokens page. It lands in your shell history; prefer the environment below.
- **Scripts and CI.** Skip `login` and set both `EVOPATHCLI_SERVER_URL` and `EVOPATHCLI_TOKEN`. The environment overrides the stored file. A stale exported `EVOPATHCLI_TOKEN` silently beats a fresh login; `evopathcli config` names the winning source.

Login states the release commands, the menu and the deploy step report:

| State | Meaning | Fix |
|---|---|---|
| Not logged in | No stored token and no environment pair | `evopathcli login --server <url>` |
| Expired | The stored expiry passed, or the server answered 401 (expired or revoked) | `evopathcli login --server <url>` again |
| Other server | The stored login is for a different URL than the target (a deploy, or `--server`) | `evopathcli login --server <target url>` |
| Lacks `system_settings:write` | Logged in, but not as an Admin | Log in as an Admin, or ask for the permission |

## 4. Signing keystore

Every update must be signed with the key that signed the first install. Android refuses an update signed by another key.

**Back it up before the first release.** The keystore and its passwords live in `~/.evopathcli/android/` (`release.jks` and `signing.json`, outside every checkout). Copy both to a password manager. A lost keystore means a new signing key, a new trust entry and uninstalling the app on every phone.

| Command | Use it |
|---|---|
| `evopathcli android keystore init [--alias a] [--dname dn]` | First time. Creates `release.jks` (RSA 4096, valid 100 years). The password comes from `ANDROID_KEYSTORE_PASSWORD`, a prompt (empty to generate one) or is generated. It refuses to replace an existing keystore. |
| `evopathcli android keystore import <file> [--alias a]` | You already have a keystore (including one used for earlier builds). Passwords come from `ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_PASSWORD` (the key password defaults to the store password) or a prompt, and are verified with `keytool` before anything is saved. |
| `evopathcli android keystore show` | Prints the path, alias and certificate SHA-256. Never prints passwords. |
| `evopathcli android keystore secrets` | Prints the four GitHub secrets, **including the passwords**, for [section 10](#10-ci-release-path). Run it on a trusted terminal and clear it afterwards. |

Use `import` when phones already run builds signed with an existing key. `init` after that would produce a different fingerprint and every phone would reject the update ([troubleshooting](#13-troubleshooting)).

Never commit the keystore or its passwords. `*.jks` and `*.keystore` are git-ignored.

## 5. Versioning rules

- **One source of truth.** `apps/android/version.properties` holds `versionName` (`x.y.z`) and `versionCode` (a whole number from 1 to 2,100,000,000). Local builds, the CLI, deploys and CI all read it.
- **`versionCode` must rise for every published APK.** Android refuses to install a lower or equal code over a higher one. Phones compare codes, never names.
- **The server enforces it.** An upload whose `(package, versionCode)` already exists is refused with 409 `RELEASE_VERSION_EXISTS`. An upload that would become current but does not exceed the current release's code is refused with 409 `RELEASE_VERSION_NOT_NEWER`, unless forced ([section 6](#6-release-from-the-command-line)).
- **Bump with the CLI:**

  ```bash
  evopathcli android version                  # show
  evopathcli android version --bump patch     # 0.1.0 (1) -> 0.1.1 (2); also minor, major
  evopathcli android version --set 1.0.0      # sets the name, code + 1
  evopathcli android version --code 40        # explicit code; must exceed the current one
  ```

  Every bump or set raises `versionCode` by one. A missing file is created at `0.1.0` / `1`.
- **Commit the file.** `android release` commits only `version.properties`, after the upload succeeded. Other routes leave the bump in your working tree.

## 6. Release from the command line

### 6.1 One shot

1. `git pull` on `main`, `evopathcli android doctor --fix`, then `evopathcli login --server https://app.example.com` ([sections 2 and 3](#2-prerequisites)). Doctor's `repo.fresh` row warns if the checkout is still behind. The release command checks the login and the keystore before it bumps anything.
2. Run:

   ```bash
   evopathcli android release --bump patch --notes "What changed"
   ```

   `--bump` is `patch` (default), `minor` or `major`. `--server-url <url>` bakes a default server address into the app (otherwise the app asks on first run). `--no-commit` skips the commit.
3. The command bumps `version.properties`, builds and signs the APK, uploads it as the current release and commits the version file as `chore(android): release <versionName> (<versionCode>)`. You should see `Published <version> (<code>) - now the current release`, the release id, the download page URL and the commit line. It writes `dist/android/<app slug>-android-<versionName>.apk` and its `.json` metadata.

If the build or the upload fails, nothing is committed, and the CLI says the version was bumped locally. Fix the cause, then continue with `android build` and `android publish` ([6.2](#62-step-by-step)). Running `release` again would bump a second time.

### 6.2 Step by step

```bash
evopathcli android version --bump patch
evopathcli android build [--server-url https://app.example.com]
evopathcli android publish --notes "What changed"
```

- `build` verifies the signature with `apksigner` against your keystore's fingerprint and refuses an APK signed by another key. `--debug` builds a debug-signed APK that is not publishable.
- `publish [apk]` defaults to the APK for the current `versionName`. It uploads the file and its `.json` to `POST /api/admin/android-app/releases`. It gives up after 15 minutes.
  - `--no-current` uploads without offering it to users.
  - `--force` makes it current even when its `versionCode` is not above the current release's.
- `evopathcli android releases` lists the server's releases (`*` marks the current one); `--json` prints JSON.

Making a release current also trusts its signing certificate for the TWA's full-screen mode (`/.well-known/assetlinks.json`), when the list has room (at most 10 trusted apps). No separate trust step is needed for releases you publish.

## 7. Release from the terminal menu

Run `evopathcli` with no arguments in a real terminal and choose **Android app (build, publish, releases)**. It calls the same functions as the commands above.

**Status panel.**

| Row | Shows |
|---|---|
| Local | `versionName (code N)` from `version.properties`, or "No apps/android checkout here" |
| Keystore | The certificate SHA-256, or the command to create one |
| Login | The email and server, and whether the account can publish; also expired, logged out or logged in to another server |
| Server | The current release, or "No release published yet" |
| Newer | Whether the local `versionCode` is above the server's |

**Actions.** An action that cannot run is labelled `unavailable`; selecting it explains why.

| Action | Needs | Does |
|---|---|---|
| Run doctor | Nothing | The `android doctor` checks; `r` re-checks. Install the SDK from a shell with `--fix`. |
| Bump version | A checkout | Choose patch, minor or major (each row previews `old -> new`). Writes `version.properties`; commits nothing. |
| Build | A checkout, the keystore | Streams Gradle output, then the APK path, size and the `apksigner` result. Bakes in the server you are logged in to. |
| Publish | A checkout, a login that can publish | Asks for optional notes, then confirms, then uploads the already-built APK for the current version with a percent progress line. |
| Release | A checkout, the keystore, a login that can publish | Choose the bump, add notes, then one confirmation for bump, build, publish and commit. |
| Releases | A login that can publish | Lists releases; choosing one offers **make current**, with a rollback warning when its code is lower. |
| Log in | Shown when the login is missing, expired, for another server or lacks the permission | Opens the login screen and returns. |

**Keys.** `up`/`down` move, `enter` selects, `r` refreshes the status, `esc` goes back.

**Confirmations.** Every remote action asks first, names the version, code and **server**, and selects **No** by default. Publish warns when the server's current release is not older than yours. Make current warns when it moves to a lower code ([section 12](#12-roll-back)).

**While a task runs**, `esc` is ignored because a build cannot be cancelled from the screen; `ctrl-c` quits the whole app.

## 8. Release during a deploy

Publish the app in the same command that deploys the server:

```bash
evopathcli deploy update --with-android
evopathcli deploy update --with-android --android-bump patch --android-notes "What changed"
```

`deploy install` takes the same flags. `--android-bump` (`patch`, `minor`, `major`) and `--android-notes` need `--with-android`; a typo is rejected before the deploy starts.

After the deploy is healthy, the step takes the deployment's public domain as the server URL, picks a checkout, compares its `versionCode` with the server's current release and, when the checkout's is higher, runs the doctor, builds with that URL baked in and publishes as current. With `--android-bump` the bump is committed only after the upload succeeded.

**Which checkout is built.** Without `--android-bump`, the deployment's own checkout (`<deploy root>/repo`) when it holds `apps/android`. The deploy has just moved it to the revision now being served, so the APK matches the web app it wraps. Otherwise the checkout you run the CLI in (or `EVOPATHCLI_REPO_ROOT`). With `--android-bump`, your own checkout comes first, and the bump is refused in the deployment's checkout (see the VPS caveat). The summary names the checkout under the `Android APK` line: `built from the deployment's checkout (<path>)`, or `checkout: <which> (<path>)` when the step skipped.

**It never fails the deploy.** Every outcome is a line in the deploy summary, and the deploy's exit code is decided before the step runs. It never prompts, so it is safe with `--non-interactive` and from cron. `--json` adds an `android` field with the outcome.

| Outcome | Summary line | Cause | Fix shown |
|---|---|---|---|
| Published | `Android APK  published <version> (code N) to <url> as the current release` | Local code above the server's | None |
| Skipped | `skipped: not logged in to <url>` | No stored login | `evopathcli login --server <url>` |
| Skipped | `skipped: the stored login for <url> has expired` | Expired login | The same login command |
| Skipped | `skipped: logged in to <other>, not <url>` | Login is for another server | The same login command |
| Skipped | `skipped: <email> lacks system_settings:write on <url>` | Not an Admin | Ask for the permission, or log in as an Admin |
| Skipped | `skipped: ... already has <release>; local is <version>` | Local code is not above the server's | `--android-bump patch` |
| Skipped | `skipped: the Android toolchain is not ready (...)` | Doctor has a failing check | The check's fix, or `evopathcli android doctor --fix` |
| Skipped | `skipped: no apps/android checkout found` | Not run from a checkout and the deployment has none | `cd <your checkout> && evopathcli android release` |
| Skipped | `skipped: the deployment has no public domain` | No URL to publish to | `evopathcli login --server <url>` then `android release` |
| Skipped | `skipped: --android-bump is not applied in the deployment's own checkout` | See the VPS caveat | Bump and commit in your own checkout |
| Skipped | `skipped: could not read the current release` | The server did not answer | `evopathcli android releases` |
| Failed | `failed: build failed ...` or `upload failed ...`, then `(the deploy itself succeeded)` | Gradle or the upload failed | `evopathcli android build ...` then `android publish`, as printed |

**VPS caveat.** Most VPS hosts have no JDK or Android SDK, so the step skips there. Run `evopathcli android doctor --fix` on the host first, or publish from your workstation with `evopathcli android release`. It refuses `--android-bump` in the deployment's checkout, because an uncommitted `version.properties` there would make the next `deploy update` refuse a dirty tree. The login must exist on the machine that runs the deploy. See [deploy to a VPS](deploy-to-vps.md).

### 8.1 From the terminal menu

The terminal menu's **Deploy → Update** and **Deploy → Install** screens ask on a step of their own, **Android app**, after the options step and before **Confirm**. It offers two choices:

- **No — web app only**
- **Yes — also build and publish the Android APK (if its version is newer than the published one)**, which adds `--with-android` to the run

Above the choices the step shows:

| Row | What it shows |
|---|---|
| checkout | The version in the deployment's checkout (`apps/android/version.properties`). The update may bring a newer one. |
| published | The server's current release, read with the stored login for `https://<domain>`. Without a login it shows `not logged in to https://<domain>` and the `evopathcli login --server https://<domain>` command. No answer within a few seconds reads as unreachable. |
| preflight | `android doctor` against the checkout the build will use: a pass/fail summary, then each failed or warning check with its fix. It runs in the background; you can choose before it finishes. |

Esc goes back to the options. The **Confirm** screen shows an **Android app** row: `build and publish if newer` or `not included`. The answer is remembered per deployment (`~/.evopathcli/deploy-preferences.json`) and selected the next time; a deployment whose checkout has no `apps/android` opens on **No**. The step has no bump or notes; use the Android screen ([section 7](#7-release-from-the-terminal-menu)) for those.

## 9. Release from the web admin page

Use this when you hold a signed APK but not the toolchain, for example one built by CI or a colleague.

1. Sign in as an Admin and open Admin, then Settings, then **Android app** (`/admin/settings/android`). Scroll to **Releases**.
2. Under **Upload a release**, choose the APK. Also choose the `<app slug>-android-<versionName>.json` the CLI wrote next to it, and the version name, version code, package name and signing certificate SHA-256 fill in. Without the JSON, type them (read the fingerprint with `evopathcli android keystore show`).
3. Add release notes (optional, up to 2,000 characters). Leave **Make it the current release** on to offer it to users now.
4. Choose **Upload**. A progress bar shows while the file streams. The APK is limited to 150 MB.
5. You should see the release in the list, marked **Current**.

Messages:

- **"This build is not newer than the current release"** with a **Force** button: the code does not exceed the current release's. Bump and rebuild, or choose Force to upload it anyway.
- **"A release with this version code already exists"**: bump the code and rebuild.

The same list makes another release current (**Make ... current**) and deletes one that is not current. See [section 12](#12-roll-back) for rollback.

## 10. CI release path

The **Android** workflow (`.github/workflows/android.yml`) builds and signs in GitHub Actions. It publishes to a rolling GitHub prerelease, **not** to your server. To host the CI build on the server, download it and upload it as in [section 9](#9-release-from-the-web-admin-page).

1. Print the four secret values with `evopathcli android keystore secrets`.
2. In the repository, open Settings, then Secrets and variables, then Actions, and add four repository secrets:

   | Secret | Value |
   |---|---|
   | `ANDROID_KEYSTORE_BASE64` | The keystore, base64 on one line |
   | `ANDROID_KEYSTORE_PASSWORD` | The keystore password |
   | `ANDROID_KEY_ALIAS` | The key alias |
   | `ANDROID_KEY_PASSWORD` | The key password |

   Without the CLI, encode the file with `base64 -w0 release.jks` (`base64 -i release.jks` on macOS).
3. Bump and commit the version (`evopathcli android version --bump patch`, then commit `apps/android/version.properties`). The workflow never bumps; it builds the version in the file.
4. Push to `main` with a change under `apps/android/**`, `packages/shared/identity.json` or the workflow file, or run **Android** from the Actions tab (`workflow_dispatch`, on `main`).
5. The `test` job runs the unit tests and builds the debug APK. The `release` job then builds and signs the release APK, verifies it with `apksigner`, moves the tag `android-latest` to the commit and replaces the asset `<app slug>-android.apk` on the prerelease **<product> Android (latest)**.
6. You should see it at `https://github.com/<owner>/<repo>/releases/tag/android-latest`. The web app links to it only when the server hosts no release.

Without all four secrets the `release` job prints the warning "Android release skipped" and publishes nothing. The debug APK stays available as the `<app slug>-android-debug` artifact of the `test` job. The CI build leaves the server address empty, so the app asks for it on first run.

## 11. Verify

1. **Server.** Admin, then Settings, then **Android app**, section **Releases**: the new version is marked **Current**. From a shell, `evopathcli android releases` shows the same with `*`. Check the trust entry: `curl -s https://app.example.com/.well-known/assetlinks.json` lists `com.<repo>.android` with your fingerprint.
2. **Users.** Sign in on a phone and open Settings, then **Android app** (`/settings/android-app`). It shows the version, size, notes and SHA-256, whether the installed app is up to date, and **Download APK**. The button fetches a signed link valid for 10 minutes.
3. **Phones.** An installed, paired app learns of the update on its next launch (every launch asks the server, at most once per 5 minutes) or, while it stays closed, from its background sync (at most every 6 hours). Users see:
   - one notification per version, "<product> <version> is available" (channel **App updates**), when notifications are allowed; tapping it opens the **Update available** card;
   - an **Update available** card on the app's **Health sync** screen, with **Download** and **What's new**;
   - the `app.update` check in **Health sync**, then **Diagnostics**: `pass` when up to date, `warn` with the new version when an update exists, `skip` when not paired or no release exists;
   - inside the app, a banner on the web app whose **Download** fetches the APK in one tap (dismissed per version);
   - on the web, Settings, then **Connected devices**: an **Update available** chip on each phone that runs an older build.
4. Install the update from the same page. It keeps the pairing because the signing key is the same.

## 12. Roll back

Making an earlier release current is allowed, but it does not undo anything on phones that already updated.

**Android refuses downgrades.** A phone that runs `versionCode` 7 never installs `versionCode` 6 over it. After a rollback only **new installs** and phones still below the rolled-back code get the older APK. Phones already on the bad build keep it, and are not offered the older one.

Roll back:

- **Terminal menu.** Android app, then **Releases**, choose the release, confirm. A lower code shows the warning and the button **Yes, roll back**.
- **CLI.** `evopathcli android releases` for the id, then `evopathcli android releases current <id>`.
- **Admin page.** Admin, then Settings, then Android app, then **Releases**, **Make ... current**. A lower code asks "Roll back to ...?" first.

**The real fix is a new, higher build.** Revert or fix the code, then `evopathcli android release --bump patch`. The new code exceeds the bad one, so every phone is offered it. Delete the bad release afterwards from the admin page; the current release cannot be deleted (409 `RELEASE_IS_CURRENT`).

## 13. Troubleshooting

| Symptom or code | Cause | Fix |
|---|---|---|
| `Not logged in. Run evopathcli login first, or set ...` | No stored login | [Section 3](#3-log-in-the-cli) |
| `EVOPATHCLI_TOKEN is set but EVOPATHCLI_SERVER_URL is not` (or the reverse) | Half an environment pair and nothing stored to cover it | Set both, or unset them and run `evopathcli login` |
| Request answers 401, exit code 5; menu shows "Expired" | The token expired or was revoked | `evopathcli login --server <url>` again; check `evopathcli config` for a stale environment token |
| Menu shows "Logged in to X, not Y"; deploy skips "logged in to X" | The stored login is for another server | `evopathcli login --server <target url>` |
| 403, or "lacks system_settings:write" | The account is not an Admin | Log in as an Admin, or ask for the permission |
| 503 with `storage_not_configured` | Object storage is not configured | Configure it at Admin, then Settings, then Storage ([storage runbook](storage-configuration.md)); upload again |
| 409 `RELEASE_VERSION_EXISTS` | That `versionCode` is already published for the package | `evopathcli android version --bump patch`, rebuild, publish |
| 409 `RELEASE_VERSION_NOT_NEWER` | Its code does not exceed the current release's | Bump and rebuild. Or `--force` (CLI) or **Force** (admin page) to override, or `--no-current` to upload without offering it. Android still refuses to install a lower code over a higher one. |
| 400 `RELEASE_NOT_AN_APK`, `RELEASE_INVALID_UPLOAD` | The file is not a ZIP/APK, or a field is malformed | Upload the `.apk` from `dist/android/`, not the `.json` or a renamed file; check the fields |
| 413 `RELEASE_TOO_LARGE` | The APK is over 150 MB | Shrink the build |
| 413 from the edge, no `RELEASE_TOO_LARGE` code (an HTML page or a bare 413) | A proxy in front of the app caps the request body below the APK size | The bundled nginx allows 160 MB on the upload path. Raise the limit on any extra proxy in front; the VPS vhost the deploy renders is never lower than `MAX_FILE_SIZE` ([spec §2.12](../specs/health-connect-sync.md#212-apk-releases)) |
| Upload times out (`Timed out after 900000ms`, or a 504 at a proxy) | A slow link: the CLI waits 15 minutes; the bundled nginx 10 minutes | Retry on a faster link. For a proxy, raise its send and read timeouts for `/api/admin/android-app/releases` |
| Phone says "App not installed" | The APK is signed with a different key than the installed app, or the phone has a higher `versionCode` | Compare fingerprints: `evopathcli android keystore show` against the phone's `app.version` check and the release's signing SHA-256 on the admin page. Same key: the phone has a higher code, so publish a higher build. Different key: uninstall the app (re-pair afterwards), or rebuild with the original key via `keystore import` |
| `apksigner not found ... skipping signature verification` (or "signature NOT verified" in the menu) | Build-tools are missing | `evopathcli android doctor --fix` |
| `The APK is signed by <A>, not by the configured keystore (<B>)` | The build used another key | Check `evopathcli android keystore show`; rebuild |
| `No release keystore is configured` | None created or imported | `evopathcli android keystore init` or `import <file>` |
| `Could not find apps/android in this directory or any parent` | Not run inside the repository | `cd` into it, or set `EVOPATHCLI_REPO_ROOT` |
| `doctor` shows red rows, exit 6 | A prerequisite is missing | JDK: install it with the printed command. SDK, platform, build-tools, licences: `evopathcli android doctor --fix`. Gradle wrapper: restore `apps/android/gradlew` from git. `version.properties`: fix the file. Keystore: `keystore init` or `import`. |
| `⚠ Your checkout is N commit(s) behind origin/main` (build), or doctor warns on `repo.fresh` | Commits on the remote are not in your checkout, so the APK would leave them out | `git pull` (or `git checkout main && git pull`), then build. With `--require-up-to-date` the build or release stops here instead of warning |
| doctor's `repo.fresh` says `could not fetch` | Offline, or git has no credentials for the remote | Fix the network or credentials and re-run; until then the comparison uses the last-known remote ref |
| `release` failed after "Version bumped" | Build or publish failed; the bump is uncommitted | Fix the cause, then `android build` and `android publish`; do not run `release` again (it bumps twice). Or revert `apps/android/version.properties` |
| Release is current but the TWA shows an address bar | The trust list was full, so the key was not added | Remove stale entries at Admin, then Settings, then Android app, trust the new one ([Android app runbook](android-app.md#63-trust-the-build-on-the-server)) |
| Phones are paired but the Doctor warns `android.releases` | No release is current | Make one current ([section 12](#12-roll-back)) or publish |
| The deploy summary says `Android APK skipped` | Expected when anything is missing | Read the `fix:` line; see [section 8](#8-release-during-a-deploy) |

## 14. Summary checklist

- [ ] Object storage configured on the server
- [ ] `evopathcli android doctor --fix` shows no red rows
- [ ] Keystore created or imported, **and backed up** with its passwords
- [ ] `evopathcli login --server <url>` as an Admin (`evopathcli config` shows it valid)
- [ ] `versionCode` bumped (`android version --bump patch`)
- [ ] Release published (`android release`, the menu, `deploy update --with-android`, or an admin upload)
- [ ] Admin, then Android app, then Releases shows it **Current**
- [ ] `assetlinks.json` lists the package and fingerprint
- [ ] Settings, then Android app offers the download; a phone shows the update card
- [ ] `version.properties` committed

## See also

- [Android app runbook](android-app.md): install, trust, pair, source apps and phone diagnostics
- [Native companion architecture](../specs/native-companion-architecture.md): why the app is a TWA plus a native module, and what needs a new APK
- [Health Connect sync spec §2.12](../specs/health-connect-sync.md#212-apk-releases): the release model, rules and routes
- [`evopathcli android` reference](../../apps/cli/README.md#building-and-publishing-the-android-app)
- [Deploy to a VPS](deploy-to-vps.md) and [storage configuration](storage-configuration.md)
- [Doctor runbook](doctor.md) (`android.releases`, `android.assetlinks`)
- [Personal access tokens](../personal-access-tokens.md) and [device authorization](../DEVICE-AUTH.md)
