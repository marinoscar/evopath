# Background Job Queue

> **Status:** shipped · **Code:** `apps/api/src/jobs/`, `apps/api/prisma/schema.prisma` (`Job`, `JobStatsRollup`) · **API:** `/api/admin/jobs/*` (see `/api/docs`) · **Admin UI:** `/admin/settings/jobs`, `/admin/settings/jobs/insights` · **Recipe:** [apps/api/src/jobs/handlers/README.md](../../apps/api/src/jobs/handlers/README.md) · **Related:** [worker-nodes.md](worker-nodes.md)

The job queue is a PostgreSQL `jobs` table that every long-running activity in the application goes through. A feature enqueues a row; an executor claims it atomically with `FOR UPDATE SKIP LOCKED` under a lease, runs the handler registered for its `type`, and settles it through one terminal chokepoint that decides succeed, retry, defer or fail. The executor is either the in-process worker pool inside the API or a remote worker node; the same handler code runs in both places. A lease reaper recovers work whose executor died, a nightly purge compacts history into lifetime counters, and an admin API reports on and repairs the queue.

## 1. Purpose

An app built from this template needs somewhere to put work that outlives a request: exports, sweeps, dumps, provider calls, fan-out. The queue gives that work what a bare `@Cron` or a detached promise cannot:

- **Retries** with backoff and a bounded attempt budget, plus a separate budget for provider rate limits.
- **Observability**: every run is a row with a status, duration, attempt count and `lastError`, listed at `/admin/settings/jobs`.
- **Safety across replicas**: two claimers never receive the same row, and a dead executor's work is recovered.
- **Offload**: node-eligible types can run on a worker node instead of the API process.

A fork adds a job type with one class and no queue wiring: no migration, no enum, no `switch`, and the type appears in the admin dashboard on its own.

What it is not:

- **Not Redis or BullMQ.** The template already requires PostgreSQL; a second datastore on the default path is a cost every fork pays.
- **Not a second process by default.** The worker runs in the API process. Worker nodes are optional and additive.
- **Not exactly-once.** Delivery is at-least-once. A handler can run twice (a retry after a partial failure, or a lease that expired while the executor was still working). Handlers should be idempotent where the operation allows.
- **Not a distributed rate limiter.** The provider throttle gate is in-memory per process; the durable deferral lives in the row.
- **Not a scheduler.** A `@Cron` decides whether work is due and enqueues it; it does not do the work.

## 2. How it works

### Components

| File (under `apps/api/src/jobs/`) | Role |
|---|---|
| `job-handler.interface.ts` | The `JobHandler` contract |
| `job-handler.registry.ts` | `register`, `get`, `types`, `serverOnlyTypes` |
| `job-type-labels.ts` | Display labels (`jobTypeLabel`) |
| `jobs.service.ts` | `enqueue`, `recordProvider` |
| `job-keys.ts` | `buildDedupKey` |
| `job-claim.service.ts` | The atomic claim |
| `job-execution-profile.ts` | Per-type `profile`, lease horizon, attempt budget |
| `job-lease.service.ts` | Lease renewal, `heldLeaseWhere`, `heldClaimWhere` |
| `job-terminal.service.ts` | The terminal chokepoint (`completeSucceeded`, `completeFailed`) |
| `backoff.util.ts`, `rate-limit.error.ts`, `provider-throttle.service.ts` | Backoff, rate-limit classification, throttle gate |
| `events/job-settled.event.ts`, `job-settled.emit.ts` | The `job.settled` event |
| `job.worker.ts` | The in-process worker pool and worker modes |
| `node-offload.service.ts` | Which types nodes are offered right now |
| `job-stuck.service.ts`, `tasks/job-stuck-reset.task.ts` | The lease reaper |
| `handlers/job-history-purge.handler.ts`, `tasks/job-history-purge.task.ts` | History purge and lifetime rollup |
| `job-temp.ts`, `tasks/temp-file-janitor.task.ts` | Temp-file prefix and janitor |
| `housekeeping.enqueue.ts` | Shared helper crons enqueue through |
| `job-secret-broker.ts` | `JobSecretBroker` for per-job node credentials |
| `job-admin.controller.ts`, `job-admin.service.ts`, `job-insights.service.ts`, `job-counts.util.ts`, `dto/` | Admin API and insights |
| `contracts/` | Node result schemas |

### The `jobs` row

| Column | Meaning |
|---|---|
| `type` | Plain `text`, not an enum, so a new handler costs zero migrations and a row can outlive its handler |
| `status` | `pending` \| `running` \| `succeeded` \| `failed` |
| `reason` | `upload` \| `rerun` \| `backfill` |
| `priority` | Ascending is more urgent; default `0`; housekeeping uses `100` |
| `subject_type`, `subject_id` | Polymorphic subject, plain `text`, no foreign key |
| `dedup_key` | Set by `buildDedupKey(type, subjectType, subjectId)` → `type:subjectType:subjectId`; `NULL` with `skipDedup` |
| `payload` | Opaque JSONB; identifiers, not copies of data |
| `attempts` | Attempts **started**; charged at claim time |
| `rate_limit_hits`, `rate_limited_at` | The separate rate-limit budget |
| `scheduled_for` | Not claimable before this instant (retry backoff, deferral) |
| `started_at`, `finished_at`, `created_at` | Timestamps |
| `lease_expires_at`, `claimed_by_node_id`, `claim_token` | The current claim; all three cleared together |
| `executor` | `server` or `node`; audit, kept on terminal rows |
| `last_error` | Last failure message, truncated at 2000 characters |
| `provider_key`, `model_version` | Audit columns written by `recordProvider` |

Two partial indexes exist only in `prisma/migrations/20260906120000_add_jobs/migration.sql`, because Prisma cannot express a `WHERE` on an index: `jobs_active_dedup_uniq_idx` (the dedup enforcement) plus `jobs_attempts_gt1_idx` and `jobs_succeeded_duration_idx` (insights). This is intentional schema drift; do not add a `@@unique` to the model.

`job_stats_rollup` holds one row per type: `succeeded_count`, `failed_count`, `sum_duration_ms` (`Float`, so `JSON.stringify` never meets a `BigInt`) and `duration_samples`.

### Handler contract

```ts
export interface JobHandler {
  readonly type: string;
  process(job: Job): Promise<void>;

  // Optional; presence is the declaration.
  readonly nodeResultSchema?: z.ZodType;
  persistNodeResult?(job: Job, result: unknown): Promise<void>;
  readonly profile?: JobExecutionProfile;          // { maxRuntimeMs, maxAttempts }
  deriveOutputKey?(job: Job): Promise<string>;
  nodeOffloadEnabled?(): Promise<boolean>;
  readonly nodeSecretBroker?: JobSecretBroker;
  canDelete?(job: Job): Promise<string | null>;
}
```

- **`type`** is dotted, lowercase and product-neutral (`export.csv`), and permanent once rows of that type exist.
- **`process` throws to fail.** There is no result object. A thrown error becomes `lastError` and a retry; a normal return means the work committed. A handler with no error handling at all fails correctly, and swallowing an error is the visible, deliberate act.
- **`attempts` already includes the current attempt** when `process` runs.
- The optional members are described where they act: node eligibility below, `profile` in Execution profile, `deriveOutputKey`/`nodeOffloadEnabled`/`nodeSecretBroker` in [worker-nodes.md](worker-nodes.md), `canDelete` in Admin API behaviour.

### Registration

A handler registers itself from its own `onModuleInit`:

```ts
onModuleInit(): void {
  this.registry.register(this);
}
```

There is no decorator and no discovery scan. A duplicate `type` logs a warning and the last registration wins, so a fork can shadow a framework handler without editing it.

The worker starts from `onApplicationBootstrap`, never `onModuleInit`. Nest runs every `onModuleInit` before any `onApplicationBootstrap`, so every handler is registered before the first claim. Losing that race would permanently fail a good job as an unknown type. `src/jobs/job.worker.bootstrap.spec.ts` proves it with a handler that stalls 40ms before registering.

### Node eligibility

Eligibility is derived from two members, never declared:

| Handler carries | Meaning |
|---|---|
| Both `nodeResultSchema` and `persistNodeResult` | Node-eligible |
| Neither | Server-only (the default) |
| Exactly one | Server-only |

`JobHandlerRegistry.serverOnlyTypes()` is that derivation. There is no `nodeEligible` flag, because a flag can disagree with the members it describes.

`persistNodeResult` persists an already-validated result and nothing else. It never recomputes the work, re-downloads the input or calls the provider again. If a result cannot be stored without redoing the work, the type is not node-eligible. `result: unknown` is deliberate: the value arrives from off-machine and only `nodeResultSchema` may narrow it.

Structural eligibility is not the same as being offered. `NodeOffloadService.offeredTypes()` intersects eligibility with runtime gates at claim time; see Worker modes and [worker-nodes.md](worker-nodes.md).

### Display labels

`job-type-labels.ts` maps a `type` to a human phrase for the dashboard. `jobTypeLabel(type)` falls back to the raw type string, because a fork's types are ones this map has never heard of and a row can name a type whose handler is gone. A label is optional polish.

### Enqueue and dedup

`JobsService.enqueue({ type, reason, subjectType?, subjectId?, payload?, priority?, scheduledFor?, skipDedup? })` inserts optimistically:

```
INSERT → P2002 on jobs_active_dedup_uniq_idx → re-read the ACTIVE row → return it
```

- `jobs_active_dedup_uniq_idx` is a partial unique index on `dedup_key` `WHERE status IN ('pending','running') AND dedup_key IS NOT NULL`. Only the database can make "is there already an active job with this key" atomic with the insert.
- The caller gets either its new row or the active row that beat it, with no flag distinguishing them. When dedup collapses a call, `reason`, `priority`, `payload` and `scheduledFor` are the first caller's.
- `skipDedup: true` leaves `dedup_key` `NULL`; NULLs never collide, so any number coexist.
- A job reaching `succeeded` or `failed` leaves the index predicate and frees its key. Dedup only collapses work still in flight.
- A P2002 from any other constraint propagates. `isActiveDedupConflict()` must positively recognise this index.
- If the re-read finds no active row (the holder settled in between), enqueue inserts again. The loop is bounded at three attempts, then errors.

`recordProvider(jobId, providerKey, modelVersion)` writes the two audit columns and never throws; a failed annotation must not fail a job whose work succeeded.

### Claim

`JobClaimService.claim({ nodeId, executor, eligibleTypes, limit, leases })` is one statement, shared verbatim by the in-process worker and the node control plane:

```sql
WITH picked AS MATERIALIZED (
  SELECT id FROM jobs
  WHERE status = 'pending'
    AND (scheduled_for IS NULL OR scheduled_for <= now())
    AND type = ANY($types::text[])
  ORDER BY priority ASC, created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT $limit
)
UPDATE jobs SET
  status = 'running', started_at = now(), scheduled_for = NULL,
  attempts = attempts + 1,
  claimed_by_node_id = $nodeId::uuid, executor = $executor,
  claim_token = gen_random_uuid(),
  lease_expires_at = now() + (l.lease_ms * interval '1 millisecond')
FROM picked p, unnest($types::text[], $leaseValues::double precision[]) AS l(type, lease_ms)
WHERE jobs.id = p.id AND jobs.type = l.type
RETURNING …
```

- There is no gap between choosing a row and owning it.
- **`MATERIALIZED` is load-bearing.** With the `unnest` join present, Postgres may re-evaluate a plain `id IN (SELECT …)` per outer row, each taking its own `SKIP LOCKED` locks, and `LIMIT` stops being a limit. It is plan-dependent; `test/jobs/job-claim.db.spec.ts` is the regression test.
- Each row gets its own type's lease (`buildClaimLeases`) and its own `claim_token`, minted by the statement, never a bound parameter.
- An empty `eligibleTypes` or `limit <= 0` returns `[]` with no round trip.
- `ORDER BY` decides which rows are taken; the returned array is a set, not a sequence.
- `RETURNING` aliases every column to its camelCase field, derived from `JOB_CLAIM_COLUMNS` (typed `Record<keyof Job, string>`), so a schema change is a compile error. Runtime values are all bound parameters.

### Attempts are charged at claim

`attempts = attempts + 1` is in the claim, not in any failure path. A job that OOM-kills or crashes its process never reaches a failure handler; charging at claim is what lets the reaper see that its budget is spent and stop a crash loop after N crashes. The cost is that a job interrupted by a deploy loses one attempt. The rate-limit deferral path gives the attempt back.

### Execution profile

`JobHandler.profile` is optional and carries exactly `{ maxRuntimeMs, maxAttempts }` (`job-execution-profile.ts`). Omitted, a type uses `JOBS_JOB_TIMEOUT_MS` and `JOBS_MAX_ATTEMPTS`.

- **The lease is derived**: `maxRuntimeMs + LEASE_GRACE_MS` (60s), or unbounded when `maxRuntimeMs: 0`, through `resolveJobLeaseMs` in `job.worker.ts`, the same function the deployment-wide timeout uses.
- **The renewal interval is derived**: lease ÷ 3, clamped to 5–60s (`resolveRenewIntervalMs`), so a renewer may miss two ticks and still hold the job.
- Do not add `leaseMs`, `heartbeatMs`, `retryBackoffMs`, `priority` or `concurrencyLimit` to the profile. Each can disagree with `maxRuntimeMs`.
- `resolveJobProfile(handler)` validates: `maxRuntimeMs` finite and `>= 0`, `maxAttempts` finite and `>= 1`. An invalid profile is dropped whole, with one warning per type.
- `resolveMaxAttempts(config, handler)` is read by both give-up paths, the terminal service and the reaper, so a `maxAttempts: 1` type is never resurrected by the reaper.

Worked example: `db.backup.run` declares `maxRuntimeMs: 6h`, `maxAttempts: 1`. Every `ai.*` type and `db.restore.run` also declare profiles.

### Lease renewal and the claim token

A claim writes `lease_expires_at` once. `JobLeaseService.renew` extends it, and both executors reach it: nodes over `POST /api/nodes/{id}/jobs/{jobId}/renew`, the in-process worker through `JobWorker.startLeaseRenewal`, a self-rescheduling `setTimeout` (never `setInterval`) that ticks every `resolveRenewIntervalMs(leaseMs)` for as long as `process()` runs, on the same lease the claim took.

- **The guard is in the write.** `heldLeaseWhere(jobId, holder)` requires the row still `running` with an unexpired lease, matched in the `UPDATE` itself. Zero rows updated means the row is no longer this executor's: renewal stops and logs at `error`. The work is not cancelled (JavaScript cannot cancel a promise), but the executor stops speaking for the row.
- **A renewal that fails on a database error is not a lost lease.** Only an actually expired lease stops the ticker.
- **`claim_token` identifies one claim of one row.** `claimed_by_node_id` alone cannot tell two API replicas apart (both claim with `null`). With the token, replica A's renewal after replica B re-claimed the row matches nothing.
- **Invariant: `claim_token IS NOT NULL` exactly while the row is claimed.** Every un-claim path (terminal writes, both reaper phases, admin retry) clears it with `claimed_by_node_id` and `lease_expires_at`. It is not published in the admin list.
- `holder.claimToken` is three-valued: absent asserts nothing, `null` asserts `claim_token IS NULL`, a uuid asserts one claim. The CLI omits the key rather than sending `null`.
- **The node plane quotes the token back** on `renew`, `result`, `failure`, `download-url`, `upload-url` and `secret`. It is optional on the wire; an older node falls back to `claimed_by_node_id` alone. See [worker-nodes.md](worker-nodes.md).
- **Settle writes are claim-conditional too.** `heldClaimWhere(job)` is id, `status = 'running'`, the same `claim_token`, the same `claimed_by_node_id`, and deliberately **no lease-expiry clause**. Renewal asks a liveness question (it asserts the future); settle asks an identity question (it records the past). A row still `running` under this token has not been given to anyone else, so an expired-but-unreaped settle is allowed to land.
- During a rolling deploy an old replica that does not send the token can still extend or settle a new replica's claim until it rolls off.

### Terminal state machine

Once a job stops running, `JobTerminalService` is the only component that decides what happens to the row. Both executors call `completeSucceeded(job)` or `completeFailed(job, error, opts?)`. Each returns a `JobSettleOutcome`:

| Outcome | Meaning |
|---|---|
| `succeeded` | Written as succeeded |
| `failed` | Written as permanently failed |
| `retry-scheduled` | Back to `pending` with a backoff `scheduledFor` |
| `rate-limit-deferred` | Back to `pending`, attempt un-charged, `rateLimitHits` + 1 |
| `write-failed` | The write failed twice; row left `running` for the reaper |
| `claim-lost` | The row is no longer held by this claim; nothing written, nothing emitted |

#### Classification order

1. A thrown `RateLimitError` (optionally carrying `retryAfterMs`).
2. `classifyRateLimit(error)`: reads a status from `err.status ?? err.statusCode ?? err.response?.status ?? err.$metadata?.httpStatusCode`; 429 and 503/529-style overload are rate limits; so are AWS throttle names (`ThrottlingException`, `TooManyRequestsException`, `SlowDown`, `RequestThrottled`, `ProvisionedThroughputExceededException`, …) even with a 400 status. It is total and never throws.
3. The caller's `opts.rateLimited` (how a node reports a rate limit as data).
4. Otherwise an ordinary failure.

`CompleteFailedOptions.permanent` short-circuits ahead of all of these: the job fails immediately with no retry. The worker uses it for a claimed type with no handler.

The delay comes from the first source that named one. `parseRetryAfterMs` accepts integer delta-seconds and an HTTP-date; absent, unparseable, negative or past input is `null`, meaning "no opinion", never zero.

A node-reported `{ rateLimited: true, retryAfterMs }` produces a byte-identical write and throttle-gate trip to a thrown `RateLimitError`.

#### Two budgets

| Budget | Bounds | Limit | Backoff |
|---|---|---|---|
| `attempts` | Bugs | `resolveMaxAttempts` (profile, else `JOBS_MAX_ATTEMPTS`, default 3) | `JOBS_RETRY_BASE_MS` → `JOBS_RETRY_MAX_MS` |
| `rateLimitHits` | Waiting on a provider | `JOBS_RATELIMIT_MAX_HITS` (default 10; deployment-wide only) | `JOBS_RATELIMIT_BASE_MS` → `JOBS_RATELIMIT_MAX_MS` |

- **Ordinary failure**: retry while `attempts < maxAttempts` (`attempts` already counts the attempt that just failed), else terminal `failed`.
- **Rate-limited**: trip the throttle gate, increment `rateLimitHits`, set `rateLimitedAt`, compute `scheduledFor`, un-charge the attempt, return to `pending`. Terminal `failed` only when `rateLimitHits` exceeds its own budget.
- Every branch releases `claimedByNodeId`, `claimToken` and `leaseExpiresAt`, and records `lastError`. `executor` is never cleared on the terminal path; it is audit. `lastError` is kept on success.

**The un-charge is an absolute value**: `attempts: job.attempts - 1`, clamped at 0, never `{ decrement: 1 }`. The write may genuinely apply twice, and a relative decrement would grant an unearned attempt.

#### Backoff

`computeBackoffMs` (equal jitter, injectable RNG):

```
exp   = min(maxMs, baseMs * 2^(attempt - 1))
delay = max(retryAfterMs ?? 0, exp / 2 + rand() * exp / 2)
```

Jitter keeps jobs deferred by one outage from retrying in the same millisecond. `retryAfterMs` is a floor, not an override.

#### Provider throttle gate

`ProviderThrottleService` shares one slot's discovery of a rate limit with the others. `registerProviderKey(type, key)` maps a type to a provider key; types sharing one quota should share one key. `trip(type, delayMs)` sets a cooldown on the key (extends, never shortens); `acquire(type)` waits it out before processing, capped at `JOBS_RATELIMIT_MAX_MS`; `recordSuccess(type)` clears it. A type with no key is a zero-cost no-op. The gate is tripped before the terminal write, on both the thrown and the node-reported paths. Today `admin.broadcast.chunk` registers `'notifications.email'`.

```ts
onModuleInit() {
  this.registry.register(this);
  this.throttle.registerProviderKey(this.type, 'acme-vision');
}
```

#### Guarded terminal write

Every terminal write goes through `safeTerminalUpdate`: `updateManyAndReturn({ where: heldClaimWhere(job) })`, retried once after 250ms, never thrown out of. A throw would leak a worker slot for the life of the process.

1. The first attempt returns no row without throwing → `claim-lost`.
2. The first attempt throws and the retry matches nothing → re-read the row by id. If it already carries exactly the values this write would have written (`rowMatchesWrite`), the first write committed → treat as written and emit. Otherwise → `claim-lost`. If the re-read throws → `write-failed`.
3. The retry itself throws → `write-failed`; the row stays `running` for the reaper.

Every terminal payload is plain scalars, `Date`s and `null`. `assertPlainTerminalData` throws on a Prisma operator, which would make rule 2 undecidable.

#### `job.settled`

`JobSettledEvent` is emitted through `EventEmitter2`, after the write, carrying the returned row, only when the job is genuinely over: `succeeded` or a give-up on either budget (including `permanent`). A retry or deferral emits nothing; `claim-lost` and `write-failed` emit nothing. The reaper's own give-up emits the same event through the shared `emitJobSettled` helper. The emit is wrapped in `try/catch`: a listener must not affect the row or the slot, and should enqueue a job rather than do real work.

Because every writer (both executors and the reaper) is claim-conditional, `job.settled` fires exactly once per settled job.

#### Test seams

`JOB_CLOCK` and `JOB_RANDOM` are optional DI tokens nothing in production provides. Services fall back to the real clock and `Math.random`; only a test constructing a service directly substitutes them, so delays can be asserted exactly.

### Worker modes

`JobWorker` (`job.worker.ts`) is provided by `JobsModule` and not exported. It writes nothing itself: rows enter through `JobClaimService.claim` and leave through `JobTerminalService`.

- **Slots.** `JOBS_WORKER_CONCURRENCY` independent loops, each claiming one job, running it, and going round again. An empty queue sleeps `JOBS_POLL_MS`; a slot that just finished does not sleep. A claim query that throws backs off instead of spinning.
- **Modes**, re-read on every claim:

  | `JOBS_WORKER_MODE` | Claims |
  |---|---|
  | `all` (default) | Every registered type |
  | `system` | Every registered type **not** in `NodeOffloadService.offeredTypes()`, plus `JOBS_SYSTEM_MODE_EXTRA_TYPES` |
  | `off` | Nothing: a pure control plane that still enqueues and serves the API |

- **An unrecognised mode warns once and behaves as `all`.** A typo must not silently stop all background work. The warning is latched at module level.
- **`system` is the complement of the node offer set**, so the fleet and the server partition the queue by construction. A structurally eligible type whose node gates are closed (for example `db.backup.run` with offload off) is still claimed by the server. `JOBS_SYSTEM_MODE_EXTRA_TYPES` is only for deliberately also running a type the fleet may run (a small or paused fleet); an entry no handler registers is dropped with one warning. Overlap is safe under `SKIP LOCKED`.
- **Eligible types are resolved per claim**, never captured at bootstrap, so a late registration and runtime gate changes are seen.
- **Per-job timeout.** `JOBS_JOB_TIMEOUT_MS` (or the profile's `maxRuntimeMs`) bounds how long a job holds a slot. A timeout is an ordinary failure (`JobTimeoutError` in `lastError`). The work is not cancelled; the slot is freed. `withTimeout` attaches handlers to the work promise before the race so a late rejection is never an `unhandledRejection`, and a late success never marks the job succeeded.
- **Unknown type.** A claimed job whose type has no handler is failed permanently through `completeFailed(..., { permanent: true })`.
- **Shutdown.** `onModuleDestroy` stops claiming, wakes every sleeping slot (all timers live in one `unref`'d set), and waits at most five seconds for in-flight jobs. Anything still running is left with its lease for the reaper.

### Lease reaper

`JobStuckService` defines "abandoned" and recovers it. `tasks/job-stuck-reset.task.ts` runs it every ten minutes; `POST /api/admin/jobs/reset-stuck` runs the same method on demand.

`stuckRunningWhere(threshold, now, leaseHorizon)` is four OR'd clauses over `status = 'running'`:

```ts
{ status: 'running', OR: [
    { leaseExpiresAt: null, startedAt: { lt: threshold } },                  // aged, unleased
    { leaseExpiresAt: null, startedAt: null, createdAt: { lt: threshold } }, // zombie
    { leaseExpiresAt: { lt: now } },                                        // dead owner
    { leaseExpiresAt: { gt: leaseHorizon } },                               // implausible lease
]}
```

| Signal | Catches |
|---|---|
| Aged, unleased | A row with no lease running longer than `jobs.stuckThresholdMinutes`. Age is consulted only when there is no lease, so a renewing job is safe at any age. |
| Zombie | `running` with no `startedAt` and no lease (a partial write or external claim path). `NULL < threshold` is never true, so no other clause sees it; `createdAt` is the substitute age. |
| Dead owner | A lease past `now`. Covers a killed replica and a vanished node identically. |
| Implausible lease | A lease further out than `resolveLeaseHorizonMs`: the longest lease any registered handler could request, plus one grace (the deployment-wide lease is always included). Computed fresh per sweep. Removing a type or lowering a runtime shortens the horizon, and an in-flight row with the older lease may be reaped on the next sweep. |

`resetStuck(olderThanMinutes?)` returns `{ reset, failed }` in two phases:

1. **Give up** on rows at or over their attempt budget (`resolveMaxAttempts`), one row at a time so each `lastError` names that job's attempt count. Each write is `updateManyAndReturn` re-asserting "still stuck", and each returned row emits `job.settled`. A concurrent reaper gets `[]` and emits nothing.
2. **Requeue** the rest to `pending` in one `updateMany`, clearing claim, token, lease and `executor` (the row may next run on the other side).

Neither phase touches `attempts`. The give-up phase is what bounds a poison pill to N crashes, and it only works because attempts are charged at claim.

The primitives live in `JobStuckService`, not in the admin service, so a `JOBS_WORKER_MODE=off` control plane in front of a node fleet can still reap. The reaper honours `JOBS_REAPER_ENABLED` and never the worker mode: leases expiring in that deployment belong to nodes, which cannot reap themselves. Only the literal `false` disables it. Running it on several replicas is safe; the switch just saves queries. The threshold is read through `SystemSettingsService.getJobsPolicy()`, which does not create the settings row, and a failed read falls back to `DEFAULT_SYSTEM_SETTINGS.jobs`.

### History purge

`job.history.purge` is a job, enqueued nightly by `tasks/job-history-purge.task.ts` at priority `100` (low), globally (constant dedup key), and skipped when one is already active. `jobs.history.purgeEnabled` is checked in the task **and** in the handler, since a purge row can also arrive from a rerun.

- **Only terminal rows are purged.** `pending` and `running` rows are never touched at any age.
- **Cutoff has two arms**: `finishedAt < cutoff`, or `finishedAt IS NULL AND createdAt < cutoff`.
- **Deleting history must not delete lifetime statistics.** Each batch folds the rows into per-type `job_stats_rollup` deltas and deletes **the exact ids it counted**, in one `$transaction`. A terminal job is always either a row or an increment, never both and never neither.
- Duration samples come from succeeded rows with both timestamps and a non-negative duration; counts include everything.
- Batches are 5000 rows, bounding lock duration so the claim keeps flowing.

### Temp-file janitor

`tasks/temp-file-janitor.task.ts` sweeps `os.tmpdir()` on module init and hourly, removing entries that start with `JOB_TEMP_PREFIX` and are older than six hours by mtime.

- `JOB_TEMP_PREFIX` (`job-temp.ts`) is derived from `APP_NAME`, falls back to a neutral slug, and is never empty, so two apps on one host never sweep each other's files.
- Skipped when `JOBS_WORKER_MODE=off`: a stale temp file is on one machine's disk and only a process that ran a handler could have created it. The mode is read through `parseWorkerMode`, the same parse the worker uses.
- Errors are swallowed per file and per sweep.

The schedules (reaper every 10 minutes, purge at midnight, janitor hourly with a six-hour age) are not configurable; each derives from something that already is.

### All long-running work is a job

Any activity that outlives the HTTP request or cron tick that started it is a registered `JobHandler` with a declared `type`, enqueued through `JobsService`. Four binding rules follow:

1. **No long-running work outside the queue.** A detached `void this.doSomething()`, an `@OnEvent` body that downloads or spawns, and a `@Cron` body that does work inline are violations. A `@Cron` only decides whether work is due and enqueues it. `jobs/tasks/job-history-purge.task.ts` is the reference cron; `jobs/housekeeping.enqueue.ts` is the shared helper several crons enqueue through.
2. **Node eligibility is derived and is the default posture.** A new type should carry `nodeResultSchema` + `persistNodeResult` unless it writes as it goes, reads several tables mid-computation, or needs a privilege a remote machine must never hold. There is no `nodeEligible` flag. A deployment declines offload with a setting read at claim time (`NodeOffloadService.offeredTypes()`, a handler's `nodeOffloadEnabled()`), never by editing the handler. `ai.*` types and `db.restore.run` are permanently server-only.
3. **A node never persists a job-scoped credential.** A secret a node needs is issued per job through `POST /api/nodes/{id}/jobs/{jobId}/secret`, gated by `assertJobHeldByNode`, bounded by the lease, held in memory, revoked when the job settles or by the sweep. The server stores the credential's handle in `job_node_secrets`, never its material. A handler declares the need by carrying `nodeSecretBroker`. The node's own `nod_` identity token is the one exception.
4. **A job type declares its execution profile, or takes the global default.** `profile` is exactly `{ maxRuntimeMs, maxAttempts }`. Lease, renewal interval and reaper horizon are derived from `maxRuntimeMs`.

**Exemptions.** Exactly three crons may do work inline. Adding a fourth means editing this table and the array in `apps/api/test/jobs/cron-enqueue-only.spec.ts`.

| Cron | Why it cannot be a job |
|---|---|
| `jobs/tasks/job-stuck-reset.task.ts` | The reaper recovers abandoned jobs. Recovery that depends on the thing it recovers is not recovery. |
| `jobs/tasks/temp-file-janitor.task.ts` | It sweeps this process's local disk; a node or another replica claiming the job would sweep the wrong filesystem. |
| `nodes/tasks/node-secret-sweep.task.ts` | It revokes short-lived database roles brokered to nodes. Tied to the queue, a wedged queue would leak live credentials. |

**Not covered.** "Long-running" means work with a duration worth accounting for: a sweep over a table, a dump, a network round trip per row. Fire-and-forget notification dispatch (`notify(...)`, `notifyPermissionHolders(...)` and the channels behind them) is not a violation; the dispatcher never rejects and failures become `notification_deliveries` rows. A bounded, single-row `job.settled` listener (`JobFailureNotifier`, `BroadcastFailureListener`, `NodeSecretRevoker`) is not either.

**Kill switches stay with scheduling.** `NODE_STALE_OFFLINE_ENABLED`, `NODE_OFFLINE_PRUNE_ENABLED` and `DB_BACKUP_SCHEDULE_ENABLED` are read in the task before enqueue, never re-asked in the handler, so a job queued by one replica is never dropped by another. With `JOBS_WORKER_MODE=off` these crons queue work nothing on that process executes.

**Test limit.** `cron-enqueue-only.spec.ts` reads each `@Cron` method body and requires it to enqueue and to contain no marker of doing work. `test/jobs/on-event-no-io.spec.ts` is its `@OnEvent` counterpart: it reads every `@OnEvent` method body and fails on a marker of storage I/O (a direct storage-provider call, `.download(`, `.upload(`). Neither follows calls into helpers; a helper's own spec pins that it only does the bounded thing it claims.

### Job inventory

| Type | Handler (under `apps/api/src/`) | Enqueued by | Node-eligible |
|---|---|---|---|
| `example.echo` | `jobs/handlers/example-echo.handler.ts` | Manual / tests | No |
| `example.checksum` | `jobs/handlers/example-checksum.handler.ts` | Manual / tests | **Yes** |
| `job.history.purge` | `jobs/handlers/job-history-purge.handler.ts` | Daily cron (midnight) | No |
| `auth.token.cleanup` | `auth/handlers/token-cleanup.handler.ts` | Daily cron | No |
| `device-auth.code.cleanup` | `device-auth/handlers/device-code-cleanup.handler.ts` | Daily cron | No |
| `storage.cleanup.stale-uploads` | `storage/handlers/storage-cleanup.handler.ts` | Daily cron | No |
| `storage.object.process` | `storage/handlers/storage-object-process.handler.ts` | Upload completion, when a processor applies | No |
| `nodes.fleet.sweep` | `nodes/handlers/node-fleet-sweep.handler.ts` | 10-minute cron | No |
| `nodes.fleet.prune` | `nodes/handlers/node-fleet-prune.handler.ts` | Daily cron | No |
| `admin.broadcast.start` | `notifications/broadcasts/handlers/broadcast-start.handler.ts` | Broadcast send/schedule | No |
| `admin.broadcast.chunk` | `notifications/broadcasts/handlers/broadcast-chunk.handler.ts` | `admin.broadcast.start` fan-out (`skipDedup`) | No |
| `db.backup.run` | `db-backup/handlers/db-backup-run.handler.ts` | Backup schedule or `POST /api/admin/db-backup/runs` | **Yes** (offered only when enabled) |
| `db.backup.sweep` | `db-backup/handlers/db-backup-sweep.handler.ts` | Backup scheduler cron | No |
| `db.restore.run` | `db-backup/handlers/db-restore-run.handler.ts` | `POST /api/admin/db-backup/runs/{id}/restore` | No (permanently) |
| `db.restore.old-db-drop` | `db-backup/handlers/db-restore-old-db-drop.handler.ts` | Backup scheduler cron | No |
| `ai.catalog.refresh` | `ai/catalog/ai-catalog-refresh.handler.ts` | Daily cron, `POST /api/admin/ai/models/refresh` | No (permanently) |
| `ai.response.run` | `ai/runtime/ai-response-run.handler.ts` | `POST /api/ai/runs` | No (permanently) |
| `ai.image.generate` | `ai/runtime/ai-image-generate.handler.ts` | `POST /api/ai/images`, `/api/ai/images/edits` | No (permanently) |
| `ai.audio.transcribe` | `ai/runtime/ai-audio-transcribe.handler.ts` | `POST /api/ai/audio/transcriptions` | No (permanently) |
| `ai.audio.speech` | `ai/runtime/ai-audio-speech.handler.ts` | `POST /api/ai/audio/speech` | No (permanently) |
| `ai.usage.purge` | `ai/usage/ai-usage-purge.handler.ts` | Daily cron | No (permanently) |
| `ai.keys.recheck` | `ai/keys/ai-keys-recheck.handler.ts` | Weekly cron, catalog sync | No (permanently) |

The three AI media handlers share `ai/runtime/ai-media-run.handler.ts`. The full cross-subsystem inventory also lives in [ARCHITECTURE.md](../ARCHITECTURE.md).

### Admin API behaviour

All routes are `@Auth({ roles: [ROLES.ADMIN], permissions: [...] })` in `job-admin.controller.ts`. The route table is in §3.

- **It reimplements nothing.** `stats.stuckRunning` counts with the reaper's own `stuckRunningWhere()`, and `reset-stuck` calls `resetStuck()`. An independent "stuck" query would drop the zombie arm and report 0 for exactly the rows stuck forever. `JobAdminService` depends on `JobStuckService` and is not exported.
- **`reset-stuck` has no default.** An empty body uses `jobs.stuckThresholdMinutes`; a DTO default would be a second source that always wins. `olderThanMinutes: 0` means every row matching any signal, at any age. The response echoes `thresholdMinutes`.
- **Filters.** `status`, `type`, `subjectType`, `subjectId`, `page`, `pageSize` (max 100); flat `{ items, total, page, pageSize, totalPages }`. `scheduled=true` means `pending` with a future `scheduled_for` and **overrides** `status`. `processedWithin` (`4h|24h|7d|30d|all`, default `all`) filters on `COALESCE(finished_at, created_at)` as two disjoint arms. Payloads and `claimToken` are never returned. Each row carries `type` and a server-resolved `typeLabel`.
- **Stats cache.** `stats()` is cached in-process for 2 seconds, shorter than any sensible poll interval, and never invalidated. Its two `groupBy` aggregates carry no `where`, so the `jobs(status, type, id)` covering index answers them; `total` is summed from the status breakdown; every status key is zero-filled.
- **Retry resets the row completely**: `status: 'pending'`, `attempts: 0`, `lastError`, `startedAt`, `finishedAt`, `scheduledFor` null, `rateLimitHits: 0`, `rateLimitedAt` null, and claim, token, lease and `executor` cleared. It is the only place that resets `attempts`. `dedupKey` is kept.
- **Retry and delete refuse a `running` job with 400** (`details: { jobId, status: 'running', reason: 'job_running' }`) and answer 404 for a missing one. The guard is a conditional write (`where: { id, status: { not: 'running' } }`), so a job that starts running in between is also refused. `reset-stuck` is the tool for a job whose executor is believed dead.
- **Handler veto on delete.** Before deleting, `remove` calls the handler's optional `canDelete(job)`. A non-null reason is a **409** (`details.reason: 'owner_refused'`); a throw is a 409 too (`owner_check_failed`), failing closed. The broadcast start and chunk handlers refuse while their broadcast is `scheduled` or `sending` (`notifications/broadcasts/broadcast-job-delete-guard.ts`).
- **Dedup collision on retry.** Moving a failed row back to `pending` re-enters the dedup index. A single retry answers **409** `details.reason: 'active_dedup_conflict'`; `retry-failed` counts it as `skipped`. `retry-failed` is a loop of single-row updates (each re-asserting `status: 'failed'`), capped at 500 per call with `remaining` reported.
- **Literal routes are declared before `:id`.** Nest matches in declaration order; `reset-stuck` after `:id` would be captured as an id.
- **Machine-readable error fields go in `details`**, because `http-exception.filter.ts` rebuilds error bodies from a fixed key allowlist.

### Insights

`GET /api/admin/jobs/insights?windowDays=` (default 7, max 90; larger is a 400, never a silent clamp) answers "how long will this take" and "is it getting faster or slower". `job-insights.service.ts`:

- **Every query is a pure `SELECT`.** No `FOR UPDATE`/`FOR SHARE`/`LOCK TABLE`, no advisory lock, no write, no `$executeRaw`. The endpoint must never block the queue it reports on.
- **On demand, in parallel, uncached.** Eight queries in one `Promise.all`, so every block describes nearly the same instant. No snapshot table, no cron.
- **Blocks:**

  | Block | Contains |
  |---|---|
  | `live` | Totals by status, `byType`, `scheduled`, `rateLimited` (`rateLimitHits > 0`, non-terminal), `retried` (`attempts > 1`) |
  | `history` | Over succeeded jobs in the window: `samples`, `avgMs`, `p50Ms`, `p95Ms` (`PERCENTILE_CONT`), `throughputPerMin` over the **last hour**; `overall` and `byType` from one `GROUPING SETS` scan. Averages and percentiles are `null`, never 0, with no samples. |
  | `eta` | Per type with work outstanding: `(pending + running) × avgMs ÷ concurrency`, with `basis` `live` (own history), `partial` (overall average) or `none` (`FALLBACK_JOB_DURATION_MS`, 30s). Concurrency via `resolveWorkerConcurrency()`, floored at 1, published raw. |
  | `lifetime` | Per type: rollup + live succeeded/failed/total/average. Counts and averages only, never percentiles. |

- The `where` clauses match the partial indexes' predicates exactly (`attempts > 1`; `status = 'succeeded' AND started_at IS NOT NULL AND finished_at IS NOT NULL`), or the planner cannot use them.
- Durations are cast to `double precision` and counts to `::int` at the database, so Prisma returns numbers, not `Decimal` objects or `bigint`.

`POST /api/admin/jobs/insights/reset-history` deletes every `job_stats_rollup` row and returns `{ reset }` (rows, one per type). No job is touched. It is a `jobs:write` action because the history it destroys cannot be rebuilt.

### Notifications raised

- **`jobs.job_failed`** — raised when a job exhausts its budget, addressed to holders of `jobs:read`, by a listener on `job.settled` (`apps/api/src/notifications/ops/job-failure-notifier.ts`). `JobsModule` has no dependency on notifications. A retry or deferral raises nothing. See [browser-notifications.md](browser-notifications.md).
- `BroadcastFailureListener` (`notifications/broadcasts/broadcast-failure.listener.ts`) and `NodeSecretRevoker` (`nodes/ops/node-secret-revoker.ts`) are other `job.settled` listeners: the first marks a broadcast `failed` when its start or chunk job fails permanently ([notification-broadcasts.md](notification-broadcasts.md)); the second revokes a node's per-job secret on settle.

## 3. Configuration and permissions

### Environment variables

Bare, unprefixed, read through `ConfigService`, each with a fallback to its default. Full comments are in `infra/compose/.env.example`.

- `JOBS_MAX_ATTEMPTS` — attempt budget, charged at claim (default 3).
- `JOBS_RETRY_BASE_MS` / `JOBS_RETRY_MAX_MS` — retry backoff bounds (2000 / 60000).
- `JOBS_RATELIMIT_MAX_HITS` — rate-limit deferrals before giving up (10).
- `JOBS_RATELIMIT_BASE_MS` / `JOBS_RATELIMIT_MAX_MS` — deferral backoff bounds, and the throttle gate's wait cap (30000 / 900000).
- `JOBS_WORKER_CONCURRENCY` — slot loops, fixed at startup; `0` starts no pool (2).
- `JOBS_POLL_MS` — idle poll interval (5000).
- `JOBS_WORKER_MODE` — `all` | `system` | `off` (`all`).
- `JOBS_JOB_TIMEOUT_MS` — per-job timeout; `0` disables (600000).
- `JOBS_SYSTEM_MODE_EXTRA_TYPES` — comma-separated extra types for `system` mode (unset).
- `JOBS_REAPER_ENABLED` — whether this process reaps; only `false` disables (on).

### System settings (`jobs` namespace)

| Key | Default | Meaning |
|---|---|---|
| `jobs.stuckThresholdMinutes` | 30 | Age at which an unleased running job is abandoned (1–10080) |
| `jobs.history.retentionDays` | 30 | Terminal history kept (1–3650) |
| `jobs.history.purgeEnabled` | `true` | Whether history is purged at all |

### Permissions

`jobs:read` for the four reads, `jobs:write` for the four writes, both seeded Admin-only. Every route also requires the Admin role. The permission matrix lives in [ARCHITECTURE.md](../ARCHITECTURE.md).

### API surface

| Route | Purpose | Permission |
|---|---|---|
| `GET /api/admin/jobs/stats` | Totals, per-status and per-type breakdowns, `scheduled`, `stuckRunning` and its threshold | `jobs:read` |
| `GET /api/admin/jobs/insights?windowDays=` | Live counts, window percentiles, ETA, lifetime totals | `jobs:read` |
| `POST /api/admin/jobs/insights/reset-history` | Clear `job_stats_rollup` | `jobs:write` |
| `POST /api/admin/jobs/retry-failed` | Requeue failed jobs, optionally one `type` (max 500 per call) | `jobs:write` |
| `POST /api/admin/jobs/reset-stuck` | Run the reaper now (`olderThanMinutes` optional) | `jobs:write` |
| `GET /api/admin/jobs` | List jobs, paginated and filterable | `jobs:read` |
| `POST /api/admin/jobs/{id}/retry` | Requeue one job (400 if running, 409 on dedup collision) | `jobs:write` |
| `DELETE /api/admin/jobs/{id}` | Delete one job (400 if running, 409 if the handler vetoes) | `jobs:write` |

## 4. Extending it in a fork

The full recipe, with worked examples, is [apps/api/src/jobs/handlers/README.md](../../apps/api/src/jobs/handlers/README.md). In summary:

1. **Implement `JobHandler`**: a permanent `type` and a `process(job)` that throws to fail. Be idempotent where you can.
2. **Self-register** with `this.registry.register(this)` in `onModuleInit()`.
3. **Provide it** in the feature's module, with `imports: [JobsModule]`.
4. **Enqueue** with `JobsService.enqueue({ type, reason, subjectType, subjectId, payload })`. Keep `payload` to identifiers. Pass `skipDedup: true` when several jobs against one subject are distinct work.

Optionally add a label in `job-type-labels.ts`. To make the type node-eligible, add both `nodeResultSchema` (schema in `jobs/contracts/`) and `persistNodeResult`, routing both executors through one write, as `example-checksum.handler.ts` does; the CLI side is in [worker-nodes.md](worker-nodes.md). Add `profile` for a type that runs long or must not retry, `registerProviderKey` for a type calling a rate-limited provider, and `canDelete` when a pending row is load-bearing for the feature's own state.

If the work is triggered on a schedule, write a `@Cron` that only enqueues (use `enqueueHousekeepingJob` from `housekeeping.enqueue.ts`). `cron-enqueue-only.spec.ts` fails a cron body that does work inline.

Worked examples: `example-echo.handler.ts` (smallest server-only handler), `example-checksum.handler.ts` (node-eligible), `job-history-purge.handler.ts` (real work plus a scheduling task), `db-backup/handlers/db-backup-run.handler.ts` (`profile`, `deriveOutputKey`, `nodeOffloadEnabled`, `nodeSecretBroker`).

## 5. Guardrails

Paths are under `apps/api/`. `*.db.spec.ts` suites run against real PostgreSQL (`npm run test:db`); the rest run in `npm test`.

| Test | Enforces |
|---|---|
| `test/jobs/cron-enqueue-only.spec.ts` | Every `@Cron` body only enqueues; exactly three exemptions |
| `test/jobs/on-event-no-io.spec.ts` | Every `@OnEvent` body is free of storage I/O (direct storage-provider calls, `.download(`/`.upload(`) |
| `src/jobs/job-handler.registry.spec.ts` | Self-registration via real `onModuleInit`; `serverOnlyTypes()` derivation incl. exactly-one-member; duplicate warns, last wins; module graph boots |
| `src/jobs/job-type-labels.spec.ts` | Unmapped type renders as itself |
| `test/jobs/jobs-enqueue.db.spec.ts` | Concurrent enqueue of one key yields one row for both callers; `skipDedup` yields NULL keys; settled job frees its key |
| `src/jobs/jobs.service.spec.ts` | Other P2002s propagate; re-read race retries, bounded; no `findFirst` pre-check; `recordProvider` swallows |
| `test/jobs/job-claim.db.spec.ts` | Two claimers never get the same row; disjoint partition under an eight-way burst; priority and age order; future `scheduledFor` skipped; `attempts` 1 after claim; `MATERIALIZED` regression |
| `src/jobs/job-claim.service.spec.ts` | Short circuits make no query; all values bound |
| `test/jobs/job-model-fields.spec.ts` | `JOB_CLAIM_COLUMNS` covers exactly the `Job` fields |
| `test/jobs/job-schema-indexes.db.spec.ts` | The hand-written partial indexes exist |
| `src/jobs/job-execution-profile.spec.ts` | Profile validation, derived lease, renewal interval and horizon |
| `src/jobs/job-lease.service.spec.ts` | `heldLeaseWhere`/`heldClaimWhere` shapes; stale token refused; no lease clause on settle |
| `test/jobs/job-lease-renewal.db.spec.ts` | A renewing job is never reaped at any age; a stale token's renewal is refused; settled rows carry no token |
| `src/jobs/job-terminal.service.spec.ts` | Both budgets, absolute un-charge, node flags identical to a thrown `RateLimitError`, exact backoff, write retry once, `claim-lost`, `rowMatchesWrite`, `job.settled` only on terminal branches, throwing listener harmless, `permanent` |
| `test/jobs/job-terminal-claim-guard.db.spec.ts` | A stale-token settle after re-claim or reap is a no-op |
| `src/jobs/rate-limit.error.spec.ts`, `src/jobs/backoff.util.spec.ts`, `src/jobs/provider-throttle.service.spec.ts` | Classification, `Retry-After` parsing, jitter bounds, gate extend/clear/cap |
| `src/jobs/job.worker.spec.ts` | Worker modes incl. `system` as the offer-set complement; typo warns once; per-claim resolution; timeout frees the slot with no `unhandledRejection`; no batch barrier; unknown type is permanent; renewal ticker; shutdown |
| `src/jobs/job.worker.bootstrap.spec.ts` | A slow-registering handler is in the first claim |
| `src/jobs/node-offload.service.spec.ts`, `test/db-backup/db-backup-node-offload.integration.spec.ts` | Offer set and its `system`-mode complement over the real module graph |
| `src/jobs/job-stuck.service.spec.ts`, `test/jobs/job-stuck-reset.db.spec.ts` | Four signals, two phases, one emit per given-up row, concurrent reapers safe |
| `src/jobs/tasks/job-stuck-reset.task.spec.ts` | Reaper runs in every mode, stops only for `JOBS_REAPER_ENABLED=false` |
| `src/jobs/handlers/job-history-purge.handler.spec.ts`, `test/jobs/job-history-purge.db.spec.ts` | Terminal rows only, both age arms, fold-and-delete in one transaction, lifetime totals conserved across purges |
| `src/jobs/tasks/temp-file-janitor.task.spec.ts`, `src/jobs/job-temp.spec.ts` | Prefix-only deletion, mode gating, never-empty prefix |
| `src/jobs/job-admin.service.spec.ts`, `test/jobs/job-admin.integration.spec.ts` | Filters, `scheduled` override, stats cache TTL, complete retry reset, 400/404/409 outcomes, `canDelete` veto, literal routes before `:id`, Admin-only |
| `test/jobs/job-admin-delete-veto.db.spec.ts` | Broadcast job delete veto against real rows |
| `src/jobs/job-insights.service.spec.ts`, `test/jobs/job-insights.db.spec.ts` | Only `SELECT`s, runs while `FOR UPDATE` locks are held, `PERCENTILE_CONT` values, `basis`, lifetime merge, `reset-history` |

Not proved: that `@Cron` schedules fire (that is Nest's), that the planner chooses the partial or covering indexes (asserted instead by the shape of each `where`), or that insights are fast on a large table.

## 6. Design decisions

- **PostgreSQL, not Redis/BullMQ.** Every fork already runs PostgreSQL, and `FOR UPDATE SKIP LOCKED` is a correct claim primitive.
- **Explicit registration, not `@JobHandler()` + `DiscoveryService`.** Discovery still needs the registry, is harder to trace ("why is this type running?"), and would be a third mechanism beside the explicit notification-channel and object-processor lists.
- **Throw to fail, not a result object.** A result object makes forgetting an `await` report success for work that never happened.
- **No required `label` on the interface.** It enlarges the contract for something the worker never reads.
- **Database-enforced dedup, not `findFirst`-then-`create`.** Check-then-act races exactly when dedup matters.
- **One-statement claim.** Rejected: `SELECT … FOR UPDATE` then `UPDATE` (wider window, no gain); an advisory lock (serialises every claimer); an in-process mutex (correct on one replica, double-claims on two).
- **Attempts charged at claim**, so a process-killing job is still bounded. Charging on failure makes a crash loop unbounded.
- **One terminal chokepoint.** Two executors writing their own terminal rows diverge silently on every retry question.
- **Two budgets.** One combined counter lets a long throttled backfill fail permanently for a transient reason.
- **Absolute un-charge**, because the terminal write can apply twice.
- **Equal jitter.** No jitter keeps a herd synchronised; full jitter can retry immediately.
- **In-memory throttle gate.** A shared gate puts a round trip in front of every job, forever, and adds a datastore; the durable deferral is already shared.
- **Settle-only `job.settled`.** Events on every state change force every subscriber to re-derive "is it over".
- **Independent slot loops.** A batch of N waits for its slowest member.
- **Fail open on an unknown worker mode**; failing closed stops all background work on a typo.
- **A renewable lease, not a fixed timeout.** A timeout cannot tell a slow job from a dead one; a lease is a statement by the executor.
- **Derived leases and renewal intervals, not `JOBS_LEASE_MS` or profile fields.** Independent knobs can contradict the runtime ceiling.
- **Per-claim token.** `claimed_by_node_id` identifies a kind of claimant, not a claim.
- **Reaper gated on `JOBS_REAPER_ENABLED`, never the worker mode.** A control plane in front of a fleet is where reaping matters most.
- **Budget-checked requeue.** Unconditional requeue turns a poison pill into an infinite crash loop.
- **Purge as a job with a rollup, in one transaction per batch.** A cron that deletes inline has no retry or record; deleting without the rollup erases lifetime stats; two statements lose or double-count on a crash.
- **Terminal-only purge.** Deleting old `pending` rows silently cancels work.
- **Derived temp prefix.** A hard-coded prefix lets two apps on one host delete each other's files.
- **Admin reuse, not reimplementation.** A separate stuck query drops the zombie arm.
- **`scheduled` as a boolean filter, not a status.** A status no row can carry splits the vocabulary.
- **Rejected for the admin API:** a default for `olderThanMinutes`, filtering by `created_at`, returning payloads, one `updateMany` for `retry-failed`, clearing `dedup_key` on retry, force-resetting or deleting running jobs, a cache at or above the poll interval.
- **Rejected for insights:** a cron-refreshed snapshot table (a writer on the hot path, and stale by construction), percentiles in the rollup (a percentile of a deleted distribution cannot be merged), unbounded lifetime percentiles, silently clamping `windowDays`, injecting `JobWorker` for the ETA divisor.

## 7. Verification

```bash
cd apps/api && npm test -- jobs
cd apps/api && npm run test:db -- jobs      # real PostgreSQL
npm run openapi:dump && npm run openapi:lint  # root scripts; boots AppModule in preview mode
```

In a running app:

1. Open `/admin/settings/jobs`. The stats tiles show totals by status, and every registered type is listed.
2. Trigger work (for example `POST /api/admin/jobs/reset-stuck`, or upload a file and enqueue `example.checksum`). The row moves `pending` → `running` → `succeeded`, with `executor` set.
3. Open `/admin/settings/jobs/insights`. `history` has samples once jobs have succeeded; `eta` lists only types with work outstanding.
4. Set `JOBS_WORKER_MODE=off` and restart: rows are enqueued but stay `pending`, and `reset-stuck` still works.

## History

- Epic #254: #255 schema and `buildDedupKey`; #259 handler contract and registry; #260 enqueue and atomic claim; #261 terminal state machine; #262 worker pool and modes; #263 reaper, purge, janitor; #264 admin API; #265 insights.
- #268/#269: node control and data planes as the second executor.
- Epic #345: #346 execution profiles; #347 in-process lease renewal and the fourth reaper signal; #351/#352 database backup as a job; #353 every long-running activity is a job.
- #361: `claim_token`. #364: token on the node plane. #456: broadcast chunk throttle key.
- #459: broadcast failure listener. #468: reaper give-up emits `job.settled`. #477: claim-conditional terminal writes. #480: `canDelete` veto.
- #520: post-upload object processing becomes the `storage.object.process` job, replacing the `storage.object.uploaded` `@OnEvent` listener; `test/jobs/on-event-no-io.spec.ts` added as its tripwire.
