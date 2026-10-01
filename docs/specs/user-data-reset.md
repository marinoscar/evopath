# User Data Reset (Danger Zone)

> **Status:** shipped · **Code:** `apps/api/src/user-data/`, `apps/web/src/pages/UserDangerZonePage.tsx`, `apps/web/src/services/userData.ts`, `apps/web/src/hooks/useUserDataReset.ts` · **API:** `/api/user-data/*` (see `/api/docs`) · **User UI:** `/settings/danger-zone`

A user can delete everything they own and keep their account. The reset is a factory reset: the user stays signed in, keeps their role, and starts again from an empty app. The work is one queue job, `user.data_reset`, requested through `POST /api/user-data/reset` behind a typed confirmation.

## 1. Purpose

- **Is:** a self-service "delete all my data" for one user, acting on the caller alone. It removes workouts, programs, gyms, health data, photos, AI keys and history, stored credentials, access tokens and notifications.
- **Is not:** account deletion. The `User` row, identities, roles and the browser session survive. It is not an admin action on another user and has no undo or backup.
- **Why:** an app built from this template accumulates personal data across many models. Without one place that decides what a user owns, a forker either leaves data behind or fails on a foreign key. `user-data/user-data-purge.ts` holds that decision for every model with a path to a user, and the admin [factory reset](factory-reset.md) runs the same code for every user.

## 2. How it works

### 2.1 Request flow

1. The page loads `GET /api/user-data/summary` to show live counts.
2. The user confirms in a dialog. The page calls `POST /api/user-data/reset` with `{ "confirmation": "DELETE MY DATA" }`.
3. The API enqueues `user.data_reset` (subject `user:<userId>`, payload `{ userId }`), records the audit event `user.data_reset.requested` and answers `202 { jobId, status }`.
4. The page polls `GET /api/user-data/reset/:jobId` until `succeeded` or `failed`.
5. On `succeeded`, `result` carries the per-category counts. On `failed`, `error` carries `lastError`.

The queue's active dedup (`jobs_active_dedup_uniq_idx` over `user.data_reset:user:<userId>`) allows one pending or running reset per user. A second request returns the job already in flight instead of queueing another. The API never pre-checks with a `findFirst`.

### 2.2 The job

`UserDataResetHandler` (`apps/api/src/user-data/handlers/user-data-reset.handler.ts`) runs three steps. The deletion itself (`collectUserObjectIds`, `deleteUserOwnedRows`, `deleteStorageObjects`) lives in `apps/api/src/user-data/user-data-purge.ts`, shared with the admin [factory reset](factory-reset.md); the handler owns the payload, the audit event and the step order.

| Step | What it does |
|---|---|
| 1. Collect | Gathers every storage object id the user owns (uploads, intake, gym and workout photo links, health document files, the avatar named by the settings) into `payload.objectIds`. It writes them **before** step 2, because step 2 cascades away the link rows that name them. |
| 2. Delete rows | Deletes the user's rows in **one** `$transaction` (timeout 5 minutes), children before the parents they `Restrict`. The counts go on `payload.deleted` in the same commit. |
| 3. Delete media | Deletes each collected object from the active storage provider, then its row. An unfinished multipart upload is aborted first. A provider failure is counted in `storageObjectsFailed`, logged, and **keeps the row**. It never fails the job. |

The result is written to `payload.result` (the queue has no result column) and the audit event `user.data_reset.completed` closes the run. The profile is `{ maxRuntimeMs: 15 minutes, maxAttempts: 3 }`.

### 2.3 Keep and delete

The table below summarises the decisions. The header comment of the handler is the authoritative per-model list; `user-data-purge.ts` executes it.

| Decision | What |
|---|---|
| Deleted | Health profile, measurements (every revision, check-ins included), health documents and their files (kept or not; the `health_documents` reference checker only guards the intake's own cleanup), photo intakes, gyms and their equipment and photos, workouts and sets, programs and their sessions and change log, training runs, events and checkpoints, quick adaptations, AI runs and usage events, AI keys, stored credentials, personal access tokens, device codes, push subscriptions, notifications and deliveries, user settings, every uploaded storage object |
| Cleared | `User.profileImageUrl` and `User.displayName` |
| Deleted unless in use | Custom exercises and custom equipment. One still referenced by another user's row is kept, rather than failing the reset on its `Restrict`. |
| Deleted (pending jobs) | A pending job whose subject is a deleted row, including a `health.document.purge` for a deleted document (step 3 deletes its file) |
| Kept | `User`, `UserIdentity`, `UserRole`, `RefreshToken` (the browser session survives), `AllowedEmail`, `AuditEvent` |
| Kept (deployment) | Worker nodes and their credentials, system settings, deployment credentials, AI models, broadcasts, backup runs |
| Kept (shared) | The seeded exercise and equipment catalog, roles, permissions and capabilities |
| Kept (jobs) | Running and settled jobs. A running job of the user's (a training run, a scan) finds its rows gone and fails on its own, as handlers already must tolerate. A reset never cancels running work. |

Personal access tokens are deleted, so a CLI or script authenticated with a `pat_` token gets `401` after the reset. The browser session is unaffected.

### 2.4 Retry safety

- Every delete is a `deleteMany` by owner, so a rerun deletes what is left and nothing else.
- Counts from an attempt that committed are read back from the payload and added to, never lost.
- Object ids recorded by an earlier attempt are unioned with freshly collected ones, so a retry after step 2 still knows which files to delete.
- A database error throws and the queue retries. A storage failure does not throw; the kept row lets a later reset retry that object.
- The raw-SQL partial unique indexes (one default gym, one in-progress workout, one active run, program and adaptation per user) are relieved by these deletes and never touched.

### 2.5 Confirmation UX

- The page sits in a new user settings group, **Danger Zone**, appended last. Its one card is **Delete all my data** at `/settings/danger-zone`.
- The page states the action is irreversible with no backup, lists what is deleted with live counts, and lists what stays. The static list renders even if the summary request fails.
- The destructive button opens a dialog (never inline). Confirming needs both an acknowledgement checkbox and the exact phrase `DELETE MY DATA`.
- While the job runs, the dialog cannot be closed and shows progress. On success it lists the non-zero counts, warns when `storageObjectsFailed` is above zero, and clears client-side caches and the shell's profile and notification state.
- The API re-checks the phrase (Zod literal; anything else is a `400`). The page only collects it.

## 3. Configuration and permissions

There are no settings keys and no environment variables. The feature is always available.

| Item | Value |
|---|---|
| Permission | `user_settings:write` on all three routes; held by every role |
| Card | No `permission` and no `feature`. It stays reachable while AI is switched off, because the reset also deletes AI keys and runs. |
| Job type | `user.data_reset` (permanent string), server-only |
| Audit actions | `user.data_reset.requested` (API), `user.data_reset.completed` (job) |

| Route | Purpose |
|---|---|
| `GET /api/user-data/summary` | Counts of what a reset would delete |
| `POST /api/user-data/reset` | Validate the phrase, enqueue the job, `202 { jobId, status }` |
| `GET /api/user-data/reset/:jobId` | Status, `result` when succeeded, `error` when failed; `404` unless the caller's own reset job |

Details: `/api/docs`.

## 4. Extending it in a fork

**When you add a model with a relation to a user, add a keep/delete decision in `apps/api/src/user-data/user-data-purge.ts`.** The file is shared: the admin [factory reset](factory-reset.md) runs the same per-user deletion for every user, so one decision covers both. No test discovers a new model, so the decision is manual.

1. Decide: is it the user's own data (delete), or account, access, audit or deployment state (keep)?
2. If it is deleted, add a `deleteMany` by owner to `deleteUserOwnedRows` in `user-data-purge.ts`. Place it after anything that `Restrict`s it and before the parents it `Restrict`s. Add its count to `ZERO_ROW_COUNTS` (which `DeletedRowCounts` follows), and to the result schema in `dto/user-data.dto.ts`.
3. If the model holds a storage object link with no cascade, add its ids to `collectUserObjectIds` in `user-data-purge.ts` so the bytes are deleted.
4. If rows exist without a foreign key to the user (like training checkpoints), delete them explicitly.
5. If it is kept, say so in the keep list in the handler's header comment.
6. Add the model to the keep/delete survey in the handler's header, to `getSummary` when the user should see its count, and to `DELETED_CATEGORIES` in `UserDangerZonePage.tsx` when it needs its own line.
7. Extend `apps/api/test/user-data/user-data-reset.db.spec.ts` with a row of the new model and assert it is gone (or kept).
8. Check [factory-reset.md §4](factory-reset.md#4-extending-it-in-a-fork) when the model also holds deployment-level or user-less rows.

The job stays server-only: never add `nodeResultSchema` or `persistNodeResult`.

## 5. Guardrails

- `apps/api/src/user-data/handlers/user-data-reset.handler.spec.ts`: contract (type, profile, server-only), subject and payload validation, object collection before deletion, one transaction, FK order, explicit checkpoint deletion, pending-job cleanup, the kept list, retry accumulation, storage failure tolerance, audit event.
- `apps/api/test/user-data/user-data-reset.db.spec.ts`: on real Postgres, the deletion satisfies every foreign key, cascades remove what the handler relies on, and the account, session and other users' data survive.
- `apps/api/test/user-data/user-data.integration.spec.ts`: permission metadata, `401` without auth, `400` on a wrong phrase, `202` and dedup, `404` for another user's job, the job type is server-only.
- `apps/api/src/user-data/user-data.service.spec.ts`: the phrase schema, caller-scoped counts, status mapping.
- `apps/web/src/__tests__/pages/UserDangerZonePage.test.tsx` and `apps/web/src/__tests__/config/userSettingsSections.test.ts`: the dialog gates, result display, and the last-group card.
- `apps/api/test/jobs/cron-enqueue-only.spec.ts` and the AI and queue guardrail suites cover the handler under the shared queue rules.

## 6. Design decisions

- **A queue job, not an inline request.** A heavy user's delete plus storage deletes outlives a request. Every long-running activity is a queue job, with a retry profile and visible history.
- **Collect object ids first, into the payload.** Step 2 cascades away the rows that say which files belong to the user. Recording the ids first lets a retry finish the media.
- **One transaction for rows, none for media.** Rows are all-or-nothing. Storage is not transactional, so a failed delete keeps its row and stays visible instead of becoming an orphaned file.
- **Keep the refresh token.** Revoking the session would sign the user out mid-reset with no way to read the result. The user stays signed in and sees it.
- **Delete personal access tokens.** They are credentials the user created; leaving them would keep scripted access to an emptied account. The cost is a `401` for CLI clients, stated in the API description.
- **Keep the audit log.** The audit trail outlives the data it describes.
- **Do not cancel running jobs.** Cancelling needs a cooperative stop in every handler. Handlers already tolerate vanished rows, so a running job fails on its own. Pending jobs about deleted rows are removed.
- **Phrase in the API, not only the UI.** A `curl` caller and a browser give the same guarantee. Rejected: a confirmation token round trip, which adds state for no gain over an exact phrase.

## 7. Verification

```bash
npx jest --config apps/api/test/jest.config.js --rootDir apps/api src/user-data test/user-data
npm run test:db --workspace=api
npm run test:run --workspace=web -- UserDangerZonePage userSettingsSections
```

Then run the app, open `/settings/danger-zone` and check:

- Confirm stays disabled until the checkbox is ticked and the phrase is typed exactly.
- `POST /api/user-data/reset` with any other phrase returns `400`.
- After the job succeeds, `/api/user-data/summary` returns zeros, the session is still valid, and the audit log holds both `user.data_reset.*` events.

## History

- #202 added the per-user data reset, the `/api/user-data` routes, the Danger Zone settings group and this spec.
