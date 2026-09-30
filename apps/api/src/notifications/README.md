# Notifications module

Server side of the notification framework: an event registry, a dispatcher
that applies user preferences and admin policy, three delivery channels, the
in-app inbox, Web Push subscriptions and configuration, and admin broadcasts.

## Module map

| Path | What it does |
|---|---|
| `notification-events.ts` | `NOTIFICATION_EVENTS`, the registry of every event the application can raise, and `NOTIFICATION_CHANNELS` (`email`, `browser`, `push`). |
| `notifications.service.ts` | The dispatcher. `notify`, `notifyNow`, `notifyAddress`, `notifyPermissionHolders` and `notifyPermissionHoldersNow` all converge on one private `dispatch()`. |
| `notification-preferences.ts` | Pure functions: what this user wants, per event and channel (`user_settings.notifications`). |
| `notification-policy.ts`, `notification-policy.service.ts` | What this deployment is willing to send (`system_settings.notifications`: `browserEnabled`, `disabledEvents`). |
| `notification-delivery.service.ts` | Writes one `notification_deliveries` row per channel attempt. |
| `notification-store.service.ts`, `notification-stream.service.ts` | The in-app inbox (`notifications` table) and the per-user SSE stream that pushes new rows to open tabs. |
| `notifications.controller.ts` | `/api/notifications`: event list, config, SSE stream, inbox reads and mark-read, push subscribe/unsubscribe. |
| `channels/` | One `NotificationChannelSender` per channel. `email-notification.channel.ts` renders an email template and sends it over SMTP or SES. `browser-notification.channel.ts` writes the inbox row and publishes it to the stream. `push-notification.channel.ts` sends an encrypted Web Push message to each of the user's `push_subscriptions`. |
| `push-config.*`, `push-subscription.service.ts` | Web Push: runtime VAPID key management (`/api/admin/push-config`, including the test-push route served by `push-test.service.ts`) and storage of browser push subscriptions. |
| `broadcasts/` | Admin broadcasts: `/api/admin/broadcasts`, the audience, and the two fan-out job handlers under `broadcasts/handlers/`. A sibling module (`BroadcastsModule`), not part of `NotificationsModule`. |
| `ops/` | `JobFailureNotifier`, a `job.settled` listener that raises `jobs.job_failed` to everyone holding the permission that can act on it. |

Email templates live outside this folder, in
[`../email/templates/`](../email/templates/index.ts).

## Delivery model

A caller raises an event by key. The dispatcher looks the event up in
`NOTIFICATION_EVENTS`, takes the channels it declares, narrows them by admin
policy (`policyChannels`), then by the recipient's stored preferences
(`resolveChannels`). A `mandatory` event ignores stored preferences, so every
declared channel stays on. Each surviving channel receives the event through
its `NotificationChannelSender`. Before each attempt the dispatcher writes a
`queued` row to `notification_deliveries`, then updates it to `sent` or
`failed`. Dispatch runs in-process and detached from the caller. There is no
retry: a process killed mid-send leaves a row stuck at `queued`, which is the
evidence. A channel failure is recorded, never thrown back to the caller.

The browser channel's durable `notifications` row is the delivery; the SSE
publish and the OS toast are liveness on top of it. The admin kill switch
(`browserEnabled: false`, or an event in `disabledEvents`) drops the browser
channel for ordinary events, so they write no inbox row. A `mandatory` event
keeps its row and arrives with `toast: false`. See `policyChannels` and
`isBrowserToastAllowed` in `notification-policy.ts`. Web Push sends only while a VAPID key
pair is active: one generated at `/admin/settings/push`, or, when none is
stored, the `VAPID_*` environment variables.

## Adding a notification

Three steps and no migration.

### 1. Declare the event

Add an entry to `NOTIFICATION_EVENTS` in
[`notification-events.ts`](notification-events.ts):

- `key`: stable and dotted, `<area>.<event>` (`billing.invoice_ready`).
  Renaming a key later is a data migration, because stored preferences are
  keyed by it.
- `label` and `description`: user-facing copy for the preferences page.
- `channels`: the channels this event can genuinely be delivered over
  (`email`, `browser`, `push`). An event whose recipient has no account, such
  as `allowlist.invitation`, declares `email` only.
- `defaultEnabled`: what an account with no stored preference gets.
- `mandatory: true`: only for events a user must not be able to silence, such
  as a privilege or security change. A mandatory event must also be
  `defaultEnabled: true`.

This one entry feeds the dispatcher, the `/settings/notifications` matrix and
`GET /api/notifications/events`. There is no second list to update, and no
preference row is created for anybody: an absent preference means "use the
event's default".

### 2. Write the templates

Write one template per channel the event declares.

**Email.** Create `apps/api/src/email/templates/<name>.email.ts`. Export a
payload interface and a pure function returning `{ subject, html, text }`.

- Build the body with the `html` tagged literal so every interpolation is
  escaped.
- Pass it to `renderLayout`. Put any call-to-action URL through the layout,
  which applies `safeUrl`.
- Hand-write the text part. There is no HTML-to-text helper.
- Register the template in
  [`../email/templates/index.ts`](../email/templates/index.ts), in both
  `EmailTemplateDataMap` and `EMAIL_TEMPLATES`. The compiler rejects half a
  registration.
- Map the event key to the template name in `EVENT_EMAIL_TEMPLATES`
  ([`channels/email-notification.channel.ts`](channels/email-notification.channel.ts)).
  A missing entry is a recorded delivery failure, not a silent skip.

**Browser and push.** Add an entry to `EVENT_BROWSER_TEMPLATES`
([`channels/browser-notification.channel.ts`](channels/browser-notification.channel.ts))
returning `{ title, body, link? }`. The push channel reads the same map. The
entry is optional: without one, the registry's `label` and `description` are
used. `link` must be a root-relative path.

Worked examples:
[`test-email.email.ts`](../email/templates/test-email.email.ts) and
[`role-changed.email.ts`](../email/templates/role-changed.email.ts).

### 3. Call `notify()` at the real trigger

Call it from a service whose module has `imports: [NotificationsModule]`:

```ts
await this.notifications.notify('billing.invoice_ready', userId, payload);
```

- Call it **after** the triggering write has committed and **outside** any
  `$transaction`.
- `notify` is detached. It schedules the dispatch and returns before anything
  is rendered or sent. It never rejects, never joins your transaction and
  never delays your response.
- `notify` takes `data: unknown`. Annotate the payload with the template's
  data type at the call site; that is the only place its shape is checked.

Pick the entry point by recipient and by whether you must wait:

| Method | Use it when |
|---|---|
| `notify(eventKey, userId, data)` | The recipient is a user account. The default. |
| `notifyAddress(eventKey, email, data)` | The recipient may have no account, such as an allowlist invitation. An address that matches an account uses that account's preferences. |
| `notifyNow(eventKey, userId, data)` | A job handler must not return before delivery has been attempted. Awaited, still never rejects. |
| `notifyPermissionHolders(eventKey, permission, data)` | The audience is "whoever can act on this": every user holding a permission. Use the constant from `PERMISSIONS`, the same one the area's controller enforces. `notifyPermissionHoldersNow` is the awaited form. |

Live examples:

- `AuthService.handleGoogleLogin`: `user.welcome`.
- `AllowlistService.addEmail`: `allowlist.invitation` through `notifyAddress`.
- `UsersService.updateUserRoles`: `security.role_changed`, mandatory.
- Operational events raised to permission holders: `jobs.job_failed`
  (`ops/job-failure-notifier.ts`), `nodes.node_offline`,
  `db_backup.backup_failed` and `db_backup.restore_completed` (mandatory).
  See §2.9 and §6 of the
  [browser notifications spec](../../../../docs/specs/browser-notifications.md)
  for the operational events and why `jobs.job_failed` has no digest.

## Admin broadcasts

A broadcast is one message an administrator sends to every active user, now
or at a scheduled time. It adds no second notification system. It raises one
of two registry events (`admin.broadcast`, which users can mute, or
`admin.broadcast_critical`, which is mandatory) through the same dispatcher,
and fans out over two job types:

- `admin.broadcast.start` freezes the audience and enqueues the chunks.
- `admin.broadcast.chunk` delivers to one slice of the audience with
  `notifyNow`. Chunks are enqueued with `skipDedup: true`.

The full design is in the broadcasts spec below.

## Further reading

- [Browser notifications and Web Push spec](../../../../docs/specs/browser-notifications.md):
  service worker, capability model, kill switch, Web Push, operational events.
- [Notification broadcasts spec](../../../../docs/specs/notification-broadcasts.md):
  audience, lifecycle, fan-out, channel selection.
- [VAPID keys runbook](../../../../docs/runbooks/vapid-keys.md): generating,
  rotating and removing Web Push keys.
- [Job handler recipe](../../jobs/handlers/README.md): how the broadcast
  handlers register with the queue.
