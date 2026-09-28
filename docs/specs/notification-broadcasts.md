# Admin Notification Broadcasts

> **Status:** shipped · **Code:** `apps/api/src/notifications/broadcasts/`, `apps/web/src/pages/Admin/BroadcastsPage.tsx`, `apps/web/src/components/admin/{BroadcastComposer,BroadcastDetailDialog}.tsx`, `apps/web/src/services/broadcasts.ts` · **API:** `/api/admin/broadcasts/*` (see `/api/docs`) · **Admin UI:** `/admin/settings/broadcasts` · **Recipe:** [notifications module README](../../apps/api/src/notifications/README.md)

A broadcast is one plain-text message an administrator composes in the app and
sends to every active user, now or at a scheduled time, over the channels the
deployment supports (email, the in-app inbox, Web Push). It is a trigger on top
of the existing notification framework and job queue: two registry events, two
job types, one table. It is not a second notification system.

## 1. Purpose

### What it is

- One message to **all active users**, sent immediately or scheduled.
- Delivered through the ordinary dispatcher, so every recipient's preferences,
  the admin kill switch and the per-channel delivery rows apply unchanged.
- Fanned out in chunks of 200 recipients through the job queue, surviving
  restarts, resumable after failure, cancellable mid-flight.

### What it is not

- **Not marketing.** No template library, no HTML body, no rich media, no
  click tracking. One plain-text message.
- **Not segmented.** No role filter, no user picker, no saved audience.
- **Not editable.** `title` and `body` are frozen at create time; there is no
  `PATCH`. Cancel and recreate; an edit could race the fan-out.
- **Not exactly attributed.** Delivery counts per broadcast are approximate
  (§2.11).

## 2. How it works

### 2.1 Two registry events

`NOTIFICATION_EVENTS` (`apps/api/src/notifications/notification-events.ts`)
declares:

```ts
{ key: 'admin.broadcast',          label: 'Announcements',
  channels: ['email', 'browser', 'push'], defaultEnabled: true }
{ key: 'admin.broadcast_critical', label: 'Important announcements',
  channels: ['email', 'browser', 'push'], defaultEnabled: true, mandatory: true }
```

The only difference is who may mute them. The composer's `critical` flag
chooses the key; the server derives `eventKey` and ignores any client-supplied
value. Both appear on `/settings/notifications` automatically: a toggle for
`admin.broadcast`, a disabled row with its reason for the critical one.

### 2.2 The model

`NotificationBroadcast` (`notification_broadcasts`):

| Column | Meaning |
|---|---|
| `title`, `body`, `link`, `ctaLabel` | Frozen content. `link` is root-relative. |
| `eventKey` | `admin.broadcast` or `admin.broadcast_critical`. |
| `channels` | The channels the admin selected (text array). |
| `status` | `NotificationBroadcastStatus`, default `scheduled`. |
| `scheduledFor` | Future send time, or null for "now". |
| `startedAt`, `finishedAt`, `canceledAt` | Lifecycle timestamps. |
| `audienceCutoff` | Frozen `createdAt` bound of the audience, stamped at claim. |
| `cursorUserId` | Keyset cursor: last user id dispatched. |
| `recipientsTargeted` | Audience count at send time (nullable until claimed). |
| `recipientsDispatched` | Recipients dispatched so far (default 0). |
| `lastError` | Why a `failed` broadcast stopped. |
| `createdById` | Author; `SetNull` on user delete. |
| *indexes* | `[status, scheduledFor]`, `[createdAt desc]`. |

### 2.3 Content and validation

`CreateBroadcastDto` (`dto/create-broadcast.dto.ts`, Zod):

| Field | Rule |
|---|---|
| `title` | Trimmed, 1–120 chars (`BROADCAST_TITLE_MAX`). |
| `body` | Trimmed, 1–2,000 chars (`BROADCAST_BODY_MAX`). Plain text. |
| `link` | Optional, ≤ 500 chars, root-relative: starts with `/`, not `//` or `/\`, no spaces or control characters. |
| `ctaLabel` | Optional, 1–40 chars; requires `link`. |
| `channels` | At least one of `email`, `browser`, `push`; no duplicates. |
| `scheduledFor` | Optional ISO-8601 with offset; must be in the future. |
| `critical` | Boolean, default `false`. `critical: true` without `browser` in `channels` is a 400. |

The `link` check produces a fixable 400 at compose time. The security
boundary is still `sanitizeLink` in the browser channel, which silently drops a
bad link at render time.

Create returns `{ broadcast, warnings }`. The only warning today fires when
`browser` was selected while the deployment-wide browser kill switch is off,
and it says one of two things depending on the broadcast's importance: for
`admin.broadcast` (non-critical), the in-app row is not written at all and the
bell never shows it — unless `push` is also selected and the recipient has an
active subscription, which writes its own in-app row; for
`admin.broadcast_critical` (mandatory), the row is still written and reaches
the bell, only the OS toast is withheld. That is a warning, not a 400, because
scheduling for after the switch is flipped back is legitimate.

**Rendering.** The body splits into paragraphs on blank lines; a single
newline inside a paragraph is joined with a space (mail clients reflow). Empty
paragraphs are dropped. `broadcast.email.ts` interpolates each paragraph as a
value into the `html` tagged literal (`email/templates/safe-html.ts`), which
escapes by construction; `SafeHtml.unsafeFromTrustedString` is never called.
The browser/push template (`EVENT_BROWSER_TEMPLATES`) is a projection that
validates `title` and `body` are strings and throws otherwise (a recorded
delivery failure). Truncation and link sanitising happen once, in the browser
channel. The push channel reuses the browser template map, so neither event
needs a third registration.

### 2.4 The audience

One function defines it, used by every reader:

```ts
// apps/api/src/notifications/broadcasts/broadcast-audience.ts
export function audienceWhere(cutoff: Date): Prisma.UserWhereInput {
  return { isActive: true, createdAt: { lte: cutoff } };
}
```

`GET /api/admin/broadcasts/audience`, the start handler's
`recipientsTargeted` count and the chunk handler's paging all call it. A count
taken with a different predicate than the pages walk makes the progress bar
lie.

- `isActive: true` is evaluated **live, per page**. A user deactivated
  mid-fan-out stops receiving from the next chunk. So `recipientsTargeted` may
  exceed `recipientsDispatched`.
- `createdAt <= audienceCutoff` is **frozen**, stamped once when sending
  begins. Without it the fan-out keeps discovering new users and "who got
  this?" becomes unanswerable.
- A user created between create and start **is included**. A user created
  after start **is excluded**.

### 2.5 Lifecycle

```
scheduled --[start handler CAS]--> sending --[chunk: empty/short page]--> sent
    |                                 |
    |                                 +--[fan-out job fails permanently:
    |                                 |    BroadcastFailureListener CAS]--> failed
    |                                 |                                       |
    |                                 +<--[POST /:id/resume CAS]--------------+
    |
    +--[cancel: from scheduled | sending | failed]--> canceled
```

Statuses: `draft`, `scheduled`, `sending`, `sent`, `canceled`, `failed`.
`draft` is unreachable by any route. It stays in the Postgres enum on purpose:
adding an enum value later needs `ALTER TYPE … ADD VALUE`, which cannot run in
Prisma's migration transaction. Do not remove it.

**Every transition is a compare-and-swap** (`updateMany` with the expected
status in the `WHERE`), never read-then-write:

| Transition | Statement |
|---|---|
| Claim | `WHERE id AND status = 'scheduled'` → `sending`, `startedAt = audienceCutoff = now` |
| Finish | `WHERE id AND status = 'sending'` → `sent`, `finishedAt` |
| Cancel | `WHERE id AND status IN ('scheduled','sending','failed')` → `canceled`, `canceledAt` |
| Fail | `WHERE id AND status = 'sending'` → `failed`, `lastError`, `finishedAt` |
| Resume | `WHERE id AND status = 'failed' AND audienceCutoff IS NOT NULL` → `sending`, clear `lastError`/`finishedAt` |

A read-then-write lets a cancel land between the read and the write and
resurrect a cancelled announcement. `updateMany` reports `count: 0` instead of
throwing `P2025`, so "somebody else already decided" is a branch, not a failed
job. It also makes a manual rerun of a finished start job harmless: the swap
matches nothing, and `audienceCutoff` can never be re-stamped.

### 2.6 Fan-out: two job types

Both live in `broadcasts/handlers/`, self-register from `onModuleInit()`, are
labelled "Broadcast start" and "Broadcast delivery" in `job-type-labels.ts`,
and use `reason: 'backfill'`. Neither declares `nodeResultSchema` or
`persistNodeResult`, so both are server-only.

**Scheduling.** `POST /api/admin/broadcasts` enqueues the start job with
`scheduledFor: broadcast.scheduledFor`. A deferred job is invisible to the
claim query until its time, so "send Friday at 09:00" is a durable `jobs` row.
There is no second scheduler.

**`admin.broadcast.start`.** Dedup left on, so a double-clicked "Send now"
cannot enqueue two. It loads the broadcast (missing row: no-op), performs the
claim CAS, counts the audience into `recipientsTargeted`, and enqueues the
first chunk with `skipDedup: true`. The `recipientsTargeted` write is
conditional on `status = 'sending'`, so a cancel between claim and hand-off
stops the enqueue.

**Start is idempotent past its claim.** A start job that claimed and then
threw leaves the row `sending` with nothing behind it. A later start execution
finds `sending` and finishes the hand-off, recounting against the **stored**
`audienceCutoff`, only when all of these hold:

- `audienceCutoff` is set;
- `cursorUserId` is null and `recipientsDispatched` is 0;
- no `admin.broadcast.chunk` job exists for this broadcast, in any status.

Otherwise it does nothing. An operator repairs a stranded broadcast by retrying
its start job from the Jobs page.

**`admin.broadcast.chunk`.** Always enqueued with **`skipDedup: true`**, by
both the start handler and the chunk handler enqueuing its successor. Chunk
*n* enqueues chunk *n+1* while itself `running`; with dedup on,
`JobsService.enqueue` returns the in-flight job (chunk *n*) instead of
inserting. Nothing throws, every job reads `succeeded`, and the broadcast
silently stops after one page. The handler specs assert the flag on both
sites.

Each chunk:

1. Re-reads the broadcast; anything but `sending` (or a missing cutoff) is a
   no-op.
2. Pages `users` with `audienceWhere(audienceCutoff)`, `id > cursorUserId`,
   `orderBy: { id: 'asc' }`, `take: 200` (`BROADCAST_CHUNK_SIZE`). Keyset on
   the primary key is stable under inserts and deletes; `createdAt` can tie.
3. Dispatches through `notifyNow` at concurrency 5
   (`BROADCAST_SEND_CONCURRENCY`), with the broadcast's stored `channels`.
4. Re-checks status every 25 recipients (`STATUS_RECHECK_INTERVAL`) so a
   cancel takes effect mid-page.
5. Commits `cursorUserId` and `recipientsDispatched` in one update, after
   dispatch.
6. On a full page, enqueues its successor; on a short page, CASes the
   broadcast to `sent`.

**Duplicate over drop.** Because the cursor advances only after dispatch, a
process killed mid-chunk re-sends at most one page (200) on retry. Advancing
first would instead skip up to 200 people invisibly and permanently. A
duplicate is bounded, visible (two delivery rows) and self-correcting.

**Progress commit is a CAS on the cursor it read.** `WHERE id AND cursorUserId
= <cursor read at start>` (`IS NULL` for the first page). Two chains can run at
once (a resume beside an operator's retry of the old chunk, or a reaped zombie
beside its replacement). Both send the same page, but only the first commit
moves the cursor; the loser returns without a successor or a finish. Two chains
collapse to one within one page.

### 2.7 Channel narrowing and `critical ⇒ browser`

The admin's channel choice reaches the dispatcher as `NotifyOptions.channels`
and is applied inside `dispatch()` as a set intersection **after**
`resolveChannels(event, preferences, policy)`:

```ts
let channels = resolveChannels(event, recipient.preferences, policy);
if (options?.channels) {
  const requested = new Set(options.channels);
  channels = channels.filter((channel) => requested.has(channel));
}
```

Intersecting an already-resolved list makes "can only narrow" structural: a
channel the event does not declare, the kill switch dropped, or the recipient
muted cannot survive. `resolveChannels` stays free of the parameter because
`GET /api/notifications/events` shares it and has no per-dispatch concept.

`mandatory` binds the **recipient**, not the sender. The intersection may
narrow a mandatory event; an admin choosing email-only is not a user opting
out.

`critical ⇒ browser` is enforced in `CreateBroadcastDto`'s `superRefine`, not
in the dispatcher. In this app the `notifications` row written by the browser
channel is the in-app record; a critical announcement without it leaves nothing
to reread. It is a policy about what the composer may send. A future call site
reaching `notifyNow('admin.broadcast_critical', …)` without this DTO could
still narrow to email alone; add a check at that entry point if it appears.

### 2.8 `notifyNow()` versus `notify()`

`notify()` is detached: it schedules the dispatch on a microtask and returns.
A chunk handler built on it would:

1. leave up to 200 dispatches in flight after `process()` returns;
2. let the worker mark the job `succeeded` for work that has not happened;
3. lose everything past the 5-second shutdown drain on SIGTERM.

`notifyNow(eventKey, userId, data, options?)` is the awaited sibling: same
registry lookup, recipient resolution, single gate and never-rejects
containment. When it resolves, every channel was attempted and every delivery
row written. It resolves `NotifyNowResult` `{ rateLimited, retryAfterMs }`:
whether any channel was throttled, and the longest wait named. A dispatch that
threw, found no user, or had no channels resolves `{ rateLimited: false,
retryAfterMs: null }`.

Use `notifyNow` from background workers only, never a request path. It is not
tracked in the in-flight set `flush()` drains; its awaiting owner decides what
happens on shutdown. `flush()` is not a substitute: it waits for every
unrelated dispatch in the process and loops until the set drains, which under a
broadcast has no bound.

### 2.9 Failure, resume, cancel and delete

**Failure listener.** `BroadcastFailureListener`
(`broadcast-failure.listener.ts`) subscribes to `JOB_SETTLED_EVENT`. When a
start or chunk job for a broadcast settles permanently `failed`, it CASes the
broadcast `sending` → `failed`, with `lastError` = `"<Start|Chunk> job <id>
failed permanently after <N> attempt(s): <cause>"` and `finishedAt` = the job's
`finishedAt`. A broadcast already `sent`, `canceled` or `failed` is untouched.
Errors are logged, never rethrown into the settle path. This covers attempt
exhaustion, rate-limit exhaustion, and the lease reaper's give-up (which also
emits `job.settled`). It is a listener, not a job: one bounded, single-row,
indexed update.

**Resume.** `POST /api/admin/broadcasts/:id/resume` (`BroadcastsService.resume`)
is the only writer of `failed` → `sending`. It clears `lastError` and
`finishedAt` and enqueues a fresh chunk (`skipDedup: true`, `reason: 'rerun'`)
from the persisted cursor. 404 for a missing row, 409 for any status but
`failed`. If the enqueue throws, it flips the row back to `failed` with a
`lastError` naming the enqueue failure, then rethrows. Retrying the dead chunk
job from the Jobs page does **not** resume: the chunk's status guard sees
`failed` and returns.

**Cancel.** `POST /:id/cancel` from `scheduled`, `sending` or `failed` (409
otherwise, 404 if missing). It does not delete queued jobs; each handler's
status guard makes them no-ops. Cancelling a `sending` broadcast can still let
up to one 25-recipient sub-group already dispatched or in flight go out. The API
description and the confirm dialog say so.

**Delete.** `DELETE /:id` answers 204, or 409 while `sending` (deleting the
row would not stop the fan-out; cancel first).

**Job deletion is refused while the broadcast is live.** Both handlers
implement `JobHandler.canDelete` via `broadcastJobDeleteRefusal`
(`broadcast-job-delete-guard.ts`): `DELETE /api/admin/jobs/:id` on a
non-terminal fan-out job whose broadcast is `scheduled` or `sending` answers
409 (`details.reason: 'owner_refused'`). A delete is not a settlement, so
nothing would learn the broadcast was stranded. Once the job is terminal, or
the broadcast is missing, `sent`, `canceled` or `failed`, deletion is allowed.
See [job-queue.md](job-queue.md).

### 2.10 Email provider rate limits

The email channel never throws. `BaseEmailProvider.send`
(`email/base-email.provider.ts`) classifies the raw error with
`classifyEmailRateLimit` (`email/email-rate-limit.ts`):

- Rate limit: SES throttle names, HTTP `429`/`503`/`529`, a `Retry-After`
  header, and SMTP `421`/`450`/`451`/`452`/`454` only when the reply text says
  rate, throttle, too many, slow down or server busy.
- Not a rate limit: SES's daily quota (it outlasts the queue's rate-limit
  budget), greylisting, full mailbox, over quota, auth failures, SMTP 5xx.

A throttled send returns `{ success: false, rateLimited: true, retryAfterMs? }`
and the delivery row's `error` starts `Rate limited by the email provider: `.
Web Push 429s are not classified.

`BroadcastChunkHandler` is the one layer that turns the flag into a
`RateLimitError`. On the first rate-limited recipient it stops launching sends
(in-flight ones finish), commits the cursor to the longest contiguous prefix,
in id order, of recipients that completed without being throttled, enqueues no
successor, and throws. The queue defers the same chunk row under
`JOBS_RATELIMIT_*` backoff, charged to `rateLimitHits`, not `attempts`. The
chunk type is registered to provider key `notifications.email`
(`BROADCAST_EMAIL_PROVIDER_KEY`), so `ProviderThrottleService` holds off every
broadcast's chunks during the cooldown. Recipients who completed out of order
after the throttled one are re-sent on resume (at most
`BROADCAST_SEND_CONCURRENCY`). If a cancel is observed once the page stops,
the chunk returns normally instead of deferring. Losing the cursor CAS on a
throttled page also returns normally. After `JOBS_RATELIMIT_MAX_HITS`
(default 10) the chunk fails permanently and the listener marks the broadcast
`failed`.

### 2.11 Delivery statistics and the SSE boundary

`notification_deliveries` carries no broadcast id. `GET /:id` returns
`approximateDeliveryAttempts`: a `groupBy(['channel', 'status'])` over rows
with this broadcast's `eventKey` and `createdAt` in `[startedAt, finishedAt ??
now]`. Two broadcasts sending at once under the same key over-count; the name
and the UI label ("delivery attempts during this broadcast") say so. For a
`failed` broadcast the window is closed at `finishedAt`; a resume clears it and
the window reopens. `startedAt` never moves.

Live toasts reach only tabs connected to the process that dispatched a given
recipient (the SSE stream is per-process). The durable row and `GET
/api/notifications` are the source of truth.

## 3. Configuration and permissions

### Permissions

- `broadcasts:read`: list, get, audience count.
- `broadcasts:write`: create, test-send, cancel, resume, delete.
- Every route also requires the Admin role. Both permissions are seeded to
  Admin only. See [ARCHITECTURE.md](../ARCHITECTURE.md) for the matrix.

### Admin UI

The **Broadcasts** card in the Operations group of `ADMIN_SECTIONS`
(`apps/web/src/config/adminSections.tsx`), path `/admin/settings/broadcasts`,
`permission: 'broadcasts:read'`. Write controls inside the page are disabled
without `broadcasts:write`. The page lists broadcasts, composes (with a native
`datetime-local` schedule field), shows detail with approximate delivery
counts, and offers cancel and resume (resume only on `failed`).

### Settings and environment

No settings namespace and no environment variables of its own. It depends on:

- the `notifications` system settings (kill switch; see
  [browser-notifications.md](browser-notifications.md));
- the email transport (`/admin/settings/email`) and VAPID configuration
  (`/admin/settings/push`) for the email and push legs;
- `JOBS_RATELIMIT_MAX_HITS`, `JOBS_RATELIMIT_BASE_MS`, `JOBS_RATELIMIT_MAX_MS`
  for throttle deferrals (see `infra/compose/.env.example`).

### API surface

| Method and route | Purpose | Permission |
|---|---|---|
| `GET /api/admin/broadcasts/audience` | Count of users a broadcast would reach now (`activeUsers`) | `broadcasts:read` |
| `POST /api/admin/broadcasts/test` | Send this composition to yourself; no broadcast row, no job | `broadcasts:write` |
| `GET /api/admin/broadcasts` | List (`page`, `pageSize` ≤ 100, `status`) | `broadcasts:read` |
| `POST /api/admin/broadcasts` | Create and queue; 201 `{ broadcast, warnings }` | `broadcasts:write` |
| `GET /api/admin/broadcasts/:id` | One broadcast with `approximateDeliveryAttempts` | `broadcasts:read` |
| `POST /api/admin/broadcasts/:id/cancel` | Cancel from `scheduled`/`sending`/`failed` | `broadcasts:write` |
| `POST /api/admin/broadcasts/:id/resume` | `failed` → `sending` from the cursor | `broadcasts:write` |
| `DELETE /api/admin/broadcasts/:id` | Delete; 409 while `sending` | `broadcasts:write` |

The literal routes (`audience`, `test`) are declared before `:id` in the
controller so the router resolves them first. Every state-changing route writes
an audit event with identifiers and shape, never the composed body.

## 4. Extending it in a fork

- **Audience targeting** (by role, by user list) is not built. Add it as a new
  predicate beside `audienceWhere()` and use it in all three readers (audience
  count, start count, chunk paging). The count and the paging must share one
  predicate.
- **Exact per-broadcast delivery counts** would need a broadcast id on
  `notification_deliveries`; see §6 for why the template does not.
- **A new send path for `admin.broadcast_critical`** outside
  `CreateBroadcastDto` must enforce `critical ⇒ browser` itself.
- **New job types that chain themselves** must enqueue their successor with
  `skipDedup: true`, as the chunk handler does. The general recipe is
  [`apps/api/src/jobs/handlers/README.md`](../../apps/api/src/jobs/handlers/README.md).
- Adding a channel to the broadcast events is a registry edit plus a template;
  see the [notifications README](../../apps/api/src/notifications/README.md).

## 5. Guardrails

API unit specs (`apps/api/src/`):

- `notifications/broadcasts/handlers/broadcast-start.handler.spec.ts`: claim
  CAS, one-instant stamping, `audienceWhere()` count, `skipDedup: true`, the
  resume conditions, cancel between claim and hand-off.
- `notifications/broadcasts/handlers/broadcast-chunk.handler.spec.ts`: status
  guard, keyset paging, `notifyNow` dispatch, cursor-after-send, successor only
  with `skipDedup: true`, mid-page cancel, cursor CAS, rate-limit stop.
- `notifications/broadcasts/handlers/broadcast-chunk-rate-limit.integration.spec.ts`:
  throttled chunk deferral.
- `notifications/broadcasts/broadcasts.service.spec.ts`: cancel, remove,
  resume (including compensation), test send, audience, approximate counts,
  audit without the body.
- `notifications/broadcasts/broadcast-failure.listener.spec.ts`: `sending` →
  `failed` only.
- `notifications/broadcasts/broadcast-job-delete-guard.spec.ts`: `canDelete`
  refusal matrix.
- `notifications/notifications.service.spec.ts`: `NotifyOptions.channels`
  narrowing, mandatory still narrowable, `notifyNow` result.
- `notifications/notification-events.spec.ts`: registry invariants for both
  keys.
- `email/email-rate-limit.spec.ts`, `email/base-email.provider.spec.ts`,
  `notifications/channels/email-notification.channel.spec.ts`: throttle
  classification.
- `email/templates/broadcast.email.spec.ts`: escaping by construction.

API integration and database suites (`apps/api/test/broadcasts/`):

- `broadcasts.integration.spec.ts`: literal routes before `:id`, Admin plus
  permission on all eight routes, `critical` validation, resume route.
- `broadcast-model.db.spec.ts`: fields, enum, indexes on real Postgres.
- `broadcast-fanout.db.spec.ts` (`npm run test:db`): real handlers and
  `JobsService` against Postgres with `notifyNow` stubbed. Exact audience
  (active, `createdAt ≤ cutoff`), concurrent start claims resolve to one
  winner, replay after cursor advance, cancel between and during chunks,
  failure listener through the real `JobTerminalService` and through the
  reaper, stranded-start recovery, resume, and two concurrent chains
  collapsing to one.

Web (`apps/web/src/__tests__/`): `pages/Admin/BroadcastsPage.test.tsx`,
`components/admin/BroadcastComposer.test.tsx`,
`components/admin/BroadcastDetailDialog.test.tsx`,
`hooks/useBroadcasts.test.ts`, `services/broadcasts.test.ts`.

The database suite proves who is dispatched to under two overlapping
executions on one Postgres; not that mail or a push arrives.

## 6. Design decisions

- **Two event keys, not a per-send "important" flag.** `mandatory` is a static
  registry property that `isChannelEnabled` and `policyChannels` branch on;
  making it per-send would put a composer's choice inside the gate that decides
  whether a user may mute. Two keys also let the preferences matrix show one
  muteable and one unmuteable row honestly.
- **Intersection after `resolveChannels`, not inside it.** Keeps a
  dispatch-time concept out of the function the preferences endpoint shares,
  and makes narrowing-only structural.
- **`critical ⇒ browser` in the DTO, not the dispatcher.** Folding it into
  `dispatch()` would give `mandatory` two meanings in two files.
- **`Job.scheduledFor`, not a `@Cron` scheduler.** The queue already stores
  the time durably and indexes it; a cron would be a second place deciding "is
  it time yet?".
- **Chunks of 200, not one job per recipient.** Thousands of rows per send
  swamp the Jobs dashboard, the history purge and per-type stats.
- **Chunks, not one long job.** A single job holds a worker slot for the whole
  send, needs an unpredictable lease, and shows no progress.
- **No recipients join table.** One row per user per broadcast grows without
  bound (50,000 users, weekly: 2.6 million rows a year). Cursor, cutoff and
  counters already bound a replay to one chunk.
- **No `broadcastId` on `notification_deliveries`.** A migration on the
  fastest-growing table plus threading a caller id through a caller-agnostic
  dispatcher, to make one number exact.
- **Plain text only.** Markdown or HTML needs `unsafeFromTrustedString` on
  admin input (stored XSS from a compromised admin) or a hand-rolled emitter;
  neither means anything on browser/push.
- **Reuse `backfill` as the job reason.** A new `JobReason` value is a
  migration plus web and OpenAPI churn for a display string the job-type label
  already carries.
- **`broadcasts:*`, not `system_settings:*`.** The card would otherwise
  advertise a permission the broadcasts controller never checks.
- **Native `datetime-local`, not `@mui/x-date-pickers`.** No new dependency
  for one field.

## 7. Verification

Automated:

```bash
cd apps/api && npm test -- broadcast
cd apps/api && npm run test:db -- broadcast
cd apps/web && npm test -- run Broadcast broadcasts
```

Manual:

1. Sign in as Admin and open `/admin/settings/broadcasts`. The audience count
   matches active users.
2. Compose a message with `email` and `browser`, click "Send test to me".
   Only you receive it; no broadcast row appears.
3. Send it now. The row moves `scheduled` → `sending` → `sent`;
   `recipientsDispatched` reaches `recipientsTargeted` (less any users
   deactivated mid-send). The Jobs page shows one "Broadcast start" job and
   one "Broadcast delivery" job per page of up to 200 recipients.
4. Mark it critical without `browser`: the composer shows a 400.
5. Schedule one for a few minutes ahead, then cancel it. It reads `canceled`
   and the start job, when claimed, does nothing.
6. As a non-admin, check `/settings/notifications`: "Announcements" has a
   toggle; "Important announcements" cannot be switched off.

## History

- Epic #319: #320 model and `broadcasts:*`; #321 the two events, channel
  narrowing and `notifyNow`; #322 templates; #323 fan-out handlers; #324 admin
  API; #325 admin page and composer; #326 database-level concurrency suite.
- Later issues: #456 email rate limits; #459 `failed`, resume and the cursor
  CAS; #468 reaper give-up emits `job.settled`; #469 idempotent start; #480
  `canDelete` guard.
- #521: corrected this doc's account of the create-time browser-kill-switch
  warning — a non-critical broadcast gets no in-app row while browser
  notifications are disabled, unless `push` is also selected and the
  recipient has a subscription; a critical one always gets its row.
