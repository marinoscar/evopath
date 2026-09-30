# Runbook: Generate, Enable, Rotate, and Disable VAPID Keys (Web Push)

This runbook covers the operator-facing lifecycle of Web Push on this
deployment: generating a VAPID key pair, turning the channel on, rotating the
keys, and turning it back off (or removing it entirely). It does not cover
the delivery mechanism itself — see
[`docs/specs/browser-notifications.md`](../specs/browser-notifications.md)
for why Web Push exists, how it fits alongside the browser-toast channel, and
what it does and does not guarantee.

**The admin UI at `/admin/settings/push` is the only path**: generate,
enable, rotate, or remove a VAPID key pair live, with no restart. Section 2
covers it in full. There is no environment-variable fallback — see the
upgrade note below if this deployment predates that.

> **Upgrading from before this change?** Web Push used to fall back to
> `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` environment
> variables whenever no `webPush` admin-settings row had ever been saved.
> That fallback is retired, with no auto-migration. If this deployment
> relied on env-set keys and never saved anything through
> `/admin/settings/push`, Web Push is now off until an administrator
> generates a key pair there (Section 2.1).

Source of truth for every claim below:

- `apps/api/src/notifications/push-config.service.ts` — `PushConfigService`,
  and specifically `resolveActiveVapidConfig()`, the one place both callers
  below ask "what VAPID key pair, if any, is active right now."
- `apps/api/src/notifications/push-config.controller.ts` — the five
  `/api/admin/push-config` routes the admin UI (and any other client) calls.
- `apps/api/src/notifications/push-config.schema.ts` — the `webPush`
  `system_settings` row's shape (`enabled`, `publicKey`, `subject`).
- `apps/api/src/notifications/push-vapid-credential.constants.ts` — where the
  private key actually lives (`CredentialsService`, `purpose: 'push_vapid'`).
- `apps/api/src/notifications/push-subscription.service.ts` — `isEnabled()`,
  the predicate that decides whether this deployment accepts push
  subscriptions at all; delegates to `resolveActiveVapidConfig()`.
- `apps/api/src/notifications/channels/push-notification.channel.ts` — the
  sender, including what happens when a send fails.
- `apps/api/src/notifications/notifications.module.ts` — registers the push
  channel unconditionally (like email/browser); see its header comment for
  why.
- `apps/web/src/pages/Admin/PushConfigPage.tsx` and
  `apps/web/src/components/admin/PushConfigConfirmDialog.tsx` — the admin UI.
- `apps/web/src/services/pushSubscription.ts` and
  `apps/web/src/hooks/usePushSubscriptionSync.ts` — the client's re-subscribe
  after a key change (Section 3).

**Web Push ships disabled by default.** Touching the admin UI is not
required — nothing in this codebase requires it, and every other
notification channel (email, the in-app browser toast) is unaffected by its
absence.

---

## 1. Before you start

- Decide whether you want Web Push at all. It is the *only* channel that can
  reach a signed-in user with the app fully closed (no open tab, no installed
  PWA in the foreground) — if that is not a requirement for this deployment,
  there is nothing to do here.
- Decide on a contact address (the VAPID subject) before generating keys: a
  `mailto:` or `https:` URL identifying the operator, per the Web Push
  protocol (RFC 8292). This is advisory metadata a push service (FCM,
  Mozilla's autopush, …) can use to reach you if this deployment's traffic
  looks abusive — it is never seen by end users. See Section 2.3 for what
  happens if you skip it.
- You need `push:read` (to view configuration) and `push:write` (to change
  it) — a permission pair of its own, **not** a reuse of `system_settings:*`,
  because generating or rotating key material has a real blast radius (every
  existing subscriber goes dark until it re-subscribes) that should not ride
  along with routine settings edits.

`PushConfigService.resolveActiveVapidConfig()` is the one place both callers
(`PushSubscriptionService` and `PushNotificationChannel`) ask "what VAPID key
pair, if any, is active right now." Three cases, in order:

1. **No `webPush` row exists, or one exists with `enabled: false`** → push is
   off, full stop.
2. **A `webPush` row exists, `enabled: true`, but no public key is stored or
   the private-key credential is missing** (corruption, a hand-edited row, a
   botched migration) → treated as disabled, and logged loudly.
3. **A `webPush` row exists, `enabled: true`, public key and private-key
   credential both present** → the active configuration.

## 2. The admin UI

Visit `/admin/settings/push` as an Admin (or any role holding `push:read`/
`push:write`). The page has three panels, matching `PushConfigPage.tsx`:

1. **Status** — always shown: configured/not, enabled/disabled, the full
   public key (monospace, copyable — it is not secret), the subject, and the
   private key's provenance (a masked hint, when it was last set, and by
   whom). The private key itself is never rendered or returned by any
   endpoint.
2. **Empty state** (nothing generated yet) — a single **Generate & enable**
   action, with an optional subject field.
3. **Configured state** — an enable/disable switch and the subject field
   (saved via `PUT`, non-destructive: the keys are retained either way), plus
   two destructive actions in a "Danger zone": **Rotate keys** and **Remove
   configuration**.

### 2.1 Generating the first key pair

From the empty state, optionally fill in a subject (`mailto:` or `https://`),
then click **Generate & enable**. This calls
`POST /api/admin/push-config/generate`, which:

- Generates a fresh VAPID key pair with `web-push`'s `generateVAPIDKeys()`.
- Stores the private key in the encrypted credential store
  (`(purpose: 'push_vapid', name: 'default')`), written **before** the
  settings row — the same partial-failure-safe ordering
  `EmailSettingsService.update` uses for the SMTP password.
- Stores the public key and the subject in the `webPush` system-settings row,
  and sets `enabled: true`.

This is **first-time only** — a second call returns `409 Conflict` and points
you at Rotate instead. It is deliberately not idempotent: a second `generate`
silently replacing a live key pair with no confirmation step would invalidate
every existing subscriber with no warning, which is exactly what Rotate's
typed confirmation exists to prevent.

### 2.2 Enabling and disabling

Once a key pair exists, the switch on the configured-state panel toggles
`enabled` via `PUT /api/admin/push-config`. This is the **non-destructive**
action — the stored key pair is retained either way, so switching back on
needs no regenerating. Disabling takes effect immediately (Section 1, case
1): no push is sent while `enabled` is `false`, and `POST
/api/notifications/push/subscriptions` starts rejecting new subscriptions
with `409 Conflict`.

Attempting to enable before any key pair has been generated returns `409
Conflict` — this endpoint flips the switch, it does not manufacture keys.

### 2.3 What happens if the subject is left blank

The subject is optional at every step. If it is unset,
`PushNotificationChannel` still sends, but falls back to a generic
`mailto:admin@example.com` and logs a warning on every delivery. Every push
this deployment sends will therefore carry `web-push`'s own example address
as its contact, which is harmless to end users (they never see it) but means
a push-service operator investigating unwanted traffic from this deployment
has no way to reach you. Set a real subject before enabling push on any
deployment that will see real traffic.

### 2.4 Rotating VAPID keys (what the Rotate button does)

Click **Rotate keys** in the Danger zone. This opens a confirmation dialog
that states the consequence and requires typing the literal `ROTATE` before
the button is enabled — the same typed-confirmation pattern
`db-backup`'s restore/rollback flow uses, with a deliberately different word
so a confirmation typed for Remove (Section 2.5) can never satisfy this one.
Confirming calls `POST /api/admin/push-config/rotate` with
`{ "confirmation": "ROTATE" }`, which:

- Generates a fresh VAPID key pair and overwrites both the stored credential
  and the row's `publicKey`.
- Leaves `enabled` exactly as it was — rotating is not a decision about
  whether push should be on, only about which keys back it.
- Replaces the subject only if one was supplied in the request; omitted
  keeps the existing one.

Returns `400 Bad Request` if nothing is configured yet — use Generate
(Section 2.1) for a first key pair.

**Every existing push subscription becomes permanently unusable the moment
you rotate.** A `PushSubscription` a browser holds is cryptographically bound
to the public key it was created with (`applicationServerKey`) — there is no
"re-key in place" operation on either side of the Web Push protocol. This is
expected behavior of the protocol, not a bug in this implementation. What
happens on the next send attempt against a subscription negotiated under the
old keys, per `push-notification.channel.ts`'s failure handling (the spec
document covers this in full): the push service rejects the send.
Whether that arrives as a 404/410 (immediate deletion of the row) or some
other error code that instead increments `failureCount` toward the 5-attempt
threshold (`MAX_PUSH_FAILURE_COUNT`) depends on how the specific push service
(FCM, autopush, …) reports a key mismatch — this codebase does not
special-case that response, so expect anywhere from immediate pruning to up
to 5 silently failed deliveries per stale subscription before the row is
cleaned up automatically.

**Recovery is automatic, but only for a browser whose permission is still
granted.** On every app boot, the client compares its existing subscription's
`applicationServerKey` against the deployment's current `vapidPublicKey`. On a
mismatch, it unsubscribes the stale subscription, calls
`pushManager.subscribe({ applicationServerKey: <new public key> })`, and
`POST`s the result to `/api/notifications/push/subscriptions`, which upserts
by `endpoint`. `sw.ts`'s `pushsubscriptionchange` handler is a separate,
browser-initiated path and does not detect a server-side key change.

**The boundary that still needs a human:** a browser that was never granted,
whose permission has since been revoked, or that never reopens the app, does
not self-heal. Nothing re-prompts a denied origin, and nothing runs the sync
without a page load. The remedy is manual: the
`NotificationPermissionBanner`'s **Enable notifications** button, or the user
toggling notifications off and back on. Until then, that subscription keeps
failing every send and eventually prunes itself via the failure threshold
above. Section 3 is the reference for this mechanism; the client design is in
[`docs/specs/browser-notifications.md`](../specs/browser-notifications.md).

### 2.5 Removing the configuration

Click **Remove configuration** in the Danger zone. Same typed-confirmation
mechanism as Rotate, but with the literal `REMOVE` — a different word on
purpose, so a confirmation copied from one dialog can never satisfy the
other. Confirming calls `DELETE /api/admin/push-config` with
`{ "confirmation": "REMOVE" }`, which:

- Deletes the stored private-key credential **first**, then the `webPush`
  settings row — the opposite order from Generate, and deliberately so: the
  safer partial-failure state is "row still present but the credential is
  gone" (Section 1's case 2 already treats that as disabled and logs
  loudly), not "row gone but the credential still present."
- Returns the resulting, now-empty configuration.

This is **destructive and immediate**: every existing push subscriber stops
receiving push, exactly as with a rotation and needing the same manual
re-subscribe to recover (Section 2.4), and there is no way to bring the same
key pair back — a subsequent Generate mints an entirely new one. The app
keeps working; only web push stops. `push_subscriptions` rows are not deleted
by this action — they sit inert until a new key pair is generated and each
browser re-subscribes, or until the 404/410 pruning path removes them.

## 3. Recovery mechanics reference

This section is the single source Section 2.4 (rotate/remove) points back to,
so the claim is checked once, not re-asserted per procedure.

**The client re-subscribes itself on reopen, under one condition.** On every
app load it reads the deployment's current `vapidPublicKey` from `GET
/api/notifications/config`, compares it against any existing subscription's
`applicationServerKey`, and on a mismatch unsubscribes and calls
`pushManager.subscribe()` against the new key, then `POST`s the result to
`/api/notifications/push/subscriptions`, which upserts by `endpoint`. The
sync reads whatever `resolveActiveVapidConfig()` currently resolves to.

**The condition: notification permission must still be `granted` on that
browser.** The sync runs from page code, which can call
`pushManager.subscribe()` without prompting only when permission is already
`granted`; it does not re-prompt. A browser that was never granted, that has
since moved to `denied`, or that never loads the app again, does **not**
self-heal. It needs the manual path (the `NotificationPermissionBanner`'s
button, or the user re-toggling notifications).

Where this lives: `apps/web/src/services/pushSubscription.ts`
(`syncPushSubscription`, `subscriptionUsesKey`),
`apps/web/src/hooks/usePushSubscriptionSync.ts` (what triggers the sync, and
only while `permission === 'granted'`), and `apps/web/src/sw.ts`'s
`pushsubscriptionchange` handler (browser-initiated only). Any copy that says
"reopening the app re-subscribes" must keep the granted-permission qualifier.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Generate & enable` answers `409` | A key pair already exists | Use **Rotate keys** (Section 2.4) |
| Enabling answers `409` | No key pair has been generated | **Generate & enable** first (Section 2.1) |
| Rotate answers `400` | Nothing is configured yet | **Generate & enable** (Section 2.1) |
| New subscriptions rejected with `409` | Push is disabled (`enabled: false`) | Turn the switch back on (Section 2.2) |
| Push is off after upgrading, though it worked before | This deployment relied on the retired `VAPID_*` environment-variable fallback and never saved `/admin/settings/push`; there is no auto-migration | Generate a key pair at `/admin/settings/push` (Section 2.1) |
| Push off although the row says `enabled: true` | The private-key credential is missing (Section 1, case 2); the API logs it loudly | Rotate or remove and generate again |
| Every delivery logs a warning about the subject | No subject set; the generic fallback is used | Set a real `mailto:` or `https:` subject (Section 2.3) |
| Some users stop receiving push after a rotation | Their browser permission is not `granted`, so they cannot self-heal | They re-enable notifications (Section 3) |

## Verify push works and troubleshoot

Open `/admin/settings/push` and use **Test & diagnostics** (needs `push:write`).
It checks the browser, sends a test push to your own devices and reports each
step. Design: [browser-notifications spec, section 2.7](../specs/browser-notifications.md).

| Symptom in the panel | Cause | Fix |
|---|---|---|
| Permission denied | The browser blocked notifications for this site | Allow notifications in the browser's site settings, then rerun |
| Key mismatch | The browser subscription was created under a previous key pair | Reload the app so it re-subscribes, then rerun |
| `403` from the push service | The push service rejects the VAPID signature or subject | Check the key pair and set a valid `mailto:` or `https:` subject (Section 2.3) |
| `404`/`410` from the push service | The subscription expired; the server pruned it | Reload the app to re-subscribe |
| Sent, but no acknowledgement in the panel | The device did not receive it in time | Check OS and battery settings for the browser, or an outdated service worker (reload to update) |
| Notification shows the browser's icon (for example the Chrome logo) instead of the app icon | Android attributes a notification to the app that posts it; from a browser tab that is the browser. The app `icon` is still the large image on the right; the `badge` is the status-bar glyph. The report shows `isStandalone: false` | Install the PWA (Chrome menu, **Install app**) so Chrome creates a WebAPK. "Add to Home screen" as a plain shortcut does not change attribution |
| Status bar shows a blank square instead of a glyph | The `badge` image is not a white and transparent silhouette | Use a monochrome white-on-transparent badge image |
| Service worker `scriptURL` in the report is `dev-sw.js?dev-sw` | The deployment runs the Vite dev server, not the production build. Push works, but Chrome's **Install app** (WebAPK) can be less reliable | Deploy with `prod.compose.yml` for production-like behaviour |

## 4. Summary checklist

- [ ] Signed in as a user holding `push:read`/`push:write`
- [ ] Subject decided (a real `mailto:` or `https:` address, not left to the
      `mailto:admin@example.com` fallback, for any deployment with real
      traffic)
- [ ] Generated via `/admin/settings/push` → **Generate & enable**
- [ ] `GET /api/notifications/config` confirms `pushEnabled: true` and
      `vapidPublicKey` matches
- [ ] If upgrading from a deployment that relied on the retired
      environment-variable fallback: confirmed push was reconfigured here
      rather than assumed to still work
- [ ] If rotating or removing: typed the exact confirmation literal
      (`ROTATE`/`REMOVE`), and understood that recovery happens
      automatically the next time each subscriber's browser boots the app
      *while its notification permission is still granted* (Section 3); a
      browser that isn't still granted needs the manual path instead
