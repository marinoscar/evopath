# Database Backup

> **Status:** shipped · **Code:** `apps/api/src/db-backup/`, `apps/web/src/pages/Admin/DbBackupPage.tsx`, `apps/cli/src/node/executors/db-backup-run.ts` · **API:** `/api/admin/db-backup/*` (see `/api/docs`) · **Admin UI:** `/admin/settings/db-backup` · **Runbooks:** [postgres-client-version.md](../runbooks/postgres-client-version.md), [node-job-secrets.md](../runbooks/node-job-secrets.md) · **Related spec:** [database-restore.md](database-restore.md)

The application takes logical backups of its own PostgreSQL database with
`pg_dump`, streams each archive straight into the deployment's object storage,
reads it back to prove it is readable, and prunes old archives by a retention
policy. Backups run on a schedule or on demand, as the `db.backup.run` queue
job, either in the API process or on a worker node. Each attempt is one row in
`database_backup_runs`.

## 1. Purpose

- **What it is.** A self-contained recovery point for an app built from this
  template: scheduled and manual `pg_dump` archives (custom format), stored in
  the bucket configured at `/admin/settings/storage`, listed and downloadable
  from the admin UI.
- **What it is not.** Not point-in-time recovery, WAL archiving or a replica.
  Not multi-destination: one deployment binds one storage provider. Restore
  is a separate feature with its own spec, [database-restore.md](database-restore.md);
  this document covers taking, keeping and deleting backups.
- **Problem it solves.** A fork gets a backup that is never buffered in memory,
  never silently truncated, never run twice at once, and never marked
  `completed` until the stored object has been read back.

## 2. How it works

### Model: `database_backup_runs`

One row per attempt (`DatabaseBackupRun` in `apps/api/prisma/schema.prisma`).
It is **not** a `jobs` row; it links to the job driving it through `job_id`
(`@unique`, `onDelete: SetNull`).

| Group | Columns | Notes |
|---|---|---|
| State | `status`, `trigger`, `started_at`, `finished_at`, `last_heartbeat_at`, `last_error` | `status`: `pending \| running \| completed \| failed \| stale`. `trigger`: `manual \| scheduled \| pre_restore` |
| Size | `bytes_written`, `size_bytes` | `BigInt`. `bytes_written` is live progress; `size_bytes` is written once at completion |
| Storage | `storage_provider`, `storage_key`, `bucket`, `format`, `checksum_sha256` | Recorded, not derived, so a bucket rename or provider swap cannot lose an old archive |
| Audit | `db_version`, `app_version`, `migration_name`, `pg_dump_version` | Best-effort; a failed read never fails a backup. `NULL` means "not recorded" |
| Proof | `verified_at` | Set only after the stored object passed `pg_restore --list` |
| Who | `created_by_id` | `SetNull` on user delete |
| Restore | `restore_status`, `restore_error`, `restored_at`, `restored_by_id`, `restore_scratch_db`, `restore_old_db`, `swapped_at`, `pre_restore_backup_id` | Written by the restore feature ([database-restore.md](database-restore.md)) |

- **The restore audit lives on the backup's own row.** A restore is always of
  exactly one backup, so there is no `database_restore_runs` table. A retried
  restore overwrites the previous attempt's fields; the full history is in
  `audit_events`.
- **`pre_restore_backup_id`** is a self-FK to the safety backup taken just
  before a restore swaps databases. `onDelete: SetNull`, so retention pruning
  that backup never deletes the restore record.
- **`BigInt` byte counts.** A dump past 2 GiB is ordinary. `JSON.stringify`
  throws on a `bigint`, so every response goes through `toRunDto`
  (`dto/db-backup-run.dto.ts`), which publishes `bytesWritten` and `sizeBytes`
  as **decimal strings** (`.toString()`, exact at any size).

### Indexes and the single-active-run guard

```sql
CREATE UNIQUE INDEX "database_backup_runs_active_uniq_idx"
  ON "database_backup_runs" ((true)) WHERE "status" IN ('pending','running');
```

- Keyed on the constant `(true)`, so **at most one** row is `pending` or
  `running` across both statuses combined. `completed`, `failed` and `stale`
  rows are unconstrained.
- The insert is optimistic. The loser's Prisma `P2002` becomes
  `DatabaseBackupAlreadyRunningError` carrying the winner's id, rendered as a
  `409` with `details.activeRunId`. There is no `findFirst` pre-check anywhere
  in that path.
- **Intentional schema drift.** Prisma cannot express a partial or expression
  index, so it exists only in hand-written migrations
  (`20260907120000_add_database_backup_runs`, recreated by
  `20260907140000_add_backup_run_job_link`). `prisma migrate diff` wants to
  drop it. Do not "fix" that with a `@@unique`.
- Other indexes: `[created_at DESC]` and `[started_at DESC]` (the admin list's
  two orderings), `[status]` (sweep and active-run lookup), and
  `[status, created_at DESC]` (retention: newest completed first).

### Lifecycle of one backup

1. **Queue.** `POST /runs` or the scheduler calls `queueBackup`, which writes
   the `db.backup.run` job and a `pending` run row (with its server-chosen
   `storage_key`) in **one transaction**. The job carries a dedup key, so the
   queue's own active-dedup index also refuses a second backup job.
2. **Claim.** A worker claims the job and flips the row `pending → running`,
   setting `started_at`. The handler declares its own execution profile:
   `maxRuntimeMs` = 6 hours, `maxAttempts` = 1. The lease is derived from
   `maxRuntimeMs` and renewed for the whole run, so the reaper never resets a
   long dump.
3. **Version check.** Before any byte is dumped, `pg-version.util.ts` compares
   the `pg_dump` client with the server. A client older than the server fails
   the run with a `last_error` pointing at
   [postgres-client-version.md](../runbooks/postgres-client-version.md). An
   unreadable version pair warns and proceeds.
4. **Stream** (below), with a heartbeat every 20 seconds.
5. **Verify** the stored object (below).
6. **Complete.** Write `completed`, `size_bytes`, `checksum_sha256`,
   `verified_at`, then enqueue `db.backup.sweep` to apply retention.

A `pre_restore` safety backup takes a different entry: the restore job calls
`startBackup`, which claims the row directly as `running` (no job of its own,
so `job_id` is `NULL`) and runs the same engine.

There is no automatic retry. The next scheduled run is the retry.

### Streaming contract

```ts
const hash = createHash('sha256');
let bytes = 0n;
const meter = new Transform({
  transform(c, _e, cb) { hash.update(c); bytes += BigInt(c.length); cb(null, c); },
});

dump.done.catch(err => meter.destroy(err));   // a dead dump tears the upload down
dump.stdout.pipe(meter);
await Promise.all([provider.upload(key, meter, opts), dump.done]);
```

- **Never buffered.** No buffer, no temp file, no second read. Checksum and
  byte count come from the same single pass as the upload.
- **Both the upload and the dump's exit code are awaited.** A dump that dies
  mid-stream just ends stdout, and the upload reports success on a truncated
  archive; only `dump.done` tells them apart. A dump can also exit non-zero
  after its last byte, and an upload can fail after a clean dump.
- **Cross-teardown.** A dead dump destroys the meter (or the upload waits
  forever); a dead upload SIGKILLs the dump. Both streams carry no-op `error`
  listeners so a deliberate destroy is never an uncaught exception.

### Read-back verification

Before a run is `completed`, the uploaded object is streamed back out of
storage through `pg_restore --list`. An empty table of contents fails the run
and deletes the object. This catches a truncated upload, a zero-byte object
and a dump of the wrong (empty) database. `pg_restore --list` opens no
database connection. The cost is one extra read per backup.

### Heartbeat

Every 20 seconds (`BACKUP_HEARTBEAT_INTERVAL_MS`, a constant) one UPDATE by
primary key writes `last_heartbeat_at` and `bytes_written`. It is the run's
liveness signal and the progress the UI shows. A failed heartbeat write is
swallowed; a sustained failure stops the heartbeat, which the staleness sweep
detects. The timer is cleared in a `finally` on every path.

### Failure ordering

1. Delete the partial object (best-effort; a failed delete never masks the
   original error).
2. Mark the row `failed` with `last_error`.

The row is the only index of what is in the bucket. Deleting first means the
worst case is a row still saying `running` with no object, which the sweep
resolves, never an orphaned object nothing points at.

### Cancellation

`cancel(runId)` works through a **process-local abort map**: only the process
that spawned `pg_dump` holds the handle. It kills the child and destroys the
meter, which fails the `Promise.all` and reaches the ordinary failure path.
There is no separate "cancelled" teardown.

| Outcome (HTTP 200) | Meaning |
|---|---|
| `signalled` | The dump was stopped; the run settles `failed` with its partial object deleted |
| `not_running_here` | This process holds no handle: the run is still `pending`, runs on another replica or node, or just settled. Nothing was stopped |

A run that is already terminal is a `400`.

### Storage destination

- The runner injects the `STORAGE_PROVIDER` DI token (not an env var) and
  reads `getBucket()`. It imports
  `StorageProvidersModule`, not `StorageModule`, so archives never get a
  user-facing `storage_objects` row.
- **The server chooses the key:**
  ```
  database-backups/<slug>/<YYYY>/<MM>/<slug>-<YYYYMMDDTHHMMSSZ>-<runId>.dump
  ```
  `<slug>` is `APP_NAME` slugified, so two apps can share a bucket. Month
  partitions keep listings cheap; the UTC timestamp sorts in time order; the
  run id makes the key unique.
- `databaseBackup.storageProvider` is a pin: empty (the default) means
  "whatever provider is active"; a non-empty value must equal the active
  provider or the request is a `400`. The same helper
  (`db-backup-storage.ts`) checks it on `PUT config` and in the runner.

### Scheduling

`DatabaseBackupScheduleTask` is a `@Cron` every **ten minutes**. It only
decides and enqueues:

1. Enqueue `db.backup.sweep` (staleness sweep, then retention).
2. If a backup is due, queue `db.backup.run`.
3. Enqueue `db.restore.old-db-drop` (drops a `<live>_old_<ts>` database a
   restore displaced, once past `oldDatabaseRetentionHours`).

**Due rule** (stateless, recomputed every tick):

```
boundary = previousFireBoundary(expr, now, timezone)
latest   = the run with the greatest started_at
fire only if latest.started_at < boundary
```

- Exactly one run per boundary; a late tick still fires (a missed window is
  recovered, not lost); a restart changes nothing.
- **Every trigger counts.** A `manual` backup after the boundary satisfies it.
- **Timezone is always passed explicitly.** An unknown zone throws
  `InvalidTimezoneError`; the scheduler stands down and logs once per bad
  value.
- **DST** is handled by `schedule.util.ts` walking civil days. Spring forward:
  a non-existent 02:00 runs at the instant the clock jumped to. Fall back: an
  ambiguous 01:30 fires on the first pass only.
- `databaseBackup.enabled: false` stops the firing, **not** the sweep, so a
  run orphaned before the switch-off cannot block manual backups.
- A backup scheduled for 02:00 starts within `[02:00, 02:10)`. If the sweep
  has not yet freed a zombie's slot, the fire is delayed by at most one tick.

### Retention: two clocks

Applied by `DatabaseBackupRetentionService` inside `db.backup.sweep`.

| Population | Rule | Setting |
|---|---|---|
| `completed`, trigger not `pre_restore` | Keep the newest N; delete the rest oldest first | `retentionCount` |
| `completed`, trigger `pre_restore` | Delete once older than the bound | `oldDatabaseRetentionHours` |

- `pre_restore` runs are neither deleted by the count rule nor counted in its
  N slots: under `restoreRollbackMode: 'drop_database'` that dump is the only
  way back from a restore. They expire with the same bound as a retained old
  database.
- **Oldest first**, so an interrupted prune still leaves the newest intact.
- `failed` and `stale` rows are never pruned. Their objects are already gone,
  and the row is the record that a backup did not happen.
- **Object first, then row.** A failed object delete keeps the row, so the next
  prune retries. A row delete that failed after its object was removed
  self-heals next time.
- The sweep is enqueued only **after** verification **and** the `completed`
  write, and only on success. Retention never throws.

### Staleness sweep

`db.backup.sweep` releases runs whose executor disappeared. Candidates match
any of three arms (window: `runStaleMinutes`, default 120):

| Arm | Catches |
|---|---|
| `running` and `last_heartbeat_at < cutoff` | A dump that was beating and stopped |
| `running`, `last_heartbeat_at IS NULL`, `started_at < cutoff` | A process that died before its first heartbeat |
| `pending` and `created_at < cutoff` | A queued backup nobody claimed (worker off, job deleted, job failed before its handler ran) |

- **A live lease wins.** A candidate whose `jobs` row is still held under a
  live lease is skipped. A node-executed run cannot write a heartbeat, so the
  job's lease is its liveness signal.
- **Conditional transition.** `updateMany … WHERE id = $1 AND status = <status
  it was read with>`. `count === 0` means the run finished in between and is
  left alone. Idempotent across replicas.
- **Row first, then object.** The slot is freed even if the object delete
  fails.
- `stale` is terminal and distinct from `failed` ("the executor went away"
  versus "the dump errored"). Nothing re-queues it. `pending` and `running`
  stale runs get different `last_error` messages.

### Running the dump on a worker node

`db.backup.run` is **node-eligible**: it carries `nodeResultSchema`,
`persistNodeResult`, `deriveOutputKey` and a `nodeSecretBroker`. The bytes go
from the database to object storage without transiting the API.

**Three gates**, intersected at claim time in `NodesService.nodeEligibleTypes`:

| Gate | Question | Default |
|---|---|---|
| `nodes.jobSecretBrokerEnabled` | May the broker issue any credential at all? | off |
| `databaseBackup.nodeOffloadEnabled` | May this workload leave the server? | off |
| `PgJobRoleBroker.usable()` | Can it mint a role here now? | probed, cached 60 s |

With any gate closed, the in-process worker takes the backup, including under
`JOBS_WORKER_MODE=system`: that mode claims the complement of
`NodeOffloadService.offeredTypes()`, so the two executors partition the queue.

- **`deriveOutputKey`** re-reads the run by `job_id` and returns the key the
  row already records, so a retried upload lands on the same key. The first
  call also flips the run `pending → running`. `persistNodeResult` refuses a
  result naming any other key.
- **Verification stays on the server.** `persistNodeResult` downloads the
  stored object and runs `pg_restore --list` before writing. The node's
  `sha256` is recorded as its claim. Both executors write through one private
  `completeRun`.
- **`bytes` is a decimal string** in the result contract
  (`apps/api/src/jobs/contracts/db-backup-run.contract.ts`, `^\d{1,20}$`),
  converted once with `BigInt()`. A JSON number is exact only below 2^53.
- **Node requirements.** `pg_dump` is a required capability (a node without it
  never declares the type). `psql` is degradable (without it, `db_version` and
  `migration_name` are `null`). `appctl node doctor --db-host <host[:port]>`
  reports the client version and a TCP probe as warnings, never failures.
  There is no tunnelling: a node needs a real network route to PostgreSQL.

### The job-scoped database credential

`db-backup/pg-job-role.broker.ts` mints one PostgreSQL login role per job,
through `POST /api/nodes/{id}/jobs/{jobId}/secret`:

- Name `appjob_<first 8 of job id>_<6 random hex>`.
- `CONNECT` on the database, `USAGE` on the schema, `SELECT` on its tables,
  nothing else. `CONNECTION LIMIT 4`.
- `VALID UNTIL` the job's lease expiry + 60 s clock-skew allowance.
- Created through an admin connection outside the Prisma pool.
- `pg_dump --no-owner --no-acl` needs no `SUPERUSER`; a SELECT-only role
  produces the same archive.
- Revoked by three independent layers: the job-settle listener, the
  `node-secret-sweep` cron, and `VALID UNTIL` itself.
- The node holds the password in one local constant: never in its config,
  state directory or logs. `job_node_secrets` stores only the role name.
- A server role without `CREATEROLE` (the ordinary managed-PostgreSQL case)
  gets `outcome: "guided"` with paste-ready SQL from
  `GET /api/admin/db-backup/node-credential-preflight`, a `200`, never a `4xx`.
  See [node-job-secrets.md](../runbooks/node-job-secrets.md).

### Admin API behaviour

- **`nextRunAt`** in `GET config` is computed on every read with the same
  `nextFireAt` the scheduler uses; never stored. It is `null` when
  `enabled` is false or the stored timezone cannot be resolved (the read
  degrades so the page that fixes it stays reachable).
- **`PUT config`** writes through `SystemSettingsService.patchSettings` (the
  one writer of `system_settings`), then re-reads with `getConfig()`. It
  validates the timezone by running the real projection, **whether or not
  `enabled` is true**, so a bad zone is refused at save time.
- **Errors** put machine-readable data under `details` only;
  `HttpExceptionFilter` drops any other top-level field.
- **`DELETE runs/{id}`** deletes object then row and reports `objectDeleted`.
  An active (`pending`/`running`) run is a `400`: cancel it first.
- **`GET runs/{id}/download`** returns a pre-signed URL valid for 300 s
  (`BACKUP_DOWNLOAD_URL_EXPIRY_SECONDS`), never a proxied stream. Only a
  `completed` run; anything else is a `400`.
- **Route order.** Every literal route is declared above every parameterised
  one in `db-backup.controller.ts`; Nest matches in declaration order.

### Notifications

- `db_backup.backup_failed` goes to holders of `db_backup:read` when a run is
  marked `failed` (`outcome: 'failed'`) or `stale` (`outcome: 'stale'`), after
  the terminal row commits.
- `db_backup.restore_completed` (mandatory) is raised by a completed restore;
  see [database-restore.md](database-restore.md).

## 3. Configuration and permissions

### Settings: `databaseBackup` namespace

Schema: `systemDatabaseBackupSchema` in
`apps/api/src/common/schemas/settings.schema.ts`; defaults in
`apps/api/src/common/types/settings.types.ts`.

| Key | Type / range | Default |
|---|---|---|
| `enabled` | boolean | `false` |
| `frequency` | `daily \| weekly \| monthly` | `daily` |
| `dayOfWeek` | 0–6 (always stored, used when weekly) | `0` |
| `dayOfMonth` | 1–28 (so "monthly" means every month) | `1` |
| `timeOfDay` | `HH:MM`, 24-hour | `02:00` |
| `timezone` | IANA name, ≤ 64 chars | `UTC` |
| `retentionCount` | 1–365 | `7` |
| `storageProvider` | ≤ 64 chars; empty = active provider | `''` |
| `runStaleMinutes` | 1–10080 | `120` |
| `compressionLevel` | 0–9 | `6` |
| `restoreRollbackMode` | `retain_database \| drop_database` | `retain_database` |
| `oldDatabaseRetentionHours` | 1–8760 | `48` |
| `nodeOffloadEnabled` | boolean | `false` |

Related: `nodes.jobSecretBrokerEnabled` (default `false`).

### Environment variables

- `DB_BACKUP_SCHEDULE_ENABLED` — whether this process runs the ten-minute
  scheduler. On unless the literal `false`. Independent of `JOBS_WORKER_MODE`:
  a control plane with `JOBS_WORKER_MODE=off` still queues backups.
- `NODE_SECRET_SWEEP_ENABLED` — the cron that revokes expired brokered roles.

### Permissions

| Permission | Grants |
|---|---|
| `db_backup:read` | Config read, run list/get, download, node-credential preflight |
| `db_backup:write` | Config write, manual trigger, cancel, delete |
| `db_backup:restore` | Restore and rollback only (see [database-restore.md](database-restore.md)) |

All three are seeded Admin-only, and every route also requires the Admin role.

### API surface

| Method + route (`/api/admin/db-backup`) | Purpose | Permission |
|---|---|---|
| `GET /config` | Policy, computed `nextRunAt`, active run id | `db_backup:read` |
| `PUT /config` | Partial policy update | `db_backup:write` |
| `POST /runs` | Queue a backup now; `409` with `details.activeRunId` if one is active | `db_backup:write` |
| `GET /runs` | Paginated list (`page`, `pageSize` ≤ 100, `status`, `trigger`) | `db_backup:read` |
| `GET /node-credential-preflight` | Capability (`outcome`) and policy (`brokerEnabled`) for node offload | `db_backup:read` |
| `GET /runs/{id}` | One run (progress polling) | `db_backup:read` |
| `GET /runs/{id}/download` | Signed archive URL (300 s) | `db_backup:read` |
| `POST /runs/{id}/cancel` | Cancel; `signalled` or `not_running_here` | `db_backup:write` |
| `DELETE /runs/{id}` | Delete run and archive | `db_backup:write` |
| `POST /runs/{id}/restore`, `/rollback` | See [database-restore.md](database-restore.md) | `db_backup:restore` |

### Job types

| Type | Role |
|---|---|
| `db.backup.run` | Take one backup. Node-eligible. Profile: 6 h, 1 attempt |
| `db.backup.sweep` | Staleness sweep, then retention |
| `db.restore.old-db-drop` | Drop a retained pre-restore database past its bound |

## 4. Extending it in a fork

- **Another backup destination.** `databaseBackup.storageProvider` and the
  `storage_provider` column already exist. Add a provider registry and select
  from it using that field; the key layout and row shape stay the same.
- **A different archive format or `pg_dump` flags.** Change
  `pg-dump.util.ts` and keep its argv test in step. Keep `--no-owner --no-acl`,
  or the SELECT-only node role stops being enough.
- **Another long-running database job.** Follow the same shape: a queue job
  with its own `profile`, a dedicated table if its lifetime outlives a lease,
  and a partial unique index (never a pre-check) for "one at a time". See
  [job-queue.md](job-queue.md) and `apps/api/src/jobs/handlers/README.md`.
- **Operator UI.** The card is registered in
  `apps/web/src/config/adminSections.tsx`; follow
  [settings-ui.md](settings-ui.md).

## 5. Guardrails

| Test | Enforces |
|---|---|
| `apps/api/src/db-backup/db-backup-active-index.db.spec.ts` | The active-run index exists, is unique, and arbitrates concurrent inserts (real Postgres) |
| `apps/api/src/db-backup/db-backup-run-job-link.db.spec.ts` | `job_id` is unique, nullable, and `SetNull` on job delete (real Postgres) |
| `apps/api/src/db-backup/db-backup-runner.service.spec.ts` | Streaming (never buffered), both halves awaited, read-back verification, failure ordering, heartbeat, cancel, version guard, prune only after success |
| `apps/api/src/db-backup/db-backup-storage.spec.ts` | Key layout and the `storageProvider` pin |
| `apps/api/src/db-backup/db-backup-retention.service.spec.ts` | Two retention clocks, oldest first, object-then-row, failed/stale never pruned |
| `apps/api/src/db-backup/tasks/db-backup-schedule.task.spec.ts` | Boundary rule, late tick, restart, timezone, DST, `DB_BACKUP_SCHEDULE_ENABLED`, never reads the worker mode |
| `apps/api/src/db-backup/handlers/db-backup-sweep.handler.spec.ts` | Three sweep arms, live-lease skip, conditional transition |
| `apps/api/src/db-backup/handlers/db-backup-run.handler.spec.ts` | Profile, `deriveOutputKey` idempotence, server-side verification of node results |
| `apps/api/src/db-backup/db-backup-admin.service.spec.ts` | Timezone refused even while `enabled` is false |
| `apps/api/src/db-backup/pg-job-role.broker.spec.ts`, `pg-job-role.broker.db.spec.ts` | Role name, grants, `VALID UNTIL`, revocation |
| `apps/api/src/db-backup/pg-dump.util.spec.ts`, `pg-version.util.spec.ts`, `schedule.util.spec.ts` | `pg_dump` argv, version guard, schedule arithmetic |
| `apps/api/test/db-backup/db-backup-admin.integration.spec.ts` | Every route through the real router and `HttpExceptionFilter`: `409` details, BigInt as decimal strings, permission split, route order |
| `apps/api/test/db-backup/db-backup-node-offload.integration.spec.ts` | The three gates and the node result path |
| `apps/cli/src/node/executors/db-backup-run.test.ts` | The node never persists or logs its credential |
| `apps/api/test/jobs/cron-enqueue-only.spec.ts` | The scheduler only enqueues |

No test runs a real `pg_dump` against a real database end to end; the engine
seam stands in for it. The restore suites exercise real archives.

## 6. Design decisions

- **A queue job with its own table.** The dump runs as `db.backup.run` so it
  gets a dashboard row, a worker slot and node offload. Three things make that
  safe: `maxRuntimeMs` (6 h) derives a lease no reaper resets mid-dump; the
  worker renews that lease for the whole run; `maxAttempts: 1` forbids an
  automatic re-dump. `database_backup_runs` stays separate because its
  heartbeat, stale window and terminal states outlive any one job.
- **Partial unique index, not a pre-check or mutex.** A `findFirst` guard is
  check-then-act and races across replicas; an in-process mutex is worthless
  on two replicas. Only the database makes "one active" atomic with the insert.
- **Streaming, not buffering or a temp file.** Buffering puts the database in
  the heap; a temp file needs disk the size of the database and reads twice.
- **Read-back verification, not checksum alone or a scratch restore.** A
  checksum proves what was sent, not what the bucket holds. A scratch restore
  per nightly would double the runtime; the restore feature does it on demand.
- **Boundary rule, not a `lastRunAt` column or an exact cron.** A stamp drifts,
  needs its own write and cannot be recomputed; a cron on the operator's
  expression must be re-registered on edit and loses a missed night.
- **Count retention for ordinary runs, age for `pre_restore`.** A count
  survives a frequency change; an age bound keeps the rollback dump for as
  long as a retained old database. A separate `preRestoreRetentionHours`
  setting was rejected as a second name for the same promise.
- **Object before row, everywhere.** An orphaned row is visible and free; an
  orphaned object is invisible and billed forever.
- **Heartbeat interval is a constant.** Every alternative value is either
  pointless or silently wrong against a 1-minute stale window.
- **Cancel through the process that holds the child.** A `cancelled` status
  column could not stop the child; `not_running_here` is honest.
- **Signed download URL, not a proxied stream.** A database-sized response
  through Nginx and an API worker would hit every timeout and starve callers.
- **The scheduler ignores `JOBS_WORKER_MODE`.** The deployment that sets `off`
  is often the only component with a database connection; gating on it would
  silently stop backups.
- **Node lease, not a second node heartbeat.** Two liveness clocks for one
  fact disagree.

## 7. Verification

1. Configure storage at `/admin/settings/storage`, then open
   `/admin/settings/db-backup` and click **Back up now**, or:
   ```bash
   appctl api POST /api/admin/db-backup/runs
   appctl api GET /api/admin/db-backup/runs/<id>
   ```
   Watch `status` go `pending → running → completed`, `bytesWritten` grow,
   and `verifiedAt` get set.
2. Trigger a second backup while the first runs: expect `409` with
   `details.activeRunId`.
3. `GET /api/admin/db-backup/runs/<id>/download`, download the archive, and run
   `pg_restore --list <file>`.
4. Enable the schedule, set `timeOfDay` a few minutes ahead, and confirm
   `nextRunAt` in `GET /config`, then a `scheduled` run within ten minutes.
5. `GET /api/admin/jobs?type=db.backup.run` shows the job; `db.backup.sweep`
   appears every ten minutes.
6. Node offload: turn on both settings, call
   `GET /api/admin/db-backup/node-credential-preflight`, and follow
   [node-job-secrets.md](../runbooks/node-job-secrets.md).
7. Tests: `cd apps/api && npm test -- db-backup`, and `npm run test:db` for the real-Postgres suites.

## History

- Epic #254, Phase 6: #280 (`pg_*` wrappers, version guard, schedule
  arithmetic), #281 (model, active-run index, streaming engine), #282
  (scheduler, retention, staleness sweep), #283 (admin API), #288
  (`db_backup.backup_failed`).
- Restore, Phase 7: #284–#287 (see [database-restore.md](database-restore.md)).
- Epic #345 moved the backup onto the queue: #346 (execution profiles), #347
  (in-process lease renewal), #349/#350 (job-scoped secret broker), #351
  (`db.backup.run`, `pending` rows, `(true)` index), #352 (node offload,
  `pg_dump_version`), #353 (cron enqueue-only, `db.backup.sweep`).
- #373: `storageProvider` default became the empty string.
