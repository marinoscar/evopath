# Runbook: Factory reset the deployment

> **Audience:** operators · **Spec:** [factory-reset.md](../specs/factory-reset.md) · **Admin UI:** `/admin/settings/factory-reset` · **Permission:** `system:factory_reset`

Use this when you want a deployment back to a fresh install: a demo or staging environment to wipe, or a fork handed to a new owner. The reset deletes every other user and all application data, including your own, and keeps your account, the configuration, worker nodes and database backups. It cannot be undone. The only way back is a database backup you take first.

## 1. Before you start

- You need an Admin account. `system:factory_reset` is seeded to the Admin role only. If an existing deployment's Admin does not see the **Factory reset** card, run `npm run prisma:seed` once so the permission is granted.
- Take a database backup and confirm it finished (section 2). Backups are kept by the reset, so it is the way to recover.
- Tell other users. Their accounts are deleted and they cannot sign in again until you re-add them to the allowlist.
- Expect these side effects:
  - Personal access tokens of every user, yours included, are deleted. CLI and script clients using `pat_` tokens get `401`.
  - Device logins in flight are lost.
  - Worker nodes of other users are reassigned to you and stay registered.
- Running jobs are not cancelled. Let them finish first if their rows matter, because a running job finds its rows gone and fails on its own.

## 2. Take a backup first

1. Open `/admin/settings/db-backup` (the page also links from the reset page's warning).
2. Start a backup and wait until its status is `succeeded`.
3. Confirm the archive is listed. You should see a new run with a size and a storage key.

## 3. Run the reset

1. Open `/admin/settings`, then the **Factory reset** card in the **Danger Zone** group, or go to `/admin/settings/factory-reset`.
2. Read the warning and the live counts of what will be deleted. You should see your own deployment's numbers.
3. Choose the destructive button. In the dialog, tick the acknowledgement checkbox and type `FACTORY RESET` exactly. Confirm stays disabled until both are done.
4. Confirm. The dialog shows progress and cannot be closed while the job runs. Only one factory reset can be queued or running at a time; a second request returns the one in flight.

You can also call the API, which re-checks the phrase:

```bash
curl -sS -X POST "https://<your-deployment>/api/admin/factory-reset" \
  -H "Authorization: Bearer <admin access token>" \
  -H "Content-Type: application/json" \
  -d '{"confirmation":"FACTORY RESET"}'
curl -sS "https://<your-deployment>/api/admin/factory-reset/<jobId>" \
  -H "Authorization: Bearer <admin access token>"
```

You should see `202` with a `jobId`, then `status` move from `pending` to `running` to `succeeded`.

## 4. What to expect

- The job runs seven steps (jobs, every user's data, custom catalog rows, nodes, other users, deployment-wide rows, storage). A large deployment can take many minutes; the job has a 30-minute profile and three attempts.
- On success the dialog lists the non-zero counts. You stay signed in with your role.
- Other users, their data, custom exercises and equipment, job history, broadcasts, allowlist entries (except yours) and every stored file except backup archives are gone.
- Your account, settings, integrations, AI models, the built-in catalog, worker nodes and backups remain.

## 5. Verify the result

1. `GET /api/admin/factory-reset/summary` returns zeros for everything it counts.
2. `/admin/settings/users` lists only your account.
3. `/admin/settings/db-backup` still lists your backups.
4. The audit log holds `admin.factory_reset.requested` and `admin.factory_reset.completed`.
5. `/admin/settings/doctor` shows the configuration checks as before.

## 6. Recover from a mistake

1. Restore the backup from section 2 with the [database restore runbook](database-restore.md).
2. Sign in again. A restore returns the database to the state of the backup, including users and data.
3. Files in storage were deleted by the reset and are not part of a database backup. Rows that pointed at them stay without their bytes.

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No **Factory reset** card | Not an Admin, or the permission was never seeded | Sign in as an Admin; run `npm run prisma:seed` |
| `403` on the routes | Caller lacks `system:factory_reset` | Use an Admin account |
| `400` on start | The phrase is not exactly `FACTORY RESET` | Type it in capitals, no extra spaces |
| Result shows `storageObjectsFailed` above zero | The storage provider refused some deletes; their rows were kept | Check storage settings (`/admin/settings/storage`), then run the reset again. A rerun retries only what is left |
| Job `failed` | A database step threw (lock timeout, restart, connection loss) | Read `error` on the job, fix the cause, then start the reset again. A retry is safe: every step is idempotent and counts carry over |
| A second request returned an old job id | A reset is already pending or running | Poll that job instead |
| A job of another type failed during the reset | It was running and its rows were deleted | Expected; no action needed |
| Other users cannot sign in | Their accounts and allowlist entries were deleted | Add them to the allowlist and have them sign in again |

## 8. Summary checklist

- [ ] I am an Admin with `system:factory_reset`.
- [ ] A database backup finished and is listed.
- [ ] Other users know their accounts will be deleted.
- [ ] I ran the reset with the exact phrase `FACTORY RESET`.
- [ ] The job `succeeded` and `storageObjectsFailed` is zero (or I re-ran it).
- [ ] The summary shows zeros, only my account remains and backups are listed.

## See also

- [Spec: admin factory reset](../specs/factory-reset.md)
- [Runbook: restore the database](database-restore.md)
- [Spec: database backup](../specs/database-backup.md)
