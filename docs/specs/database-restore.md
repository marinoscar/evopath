# Database Restore

> **Status:** shipped · **Code:** `apps/api/src/db-backup/` (`restore-preflight.service.ts`, `database-restore.service.ts`, `admin-connection.util.ts`, `migration-state.util.ts`, `handlers/db-restore-run.handler.ts`, `handlers/db-restore-old-db-drop.handler.ts`), `apps/web/src/components/admin/DbBackupRestoreDialog.tsx`, `apps/web/src/pages/Admin/DbBackupPage.tsx` · **API:** `POST /api/admin/db-backup/runs/{id}/restore`, `/rollback` (see `/api/docs`) · **Admin UI:** `/admin/settings/db-backup` · **Runbook:** [database-restore.md](../runbooks/database-restore.md) · **Related spec:** [database-backup.md](database-backup.md)

An administrator can replace the live database with the contents of a
completed backup, and undo that replacement. A side-effect-free pre-flight
decides whether the automated path can run. The restore replays the archive
into a scratch database while the application keeps serving, verifies it, and
then swaps it in with two renames. When the automated path cannot run (most
often because the role lacks `CREATEDB`), the API answers with a paste-ready
command block for a manual restore instead of an error.

## 1. Purpose

- **What it is.** The recovery half of [database-backup.md](database-backup.md):
  restore from any `completed` backup row, with pre-flight gates, a safety net
  (a retained old database or a fresh `pre_restore` dump), a rollback, and an
  audit trail on the backup's own row.
- **What it is not.** Not point-in-time recovery, not a cross-cluster migration
  tool, and not safe with more than one API replica running (see
  [Migration roll-forward and exit](#migration-roll-forward-and-exit)). It
  never runs `prisma migrate deploy` for you.
- **Problem it solves.** A fork gets a restore that cannot leave a half-dropped
  live database behind, that a mis-click or a retried request cannot fire, and
  that still works on managed PostgreSQL where the app role cannot create
  databases.

## 2. How it works

### Overview

```
1. Download the archive to a seekable temp file; re-verify checksum and TOC.
2. (pre_restore_dump mode) take a fresh safety backup.
3. CREATE DATABASE <live>_restore_<ts>
4. pg_restore -j N into it   ← the app is fully up for this entire phase
5. Verify the restored database.
6. Swap, in seconds, then exit the process.
```

The application serves normally throughout steps 1–5, which take hours on a
real database (a `pg_dump` archive stores `CREATE INDEX`, so every index is
rebuilt). **A failure at any point before the rename leaves the live database
untouched and drops the scratch database.** The only destructive window is the
two renames.

### The pre-flight rule

> **No pre-flight path may create, drop or rename anything.**

An operator asks "can I restore this?" precisely when they have not decided to.
The pre-flight (`RestorePreflightService`) only reads. The test spies on the
four mutating helpers and matches every statement the fake cluster receives
against `CREATE DATABASE|DROP DATABASE|ALTER DATABASE|pg_terminate_backend`.

### The cluster admin connection

`admin-connection.util.ts` opens a short-lived `pg.Client` for one unit of work
(`withAdminConnection(config, fn)`).

- **Outside the Prisma pool.** `ALTER DATABASE … RENAME` fails while any
  session is connected to the database being renamed, and Prisma holds a pool
  of exactly those sessions. A database also cannot be renamed from a session
  connected to it, and Prisma is bound to the live database.
- **On the maintenance database, `postgres`.** When the application's own
  database is named `postgres`, it falls back to `template1`. The maintenance
  database is a parameter, not an environment variable.
- **Always closed** in a `finally`, on return, throw, and an optional
  wall-clock bound. A failing `end()` never masks the original error.
- **`statement_timeout` is set to `0`** on every admin session. A timeout
  cancels the client's wait, not the `CREATE`/`RENAME`, and leaves the caller
  unsure whether it happened. The optional wall-clock bound on the callback is
  off by default; pre-flight passes 15 seconds; the swap passes none.

| Operation | Reads or mutates | Called by pre-flight |
|---|---|---|
| `probeCreateDatabasePrivilege`, `probePgExtensionAvailable`, `readDatabaseSizeBytes`, `readDataDirectory`, `countDistinctClientAddresses` | read | yes |
| `databaseExists` | read | no (restore, before `CREATE DATABASE`) |
| `createDatabase`, `dropDatabase`, `terminateConnections`, `renameDatabase` | **mutate** | **never** |

### Identifiers and name builders

- **DDL cannot use bind parameters**, so every identifier is interpolated
  through `quoteIdentifier`, which **rejects** (never escapes) anything outside
  `^[A-Za-z_][A-Za-z0-9_$]*$` or over 63 bytes.
- Derived names: `<live>_restore_<ts>` (scratch) and `<live>_old_<ts>`
  (displaced), both UTC, using the same `compactTimestamp` as backup keys.
- **Trim the base, never the tail.** PostgreSQL silently truncates identifiers
  to 63 bytes. For a long database name, truncating the timestamp would make two
  restores share one scratch database. The builders shorten `<live>` so the
  suffix always survives.

### The gates

Seven gates, evaluated in one session and **all reported**, passes included.
Each verdict is `pass`, `warning` or `block` with its own `action` item.

| Gate | Kind | On failure |
|---|---|---|
| `pg_client_version` (client major vs server major) | capability | **blocks**, not overridable |
| `admin_connection` (maintenance database reachable) | capability | `guided` |
| `createdb_privilege` (probed, never assumed) | capability | `guided` |
| `extensions` (every installed extension is available) | capability | `guided` |
| `disk_space` (free ≥ ~1× database, +1× when retaining) | disk | **downgrades** the rollback mode, never refuses |
| `replicas` (distinct client addresses) | replicas | warning only |
| `schema_compatibility` (archive vs live migration) | overridable | blocks unless overridden |

- **`createdb_privilege`**: `SELECT (rolsuper OR rolcreatedb) FROM pg_roles
  WHERE rolname = current_user`. Managed PostgreSQL withholds `CREATEDB` as a
  matter of course.
- **`pg_client_version`** blocks because an older client cannot read the
  archive whoever runs it; the fix is an image rebuild
  ([postgres-client-version.md](../runbooks/postgres-client-version.md)). An
  unparseable version proceeds.
- **`extensions`** compares `pg_extension` in the live database (via Prisma)
  with `pg_available_extensions` on the cluster. It matters when restoring onto
  a new server.
- **`disk_space`**: under `retain_database`, a short disk downgrades the
  *effective* rollback mode to `pre_restore_dump` and reports that the recovery
  guarantee changes from seconds to hours. An unreadable data directory
  (`SHOW data_directory` needs privileges managed platforms withhold, and there
  is no `db` service in `base.compose.yml`) is a warning. Unreadable numbers
  leave the configured mode alone.
- **`replicas`**: `COUNT(DISTINCT client_addr)` approximates "more than one API
  instance". It also counts `psql` windows and exporters, and undercounts
  replicas behind NAT, so it only warns.
- **`schema_compatibility`** compares the run's `migration_name` with the live
  latest applied migration, using the single query in `migration-state.util.ts`
  that the backup engine also uses. It blocks in **both** directions:
  `archive_older` (running code selects columns that are missing) and
  `archive_newer` (the migration runner will see nothing to apply). An archive
  with no recorded migration is a warning.

### Outcomes and precedence

| Pre-flight outcome | API `mode` | Meaning |
|---|---|---|
| `ok` | `running` | Gates passed (warnings may be attached); the restore is queued |
| `guided` | `guided` | A capability gate failed; the body carries a command block. Nothing started |
| `blocked` | `blocked` | Something would fail or corrupt the deployment. Nothing started |

- **Precedence:** non-overridable block, then `guided`, then overridable block.
  `guided` outranks the schema block so the operator is not told to re-send
  with an override that cannot help; the guided block gains a migration step
  instead.
- **The override unblocks exactly one gate.** `overrideSchemaCheck` (the API
  field; the service option is `overrideSchemaMismatch`, and the field name is
  published as `block.overrideParameter` from `RESTORE_SCHEMA_OVERRIDE_FIELD`)
  clears `schema_compatibility` and nothing else.

### The guided command block

On `guided`, the command block **is** the deliverable, and it is asserted by
string in tests:

- Fully parameterised: real host, port, user, database names, run id, archive
  filename. No `<placeholder>`.
- Two values are deliberately not printed: the **password** (exported from the
  operator's environment) and the **signed download URL** (minted, with a
  five-minute expiry, by the command on the line above).
- Ends with the two renames that undo the swap, and a runbook pointer. Gains a
  migration step only when the schema also mismatches.
- No hard-coded application, product or repository name.

### What pre-flight does not check

- **The archive's bytes.** Reading a database-sized object through
  `pg_restore --list` cannot fit in an HTTP request. It is the restore job's
  first phase.
- **Whether derived names are free.** The timestamp is generated when the
  restore builds the name; `databaseExists` runs then.
- **The run's status, the caller's permission, the 404.** The endpoint owns
  those.

### The restore job: `db.restore.run`

`startRestore` runs the pre-flight and, on `ok`, **enqueues** `db.restore.run`;
a worker calls `executeRestoreJob`.

- **Profile:** `maxRuntimeMs` 6 hours, **`maxAttempts: 1`**. Attempts are
  charged at claim time, so a restore whose executor dies is failed by the
  reaper, never re-run.
- **Server-only, permanently.** It carries neither `nodeResultSchema` nor
  `persistNodeResult`. It renames the live database, terminates connections,
  needs `CREATEDB`, and exits the process.
- **Concurrency: three guards.**
  1. `activeRestoreRunId`, a process-local flag set before the pre-flight,
     closes the double-click race.
  2. A type-wide query for a `pending`/`running` `db.restore.run` refuses a
     second restore of *any* archive, including one queued by another process.
  3. The queue's active-dedup index closes the same-archive race between
     replicas atomically.
  All three answer `already_running`, which the controller maps to `409`.
  A `pending` restore job nothing claims blocks later restores until an
  operator deletes it from `/admin/settings/jobs`.
- **The pre-flight also runs inside `startRestore`**, not only in the endpoint,
  so no caller (including rollback) can reach a restore with no gates.

### Download and re-verification

- **Downloaded to a file, not streamed.** `pg_restore -j N` seeks, and refuses
  `-j` with stdin. The file uses `JOB_TEMP_PREFIX` from
  `apps/api/src/jobs/job-temp.ts`, so the temp-file janitor sweeps it after a
  SIGKILL. It is deleted before the swap (the process does not return from it).
- **Re-verified against the bytes as they are now:** both the stored SHA-256
  and `pg_restore --list`. A failure raises `DatabaseRestoreArchiveError`
  **before `CREATE DATABASE`**.

### Safety backup

Taken only in the *effective* `pre_restore_dump` mode (under
`retain_database`, the displaced database is the way back). It goes through
`DatabaseBackupRunnerService.startBackup` (trigger `pre_restore`), so the
single-active-run index still applies. `startBackup` is detached, so the
restore **polls the row until it settles** before continuing. A safety backup
that does not complete abandons the restore before anything is created.

### Verification of the restored database

`--exit-on-error` proves no statement failed. Two cheap checks prove there was
something to restore:

- at least one ordinary table outside the system schemas;
- a non-empty `_prisma_migrations`.

The archive's migration is already on the run row and was already gated, so
this step does not re-read it.

### The swap

```ts
await writeRestoreState(runId, { restoreStatus: 'swapping' });
const catalog = await exportCatalog(runId, { /* post-swap audit values applied */ });

await maintenance.setInMemoryOverride({ enabled: true, message, allowAdmins: false });

await withAdminConnection(pg, async (client) => {
  await prisma.$disconnect().catch(() => {});
  await terminateConnections(client, pg.database);

  await renameDatabase(client, pg.database, oldDb);
  try {
    await renameDatabase(client, scratchDb, pg.database);
  } catch (err) {
    await renameDatabase(client, oldDb, pg.database).catch(logCritical);
    throw err;
  }

  await reinsertCatalog(pg, catalog);   // the settled `jobs` row goes first
});

await announceRestoreCompleted(...);   // awaited
exitProcess(0);                        // the supervisor rebuilds the pool
```

- **Maintenance window, in memory, `allowAdmins: false`.** The persisted flag
  lives inside the database being renamed, so `MaintenanceModeService` has an
  in-memory override layer used only here. Between the renames there is no
  database under the live name, so even admins are held back. The window is
  released by the exit, not before it.
- **The job settles itself inside the carry.** `process()` never returns on
  this path, so the worker's terminal write never runs. `CARRY_JOB_SQL` upserts
  the `jobs` row as `succeeded` (lease and claim cleared) as the first write
  into the promoted database. It lands if and only if both renames succeeded.
  Without it, the restarted reaper would mark a successful restore `failed`.

### Inner recovery

If the second rename fails, the original is renamed back.
`DatabaseRestoreSwapError` carries `originalRestored`:

| `originalRestored` | State | Behaviour |
|---|---|---|
| `true` | Back on the original database; the restore did not happen | Close the maintenance window, record the failure, **do not exit** |
| `false` | No database under the live name | **Leave the window open** (orderly 503s), log CRITICAL with both names, keep the process up; a human finishes the swap ([runbook](../runbooks/database-restore.md), "The swap half-completed") |

**The scratch database is kept when the swap fails** (it is a complete,
verified restore; the failure was a rename). It is dropped for every failure
before the swap.

### Catalog carry-over

The restored database's `database_backup_runs` is as of backup time. Rows are
exported before the rename and re-inserted after, through a second session on
the live name:

1. **This run's post-swap audit values are applied during the export**, never
   written to the database about to be renamed away.
2. **User FKs go through a subselect** (`(SELECT id FROM users WHERE id = $n)`),
   so an admin created after the backup becomes `NULL` instead of aborting the
   whole carry with an FK violation.
3. **`ON CONFLICT (id) DO UPDATE`**, never `DO NOTHING`, because most ids
   already exist with stale contents.
4. **`pre_restore_backup_id` is a second pass**, after every referent exists.

`reinsertCatalog` **never throws**: by then the swap is irreversible, and a
throw would reach a failure handler that assumes it was not. A failed carry
logs CRITICAL and names the manual fix.

### Migration roll-forward and exit

- `_prisma_migrations` comes from the archive, so after the swap the database
  is at the archive's migration. **Run `prisma migrate deploy` yourself** when
  the schemas differed; it is documented, never automatic.
- **The restore ends in `process.exit(0)`.** There is no API to rebuild a
  Prisma pool in place. The exit is behind `DatabaseRestoreSeam.exitProcess`
  so tests can assert it.
- Two hard prerequisites, neither enforceable from code:
  - **a restart policy** (`restart: unless-stopped` or a Kubernetes
    Deployment), or a successful restore leaves the app down;
  - **a single API replica**, because the maintenance flag is per-process.

### Rollback

`DatabaseRestoreService.rollback` returns one of three results:

| `mode` | When | Cost |
|---|---|---|
| `renamed` | The retained `<live>_old_<ts>` still exists | **Seconds**: the swap with names exchanged |
| `restore_started` | It is gone, but a completed `pre_restore` backup exists | **Hours**: delegates to `startRestore` against that archive, gates included, with the schema check overridden |
| `unavailable` | Neither exists | None; the rollback window closed |

- The `renamed` path is a synchronous admin request, not a queue job. It
  reuses the same `renameSwap`, so the inner recovery exists once. It parks the bad restore under a fresh `<live>_restore_<ts>` and never
  drops it.
- It carries the catalog over too, and sets `restore_status: 'rolled_back'`.
- The schema override on `restore_started` is required: the live migration is
  now the archive's, so the gate would block spuriously.
- The rollback's exit is delayed by `ROLLBACK_EXIT_DELAY_MS` (500 ms) so its
  HTTP response is delivered first.

### Dropping retained databases

`db.restore.old-db-drop`, enqueued by the backup scheduler's ten-minute tick,
calls `DatabaseRestoreService.dropExpiredOldDatabases`:

- **Row-driven, not name-driven.** It drops only `<live>_old_<ts>` names
  recorded in `restore_old_db`, never anything matching the prefix in
  `pg_database`, so a database an operator created by hand from the guided
  block is never touched. The cost: if the carry-over failed, nothing drops
  that database automatically.
- The clock is `swapped_at` (older than `oldDatabaseRetentionHours`); an
  in-flight restore has `NULL` and can never be swept.
- A semantic guard refuses a name equal to the live or maintenance database.
- Server-only, no profile of its own; idempotent (`databaseExists` skips a
  database already gone).

### Progress and audit trail

`restore_status`: `restoring → verifying → swapping → completed | failed`, plus
`rolled_back`. `restoring` covers download through the last `pg_restore` byte.
Every progress write swallows its own failure.

| `audit_events.action` | Written | Lands in |
|---|---|---|
| `db_restore:start` | At the beginning | The pre-swap database (survives in `<live>_old_<ts>`) |
| `db_restore:swap` | Just before the renames | The pre-swap database |
| `db_restore:complete` | After the renames, via the carry | The promoted database, with the whole timeline in `meta` |
| `db_restore:failed` | Any failure before the swap settles | The live database |
| `db_restore:rollback` | On a rename rollback, via the carry | The promoted (original) database |

The per-restore audit also lives on the backup's own row (`restore_status`,
`restore_error`, `restored_at`, `restored_by_id`, `restore_scratch_db`,
`restore_old_db`, `swapped_at`, `pre_restore_backup_id`); see
[database-backup.md](database-backup.md#model-database_backup_runs).

### HTTP endpoints

```
POST /api/admin/db-backup/runs/{id}/restore    { "confirmation": "RESTORE",
                                                 "overrideSchemaCheck"?: boolean }
POST /api/admin/db-backup/runs/{id}/rollback   { "confirmation": "ROLLBACK" }
```

- **Typed confirmation literal.** Exactly `RESTORE` / `ROLLBACK`, uppercase, a
  Zod literal on the DTO. Anything else is a `400` that starts nothing (the
  restore service is never called). Different words per route, so a copied body
  cannot fire the other operation. `overrideSchemaCheck` defaults to `false`.
- **Returns once the cheap gates have run.** The caller polls
  `GET /runs/{id}` and reads `restoreStatus`. The poll sees `swapping`, then
  connection errors, then `completed` after the supervisor restarts the
  process. That sequence is success.
- **Six normal outcomes, all `200`, keyed by `mode`** (restore: `running`,
  `guided`, `blocked`; rollback: `renamed`, `restore_started`, `unavailable`).
  `running` carries `runId`, `scratchDatabase`, `oldDatabase`, `preflight`;
  `guided` carries `guidance { reason, commands, runbook }`; `blocked` carries
  `block { gateId, message, overridable, overrideParameter }`. `preflight`
  lists every gate plus the rollback plan, both migration names and the size
  readings.
- **`409`** for a concurrent restore, with the active id at
  `details.activeRunId` (top-level fields are dropped by
  `HttpExceptionFilter`).
- **Error mapping in the controller.** The admin service throws domain errors
  (`DatabaseRestoreRunNotFoundError` → `404`, `DatabaseRestoreNotAllowedError`
  → `400`) because the restore path is also re-entered from inside a running
  rollback. Not-allowed means restoring a run that is not `completed`, or
  rolling back a run that was never restored.
- The run DTO publishes the `restore*` columns; an unrecognised stored
  `restoreStatus` narrows to `null`.

### Operator UI

`DbBackupPage.tsx` (row actions), `DbBackupRestoreDialog.tsx`,
`DbBackupConfigPanel.tsx`, `dbBackupTable.tsx`, `hooks/useDbBackup.ts` and
`services/dbBackup.ts`:

- **One dialog, `intent: 'restore' | 'rollback'`**, so the acknowledgement and
  typed-literal machinery exists once.
- **Consent.** The first confirm needs an acknowledgement that the application
  will restart plus the typed literal. After a `blocked` outcome, the override
  needs a second acknowledgement naming the mismatch and the literal typed
  again (the field is cleared). Both fields reset on every open.
- **Every gate is rendered**, passes included. A downgraded rollback plan gets
  its own warning ("hours, not seconds").
- **`guided` is rendered at `info` severity**, with a copyable, selectable
  command block. The runbook is shown as a repository path, not a link.
- **Preconditions disable controls, never hide them**, using the predicates
  `isBackupDownloadable`, `isBackupRestorable`, `isBackupCancelable`,
  `isBackupDeletable`, `isRollbackAvailable`. A `stale` run is neither
  downloadable nor restorable.
- **The mid-swap outage is expected.** While a restore is in flight, an
  unreachable API renders at `info` ("This is the expected last step"). The flag
  stays set until a successful read shows nothing in flight. The following
  `503` with the maintenance marker is handled by `MaintenanceGate`.
- **Byte fields stay strings** end to end.
- The policy form omits `storageProvider` and `runStaleMinutes`; both remain
  settable through `PUT /api/admin/db-backup/config`.

### Notification

`db_backup.restore_completed` is **mandatory** (users cannot mute it). It is
raised from inside the promoted database, `await`ed before `process.exit(0)`,
and never throws. Recipients are holders of `db_backup:read`, resolved from the
restored `users`, plus the actor if they exist there. See
[browser-notifications.md](browser-notifications.md).

## 3. Configuration and permissions

### Settings (`databaseBackup` namespace)

| Key | Effect on restore |
|---|---|
| `restoreRollbackMode` | `retain_database` (default: keep the displaced database, rollback in seconds) or `drop_database` (take a `pre_restore` dump instead; the pre-flight reports this as `pre_restore_dump`) |
| `oldDatabaseRetentionHours` | How long a retained database, and a `pre_restore` backup, are kept (default 48) |

Full namespace: [database-backup.md](database-backup.md#settings-databasebackup-namespace).
No environment variables are specific to restore.

### Permissions

`db_backup:restore` gates both routes, and nothing else does. Both routes also
require the Admin role. It is seeded Admin-only. See §6 for why it is separate
from `db_backup:write`.

### API surface

| Method + route | Purpose | Permission |
|---|---|---|
| `POST /api/admin/db-backup/runs/{id}/restore` | Pre-flight, then queue the restore; body `{"confirmation":"RESTORE"}` | `db_backup:restore` |
| `POST /api/admin/db-backup/runs/{id}/rollback` | Undo the last restore of this run; body `{"confirmation":"ROLLBACK"}` | `db_backup:restore` |
| `GET /api/admin/db-backup/runs/{id}` | Poll `restoreStatus` | `db_backup:read` |

### Job types

| Type | Role |
|---|---|
| `db.restore.run` | The restore. Server-only; 6 h; 1 attempt |
| `db.restore.old-db-drop` | Drop retained databases past their window. Server-only |

## 4. Extending it in a fork

- **Additional pre-flight gates** go in `restore-preflight.service.ts`. A gate
  must only read, must report on pass as well as failure, and must decide which
  outcome it feeds (`guided` for capabilities, `blocked` for correctness,
  warning for heuristics). Add a case to the "no create/drop/rename" test.
- **Anything that mutates the cluster** goes through the existing helpers in
  `admin-connection.util.ts`, so it inherits the identifier allowlist and the
  connection contract.
- **Tables that must survive a restore** (like `database_backup_runs`) need the
  same carry-over treatment in `exportCatalog`/`reinsertCatalog`. Otherwise a
  restore returns them to backup time.
- **More than one API replica.** Stop the other replicas before restoring;
  nothing here coordinates them.
- The operator procedure lives in the
  [runbook](../runbooks/database-restore.md); extend it there.

## 5. Guardrails

| Test | Enforces |
|---|---|
| `apps/api/src/db-backup/admin-connection.util.spec.ts` | Connection always closed; `statement_timeout` 0; `template1` fallback; identifier allowlist; long names keep their suffix |
| `apps/api/src/db-backup/restore-preflight.service.spec.ts` | Each gate's outcome; guided block asserted by string; override scope; disk downgrade; **no pre-flight path creates, drops or renames** |
| `apps/api/src/db-backup/database-restore.service.spec.ts` | Failure at each phase leaves live untouched; inner recovery; carry-over rules; `allowAdmins: false`; re-verification; rollback modes; row-driven drop |
| `apps/api/src/db-backup/database-restore.db.spec.ts` | Against real PostgreSQL: rename refused onto a taken name, inner recovery, no leaked session, subselect FK yields `NULL`, self-FK second pass |
| `apps/api/src/db-backup/handlers/db-restore-run.handler.spec.ts` | `db.restore.run` has no node members and is in `serverOnlyTypes()` |
| `apps/api/src/db-backup/dto/db-backup-restore.dto.spec.ts` | Result → `mode` mapping; `guidance`/`block` hoisted; override field name tied to `RESTORE_SCHEMA_OVERRIDE_FIELD` |
| `apps/api/src/db-backup/db-backup-admin.service.spec.ts` | Refuses non-`completed` and never-restored runs without reaching the engine |
| `apps/api/test/db-backup/db-backup-restore.integration.spec.ts` | Confirmation literal (never reaches the service); all modes; guided is `200`; `409` `details.activeRunId`; `db_backup:restore` required and `db_backup:write` alone gets `403` |
| `apps/web/src/__tests__/pages/Admin/DbBackupPage.test.tsx`, `pages/Admin/dbBackupTable.test.ts`, `hooks/useDbBackup.test.ts` | Disabled (not hidden) actions, expected-outage rendering, string byte fields |

No test runs an end-to-end restore of a real archive into a real database;
that needs `pg_dump`, `pg_restore` and a spare cluster, and is what a staging
rehearsal is for.

## 6. Design decisions

- **`db_backup:restore` is its own permission.** Scheduling a nightly dump and
  replacing the production database are different authorities. A separate
  permission lets a deployment grant the first without the second. Folding it
  into `db_backup:write` would silently give every existing holder the power
  to roll back production.
- **Replay into a scratch database, then rename.** In-place
  `pg_restore --clean` drops every object first, including the table tracking
  the restore, so a mid-way failure leaves a broken live database with no UI and
  no way back.
- **Admin connection outside the Prisma pool.** The pool's sessions are what
  must be gone before a rename, and Prisma cannot connect elsewhere.
- **`statement_timeout` 0, not a defensive timeout.** A cancelled rename may or
  may not have happened; an unbounded, visible wait is safer than ambiguity.
- **Reject identifiers, do not escape them.** An allowlist's worst failure is a
  loud refusal.
- **Probe `CREATEDB`, never assume it.** Assuming it moves the failure into
  the middle of an incident.
- **`guided` is a `200`, not a `4xx`.** Managed PostgreSQL is a supported
  platform; the body is the working alternative.
- **Downgrade on short disk, never refuse.** An operator mid-incident must keep
  a path forward; the cost is reported.
- **The replica heuristic only warns.** It cannot tell a replica from a `psql`
  window.
- **One override field, one gate.** A single `force` flag would turn the escape
  hatch into a way to skip every gate, including capability facts.
- **Typed literal, not `confirm: true`.** Browsers, proxies, retries and
  double-clicks all reproduce a boolean; none reproduces a typed word.
- **One status, one discriminator.** `202`/`409` per outcome would misreport
  `guided` and `blocked`, which started nothing.
- **Download, not stream, into `pg_restore`.** Streaming forfeits `-j`
  parallelism on the phase that dominates the runtime.
- **Re-verify, do not trust the backup-time checksum.** The object has sat in
  storage, and a download can truncate.
- **Carry the catalog over; never throw from it.** Skipping it loses every
  backup since the archive, including the way back.
- **Exit after the swap; never auto-migrate.** No API repoints a Prisma pool;
  an automatic migration makes one irreversible act into two.
- **Row-driven drop of retained databases, as a job.** A prefix sweep would
  drop a database an operator created by hand.
- **One dialog for restore and rollback**, and warnings visible before the
  decision, not after a failure.

## 7. Verification

1. Take a backup and wait for `completed` (see
   [database-backup.md](database-backup.md#7-verification)).
2. Confirm the literal is enforced:
   ```bash
   appctl api POST /api/admin/db-backup/runs/<id>/restore --data '{"confirmation":"restore"}'
   ```
   Expect `400`, and no new `db.restore.run` in `/admin/settings/jobs`.
3. On a role without `CREATEDB`, send `{"confirmation":"RESTORE"}`: expect
   `200` with `mode: "guided"` and a command block with real names and no
   placeholders.
4. On a disposable deployment with a restart policy and one API replica,
   restore from `/admin/settings/db-backup`. Watch `restoreStatus` move through
   `restoring`, `verifying`, `swapping`; see the expected outage; then
   `completed`, the `db_backup.restore_completed` notification, and the backup
   list intact.
5. Roll back with `{"confirmation":"ROLLBACK"}`: expect `mode: "renamed"`
   under `retain_database`.
6. Tests: `cd apps/api && npm test -- db-backup`, and `npm run test:db` for
   `database-restore.db.spec.ts`.
7. Follow the manual procedure in the
   [runbook](../runbooks/database-restore.md) once in staging.

## History

- Epic #254, Phase 7: #284 (cluster admin connection, pre-flight gates), #285
  (scratch restore, swap, rollback, catalog carry-over, retained-database
  drop), #286 (restore and rollback endpoints, `db_backup:restore`), #287
  (operator dialog and page).
- #288: `db_backup.restore_completed` notification.
- Epic #345, #353: restore became the `db.restore.run` queue job and the
  retained-database drop became `db.restore.old-db-drop`.
