# Runbook: Baseline EvoPath's Database onto the Platform Migration History

**Status.** The code side and the rehearsal are done (section 6). The
**production step is an owner step** and has not been run (section 7). Do not
run it from an agent session.

This is the EvoPath record of adopting `@marinoscar/platform-db`: the mapping
of the platform's migration history (v1, `0001` to `0022`) onto the migration
directories this database already applied, the deviations that were decided,
the rehearsal log, and the production procedure.

The generic procedure and the tool's reference are in EnterpriseAppBase:
`docs/runbooks/database-baseline.md` and `packages/platform-db/README.md`. This
page does not repeat them; it records what is specific to EvoPath.

Tracking: [marinoscar/EnterpriseAppBase#747](https://github.com/marinoscar/EnterpriseAppBase/issues/747)
(PP-10.6). Adoption ledger: [platform-adoption/README.md](../platform-adoption/README.md).

---

## 1. What changed and what did not

Adopting the package changes **no existing migration**. Every directory under
`apps/api/prisma/migrations/` that the production database applied is untouched,
under its original name, with its original bytes.

| Change | Effect on the database |
|---|---|
| `apps/api/prisma/platform.lock` (new) | none. A file; `db:check` and `db:drift` read it |
| `@marinoscar/platform-db` in `apps/api` | none |
| New migration directory `20261007141520_add_retention_created_at_indexes` | **one real change on the next `prisma:migrate`**: three plain btree indexes, `notification_deliveries_created_at_idx`, `notifications_created_at_idx`, `ai_runs_created_at_idx`, on `created_at`. No data change, no column change |
| `@@index([createdAt])` on `NotificationDelivery`, `Notification`, `AiRun` in `schema.prisma` | none; it makes the schema match the migration so `db:drift` stays empty. The generated client types do not change |
| CI: `db:check`, `db:check:database`, `db:drift` after `prisma:migrate` | none |

Why a migration appears at all: the package's history now has 22 migrations and
EvoPath's database holds the first 21. Migration `0022` (retention indexes) is
**new to this database**. The baseline therefore runs with `--through 21`
("the database equals platform migration 21"), installs `0022` as a byte copy at
the end of EvoPath's history, and leaves `prisma migrate deploy` to apply it
like any other migration. It is **not** marked applied by hand.

## 2. The mapping

`platform.lock` maps all 22 package migrations. **Zero** `prisma migrate resolve`
calls are needed, because every one of the first 21 is already recorded in
`_prisma_migrations` under a local name.

| Platform id | EvoPath directory | How it matched |
|---|---|---|
| `0001_initial` to `0019_add_device_session_credential_link` (19 migrations) | the same names, `20260124223146_initial` to `20260927130000_add_device_session_credential_link` | identical bytes |
| `0020_add_worker_node_vitals` | `20260930100000_add_worker_node_vitals` (**renamed id**; the platform's is `20260928100000_...`) | identical bytes, matched by hash. The directory name is irrelevant to the match |
| `0021_add_job_trace_context` | `20260930120000_add_job_trace_context` | identical after stripping comments. Line 1 differs: `Issue #132` here, `Issue #607` in the package. The lock records `localSha256` (this file's hash) and a `note`; the checksum Prisma stored for the applied file is this file's, so the local file is **not** edited |
| `0022_add_retention_created_at_indexes` | `20261007141520_add_retention_created_at_indexes` (**new**) | installed byte copy |

The 30 other directories (everything from `20260929125915_add_health_profile`
onward, plus the Android and memory work) are EvoPath's own and are not in the
lock. Their interleaving with platform directories is harmless: the lock records
origin, not position, and `db:check` does not require platform directories to be
contiguous (it checks only that they sort in package order, which they do).

## 3. Deviations that were decided

Declared in `platform.lock` under `deviations` and `rawSqlIndexes`.

| Deviation | Decision |
|---|---|
| `push_subscriptions.platform TEXT NOT NULL DEFAULT 'browser'` and the check constraint `push_subscriptions_platform_check` (migration `20261004100000_add_push_subscription_platform`; the Android push channel depends on it) | Declared as `app:push-subscriptions-platform`. **Never dropped.** The platform history has no equivalent migration, so a seam request to add it to `platform-db` is the way to remove the deviation. The check constraint is not printed by Prisma's diff, so the baseline does not see it; `push-subscription-platform.db.spec.ts` covers it |
| EvoPath's 46 domain models: 9 enums, 46 tables, 91 indexes and 77 foreign keys, including the foreign keys to `users`, `storage_objects` and `personal_access_tokens` | Declared as `app:domain-types`, `domain-tables`, `domain-indexes`, `domain-foreign-keys`, 223 statements generated from the dry run. They are **not deviations of platform-owned objects**: no platform table, column or constraint is altered by them. The tool's diff has no app-object filter, so each statement must be listed or it reports `DIFF_BLOCKING`. They matter only to `db:baseline`; `db:check`, `db:check:database` and `db:drift` ignore them |
| EvoPath's 10 domain raw-SQL partial unique indexes | Listed in `rawSqlIndexes` (name and `pg_indexes.indexdef`), so `db:drift` asserts them next to the platform's four. They stay out of `schema.prisma`: never "fix" them with `@@unique` |
| Anything else | There was nothing else. The dry run's 224 statements are exactly the five groups above |

`20260930180000_remove_user_ai_model_choices` is a data-only `UPDATE`. It changes
no schema and the baseline does not see it. It matters for the identity adoption
(a later story).

## 4. Rules that apply from now on

- **Never rename, edit or delete a migration directory listed in
  `platform.lock`.** `_prisma_migrations` identifies a migration by its directory
  name and stores its checksum. A renamed directory looks new and would run again.
  `npm run db:check` (and CI) fail on a changed, renamed or missing locked
  directory.
- **Never write to `_prisma_migrations` by hand.** For this adoption the expected
  number of `prisma migrate resolve --applied` calls is zero. If any tool proposes
  one, stop and investigate on the issue.
- **Never run `db:baseline -- --apply` in production.** The lock is committed and
  complete; there is nothing to apply. `appctl deploy update` must never run a
  baseline either.
- **Forward-only.** Never drop `push_subscriptions.platform` or its data.
- **EvoPath's own migrations** keep using `npm run prisma:migrate:dev`. They are
  not in the lock.
- **Upgrading the package.** Change the version in every platform URL, run
  `npm install`, then `npm run db:sync` (installs new platform migrations as new
  directories and extends the lock), review them, commit, and `npm run
  prisma:migrate`.

## 5. Commands (all from `apps/api`)

| Command | What it does | Writes to the database |
|---|---|---|
| `npm run db:sync` | installs platform migrations the lock lacks. Prints "up to date; nothing to install" now | no |
| `npm run db:check` | offline: every locked file is byte-identical to the lock (or its recorded comment-only divergence), none missing | no |
| `npm run db:check:database` | the same, plus every `_prisma_migrations` row matches the file on disk | no |
| `npm run db:drift` | replays the history in a throwaway shadow database and compares it with `schema.prisma`; asserts the 14 raw-SQL indexes | no (creates and drops its own shadow database; needs `CREATEDB` or `SHADOW_DATABASE_URL`) |
| `npm run db:baseline -- --through 21` | the baseline **dry run** (no `--apply`): B1 map, B2 ledger, B3 diff, B4 indexes | no |

`db:drift`, `db:check:database` and `db:baseline` read `DATABASE_URL`, built by
`scripts/platform-env.js` from `POSTGRES_*`, as `scripts/prisma-env.js` does. Use
these scripts, never a bare `npx prisma` or `npx platform`.

## 6. Rehearsal log

Run on 2026-10-07 against a local PostgreSQL 16.14, from the branch that carries
this page. No row data appears below.

### 6.1 Setup: a restored copy

The production backup archive was not available to the agent session. The copy is
the closest local equivalent, made the same way:

1. Build a database from EvoPath `origin/main`'s own history:
   `npm run prisma:migrate` into an empty database (51 migrations), then
   `npm run prisma:seed`.
2. `pg_dump -Fc` it (the format `db.backup.run` writes; 251 KB), then
   `createdb` a new database and
   `pg_restore --no-owner --no-privileges -d <copy> <archive>`.
3. The copy has 51 rows in `_prisma_migrations` and 78 tables in `public`
   (the 77 models plus the ledger).

**Repeat this section against a real production archive before the production
step** (`docs/runbooks/database-restore.md` section 4.1 for where the archive comes
from, and section 4.3 for the scratch database; never the in-app restore). The
outcome should be the same; any difference means the copy is not faithful or
production has drifted, and the production step must wait.

### 6.2 The log

| # | Command (against the copy) | Result |
|---|---|---|
| 1 | `npm run prisma -- migrate status` | `51 migrations found`, `Database schema is up to date!` |
| 2 | `SELECT count(*) FROM _prisma_migrations` | `51`; ledger digest recorded for comparison |
| 3 | `npm run db:baseline` (no lock yet, default `--through`) | `B1: 21 matched, 1 unmatched, 30 app-only`; `B3: 227 blocking`: the 3 retention indexes missing in the database, `push_subscriptions.platform`, and 223 domain statements. The 21 matches: 19 `[sha256]`, `0020` `[sha256]` under its renamed directory, `0021` `[normalised, localSha256 recorded]` |
| 4 | `npm run db:baseline -- --through 21` (no lock) | `B3: 224 blocking` (the same minus the 3 indexes); this list is what the lock's `deviations` were generated from |
| 5 | lock with the five deviations, `rawSqlIndexes`, no migrations; `npm run db:baseline -- --through 21` | `B1: 22 matched`, `B2: 0 problems`, `B3: 0 blocking, 224 declared`, `B4: 0 problems`, `B5: 0 to resolve, 1 to install only`, `dry run clean` |
| 6 | `npm run db:baseline -- --through 21 --apply` | installed `20261007141520_add_retention_created_at_indexes`; wrote `platform.lock` (22 entries); `B6 verify: ok`; `baseline applied and verified` |
| 7 | `SELECT count(*), <digest> FROM _prisma_migrations` | still `51` and the same digest: **the apply wrote nothing to the database** |
| 8 | `npm run prisma -- migrate status` | one migration not yet applied (exit 1, as Prisma does) |
| 9 | `npm run prisma:migrate` | applied only `20261007141520_add_retention_created_at_indexes` |
| 10 | `npm run prisma -- migrate status` | `52 migrations found`, `Database schema is up to date!` |
| 11 | `npm run db:sync` | `up to date; nothing to install` |
| 12 | `npm run db:check` | `ok (22 installed platform migration(s))` |
| 13 | `npm run db:check:database` | `ok (52 ledger row(s) match the files)` |
| 14 | `npm run db:drift` | first run: `SCHEMA_DRIFT`, `DROP INDEX` for the 3 retention indexes (`schema.prisma` lacked them). After adding the three `@@index([createdAt])`: `ok (the migrations equal the schema; 14 raw-SQL index(es) present)` |
| 15 | `npm run db:baseline` (default `--through`, lock present) | `B1: 22 matched`, `B3: 0 blocking, 224 declared`, `B5: 0 to resolve, 0 to install only`, `nothing to do` |
| 16 | `npm run prisma:seed`, twice | both `Database seeding completed successfully` |
| 17 | `DbMigrationsDoctorCheck.run()` (the `db.migrations` check) against the copy | `pass`, `52 migrations applied, none failed` |
| 18 | `npm run build`, then `npm run smoke` with the copy as the database | `/api/health/live` 200, `/api/health/ready` 200 ("can reach the database"), `/api/openapi.json` 200, `all checks passed` |
| 19 | a fresh empty database, `npm run prisma:migrate`, then 12, 13, 14 | all `ok` (`52 ledger row(s)`, `14 raw-SQL index(es)`): the adopted history deploys from scratch |
| 20 | `npm run test:db` on the fresh database | 94 suites passed; 1507 tests passed, 4 skipped (including `platform-lock.db.spec.ts`, `push-subscription-platform.db.spec.ts`, `job-schema-indexes.db.spec.ts`) |
| 21 | negative run: append a line to `20260906120000_add_jobs/migration.sql`, `npm run db:check` | exit 1: `LOCAL_MODIFIED platform:0008_add_jobs ... an installed migration is never edited`. Restored with `git checkout` |

### 6.3 The state production will be in, and the one trap in it

Row 5 above is the lock **before** `--apply`. The committed lock is the lock
**after** it, and production will see the new image with the database not yet
migrated. That state was rehearsed on a second copy of the same archive:

| Command (second copy, committed lock, `0022` not applied yet) | Result |
|---|---|
| `npm run db:baseline -- --through 21` | `B1: 22 matched`, `B2: 0 problems`, `B3: 0 blocking, 224 declared`, `B4: 0 problems`, `B5: 0 to resolve, 0 to install only`, **`nothing to do`**. Exit 0 |
| `npm run db:check:database` | `ok (22 ...)`, `1 migration(s) not applied yet (run prisma migrate deploy)`, `ok (51 ledger row(s) match the files)`. Pending is not a failure |
| `npm run db:baseline` (**no `--through`**) | `B2: 1 problem`, `B3: 3 blocking` (the 3 retention indexes), `B5: 1 to resolve` (`would resolve --applied 20261007141520_...`), **`REFUSED DIFF_BLOCKING`**. Nothing was written |
| `npm run prisma:migrate` | applied only `20261007141520_...`; the other 51 ledger rows are byte-for-byte the same (same digest) |
| then `db:baseline`, `db:check:database`, `db:drift`, `migrate status` | `nothing to do`, `ok (52 ...)`, `ok (... 14 raw-SQL index(es))`, `up to date` |

**The trap.** Before the migration is applied, a dry run **without
`--through 21`** proposes `prisma migrate resolve --applied` for `0022`. That
would mark three indexes applied that do not exist. The diff check refuses it
here, but the rule stands: **before `prisma:migrate`, always pass
`--through 21`; if any command proposes a `resolve`, stop.** After
`prisma:migrate`, the plain command is the right one.

## 7. Production procedure (owner step)

Not run. Run it after the rehearsal in section 6.1 has been repeated on a real
backup archive and gave the same results. The agent that wrote this page does
not run any of it.

**Before you start**

- Decide when the change deploys. Merging the pull request puts migration
  `20261007141520_add_retention_created_at_indexes` in the repository, and the next
  `evopathcli deploy update` (including a scheduled one: see
  `docs/runbooks/deploy-to-vps.md`, the cron example) runs `prisma:migrate` and
  applies it. That is safe (three index builds, no data change), but if you want
  the verification below to come first, pause the scheduled update, or run the
  steps before merging with the branch checked out on the server.
- The database role needs `CREATEDB` for the dry run's throwaway shadow database.
  If it does not (common on managed PostgreSQL), create an empty database
  and add `--shadow-database-url <url>` to the dry run and to `db:drift`
  (`SHADOW_DATABASE_URL` for `db:drift`).
- Use the same `-f` files and `-p` project the deployment record uses
  (`evopathcli deploy status`; the compose project name is recorded, never
  re-derived). Below, `COMPOSE` stands for that whole prefix, for example
  `cd infra/compose && docker compose -p <project> -f base.compose.yml -f prod.compose.yml -f vps.compose.yml`.

**Steps**

1. **Fresh backup.** On `/admin/settings/db-backup`, choose **Back up now**, wait
   for status `succeeded`, and note the run id. This backup is the rollback.
   (A backup older than the last write is not a rollback.)
2. **Open a maintenance window** if you want one:
   `docs/runbooks/maintenance-mode.md`. Optional here, because the baseline writes
   nothing; `evopathcli deploy update --maintenance` covers the migration itself.
3. **Build the new image without restarting anything**, so the commands run
   against the new code: `COMPOSE build api`. The running `api` container is not
   touched.
4. **Pre-flight dry run** (read-only, no `--apply`):

   ```bash
   COMPOSE run --rm --no-deps api npm run db:baseline -- --through 21
   ```

   Expect, and compare with section 6.3: `B1: 22 matched, 0 unmatched, 30 app-only`,
   `B2: managed by Prisma Migrate; 0 problem(s)`, `B3: 0 blocking, 224 declared`,
   `B4: 0 problem(s)`, `B5: 0 to resolve, 0 to install only`, and
   `nothing to do: platform.lock maps every package migration and the database
   records them`. Exit code 0.

   The commands run in the built `api` image (`npm ci` installs the platform package
and its `platform` binary, and the image carries `apps/api/scripts` and
`apps/api/prisma`). That the binary resolves inside the image was **not** exercised
in the rehearsal (no Docker there); if `platform: not found` appears, run the same
commands from a checkout of the branch with the production `POSTGRES_*` values
instead.

**Stop, and post the output on the issue, if** it reports any `REFUSED` code,
   any blocking statement, any `to resolve` above 0, or a `B1` count other than
   22 matched. Do not continue and do not "fix" it with `--force-remap` or
   `--apply`.
5. `COMPOSE run --rm --no-deps api npm run db:check:database`. Expect
   `ok (22 installed platform migration(s))` and
   `1 migration(s) not applied yet (run prisma migrate deploy)` and
   `ok (51 ledger row(s) match the files)`.
6. **Deploy and migrate** with the normal path: `evopathcli deploy update`
   (add `--maintenance` for a planned window). Its `migrate` step runs
   `npm run prisma:migrate`, which applies exactly one migration:
   `20261007141520_add_retention_created_at_indexes`.
7. **Post-deploy checks** (all read-only):

   ```bash
   COMPOSE exec api npm run prisma -- migrate status   # Database schema is up to date! (52 migrations)
   COMPOSE exec api npm run db:sync                    # up to date; nothing to install
   COMPOSE exec api npm run db:check:database          # ok (22 ...), ok (52 ledger row(s) match the files)
   COMPOSE exec api npm run db:drift                   # ok ... 14 raw-SQL index(es) present
   COMPOSE exec api npm run db:baseline                # nothing to do
   ```

   Then the Doctor (`/admin/settings/doctor`): `db.migrations` passes.
8. **Post on the issue** (no row data): the commands and outputs of steps 4, 5 and
   7, and the backup run id from step 1. Comment `Approved: production baseline`
   before step 6 if that is the process you want recorded.

**Expected database writes in the whole procedure:** one migration, three
`CREATE INDEX` statements. The baseline commands write nothing. Zero
`migrate resolve` calls. If anything else writes, treat it as a failure and use
the rollback.

## 8. Rollback

- **Repository.** Revert this change's pull request. That removes the lock, the
  dependency, the new migration directory, the three `@@index` lines and the CI
  steps. Existing migration directories were never changed, so nothing else is
  needed. If `0022` was already applied, the three indexes stay in the database;
  they are harmless, and a later `db:sync` or re-adoption maps them. To drop them
  as well, write an ordinary forward migration.
- **Database.** The expected database writes are three indexes. If the procedure
  wrote anything else, restore the backup from step 1 by following
  [database-restore.md](database-restore.md), then run
  `COMPOSE exec api npm run prisma -- migrate status`.
- **Fallback.** Tag `MonoRepo` (see the adoption ledger, section 6).

After a restore from an older archive, run `npm run db:check:database`: it proves
the restored ledger still agrees with the files on disk
([database-restore.md](database-restore.md) section 4.6 links here).

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `DIFF_BLOCKING` listing the three `DROP INDEX` statements | A dry run **without `--through 21`** before `prisma:migrate` | Pass `--through 21` (section 6.3), or run `prisma:migrate` first |
| `DIFF_BLOCKING` listing anything else | The database differs from what the rehearsal saw: someone changed a platform table, or a domain migration was added after the lock's deviations were generated | Stop. Post the output on the issue. A new domain migration needs its statements added to the `app:domain-*` deviations (regenerate from a dry run on a copy), never a loosened check |
| `LEDGER_CHECKSUM_MISMATCH` / `LOCAL_MODIFIED` | A locked `migration.sql` was edited after it was applied | `git checkout` the file. Never edit an applied migration |
| `LOCAL_DIR_MISSING` | A locked directory was renamed or deleted | Restore it from Git |
| `LOCK_NOT_EMPTY` on `--apply` | The lock already has entries | Correct: there is nothing to apply. Do not use `--force-remap` in production |
| `permission denied to create database` | The role cannot create the shadow database | `--shadow-database-url <empty database>` |
| `Error: You must set datasource.shadowDatabaseUrl` | `prisma.config.ts` lost the `shadowDatabaseUrl` line | Restore `shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL` |
| `db:drift` prints `SCHEMA_DRIFT` | `schema.prisma` and the migrations disagree | Add the missing migration, or fix the schema. Never edit a locked migration |

## 10. Tool gaps found (for kvox and MemoriaHub)

Reported as follow-ups on the platform issues (#710, #711):

- **No app-object filter in the baseline diff.** An app with domain tables must
  list every domain statement as a deviation (223 here). A way to declare "objects
  owned by the app" (tables by name or prefix, or the app's own migrations) would
  remove the generated list and its upkeep.
- **A comment-only divergence is handled** (`localSha256` plus `note`), but the
  generated note is generic; the specific difference (an issue reference on line 1)
  is recorded here and pinned by `test/prisma/platform-lock.spec.ts`.
- **A platform migration the app lacks (here `0022`) makes the default dry run
  propose `resolve --applied` before `prisma:migrate`.** The diff check refuses it,
  but a warning when the proposed `resolve` targets a migration whose effect is
  absent from the database would be clearer.
- **The push-subscription platform column** belongs in the platform history (seam
  request); until then it is a declared deviation.
