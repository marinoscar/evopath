# Notifications, Browser Notifications and Web Push

> **Status:** shipped · **Code:** `apps/api/src/notifications/`, `apps/web/src/sw.ts`, `apps/web/pwa/`, `apps/web/src/contexts/NotificationContext.tsx`, `apps/web/src/services/{browserNotifications,pushSubscription}.ts`, `apps/web/src/hooks/{useNotificationCapability,usePushSubscriptionSync}.ts` · **API:** `/api/notifications/*`, `/api/admin/push-config` (see `/api/docs`) · **Admin UI:** `/admin/settings/notifications`, `/admin/settings/push` · **User UI:** `/settings/notifications` · **Runbook:** [VAPID keys](../runbooks/vapid-keys.md) · **Recipe:** [notifications module README](../../apps/api/src/notifications/README.md)

The notification framework raises events from a single registry and delivers
them over three channels: email, an in-app inbox with OS toasts, and Web Push.
Users choose per event and channel. An administrator can mute browser toasts
deployment-wide. The web app is an installable PWA whose service worker shows
notifications and receives pushes while the app is closed. Web Push runs behind
a VAPID key pair that an administrator generates, rotates and removes at
runtime.

## 1. Purpose

### What it gives a fork

- One registry of events (`notification-events.ts`) feeding the dispatcher,
  the preferences matrix and `GET /api/notifications/events`.
- A durable per-user inbox with a live SSE stream, unread count and a bell.
- OS notifications on desktop, Android and installed iOS web apps, and Web
  Push with every tab closed.
- Every delivery attempt audited in `notification_deliveries`.
- Recipients addressed as a user, an address, or "holders of permission X".

### Three platform facts that shape the design

| Fact | Consequence |
|---|---|
| `new Notification(...)` throws on Android Chrome. | Notifications go through a service worker's `registration.showNotification()`. Without a service worker, Android gets nothing. |
| iOS/iPadOS Safari grants the Notifications API only to a web app added to the Home Screen, which needs a manifest with `display: 'standalone'`. | The app ships a web app manifest. Without it, iOS gets nothing. |
| The SSE stream is liveness only: no replay, no `Last-Event-ID`, per-process fan-out. A closed tab receives nothing. | Web Push is the only way to reach a phone with the app closed. |

### What it is not

- Not a campaign tool; the one all-users send is
  [notification-broadcasts.md](notification-broadcasts.md).
- No retry of a failed channel send, and no digest of repeated events (§6).

## 2. How it works

### 2.1 The event registry

`NOTIFICATION_EVENTS` in `apps/api/src/notifications/notification-events.ts`
declares every event. Each entry has:

| Field | Meaning |
|---|---|
| `key` | Stable dotted `<area>.<event>`. Stored preferences are keyed by it, so renaming is a data migration. |
| `label`, `description` | User-facing copy on the preferences page. |
| `channels` | Subset of `NOTIFICATION_CHANNELS` (`email`, `browser`, `push`) the event can be delivered over. |
| `defaultEnabled` | What a user with no stored preference gets. Absent preference means "use the default"; no preference rows are created. |
| `mandatory` | `true` means the user cannot mute it. All-or-nothing: stored preferences are ignored entirely. A mandatory event must be `defaultEnabled: true`. |

Registered events:

| Key | Channels | Mandatory |
|---|---|---|
| `user.welcome` | email | no |
| `allowlist.invitation` | email | no |
| `security.role_changed` | email, browser | yes |
| `admin.broadcast` | email, browser, push | no |
| `admin.broadcast_critical` | email, browser, push | yes |
| `jobs.job_failed` | email | no |
| `nodes.node_offline` | email, browser | no |
| `db_backup.backup_failed` | email, browser | no |
| `db_backup.restore_completed` | email, browser | yes |

The two broadcast events are specified in
[notification-broadcasts.md](notification-broadcasts.md). The four
operational events are in §2.9.

### 2.2 Dispatch and the delivery model

Every entry point on `NotificationsService` converges on one private
`dispatch()`:

| Method | Recipient | Awaited? |
|---|---|---|
| `notify(eventKey, userId, data, options?)` | A user account | No. Detached. |
| `notifyAddress(eventKey, email, data, options?)` | An address; resolved to an account when one exists | No |
| `notifyNow(eventKey, userId, data, options?)` | A user account; for job handlers | Yes. Resolves `NotifyNowResult` (`{ rateLimited, retryAfterMs }`). |
| `notifyPermissionHolders(eventKey, permission, data, options?)` | Every active user holding a permission | No |
| `notifyPermissionHoldersNow(...)` | Same | Yes |

`dispatch()` resolves channels in one place, `resolveChannels(event,
preferences, policy)`:

1. Start from the event's declared `channels`.
2. Narrow by admin policy (`policyChannels`, §2.4).
3. Narrow by the recipient's stored preferences (`isChannelEnabled`), unless
   the event is mandatory.
4. Optionally intersect with `NotifyOptions.channels` (narrowing only; used by
   broadcasts).

Each surviving channel's `NotificationChannelSender` is called. Before each
attempt the dispatcher writes a `notification_deliveries` row with status
`queued`, then updates it to `sent` or `failed` (with `error` and
`providerMessageId`). There is no retry; a process killed mid-send leaves the
row at `queued`, which is the evidence. A channel failure is recorded, never
thrown to the caller. Every entry point is contained (`runContained`) and never
rejects.

`notify()` schedules the dispatch on a microtask and returns. On shutdown the
service drains in-flight detached dispatches for up to 5 seconds
(`SHUTDOWN_DRAIN_MS`). Call it after the triggering write has committed and
outside any `$transaction`.

### 2.3 The three channels

| Channel | Sender | What it does |
|---|---|---|
| `email` | `channels/email-notification.channel.ts` | Renders the template mapped in `EVENT_EMAIL_TEMPLATES` and sends it over the configured transport (SMTP settings at `/admin/settings/email`, or SES). A missing mapping is a recorded failure. |
| `browser` | `channels/browser-notification.channel.ts` | Writes a `notifications` row (the inbox), then publishes it to the user's SSE stream with a server-computed `toast` flag and a `pushed` flag (§2.12). Titles and bodies are truncated (`MAX_TITLE_LENGTH`, `MAX_BODY_LENGTH`); `link` goes through `sanitizeLink` (root-relative only). |
| `push` | `channels/push-notification.channel.ts` | Writes its own `notifications` row, then sends an encrypted Web Push message to each of the user's `push_subscriptions` (§2.7). |

`EVENT_BROWSER_TEMPLATES` maps an event to `{ title, body, link? }`. The push
channel reads the same map; without an entry the registry's `label` and
`description` are used.

The push channel writes its own row rather than sharing the browser channel's.
Channels are independently pluggable, and no event today declares both
`browser` and `push` except the broadcasts, so a shared id would couple two
senders for no current benefit. An event declaring both produces two rows.

### 2.4 Inbox row versus OS toast, and the admin kill switch

The browser channel is two things:

1. A row in `notifications`. This is the delivery.
2. An OS toast raised by the page or the service worker. This is decoration.

The deployment-wide policy is the `notifications` system-settings namespace:
`{ browserEnabled: boolean, disabledEvents: string[] }`
(`systemNotificationsSchema`). Default `{ browserEnabled: true, disabledEvents:
[] }`. `disabledEvents` is a suppression list of event keys; unknown keys are
stored and never match. `notification-policy.ts` holds two pure functions:

| Function | Decides | Mandatory events |
|---|---|---|
| `policyChannels(event, policy)` | Whether the dispatcher calls the `browser` channel at all. A non-mandatory event loses `browser` when the switch is off or the event is in `disabledEvents`. | Exempt. All declared channels stay, so the inbox row is always written. |
| `isBrowserToastAllowed(eventKey, policy)` | The `toast` flag on the SSE frame. | Not exempt. A mandatory event gets its row with `toast: false`. |

`email` has no policy gate. `push` is not gated by this policy; it is gated by
whether a VAPID key pair is active (§2.7).

The `toast` flag is computed server-side, at publish time, per frame. A
long-lived tab with a stale config cannot re-enable a toast the administrator
muted. The same `policyChannels` result feeds `channels` on
`GET /api/notifications/events`, so the preferences matrix never offers a
channel the dispatcher would refuse. That response also carries
`declaredChannels`, the registry's unfiltered list: the admin policy page
reads it instead of `channels`, so an event an administrator has suppressed
(and whose `channels` therefore drops `browser`) stays listed with its toggle
still reachable, rather than vanishing from the page that is the only way to
re-enable it.

The policy reader (`notification-policy.service.ts`) never throws and fails
open to the default: a database fault costs at most an unwanted toast, never a
silenced mandatory event.

### 2.5 How a non-admin learns the policy

The admin card sits behind `system_settings:read`, which Viewer and
Contributor do not hold. Every user still needs to know whether asking the
browser for permission is worthwhile. `GET /api/notifications/config` is
readable by any authenticated user (`@Auth()`, no permission) and returns:

```json
{ "browserEnabled": true, "pushEnabled": false, "vapidPublicKey": null }
```

- `browserEnabled`: the kill switch. A client must not prompt for OS
  permission while it is `false`; a denial cannot be re-prompted.
- `pushEnabled`: whether a VAPID key pair is active right now.
- `vapidPublicKey`: the public key for `pushManager.subscribe()` when
  `pushEnabled` is true.

Per-event suppression is not in this response; it travels as `toast` on each
SSE frame.

### 2.6 The 8-state capability model

`useNotificationCapability.ts` resolves the device's capability. The order is
the behaviour, because the conditions overlap (an iPad in a Safari tab on HTTP
satisfies three):

```
resolveNotificationCapability(inputs):
  1. adminDisabled                         -> 'admin-disabled'
  2. !isSecureContext                      -> 'insecure-context'
  3. !hasNotification && !hasServiceWorker -> 'unsupported'
  4. isIos && !isStandalone                -> 'ios-needs-install'
  5-8. by permission:
     denied                        -> 'denied'
     default                       -> 'default'          (prompt offered)
     granted, no SW registration   -> 'sw-unavailable'   (degraded, control stays enabled)
     granted, SW registration      -> 'granted'
```

- `adminDisabled` comes from `GET /api/notifications/config`'s
  `browserEnabled` (`useNotificationConfig`). It outranks everything because
  no user remedy exists.
- `sw-unavailable` is decided only after permission is `granted`. If it
  preempted `default`, a user whose worker failed to register could never reach
  the permission prompt, which renders only in the `default` state.
- `ios-needs-install` renders `AddToHomeScreenPanel.tsx` on the settings page.

### 2.7 Web Push

**VAPID configuration.** Stored like SMTP: non-secret fields in a settings row,
the secret in the encrypted credential store.

- `system_settings` key `webPush`: `{ enabled, publicKey, subject }`. All
  public; the page shows them in full.
- One `Credential` row at `(purpose: 'push_vapid', name: 'default')` holding
  only the private key. No endpoint returns it; the admin view carries a masked
  `privateKeyStatus` (`configured`, `hint`, `updatedAt`, `updatedByUserId`).

`PushConfigService.resolveActiveVapidConfig()` is the single answer to "which
key pair is active", used by both `PushSubscriptionService` and the push
channel:

| Case | Result |
|---|---|
| No `webPush` row | Fall back to `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` env vars, if set. |
| Row `enabled: true`, public key and credential present | The database wins, even over set env vars. |
| Row `enabled: false` | Push off. No env fallback, so "disable" really disables. |
| Row `enabled: true`, credential missing | Treated as disabled and logged loudly. Never silently reverts to env. |

A fresh deployment has neither, so push ships disabled.

**Admin actions** (`/admin/settings/push`, `PushConfigPage.tsx`):

- **Generate**: first-time key pair; sets `enabled: true`. 409 if already
  configured. Writes the credential first, then the row.
- **Enable/disable, subject** (`PUT`): never manufactures keys; 409 when
  enabling with no key pair. `If-Match` version check.
- **Rotate**: replaces the key pair; `enabled` unchanged. Body
  `{ "confirmation": "ROTATE" }`. 400 if nothing is configured.
- **Remove**: deletes the credential, then the row. Body
  `{ "confirmation": "REMOVE" }`. With the row gone, env vars (if any) apply
  again. Deleting the credential first means a partial failure lands in the
  "credential missing" case (disabled), never on stale env keys.

The two confirmation words differ so a body copied from one route is rejected
by the other. `PushConfigConfirmDialog` clears the typed text whenever it opens
or its action changes. Rotate and remove both break every existing
subscription: a `PushSubscription` is bound to the key it was created under.

**Subscriptions.** `push_subscriptions` rows (`endpoint` unique, `p256dh`,
`auth`, `expirationTime`, `userAgent`, `failureCount`, `lastSuccessAt`).
`POST /api/notifications/push/subscriptions` upserts by `endpoint` and answers
409 while no key pair is active. Deleting a user cascades.

**Sending.** The push channel is always registered, like `email`: an
unconfigured deployment produces an honest `failed` delivery row an
administrator can fix, rather than a silently absent channel. Per send:

- Fan-out is `Promise.allSettled`; one dead endpoint does not stop the others.
- 404/410 from the push service deletes the subscription immediately.
- Any other failure (429, 5xx, network) increments `failureCount`; the row is
  pruned at `MAX_PUSH_FAILURE_COUNT` (5).
- A blank subject falls back to `mailto:admin@example.com` with a warning; it
  never fails the send.

**Testing and diagnostics.** `POST /api/admin/push-config/test` (`push:write`)
sends a real, signed test push to the caller's own subscriptions only, never
anyone else's. `push-test.service.ts` (`PushTestService`) builds the answer:

- Config integrity: source (`admin`, `env` or `none`), whether the public and
  private keys form a pair, whether the subject is valid.
- Whether the browser's subscription key matches the server key (the request
  may carry this browser's `endpoint` and `applicationServerKey`).
- Per-subscription push-service results: status code, response body, duration.
- Push-event policy and preference state, plus plain-English `hints`.

The route always answers `200`; a failed send is the diagnostic. A 404/410
prunes that subscription, as a real delivery does. No `notifications` or
`notification_deliveries` row is written, and the audit action is
`push_config:test`. The private key, `p256dh`/`auth` and full endpoints never
appear in the response.

It is a bounded synchronous request, not a queue job: it touches only the
caller's own handful of devices, sends in parallel under a 10 s per-send
timeout, and the admin needs the result inline. Nothing outlives the request.

**Service worker.** A payload with `test: true` is always shown, even with a
focused tab, and every window client gets a `push-test-received` message so
the page can confirm end-to-end delivery. Clicking it navigates without
marking a notification read. A real (non-test) payload is also always shown as
an OS notification, focused tab or not. The page's SSE handler raises no OS
toast for a focused tab (§2.12), so this is the only visible alert a focused
user gets, not a duplicate. A backgrounded but still open tab skips its own
SSE toast when the push will show it (§2.12).

**Icon attribution.** Android attributes a notification to the app that posts
it. From a browser tab that is the browser (for example Chrome), which a site
cannot override. The payload `icon` still appears as the large image and the
`badge` is the status-bar glyph; the badge must be a white and transparent
silhouette, or Android draws a blank square. An installed PWA (a WebAPK) is
attributed to the app with its own icon; "Add to Home screen" as a plain
shortcut is not. `apps/web/pwa/manifest.ts` already meets the installability
requirements. The diagnostics report's `isStandalone: false` marks a browser
tab.

**UI.** The **Test & diagnostics** section on `/admin/settings/push`
(`PushTestPanel.tsx`, `services/pushDiagnostics.ts`): permission check and
request, browser checklist, stepwise test with a step log and device receipt
(waits 20 s for the ack), local notification test, and copy diagnostics.

### 2.8 Client subscription flow

`apps/web/src/services/pushSubscription.ts` is the one module every caller
uses. Nothing in it throws; failures are logged and swallowed.

| Export | Role |
|---|---|
| `requestPermissionAndSyncPush(config)` | Asks for permission; on `granted` with push enabled, starts a sync. Behind the auto-prompt, the banner button and the settings-page button. |
| `syncPushSubscription(vapidPublicKey)` | Boot-time subscribe-and-sync. De-duplicated through one in-flight promise. |
| `removePushSubscription()` | Logout cleanup. |
| `claimAutoPermissionPrompt()` | Returns `true` once per page load. |

**Automatic prompt.** `usePushSubscriptionSync.ts` (called once, in
`Layout.tsx`) requests permission on app load when the capability is `default`
and `config.pushEnabled` is true. It is a deliberate product choice: a
denial is permanent, but push matters enough here to spend the shot. Firefox
and Safari ignore a gestureless request, and Chrome may demote it to a quiet
address-bar icon, so the gesture-driven paths remain.
`useBrowserNotificationPermission.ts` only observes permission; it re-reads on
the Permissions API `change` event, `visibilitychange`, and the same-page
`NOTIFICATION_PERMISSION_CHANGED_EVENT`.

**Boot-time sync.** Runs on every boot and whenever permission becomes
`granted`; never prompts itself:

1. Await `navigator.serviceWorker.ready`, raced against a 10-second timeout
   (`SERVICE_WORKER_READY_TIMEOUT_MS`), because `ready` never settles without a
   worker.
2. Read `pushManager.getSubscription()`. If its
   `options.applicationServerKey` definitely differs from the current
   `vapidPublicKey` (a rotation), `unsubscribe()` it. A browser that does not
   expose the key counts as matching, to avoid minting a new endpoint every
   boot.
3. If no subscription remains, `pushManager.subscribe({ userVisibleOnly: true,
   applicationServerKey })`.
4. `POST` `subscription.toJSON()` to `/api/notifications/push/subscriptions`.
   Idempotent (upsert by endpoint), so running it every boot makes the
   subscription self-healing and doubles as rotation recovery for any browser
   whose permission is still `granted`.

**Banner.** `NotificationPermissionBanner`
(`apps/web/src/components/notifications/`) mounts under `MaintenanceBanner` in
`Layout`. It shows only when the deployment offers push or browser
notifications, the capability is `default`, `denied` or `ios-needs-install`,
the route is not `/settings/notifications`, and that state was not dismissed
this session. Copy per state: an **Enable notifications** button (`default`);
instructions for the browser's site settings (`denied`); an Add to Home Screen
hint (`ios-needs-install`). Dismissal is stored per state in
`sessionStorage`, so a changed state shows again.

**Logout.** `AuthContext.tsx`'s `logout` calls `removePushSubscription()`
before `POST /api/auth/logout`, so a shared browser stops receiving the
previous user's pushes. It uses `getRegistration()` (no wait without a
worker), is bounded to 3 seconds (`LOGOUT_UNSUBSCRIBE_TIMEOUT_MS`), swallows
404s, and keeps the browser-side subscription so the next sign-in re-registers
the same endpoint.

**Settings page push column.** `NotificationSettings.tsx`'s
`pushChannelState()`: with `pushEnabled === false` the row is disabled with
"Not available yet" (a deployment fact, not a browser refusal). With
`pushEnabled === true` the row is never disabled, because push is an
account-level preference; on a device that is not granted it carries "Not
enabled on this device".

### 2.9 Operational events

Four events are facts about the deployment, not about a person. Their audience
is a permission: whoever can act on it.

| Key | Channels | Mandatory | Audience | Raised by |
|---|---|---|---|---|
| `jobs.job_failed` | email | no | `jobs:read` | `JobFailureNotifier` (`notifications/ops/`), a `job.settled` listener |
| `nodes.node_offline` | email, browser | no | `nodes:read` | the `nodes.fleet.sweep` handler |
| `db_backup.backup_failed` | email, browser | no | `db_backup:read` | `DatabaseBackupRunnerService` on failure; the `db.backup.sweep` handler for stale runs |
| `db_backup.restore_completed` | email, browser | **yes** | `db_backup:read` plus the triggering operator | `DatabaseRestoreService` after the database swap |

Email templates: `apps/api/src/email/templates/{job-failed,node-offline,backup-failed,restore-completed}.email.ts`.
No migration, table or endpoint was needed.

- **Why `restore_completed` is mandatory.** The live database was replaced and
  every later write is gone; silence is the risk. Its email footer says why it
  cannot be muted.
- **Why `jobs.job_failed` is email-only.** A bell row needs somewhere to lead.
  A failed job is a filter on the jobs list, not a page. The other three link
  to `/admin/settings/workers` or `/admin/settings/db-backup`.
- **Terminal only.** `jobs.job_failed` fires on `status === 'failed'`: attempt
  budget exhausted, rate-limit give-up, a handler declaring the job unrunnable,
  or the lease reaper's permanent give-up (which emits `job.settled` through
  the shared `emitJobSettled` helper). Retries and deferrals emit nothing.

**`notifyPermissionHolders`.** Resolves active users (`isActive: true`)
holding the permission through any role, in one indexed query, then fans out
through the same per-user dispatch as `notify`. Preferences, `mandatory`, admin
policy and delivery rows are the same code. Details:

- Zero recipients is a `debug` log and a no-op. A failing recipient query is
  logged, never thrown: every caller is already a failure path.
- `alsoNotifyUserIds` is unioned with the holders and de-duplicated by user id
  before dispatch. The restore uses it to include the operator.
- It filters `isActive`, unlike `loadRecipient` for `notify`, where the account
  is the event's subject and dropping it could defeat a mandatory event.

**Two orderings.**

- `JobFailureNotifier` is an `@OnEvent(JOB_SETTLED_EVENT)` bystander in
  `NotificationsModule`, not a call inside `JobTerminalService`. That keeps
  `JobsModule` free of a dependency on `NotificationsModule`. `EventEmitter2`
  dispatches synchronously, so the handler calls the detached entry point and
  wraps its body in `try`/`catch`.
- The restore calls the awaited `notifyPermissionHoldersNow` after
  `renameSwap` and before `exitProcess`. After the swap, so rows land in the
  promoted database and recipients come from the restored `users`. Before the
  exit, because a detached dispatch is dropped when the process exits. An
  operator created after the archive was taken may be missing; the template
  renders "Not recorded".

### 2.10 The PWA shell

**Manifest.** `apps/web/pwa/manifest.ts`'s `buildManifest()` reads `APP_NAME`,
`THEME_COLOR` and `BACKGROUND_COLOR` from `@app/shared`, the same constants
`vite.config.ts` substitutes into `index.html`. Load-bearing fields:

- `display: 'standalone'`: required for iOS Home Screen install, and
  therefore for notifications on iOS.
- `id: '/'`: pins app identity so `start_url` (`/?source=pwa`) can change
  without the OS seeing a second app.

**Service worker.** `apps/web/pwa/service-worker.ts` configures `VitePWA`
with `strategies: 'injectManifest'`, `srcDir: 'src'`, `filename: 'sw.ts'`,
`registerType: 'prompt'`, and `globPatterns:
['**/*.{js,css,html,ico,png,svg,woff2}']`. `apps/web/src/sw.ts` is one
hand-written file holding precaching (`self.__WB_MANIFEST`), the SPA
navigation fallback, and the `push`, `notificationclick` and
`pushsubscriptionchange` handlers.

**Update and install prompts.** `components/pwa/UpdatePrompt.tsx` registers the
worker (`useRegisterSW`), surfaces a waiting worker, and posts
`{ type: 'SKIP_WAITING' }`, which `sw.ts` listens for.
`components/pwa/InstallPrompt.tsx` offers install where the browser fires
`beforeinstallprompt`; iOS is covered by `AddToHomeScreenPanel.tsx` instead.

**Caching headers.** `apps/web/nginx.conf` has exact-match blocks for
`/sw.js`, `/registerSW.js` and `/manifest.webmanifest` with
`Cache-Control: no-cache`, ahead of the one-year `immutable` rule for static
assets. A cached worker is a deploy users never receive; a cached manifest is a
stale app name and icon. nginx `add_header` replaces rather than merges, so a
new `location` block must repeat the server-level security headers.

**CSP.** `script-src 'self'` already permits `/sw.js`.
`infra/nginx/nginx.conf` adds explicit `worker-src 'self'` and
`manifest-src 'self'` (Safari has required `manifest-src` spelled out).

### 2.11 Service-worker constraints

**The worker never calls the API.** It cannot authenticate:

- The access token is memory-only, a private field on `ApiClient`
  (`apps/web/src/services/api.ts`).
- The refresh cookie is scoped to `/api/auth` and rotated on every use. A
  worker that refreshed would spend the token behind the page's back and log
  the user out.

Everything the worker needs is pushed to it (a push payload, or a
`postMessage` from a page). So `notificationclick` never marks a notification
read itself. It either focuses an open client and `postMessage`s the click
(the page calls `markRead` and navigates, as the in-page toast does), or
`clients.openWindow()`s `<link>?n=<id>`, which `NotificationContext.tsx` reads
on boot, handles, and strips with `replace: true`. The handler re-validates
`link` with `isInternalLink` (`apps/web/src/utils/internalLink.ts`) before
navigating, even though `sanitizeLink` ran at write time.

**Nothing under `/api` is precached or runtime-cached.** Cache Storage outlives
logout and is not per-account, so a cached authenticated response would leak to
the next user of the device.

- `globPatterns` match only built static files in `dist/`, which contains
  nothing from the API.
- The navigation fallback has `denylist: [/^\/api\//]`. `/api/notifications/stream`
  is SSE and never ends; a handler that took it would keep the worker busy
  until the browser killed it. `/api/docs` and download URLs must reach the
  server too.

**Every `push` event ends in `showNotification`.** A `push` handler that
resolves without one makes Chrome show a generic "This site has been updated
in the background" notice. A real push is shown whether or not a client is
visible and focused (§2.7); a malformed payload gets a generic fallback
notification. Only a test push whose `showNotification` throws falls back to
its `push-test-received` ack as the substitute.

**`pushsubscriptionchange`** resubscribes best-effort only and does not
`POST` (it cannot authenticate). The page's boot-time sync (§2.8) is the real
mechanism.

### 2.12 Foreground suppression and cross-tab dedup

Three independent checks in the page:

- **Foreground suppression.** Show an OS notification only when no window is
  both `document.visibilityState === 'visible'` and `document.hasFocus()`.
  This governs the page's SSE toast only; the service worker shows real Web
  Push payloads regardless of focus (§2.7).
- **Push-covered suppression.** The SSE `notification` frame carries
  `pushed: boolean` next to `toast`. It is `true` when the final resolved
  channel list for that dispatch (admin policy, user preference, mandatory
  override, `NotifyOptions.channels` narrowing) includes `push`. That list is
  `NotificationDispatchContext.channels`, which the browser channel only reads.
  `pushed` means a push will be attempted, not that it succeeded or that this
  browser is subscribed; a missing field (older server) reads as `false`. In
  `NotificationContext.tsx`, a tab that is not visible and focused, and whose
  `toast` allows it, skips its own OS toast only when all of these hold:
  `pushed` is `true`, the notification config has `pushEnabled` and a
  `vapidPublicKey`, and `hasActivePushSubscription(key)`
  (`services/pushSubscription.ts`) is `true`. That helper uses
  `getRegistration`, never `.ready`, requires the subscription key to match,
  caches for 30 s, and is invalidated by sync and remove. Every uncertain case
  (no subscription, config read failure, `pushed` false or missing) shows the
  page toast. Bell, unread count and row updates are unaffected.
  Trade-off: if the push service drops the message, a backgrounded tab shows
  no OS toast, though the inbox row still arrived over SSE. A VAPID rotation
  mid-session can at worst produce a duplicate, never a missing toast.
- **Cross-tab dedup.** `showAppNotification` (`browserNotifications.ts`) calls
  `registration.getNotifications({ tag: notification.id })` and skips when a
  notification with that tag exists. Every tab receives the SSE frame; the
  registration's list is shared by all tabs, and both the SW path and the page
  `Notification` fallback set `tag` to the notification id.

## 3. Configuration and permissions

### Settings

| Namespace / store | Keys | Edited at |
|---|---|---|
| `system_settings.notifications` | `browserEnabled`, `disabledEvents` | `/admin/settings/notifications` |
| `system_settings.webPush` | `enabled`, `publicKey`, `subject` | `/admin/settings/push` |
| `credentials` (`push_vapid` / `default`) | VAPID private key, encrypted with `SECRETS_ENCRYPTION_KEY` | `/admin/settings/push` |
| `user_settings.notifications` | Per-user, per-event, per-channel preferences | `/settings/notifications` |

### Environment variables

- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`: optional fallback
  key pair, used only while no `webPush` row exists (§2.7).
- `SECRETS_ENCRYPTION_KEY`: required to store the VAPID private key.

### Permissions

- `system_settings:read` / `system_settings:write`: the notifications policy
  card and its writes.
- `push:read` / `push:write`: VAPID configuration. Admin only.
- Any authenticated user: everything under `/api/notifications/*`, scoped to
  the caller.

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the full permission matrix.

### API surface

| Method and route | Purpose | Permission |
|---|---|---|
| `GET /api/notifications/events` | Registry events, each with `channels` (policy-filtered, for the preferences matrix) and `declaredChannels` (unfiltered, so the admin policy page keeps listing a suppressed event) | authenticated |
| `GET /api/notifications/config` | `browserEnabled`, `pushEnabled`, `vapidPublicKey` | authenticated |
| `GET /api/notifications/stream` | SSE stream of new inbox rows, each with `toast` and `pushed` | authenticated |
| `GET /api/notifications` | Caller's inbox, paginated (`page`, `pageSize`, `unreadOnly`) | authenticated |
| `GET /api/notifications/unread-count` | Unread count | authenticated |
| `POST /api/notifications/:id/read` | Mark one read | authenticated |
| `POST /api/notifications/read-all` | Mark all read | authenticated |
| `POST /api/notifications/push/subscriptions` | Register (upsert) a push subscription; 409 with no active key pair | authenticated |
| `DELETE /api/notifications/push/subscriptions` | Remove a push subscription; 204, 404 if not the caller's | authenticated |
| `GET /api/admin/push-config` | Config plus masked `privateKeyStatus` | `push:read` |
| `PUT /api/admin/push-config` | Set `{ enabled, subject }` | `push:write` |
| `POST /api/admin/push-config/generate` | First key pair | `push:write` |
| `POST /api/admin/push-config/rotate` | Replace key pair (`ROTATE`) | `push:write` |
| `DELETE /api/admin/push-config` | Remove credential and row (`REMOVE`) | `push:write` |
| `POST /api/admin/push-config/test` | Test push to the caller's own devices, with diagnostics | `push:write` |

## 4. Extending it in a fork

Adding an event, its templates and its call site is the recipe in
[`apps/api/src/notifications/README.md`](../../apps/api/src/notifications/README.md).
Three steps, no migration.

Choosing an entry point:

- A user account: `notify`.
- Maybe no account (invitations): `notifyAddress`.
- Inside a job handler that must not return before delivery: `notifyNow`.
  Never from a request path.
- "Whoever can act on this": `notifyPermissionHolders`, passing the constant
  from `PERMISSIONS` that the area's controller enforces. Address a
  permission, not a role; roles are bundles that change.

If a fork's queue produces enough failures to need a digest, build a batching
layer in front of `notifyPermissionHolders`, not a new entry point on
`NotificationsService`. The template ships none (§6).

Rebranding (`APP_NAME`, colours) flows into the manifest automatically through
`@app/shared`; see [packages/shared/README.md](../../packages/shared/README.md).

## 5. Guardrails

API (`apps/api/src/notifications/`, `apps/api/test/`):

- `notification-events.spec.ts`: registry invariants (unique keys, key shape,
  non-empty channels, `mandatory` implies `defaultEnabled`).
- `notification-policy.spec.ts`, `notification-policy-enforcement.spec.ts`,
  `test/notifications/notification-policy.integration.spec.ts`: kill switch,
  mandatory exemption, `toast` flag.
- `notification-preferences.spec.ts`: preference resolution.
- `notification-failure-containment.spec.ts`: entry points never reject.
- `notify-permission-holders.spec.ts`: permission-addressed recipients.
- `operational-events-no-migration.spec.ts`,
  `operational-events-preferences.spec.ts`, `ops/job-failure-notifier.spec.ts`:
  the four operational events.
- `security-role-changed-wiring.spec.ts`: the mandatory role-change event.
- `push-config.service.spec.ts`, `test/settings/push-config.integration.spec.ts`:
  VAPID precedence and admin routes.
- `push-subscription.service.spec.ts`, `channels/push-notification.channel.spec.ts`,
  `test/notifications/{push-subscriptions,push-channel-registration}.integration.spec.ts`:
  subscriptions and sending.
- `test/notifications/notifications-isolation.integration.spec.ts`: a user
  reads only their own inbox.
- `test/settings/notification-events.integration.spec.ts`: the events route.

Web (`apps/web/src/__tests__/`):

- `pwa/manifest.test.ts`, `pwa/service-worker.test.ts`: manifest fields and
  the worker's `push`/`notificationclick`/`pushsubscriptionchange` handlers
  under jsdom.
- `hooks/useNotificationCapability.test.ts`: the 8-state precedence.
- `services/browserNotifications.test.ts`: SW-first display, fallback, dedup.
- `services/pushSubscription.test.ts`, `hooks/usePushSubscriptionSync.test.ts`:
  sync, rotation detection, logout cleanup, auto-prompt.
- UI: `components/notifications/NotificationPermissionBanner.test.tsx`,
  `components/settings/{NotificationSettings,AddToHomeScreenPanel}.test.tsx`,
  `pages/Admin/{PushConfigPage,NotificationSettingsPage}.test.tsx`,
  `contexts/NotificationContext.test.tsx`.

## 6. Design decisions

- **`injectManifest`, not `generateSW`.** `generateSW` writes the whole worker,
  leaving no file for push handlers. Its `importScripts` escape hatch splits
  one worker across a generated and a hand-written file that cannot see each
  other, so routing and push logic drift apart silently.
- **`registerType: 'prompt'`, not `'autoUpdate'`.** Auto-update reloads the
  page under the user and discards unsaved form state. The prompt costs one
  click.
- **Manifest from `@app/shared`, not `VITE_APP_NAME`.** An env var makes the
  deployment a second source of truth for the product name.
- **Server-side toast enforcement.** Enforcing the kill switch in the client
  only would leave other stream consumers unenforced and make the control a
  suggestion.
- **A dedicated `GET /api/notifications/config`, not widening
  `system_settings:read`.** That permission exposes the whole settings
  document. The kill switch is a modelled, typed namespace rather than a
  free-form feature flag for the same reason.
- **Tag-based dedup, not cross-tab leader election.** The registration's
  notification list is already shared per origin; leader election adds a
  protocol with its own failure modes.
- **Push channel always registered.** Registering it only when keys existed at
  boot hid the channel; an always-present channel with a visible `failed` row
  is actionable.
- **VAPID split between settings row and credential.** The public key must be
  displayable; only the private key is secret. Mirrors SMTP.
- **Automatic permission prompt.** Accepted cost of a one-shot denial because
  push is critical for this product; manual paths remain for browsers that
  require a gesture.
- **Permission-addressed operational events, not role-addressed.** The
  audience follows grants automatically; a renamed or split role cannot leave
  it mailing the wrong bundle.
- **No digest for `jobs.job_failed`.** Nothing in the template produces the
  volume, and a roll-up is a second scheduler and a way for a failure notice to
  arrive late. A fork with the volume builds it in front of
  `notifyPermissionHolders`.

## 7. Verification

Automated:

```bash
cd apps/api && npm test -- notifications
cd apps/web && npm test -- run pwa Notification notification Push push
```

Manual (jsdom cannot show a real OS notification):

1. Sign in as Admin. At `/admin/settings/push`, click Generate. `GET
   /api/notifications/config` now returns `pushEnabled: true` and a
   `vapidPublicKey`.
2. Reload the app. Grant permission when prompted (or use the banner). A row
   appears in `push_subscriptions` for your user.
3. Trigger a notification (for example, change a test user's role). The bell
   updates; with the tab in the background an OS notification appears; with
   every tab closed, a push notification appears.
4. At `/admin/settings/notifications`, turn browser notifications off. Change
   a role again: the inbox row still appears, no OS toast is shown.
5. Rotate the keys. Reload the app: the subscription is replaced (new
   endpoint) without a prompt.

Check by hand on desktop Chrome/Edge, Firefox and Safari; Android Chrome with
the app closed; iOS Safari in a tab (install panel) and installed (push).

## History

- Epic #215 (issues #216–#233): brand icons, manifest, `injectManifest`
  service worker, update and install prompts (#219), nginx caching and CSP
  (#220), the capability model (#221), SW display and click handling, foreground
  suppression and dedup (#224), the admin policy and its enforcement
  (#225–#227), the `push` channel and subscriptions (#228–#230), the iOS
  walkthrough (#231).
- Issue #288 (epic #254): the four operational events and
  `notifyPermissionHolders`.
- Issue #355: runtime-configurable VAPID keys and `push:*`.
- Issue #365: client-side subscription, automatic prompt, banner, logout
  cleanup.
- Issue #468: the lease reaper's give-up raises `jobs.job_failed`.
- Issue #521: `GET /api/notifications/events` gains `declaredChannels`, so the
  admin policy page keeps listing an event whose browser delivery it
  suppressed.
