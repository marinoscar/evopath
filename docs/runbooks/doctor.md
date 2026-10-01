# Runbook: Triage with the Doctor

> **Audience:** operators · **Spec:** [doctor.md](../specs/doctor.md) · **Admin UI:** `/admin/settings/doctor` · **Permission:** `system_settings:read`

Use this when something about a deployment is wrong or unverified (sign-in fails, uploads fail, email does not arrive, jobs do not run, telemetry is empty) and you want one list of what is misconfigured or down. The Doctor runs read-only checks across the database, authentication, maintenance, storage, email, Web Push, AI (providers, model assignments, web search), the job queue, worker nodes, backups and telemetry, and tells you which settings page or command fixes each problem. It changes nothing. For the design, the full check list and the exact pass, warn, fail and skip rules, see the [spec](../specs/doctor.md#27-check-inventory).

## 1. Before you start

- You need an Admin account: the report requires `system_settings:read`, which only the Admin role holds.
- During a maintenance window the Doctor answers only when the window allows admins. With `allowAdmins: false` it returns the maintenance `503`; close the window first ([maintenance runbook](maintenance-mode.md)).
- Running it is safe at any time and as often as you like. It sends no email or push, writes no object, calls no model and enqueues nothing.
- A report is cached for 15 seconds. After you fix something, use **Run again** (or `refresh=true`) so you see the new state rather than the cached one.

## 2. Run the Doctor

### 2.1 In the web app

1. Sign in as an Admin and open `/admin/settings`, then the **Doctor** card (Observability group), or go straight to `/admin/settings/doctor`.
2. Read the verdict at the top, then the status counts.
3. Expand any category with a warning or failure (those open by default). Turn on **Problems only** to hide everything else.
4. On each problem row, read the **detail** (what was found) and the **remedy** (what to do), then use **Open settings** to reach the page that fixes it.
5. Choose **Run again** after each fix. It bypasses the cache and runs every probe again.

### 2.2 Over HTTP

```bash
curl -sS "https://<your-deployment>/api/admin/doctor?refresh=true" \
  -H "Authorization: Bearer <admin access token or pat_ token>"
```

Add `&category=storage` to run one category. To list only the problems:

```bash
curl -sS "https://<your-deployment>/api/admin/doctor?refresh=true" \
  -H "Authorization: Bearer $TOKEN" \
  | jq '.data.checks[] | select(.status=="warn" or .status=="fail") | {id, status, detail, remedy}'
```

With the CLI, if you are already logged in:

```bash
evopathcli api GET /api/admin/doctor --raw | jq '.data.verdict'
```

The call always answers `200` when you are authorized; a failing check is a row in `data.checks`, not an error status. `401` means no valid token, `403` means the account lacks `system_settings:read`.

## 3. Read the report

| Status | Meaning | What to do |
|---|---|---|
| `pass` | Verified healthy. | Nothing. |
| `skip` | Not evaluated, for one of two reasons (below). | Usually nothing. |
| `warn` (amber) | It works, but something needs attention. | Read the remedy; plan the fix. |
| `fail` (red) | Broken. | Fix now, starting with the topmost failure. |

The **verdict** is the worst status present, ordered `pass`, `skip`, `warn`, `fail`.

A `skip` means one of:

- **A check it depends on did not pass.** The detail reads `Skipped: <check> did not pass`. Fix that one first; the skipped check runs again on the next report. Example: `storage.bucket` is skipped while `storage.config` fails.
- **The capability is off on purpose.** AI switched off, web search off, or telemetry collection off. Nothing needs fixing unless you meant it to be on.

Fix problems top to bottom within a category, and start with `core`: a failing `db.connection` makes most other checks skip or fail.

## 4. Triage by check

Each entry is the meaning of a `warn` or `fail` and where to go. The remedy in the report is authoritative for your deployment; this table is the map.

### Core, authentication and maintenance

| Check | Red or amber means | Go to |
|---|---|---|
| `db.connection` | The database did not answer, or `SELECT 1` took over 500 ms. | Check PostgreSQL is running and reachable, and `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` in `infra/compose/.env`. |
| `db.migrations` | A migration is unfinished or rolled back, or none was ever applied. | Run `npm run prisma:migrate` in the `api` container. For an unfinished one, resolve it first as the remedy describes. |
| `secrets.encryption-key` | `SECRETS_ENCRYPTION_KEY` is missing or malformed. | [Rotate or recover the key](rotate-secrets-encryption-key.md). If credentials were saved, restore the original key; a new one cannot decrypt them. |
| `auth.jwt-secret` | `JWT_SECRET` is unset (fail) or under 32 characters (warn). | Set a random value of 32 or more characters and restart the API. Everyone signs in again. |
| `auth.providers` | No sign-in provider is configured. | Set the `GOOGLE_*` variables in `.env` and restart the API. |
| `auth.initial-admin` | No active Admin (fail), or `INITIAL_ADMIN_EMAIL` unset (warn). | Set `INITIAL_ADMIN_EMAIL` and sign in with that account; or `/admin/settings/users`. |
| `maintenance.mode` | A window is open (warn), or the saved setting could not be read. | `/admin/settings/maintenance`. If `MAINTENANCE_MODE` holds it open, unset it and restart; see [maintenance runbook](maintenance-mode.md). |

### Storage, email and Web Push

| Check | Red or amber means | Go to |
|---|---|---|
| `storage.config` | Object storage is not configured, or its settings cannot be read. | `/admin/settings/storage`; see [storage configuration](storage-configuration.md). A read failure usually means the wrong `SECRETS_ENCRYPTION_KEY`. |
| `storage.bucket` | The store did not answer, rejected the credential, reports a missing bucket or region mismatch, or the key may not read the bucket. | `/admin/settings/storage`, then **Test connection** there. A pass is weaker than that test: a missing bucket can still pass here (see the [spec](../specs/doctor.md#27-check-inventory)). |
| `email.config` | Email is not configured or switched off (warn), or incomplete (fail). | `/admin/settings/email`, then **Send test email** there. |
| `push.vapid` | Web Push is off or unconfigured (warn), or the key pair or subject is invalid (fail). | `/admin/settings/push`; see [VAPID keys](vapid-keys.md). Regenerating keys forces browsers to re-subscribe. |

### AI, jobs, nodes and backup

| Check | Red or amber means | Go to |
|---|---|---|
| `ai.enabled` | Always `pass` or `skip`; `skip` means AI is off, and the three other AI checks skip with it. | `/admin/settings/ai` if you want it on. |
| `ai.providers` | AI is on but no provider is enabled, an enabled provider has no adapter, or it has no org key while the key policy promises a fallback. | `/admin/settings/ai`; see [AI configuration](ai-configuration.md). Use the **Test** button there to prove a provider. |
| `ai.feature-assignments` | Fail: a feature (a photo feature or a training role) has no enabled, capable model, or under `byok_with_org_fallback` none on a provider that serves users without their own key. Warn: a stored assignment or default is no longer enabled or capable, so calls fall through to another model. | Enable a capable model at `/admin/settings/ai/models`, then assign it at `/admin/settings/ai/assignments` ([AI configuration](ai-configuration.md#61-assign-models-to-features)). For the org-key case, save an organization key at `/admin/settings/ai` or switch the key policy to `byok`. Training-agent models are covered here: see [AI training plans](ai-training-plans.md#4-enable-and-assign-models-for-the-four-roles). |
| `ai.web-search` | `skip`: web search is off. Warn: it is on but no enabled provider supports hosted web search (OpenAI does), the researcher has no eligible model, or its assigned model cannot search. | Enable OpenAI and a model with hosted tools at `/admin/settings/ai` and assign it to the researcher at `/admin/settings/ai/assignments`, or switch **Web search** off. See [enable web search](ai-training-plans.md#2-enable-web-search). |
| `jobs.worker` | `JOBS_WORKER_MODE` is unrecognised or `off`, or `JOBS_WORKER_CONCURRENCY` is zero. | Set the variable and restart the API, or make sure another instance or worker nodes run jobs. |
| `jobs.backlog` | A job is stuck running with no live lease, or the oldest due job has waited over 15 minutes. | Confirm a worker runs (`jobs.worker`), then review or reset jobs at `/admin/settings/jobs`. |
| `nodes.fleet` | An enrolled node is stale or offline. | `/admin/settings/workers`; on the node, `evopathcli node status`. See [run worker nodes](run-worker-nodes.md). |
| `backup.schedule` | The latest run failed or went stale (fail), or the schedule is off, never completed, or the last success is over 48 hours old (warn). | `/admin/settings/db-backup`: read the run's error, fix the cause, then run a backup now. |
| `backup.pg-client` | `pg_dump` is missing (warn), or older than the server or the pinned version (fail). | [Postgres client version](postgres-client-version.md). |

### Telemetry

The chain `telemetry.export`, `telemetry.connection`, `telemetry.reachable`, `telemetry.tables`, `telemetry.freshness` runs in that order; work through it from the top, because each skips when the one before fails. Procedures are in the [telemetry runbook](telemetry.md).

| Check | Red or amber means | Go to |
|---|---|---|
| `telemetry.export` | `skip`: collection is off. Fail: collection is on but `OTEL_ENABLED` is not `true`. Warn: the export gate is closed, so no GreptimeDB connection yet. | Set `OTEL_ENABLED=true` and the OTLP endpoint for the `api` container with `telemetry.compose.yml`; or `/admin/settings/telemetry`. |
| `telemetry.connection` | No GreptimeDB reader connection is configured. | `/admin/settings/telemetry`. |
| `telemetry.reachable` | GreptimeDB did not answer as the reader. | Check the GreptimeDB container and the reader login; use **Test connection** on the settings page. |
| `telemetry.tables` | The store is unreadable, a table is missing (nothing exported yet), or no retention is set. | Check the collector exports to this database; apply retention at `/admin/settings/telemetry` (needs the admin login). |
| `telemetry.freshness` | No trace or log arrived within 5 minutes (warn), or none in 7 days (fail). | Check the OpenTelemetry collector container and `OTEL_EXPORTER_OTLP_ENDPOINT`; the Telemetry Dashboard shows the gap. |

## 5. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| The page shows a red request-error alert, not rows | The request failed: `403`, a network error, or a maintenance `503`. A failing check never looks like this. | `403`: the account needs `system_settings:read`. `503`: close the maintenance window or allow admins. Then **Retry**. |
| A problem you fixed still shows | The 15 second cache. | **Run again**, or add `refresh=true`. |
| A check reads `Timed out after 5000ms` | The probe did not answer in time. | Check that the service it probes is reachable from the API; the remedy names the settings page. |
| Many checks read `skip` | A shared dependency failed (usually `db.connection`), or capabilities are off. | Fix the topmost `fail` and run again. |
| The whole run takes many seconds | Telemetry checks wait on each other in a chain, up to 36 seconds when GreptimeDB is unreachable. | Fix the telemetry connection, or read the other categories while it finishes. |
| `storage.bucket` passes but uploads fail | The check is a read and cannot prove a write. | Run **Test connection** at `/admin/settings/storage`. |
| The API itself is down | The Doctor runs inside the API. | Run `evopathcli deploy doctor` on the server ([deploy runbook](deploy-to-vps.md)) and read the container logs. |

## 6. Summary checklist

- [ ] Signed in as an Admin; no maintenance window blocking admins
- [ ] Ran the Doctor and read the verdict
- [ ] Fixed `fail` rows first, starting with `core`
- [ ] Resolved or accepted each `warn`
- [ ] Understood every `skip` (dependency or intentionally off)
- [ ] Used the settings page's Test button where a pass is weaker than an end-to-end test
- [ ] **Run again**, and the verdict is what you expected

## See also

- [Admin Doctor spec](../specs/doctor.md): the check contract, every rule, how to add a check.
- [Maintenance mode runbook](maintenance-mode.md), [telemetry runbook](telemetry.md), [deploy to a VPS](deploy-to-vps.md).
- [AI training plans runbook](ai-training-plans.md), [AI configuration runbook](ai-configuration.md).
- [`evopathcli` reference](../../apps/cli/README.md#checking-prerequisites): the host-level `evopathcli deploy doctor`.
