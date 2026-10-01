# Admin Factory Reset (Danger Zone)

> **Status:** shipped · **Code:** `apps/api/src/admin-factory-reset/`, `apps/api/src/user-data/user-data-purge.ts` (shared deletion), `apps/web/src/pages/Admin/FactoryResetPage.tsx`, `apps/web/src/services/factoryReset.ts`, `apps/web/src/hooks/useFactoryReset.ts` · **API:** `/api/admin/factory-reset/*` (see `/api/docs`) · **Admin UI:** `/admin/settings/factory-reset` · **Runbook:** [factory-reset.md](../runbooks/factory-reset.md)

An administrator can return the whole deployment to a fresh install. Every other user and all application data are deleted. The administrator who asked stays signed in, and configuration, infrastructure and backups stay. The work is one queue job, `admin.factory_reset`, requested through `POST /api/admin/factory-reset` behind a typed confirmation and the `system:factory_reset` permission.

## 1. Purpose

- **Is:** a deployment-wide "start again" for the person who runs the deployment. It deletes every user's data (the actor's included), every other account, custom catalog rows, job history, broadcasts, the allowlist and every stored file except database backup archives.
- **Is not:** a restore, an uninstall or a reset of configuration. System settings, deployment credentials (storage, AI, SMTP), AI models, roles, permissions and the seeded catalogs survive, so the app is usable straight away. It has no undo; the way back is a database backup taken first ([runbook](../runbooks/factory-reset.md)).
- **Why:** an app built from this template accumulates data in many models across many users. Without one decision per model, a forker's "reset" either leaves rows behind or fails on a foreign key halfway. The sibling [user data reset](user-data-reset.md) decides this per user; the factory reset runs that same deletion for every user and adds the deployment-level rows.

## 2. How it works

### 2.1 Request flow

1. The page loads `GET /api/admin/factory-reset/summary` to show live deployment-wide counts.
2. The administrator confirms in a dialog. The page calls `POST /api/admin/factory-reset` with `{ "confirmation": "FACTORY RESET" }`.
3. The API enqueues `admin.factory_reset` (payload `{ actorUserId }`, no subject), records the audit event `admin.factory_reset.requested` and answers `202 { jobId, status }`.
4. The page polls `GET /api/admin/factory-reset/:jobId` until `succeeded` or `failed`.
5. On `succeeded`, `result` carries the per-category counts. On `failed`, `error` carries `lastError`.

The job has no subject, so the queue's active dedup (`jobs_active_dedup_uniq_idx`) allows one pending or running factory reset for the whole deployment. A second request returns the job already in flight. The API never pre-checks with a `findFirst`.

### 2.2 The job

`AdminFactoryResetHandler` (`apps/api/src/admin-factory-reset/handlers/admin-factory-reset.handler.ts`) runs seven steps in this order. Each is idempotent and commits in its own transaction (storage is its own provider calls). The profile is `{ maxRuntimeMs: 30 minutes, maxAttempts: 3 }`.

| # | Step | What it does |
|---|---|---|
| 1 | Jobs | Deletes every pending, succeeded and failed job row in chunks, except this job and any job a `database_backup_runs` row links to. It runs first so queued work about rows that are about to go does not start mid-reset. Running jobs of other types are left alone. |
| 2 | Every user's data | For each user, the actor included, runs `deleteUserOwnedRows` from `user-data/user-data-purge.ts`, the same deletion the user's own reset runs, one transaction per user. |
| 3 | Custom catalog rows | Deletes custom exercises, then custom equipment types (`ownerUserId` not null) that step 2 kept because another user's row still used them. It precedes step 5 because `Exercise.owner` cascades. |
| 4 | Nodes | Reassigns other users' worker nodes and node credentials to the actor. A node whose name the actor already uses cannot move (`@@unique([createdById, name])`); it cascades with its owner and is counted as `workerNodesRemoved`. |
| 5 | Other users | Deletes every user except the actor, in chunks. Identities, roles and refresh tokens cascade. Audit, settings, credential, AI model and backup-run provenance columns are `SET NULL` on tables that are kept. |
| 6 | Deployment-wide leftovers | One transaction: allowlist entries (except the actor's own), broadcasts, a final sweep of notifications, notification deliveries, push subscriptions, AI runs and usage events (including any with no user), every remaining device code, training checkpoints whose run no longer exists, and `job_stats_rollup` rows. |
| 7 | Storage | Deletes every `StorageObject` whose `storageKey` is not a backup archive's, in id order: bytes from the active provider, then the row. A provider failure is counted in `storageObjectsFailed`, logged and keeps the row. It never fails the job. |

The result goes to `payload.result` (the queue has no result column) and the audit event `admin.factory_reset.completed` closes the run. A missing or deleted actor fails the job before anything is deleted.

### 2.3 Keep and delete

The handler header comment holds the authoritative per-model list for every model in `schema.prisma`. The summary:

| Decision | What |
|---|---|
| Kept (the actor) | The `User` row, `UserIdentity`, `UserRole`, `RefreshToken` (the browser session survives), the actor's `AllowedEmail` entry |
| Kept (access model) | Roles, permissions, role-permission links |
| Kept (deployment) | System settings, deployment credentials (storage, AI, SMTP), AI models, worker nodes and node credentials (reassigned to the actor), `JobNodeSecret` handles |
| Kept (shared) | The seeded exercise and equipment catalog and capabilities |
| Kept (backups) | Database backup runs, their archives in storage and the jobs they link to |
| Kept (audit) | `AuditEvent`. Deleted users' `actorUserId` becomes null. |
| Kept (jobs) | Running jobs and this job. A running job of another type finds its rows gone and fails on its own, as handlers already must tolerate. |
| Deleted (users) | Every other user and their sessions, identities, roles, access tokens and AI keys |
| Deleted (data) | Everything the user reset deletes, for every user including the actor: workouts, programs, gyms, health data, photo intakes, training runs, AI runs and usage, stored credentials, notifications, user settings |
| Deleted (catalog) | Custom exercises and custom equipment types |
| Deleted (deployment) | Pending and finished job history, job statistics rollups, broadcasts, allowlist entries except the actor's, device codes |
| Deleted (storage) | Every stored object except backup archives |

Consequences to state to the operator:

- Personal access tokens of every user, the actor included, are deleted. A CLI or script using a `pat_` token gets `401` afterwards.
- Device logins in flight are lost, because every device code is deleted.
- Other users cannot sign in again unless they are re-added to the allowlist.

### 2.4 Retry safety

- Every step is a `deleteMany` (or a reassignment) by a condition a rerun re-evaluates, so a retry after any committed step deletes what is left and nothing else.
- Counts commit onto `payload.deleted` in the same transaction as the rows they count. A retry adds to them and never loses them.
- Storage object ids are not written to the payload. The set "every object that is not a backup archive" is recomputed exactly on each attempt, and row deletion never removes a `StorageObject` (`uploadedById` is `SET NULL`). The user reset must persist ids first because the link rows that name its objects cascade away; here nothing is lost, and no deployment-sized id list sits in a JSON payload.
- Storage paging moves forward by id, so a kept (failed) object is not retried forever within one run. A later reset retries it.
- A database error in any step throws and the queue retries. Storage is the only step that tolerates failure.
- The raw-SQL partial unique indexes are relieved by these deletes and never touched.

### 2.5 Confirmation UX

- The page is the one card, **Factory reset**, in a new admin settings group, **Danger Zone**, appended last. The group sits alone and is never folded into Operations.
- The page opens with an error-bordered panel stating that the action erases the whole application for everyone and cannot be undone. A backup-first warning links to `/admin/settings/db-backup`.
- It lists what is deleted with live counts from the summary, and what stays. The static lists render even if the summary request fails.
- The destructive button opens a dialog (never inline). Confirming needs both an acknowledgement checkbox and the exact phrase `FACTORY RESET`.
- While the job runs, the dialog cannot be closed and shows progress. On success it lists the non-zero counts, warns when `storageObjectsFailed` is above zero, and clears client-side caches and the shell's profile and notification state. On failure it shows the error and allows a retry.
- The API re-checks the phrase (Zod literal; anything else is a `400`). The page only collects it.

## 3. Configuration and permissions

There are no settings keys and no environment variables.

| Item | Value |
|---|---|
| Permission | `system:factory_reset` on all three routes; seeded to the Admin role only. An existing deployment gets it on the next `npm run prisma:seed`. |
| Card | `permission: 'system:factory_reset'`, no `feature`, no `alwaysShow`. Not reachable for a `system_settings:write` holder who is not an Admin. |
| Job type | `admin.factory_reset` (permanent string), server-only |
| Audit actions | `admin.factory_reset.requested` (API), `admin.factory_reset.completed` (job) |

| Route | Purpose |
|---|---|
| `GET /api/admin/factory-reset/summary` | Deployment-wide counts of what a reset would delete |
| `POST /api/admin/factory-reset` | Validate the phrase, enqueue the job, `202 { jobId, status }` |
| `GET /api/admin/factory-reset/:jobId` | Status, `result` when succeeded, `error` when failed; `404` unless the job is a factory reset |

Details: `/api/docs`.

## 4. Extending it in a fork

**When you add a model with a relation to a user, the keep/delete decision belongs in `apps/api/src/user-data/user-data-purge.ts`.** That one file serves both the per-user reset and the factory reset. Follow [user-data-reset.md §4](user-data-reset.md#4-extending-it-in-a-fork); step 2 of the factory reset then covers the new model for every user with no further change.

Then check the factory reset's own decisions:

1. If the model has **no user relation** (deployment-level data, like broadcasts), add a delete to the deployment-wide step in `admin-factory-reset.handler.ts`, add its count to `FactoryResetRowCounts` and to `adminFactoryResetResultSchema` in `dto/admin-factory-reset.dto.ts`, and to `getSummary` plus `DELETED_CATEGORIES` in `FactoryResetPage.tsx` when the operator should see it.
2. If it holds a nullable user reference (`SET NULL`) on a table that step 2 cannot reach, sweep the user-less rows in the deployment-wide step so none are left as orphans.
3. If another user can own a row that references custom catalog rows, check step 3's order against the new `Restrict` edges.
4. If a table must survive (configuration, infrastructure, audit), record it as kept in the handler's header comment.
5. Extend `apps/api/test/admin-factory-reset/admin-factory-reset.db.spec.ts` with a row of the new model and assert it is gone (or kept).

The job stays server-only: never add `nodeResultSchema` or `persistNodeResult`.

## 5. Guardrails

- `apps/api/src/admin-factory-reset/handlers/admin-factory-reset.handler.spec.ts`: contract (type, profile, server-only), input refusal, each of the seven steps and their order, the kept tables are never touched, nodes reassigned before users are deleted, storage failure tolerance and forward paging, count accumulation across attempts, the completion audit event.
- `apps/api/test/admin-factory-reset/admin-factory-reset.db.spec.ts`: on real Postgres, the whole reset satisfies every foreign key, keeps the actor, configuration, catalogs and backups, re-runs cleanly and resumes after a partial run.
- `apps/api/test/admin-factory-reset/admin-factory-reset.integration.spec.ts`: permission metadata, `401` without auth, summary shape, `202` and deployment-wide dedup, status and error mapping, `404` for another job type, `400` for a non-UUID id, the job type is server-only.
- `apps/api/src/admin-factory-reset/admin-factory-reset.service.spec.ts`: summary scope (excludes the caller, backup archives, running jobs, the caller's allowlist entry), enqueue and audit, status mapping.
- `apps/api/test/prisma/seed-data.spec.ts`: `system:factory_reset` is granted to Admin only.
- `apps/web/src/__tests__/pages/Admin/FactoryResetPage.test.tsx`: warning, backup link, counts and skeletons, the checkbox and exact-phrase gate, non-dismissable progress, storage-failure warning, failure and retry.
- `apps/web/src/__tests__/config/settingsRegistry.test.ts`: the Danger Zone group and its card are last and carry the permission.
- `apps/api/test/jobs/cron-enqueue-only.spec.ts` and the AI and queue guardrail suites cover the handler under the shared queue rules.

## 6. Design decisions

- **A queue job, not an inline request.** A deployment's worth of deletes and storage calls outlives a request. Every long-running activity is a queue job with a retry profile and visible history.
- **Seven transactions, not one giant one.** One transaction over a deployment's rows would hold locks on every user table for minutes and exceed any sane timeout. Each step is an idempotent `deleteMany` that a retry re-evaluates, with its counts committed in the same transaction.
- **Share the per-user deletion.** A second copy of the per-user delete would drift from the first. One file means a new model is decided once and both resets cover it. Rejected: deleting users and relying on cascades, which misses `Restrict` edges and `SET NULL` rows that are user data.
- **No storage ids in the payload.** The object set is recomputable from the database on every attempt. Persisting it would put a deployment-sized list in a JSON column for no benefit.
- **Reassign nodes instead of deleting them.** Worker nodes are infrastructure. Handing them to the actor keeps them registered and lets the actor revoke their credentials. The name-clash exception is counted rather than hidden.
- **Keep backups, their archives and their jobs.** The backup is the undo. The reset must never remove the thing that lets an operator recover from it.
- **Keep the actor's session.** Revoking it would sign the administrator out mid-reset with no way to read the result.
- **Keep the audit log.** The trail records who ran the reset and outlives the data it describes.
- **Do not cancel running jobs.** Cancelling needs a cooperative stop in every handler. Handlers already tolerate vanished rows, so a running job fails on its own.
- **Dedicated permission, Admin only.** `system_settings:write` is held by roles that must not be able to erase the deployment. Rejected: a confirmation-token round trip, which adds state for no gain over an exact phrase plus a dedicated permission.

## 7. Verification

```bash
npx jest --config apps/api/test/jest.config.js --rootDir apps/api src/admin-factory-reset test/admin-factory-reset
npm run test:db --workspace=api
npm run test:run --workspace=web -- FactoryResetPage settingsRegistry
```

Then run the app on a throwaway deployment as an Admin, create a second user with some data, and check:

- The Danger Zone card appears last in `/admin/settings` for an Admin and not for another role.
- Confirm stays disabled until the checkbox is ticked and the phrase is typed exactly.
- `POST /api/admin/factory-reset` with any other phrase returns `400`; a non-Admin gets `403`.
- After the job succeeds, `/api/admin/factory-reset/summary` returns zeros, the Admin's session is still valid, backup runs and archives remain, and the audit log holds both `admin.factory_reset.*` events.

## History

- #202 added the per-user data reset whose deletion this feature shares.
- #211 added the admin factory reset, `system:factory_reset`, the `/api/admin/factory-reset` routes, the admin Danger Zone group, the extraction of the per-user deletion into `user-data/user-data-purge.ts` and this spec.
