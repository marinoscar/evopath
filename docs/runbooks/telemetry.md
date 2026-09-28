# Runbook: Enable, Configure and Operate Telemetry

> **Audience:** operators · **Spec:** [telemetry.md](../specs/telemetry.md) (connection: [§8](../specs/telemetry.md#8-runtime-connection)) · **Admin UI:** `/admin/settings/telemetry`, `/admin/settings/telemetry/explorer` · **Permission:** `telemetry:read`/`telemetry:write`/`telemetry:query`

This runbook covers turning telemetry on for a deployment (local or VPS),
deploying the GreptimeDB/collector containers themselves on a VPS, setting
policy, verifying it, pointing a deployment at a GreptimeDB or rotating its
reader/admin credentials from the admin UI, rotating GreptimeDB's other
passwords by editing the environment, and connecting a BI tool to it over
SSH. It does not cover the design — see [the spec](../specs/telemetry.md) for
the architecture, the two switches, the connection's precedence rule, the
stack-agent sidecar ([§10](../specs/telemetry.md#10-deploying-the-stack-stack-agent)),
and the security model.

Source of truth for every claim below:

- `infra/compose/telemetry.compose.yml`, `infra/compose/vps.telemetry.compose.yml`, `infra/compose/vps.compose.yml` (`stack-agent`)
- `infra/otel/otel-collector-config.yaml`
- `infra/compose/.env.example` (the `GREPTIME_*` and `STACK_AGENT_TOKEN` blocks)
- `apps/api/src/telemetry/` (settings, status, retention, explorer, assistant)
- `apps/api/src/telemetry/connection/` (the runtime connection: resolver, admin service, test service, controller)
- `apps/api/src/telemetry/stack/` (stack-agent client, `telemetry.stack.deploy` job, controller)
- `apps/stack-agent/` (the sidecar)
- `apps/cli/src/deploy/compose-files.ts`, `env-metadata.ts` (`effectiveGroups`, `STACK_AGENT_TOKEN`)

**Telemetry ships off, but the containers ship on.** A fresh VPS deployment
always carries the GreptimeDB and collector containers and `stack-agent`
(§2.2) — `observability` is no longer optional — but `telemetry.enabled` is
still `false` by default, so nothing is collected until an administrator
turns it on (§4).

---

## 1. Before you start

- **Know which environment you are enabling this in.** Development uses
  `infra/compose/telemetry.compose.yml` directly; a VPS deployment carries
  the telemetry stack on every install and update, with no group or flag
  needed (§2.2). Older deployments recorded before this became the default
  gain it on their next `appctl deploy update`.
- **You need `telemetry:write`** to change the policy, `telemetry:read` to
  view it, and `telemetry:query` to use the explorer or the assistant. All
  three are Admin-only by default.
- **Decide your retention before the first run.** `retentionDays` (1–3650,
  default 30) is applied as a database-level TTL; changing it later is cheap
  (§5), but it is worth choosing deliberately for a deployment that expects
  real load.
- **The AI assistant needs the AI platform on.** If you plan to configure it
  (§6), have AI enabled and at least one provider/model available first —
  see [ai-configuration.md](ai-configuration.md).

## 2. Enable the overlay

### 2.1 Development

From `infra/compose`:

```bash
docker compose -f base.compose.yml -f dev.compose.yml -f devdb.compose.yml \
  -f telemetry.compose.yml up
```

This starts `otel-collector` and `greptimedb` alongside the usual stack, and
sets `OTEL_ENABLED=true` on the `api` service (switch 1 of 2 — see the
spec's §2). Before running it, set the `GREPTIME_*` passwords in
`infra/compose/.env` (§3) — compose refuses to start `greptimedb` or
`otel-collector` if any `GREPTIME_*_PASSWORD` is empty, naming the missing
key.

- GreptimeDB HTTP API / SQL dashboard: http://localhost:14000/dashboard
- GreptimeDB PostgreSQL wire protocol: `localhost:14003` (`psql`, BI tools)
- Collector OTLP: `localhost:4327` (gRPC), `localhost:4328` (HTTP)

### 2.2 VPS deployment

The telemetry overlay ships with every VPS deployment; there is nothing to
opt into:

```bash
appctl deploy install --domain app.example.com
```

`effectiveGroups()` (`apps/cli/src/deploy/compose-files.ts`) always includes
`observability`, so `telemetry.compose.yml` and `vps.telemetry.compose.yml`
are always in the compose file list, the `GREPTIME_*_PASSWORD` values and
`STACK_AGENT_TOKEN` are generated as random hex with no prompt, and
`stack-agent` (§2.3) starts alongside the rest of the stack. `--group
observability` is still accepted on `install`/`update` — it is now a
harmless no-op, kept so an existing script does not break. A deployment
recorded before this became the default gains the stack, `stack-agent`
included, on its next `appctl deploy update`, with no flag.

On a VPS, GreptimeDB's Postgres wire port is published on
**`127.0.0.1:${GREPTIME_BIND_PG_PORT}` only** (default `14003`); nothing
about the telemetry store is reachable from outside the host. See
[deploy-to-vps.md](deploy-to-vps.md) for the rest of the install/update flow.

### 2.3 Deploying the containers themselves, from the admin UI

Shipping the compose files does not start GreptimeDB and the collector by
itself if they are not already running — for example, right after the first
install, or if they were stopped or removed on the host. Start (or restart)
them with no shell access:

1. Sign in as an Admin (`system_settings:write`) and open **Admin → Settings
   → Observability → Telemetry** (`/admin/settings/telemetry`).
2. In the **Telemetry services** section, click **Deploy GreptimeDB** (or
   **Redeploy**, once they have run before). This queues a
   `telemetry.stack.deploy` job and returns at once; the section polls it
   while it runs.
3. The job asks `stack-agent` — the sidecar that holds the Docker socket, see
   [the spec §10](../specs/telemetry.md#10-deploying-the-stack-stack-agent) —
   to run `docker compose up -d greptimedb otel-collector`, which can take up
   to ten minutes on a slow link if it has to pull the images. A second click
   while one is already running returns that same job instead of starting a
   duplicate.
4. On success, the section shows the containers' state and the connection
   (§9) and status (§7) refresh automatically, with no restart. On failure,
   the section shows the tail of what `stack-agent` printed — read it the
   same way you would read `docker compose up`'s own output.
5. `GET /api/admin/telemetry/stack` (`system_settings:read`) reports `agent:
   not_configured` when this deployment has no `stack-agent` — which should
   not happen on a VPS deployment made with a current `appctl`, but can on a
   deployment where `STACK_AGENT_URL`/`STACK_AGENT_TOKEN` were removed by
   hand from `vps.compose.yml`'s `api` environment.

The messages shown here are always about "the telemetry services" or
"GreptimeDB" — never about compose, a compose file, or the CLI. If you would
rather do this from a shell (for example, while debugging), §10 below still
works exactly as it did before this feature.

## 3. Set the GreptimeDB passwords

Three accounts, in `infra/compose/.env` (or supplied to the VPS wizard):

| Variable | Used by | Privilege |
|---|---|---|
| `GREPTIME_WRITER_USER`/`PASSWORD` | the collector, to ingest | write-only |
| `GREPTIME_READER_USER`/`PASSWORD` | the API — status, explorer, assistant; also BI tools | read-only |
| `GREPTIME_ADMIN_USER`/`PASSWORD` | the API, only to set retention | DDL (`ALTER DATABASE`) |

`.env.example` ships development placeholders (`change-me-writer`, etc.).
**Change all three before running the overlay anywhere reachable off your
own machine.** There is no compose-level default: an empty password fails
`docker compose up` outright rather than silently starting GreptimeDB with a
well-known credential.

## 4. Turn telemetry on

1. Sign in as an Admin and open **Admin → Settings → Observability →
   Telemetry** (`/admin/settings/telemetry`), or call the API directly:

   ```bash
   curl -sS -X PUT https://<your-deployment>/api/admin/telemetry/config \
     -H "Authorization: Bearer <admin access token>" \
     -H 'Content-Type: application/json' \
     -d '{"enabled": true, "retentionDays": 30,
          "query": {"maxRows": 10000, "timeoutSeconds": 30},
          "assistant": {"enabled": false, "provider": null, "modelId": null,
                        "shareResults": true, "maxResultRowsToModel": 100, "maxSteps": 15}}'
   ```

2. This takes effect on the instance that served the request immediately,
   and on every other instance in a fleet within about five seconds (the
   settings cache and the export gate both refresh on that interval — see
   [the spec, §2](../specs/telemetry.md#2-the-two-switches)).
3. The save also enqueues a `telemetry.retention.apply` job, so the
   retention you chose reaches GreptimeDB right away rather than at the next
   nightly run.
4. **Set the instance identifier if this telemetry store is shared.** Every
   span, log record and metric batch is labelled with `instanceId` (the
   `app.instance.id` resource attribute) — by default the application's own
   slug, which is enough as long as only one deployment writes to this store.
   If more than one deployment (two forks, or staging and production of one
   fork) shares this GreptimeDB or the dashboards built on it, give each a
   distinct `instanceId` so their data can be told apart:

   ```bash
   curl -sS -X PUT https://<your-deployment>/api/admin/telemetry/config \
     -H "Authorization: Bearer <admin access token>" \
     -H 'Content-Type: application/json' \
     -d '{"instanceId": "acme-prod"}'
   ```

   **Keep it stable once set.** Changing it later splits one deployment's
   history in two in every query and dashboard filtered by it — treat it like
   a hostname, not a display label. Send `"instanceId": null` to return to
   the `APP_SLUG` default. The change takes effect for the next batch
   exported, on the same refresh interval as step 2 above; see
   [the spec's instance identifier subsection](../specs/telemetry.md#the-instance-identifier).

## 5. Set retention

Change `retentionDays` (1–3650) the same way — a `PUT` with just that field:

```bash
curl -sS -X PUT https://<your-deployment>/api/admin/telemetry/config \
  -H "Authorization: Bearer <admin access token>" \
  -H 'Content-Type: application/json' \
  -d '{"retentionDays": 90}'
```

The change is applied as `ALTER DATABASE <db> SET 'ttl'='90d'` by the queued
job, and re-asserted every night at 04:00 UTC regardless — so if GreptimeDB
was down when you saved, or its volume was later recreated, retention
self-heals on the next run without any action from you.

## 6. Configure the AI assistant

1. Confirm AI is enabled for the deployment (`/admin/settings/ai`) and at
   least one provider/model is available.
2. In the telemetry policy, set `assistant.enabled: true` and pick
   `assistant.provider`/`assistant.modelId` (both `null` clears them back to
   "not configured"). Optionally adjust `assistant.shareResults`,
   `assistant.maxResultRowsToModel` (≤ 100) and `assistant.maxSteps` (1–20;
   default 15). The assistant is a troubleshooting agent — it orients
   itself, takes a baseline, drills down and correlates by trace before
   answering — so a low budget can end the investigation before it
   concludes; recommend 15–20. An existing deployment keeps whatever value
   it already has stored (older ones default to 6): raise it at
   `/admin/settings/telemetry` if investigations are coming back
   `inconclusive` for running out of steps.
3. The assistant spends the asking user's own AI key, or the organisation
   key, per the deployment's key policy — nothing further to configure per
   user.
4. Try it from the explorer's assistant drawer (`/admin/settings/telemetry
   /explorer`), or `POST /api/admin/telemetry/assistant/stream` directly.
   `telemetry:query` and `ai:use` are both required. Example questions: "is
   anything wrong right now?", "why are requests to /api/jobs slow?", "what
   errored in the last hour and why?", or trace-specific follow-ups once it
   has cited a trace id. A plain "write me a query for X" still works — the
   report's first `queries` entry is it.

## 7. Verify

1. **Status card.** `GET /api/admin/telemetry/status` (or the settings page)
   reports `configured: true`, `reachable: true`, a `version` string, the
   `ttl` currently in force, and the store's tables with row estimates. This
   endpoint always answers `200` — an unreachable store shows up as fields,
   not an error — so a `configured: false` or `reachable: false` here is the
   first thing to read on any problem below.
2. **A starter query.** Open the explorer and run one of the starter
   queries (or `SELECT count(*) FROM opentelemetry_traces` if the app has
   served any traffic since telemetry was enabled). An empty result with no
   error usually means the gate has not opened yet — wait a few seconds and
   retry, or see §12.
3. **The assistant**, if configured: ask it a simple question ("how many
   requests failed in the last hour?") and confirm you get a `step` stream
   ending in an `answer` event with a `sql` and `explanation`.

## 8. Reading the dashboard

**Admin UI:** `/admin/settings/telemetry/dashboard` · **Permission:**
`telemetry:query`. Full design: [the spec §11](../specs/telemetry.md#11-dashboard).

Open it after §7's checks pass — it needs the same `configured`/`reachable`
store, and reads nothing else new. Where the explorer needs you to write
SQL, this page answers "is anything wrong?" from one glance at the verdict
banner at the top.

**Verdict meanings and first action:**

| Verdict | Meaning | First action |
|---|---|---|
| `healthy` | No rule fired in the current window | Nothing to do |
| `degraded` | One rule crossed its lower threshold (5xx rate, p95 latency, or error-log ratio) | Read the reason line for the offending route or message; open the matching panel (API requests, log severity, or Top problems) for the detail |
| `critical` | One rule crossed its upper threshold | Same as `degraded`, more urgently — check whether the offending route or message points at a recent deploy or change |
| `no_data` | No trace or log in the last 5 minutes | See the checklist below — this overrides every other rule, since the others would be judging silence |

**No data checklist** (also see [Troubleshooting](#13-troubleshooting)):

1. Is `telemetry.enabled` on? Check `/admin/settings/telemetry` or `GET
   /api/admin/telemetry/status` (§7).
2. Is the collector healthy? `curl http://<host>:13133` (its health-check
   extension) from a host that can reach it.
3. Does GreptimeDB answer? `curl http://<host>:4000/health`.
4. Is `OTEL_ENABLED=true` set on the `api` service, and has it been
   restarted since? This one needs a container restart, not just a settings
   change — §2.2 and [§13](#13-troubleshooting) below.

**Drilling down and sharing a view:** the whole page state — window,
filters, log severities, search text, auto-refresh — lives in the URL, so
copying the address bar's link reproduces exactly what you are looking at
for anyone else with `telemetry:query`. Drag across an API or log timeline
(tap on a phone) to zoom into that span; a "Reset zoom" chip in the filter
bar returns to the preset range.

Every panel's header offers **"Open in Explorer"**, which loads that panel's
own query into the Explorer's editor without running it — press Run there
once you have reviewed it. Where the assistant is configured and switched on
(§6) and you hold `ai:use`, every panel also offers **"Ask assistant"** (the
verdict banner calls it **"Explain this"**), which opens the assistant with
a question about that panel prefilled — edit it and press Ask; it is never
sent on its own. On a phone, both actions are folded into the panel's `⋮`
menu. Opening a log event and following **"View trace"** (shown only when
the event carries a real trace id) does the same: it loads that trace's
spans into the Explorer, unrun. The Dashboard's header links to the
Explorer, the Explorer's back to the Dashboard, and `/admin/settings/telemetry`
offers "Open dashboard" whenever telemetry is on and you hold
`telemetry:query`.

**Known limits:**

- No CPU, memory or disk tile — only requests, logs and two Node runtime
  metrics are collected today (spec §11.2).
- Error messages are grouped by their raw first 200 characters, not a
  normalized template: two errors differing only by an embedded id or
  timestamp show up as separate rows.
- The verdict's thresholds are fixed, not configurable per deployment (spec
  §11.7, §11.12).
- Server-Sent Events routes (anything ending in `/stream`) are excluded from
  the p95 tile, the p95 line and the "slowest route" reason, so a long-lived
  subscription never manufactures a false `degraded`/`critical` verdict; they
  still count in requests, error rates and the Top problems table.

## 9. Point a deployment at a GreptimeDB, or rotate credentials, from the UI

The GreptimeDB connection the API uses is resolved at runtime, not fixed
from `.env` alone: an administrator can save a connection (host,
PG port, database, reader/admin logins) at **Admin → Settings →
Observability → Telemetry**, in the **Connection** section
(`/admin/settings/telemetry`), and it takes effect immediately — no restart,
no container recreate. See [the spec, §8](../specs/telemetry.md#8-runtime-connection)
for the precedence rule and what is and is not configurable here.

1. Open the Connection section. Leave **Host** blank to use the GreptimeDB
   deployed next to the app: with a blank host, there is nothing to enter —
   the page shows a "Managed by the deployment" summary instead of
   port/database/login fields, since that GreptimeDB's own logins and
   passwords (from `.env`, §3) are what the API will use. Type a host only
   for an **external** GreptimeDB; that reveals the port, database, reader
   login (required) and admin login (optional, for retention) fields.
2. **Test first.** Click **Test connection** before saving. With a blank
   host this probes the deployment's own GreptimeDB with its own logins —
   anything typed elsewhere in the form is ignored. With a custom host it
   checks the reader (and the admin, if given) against the values in the
   form, not necessarily the stored connection. Either way it always
   reports a pass/fail per login rather than an HTTP error; fix anything it
   reports before saving.
3. Click **Save**. The connection takes effect on this instance immediately
   and on every other instance in a fleet within about five seconds (the
   same refresh interval the settings cache and export gate use — see
   [the spec §2](../specs/telemetry.md#2-the-two-switches)). The save also
   re-applies the export gate and re-enqueues `telemetry.retention.apply`.
   Saving with a blank host stores only "automatic" and deletes any
   reader/admin password saved from an earlier custom connection.
4. **Rotating a reader or admin password for a custom (external) host**:
   leave the other fields as they are, type the new password into that
   login's password field, and save. Leaving a password field blank keeps
   the currently stored one — you do not need to retype a password you are
   not changing. There is nothing to rotate here for an automatic host: it
   always uses the deployment's current `GREPTIME_*` password (§10).
5. **Revert to the deployment default**: only offered for a stored custom
   connection (an automatic connection already *is* the deployment
   default, so there is nothing to revert). Use it when a saved external
   connection's logins have gone stale. Click **Revert to deployment
   default** (or `DELETE /api/admin/telemetry/connection`). This deletes
   the stored connection and both stored passwords; the `GREPTIME_*` values
   from `.env` (§3) apply again, exactly as they did before any connection
   was ever saved.
6. Re-check status (§7) after any of the above — a wrong password or
   unreachable host shows up there the same way it always has.

**This only changes what the API uses to *connect*.** If you rotate a
password **inside GreptimeDB itself** (for example, editing GreptimeDB's
`--user-provider` list), you still have to update the stored value here (or
in `.env`, for the deployment default) to match — the UI does not reach into
GreptimeDB and change its accounts, only what the API authenticates as.
Likewise, the writer login and the HTTP port are never configurable here
(§8 of the spec): rotating those still means editing `GREPTIME_WRITER_*` in
`.env` and recreating the collector/GreptimeDB containers, per §10 below.

## 10. Rotate GreptimeDB passwords (environment / collector / container)

Use this section for the writer login and the HTTP port, which are never
configurable from the admin UI, or when you would rather rotate every
account by editing `.env` and recreating containers than use §9 for the
reader/admin logins.

1. Pick new values for the accounts you are rotating (§3 lists them).
2. Edit `infra/compose/.env` (or the VPS deployment's `.env`) with the new
   `GREPTIME_*_PASSWORD` values. Rotate the reader and admin passwords
   together with the writer's if you are doing a full rotation — GreptimeDB
   is reconfigured from the same `--user-provider` flag on every restart, so
   a stale password left in `.env` for one role locks that role out.
3. Recreate the affected containers so they pick up the new environment:

   ```bash
   docker compose -f base.compose.yml -f dev.compose.yml -f devdb.compose.yml \
     -f telemetry.compose.yml up -d --force-recreate greptimedb otel-collector api
   ```

   (On a VPS, use the equivalent `-f` set from `appctl deploy update`, or run
   `appctl deploy update` after editing `.env` so it recreates the right
   services for you.)
4. GreptimeDB reads its accounts from `--user-provider` at startup, so the
   old passwords stop working the moment it restarts. Re-check status (§7)
   afterward: a wrong password on the reader or admin connection shows up as
   `reachable: false` with the driver's authentication error in `error`.
5. If you use a BI tool over the SSH tunnel (§11), update its stored
   credential to the new reader password.

## 11. Connect a BI tool over SSH

GreptimeDB's Postgres wire port is never published on a public interface.
Reach it through a tunnel:

```bash
ssh -L 14003:127.0.0.1:14003 <user>@<your-vps-host>
```

(Use the deployment's actual `GREPTIME_BIND_PG_PORT` if it was changed from
the default `14003` — for example, because more than one deployment shares
the host.) Then point your tool at:

| Field | Value |
|---|---|
| Host | `localhost` |
| Port | `14003` (or your tunnel's local port) |
| Database | `public` (or the deployment's `GREPTIME_DB`) |
| User | `GREPTIME_READER_USER`'s value |
| Password | `GREPTIME_READER_PASSWORD`'s value |
| SSL | off (the tunnel already encrypts the hop) |

Notes per tool:

- **Power BI.** Use the PostgreSQL connector. Prefer **Import** mode: a
  telemetry query result is a snapshot in time and GreptimeDB is not tuned
  for a report that re-queries live on every filter change.
  **DirectQuery** works but re-runs your SQL per interaction, so keep the
  underlying query narrow (a time-bounded view, not a raw table scan) and
  expect it to compete with `telemetry.query.timeoutSeconds` if it is slow.
- **Excel.** Data → Get Data → From Database → From PostgreSQL Database
  (Power Query), same connection fields.
- **DBeaver.** New PostgreSQL connection with the fields above; GreptimeDB's
  own SQL dialect (Apache DataFusion SQL, PostgreSQL-flavoured) mostly reads
  as ordinary SQL, but see the spec's spike findings for what differs
  (no bind parameters, flattened attribute columns need double quotes).
- The tunnel must stay open for the tool's session; a tool that reconnects
  automatically (most BI schedulers) needs the tunnel kept alive the same
  way, for example with `autossh` or a systemd unit wrapping the `ssh -L`
  command above.

The reader account can only `SELECT`/`SHOW`/`DESCRIBE` and read
`information_schema` — GreptimeDB itself refuses everything else for it, so
a BI tool cannot write to or alter the telemetry store no matter what it is
configured to do.

## 12. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Status reports `configured: false` | Neither a stored connection nor a usable `GREPTIME_*` deployment default names a host | Save a connection (§9), or deploy the containers (§2.3 on a VPS; §2.1 in development) and confirm the `GREPTIME_*` variables reached the `api` service's environment |
| Status reports `configured: true`, `reachable: false` | GreptimeDB is down, still starting, or a password is wrong | Check `docker compose ps greptimedb` and its logs; re-check the reader/admin passwords (§9 for a stored connection, §10 for the deployment default); on a VPS, try **Deploy GreptimeDB** (§2.3) to restart it |
| Test connection / status error says `host "<host>" could not be resolved` | The configured host has no DNS answer at all — usually the telemetry containers (`telemetry.compose.yml`) aren't running, so `greptimedb` isn't a known service name, or the connection points at the wrong hostname | Deploy the containers (§2.3 on a VPS; §2.1 in development) or fix the host in the Connection section (§9); the response can take up to ~15–20 s to arrive, since the host is given a longer lookup than the usual connect timeout before it is reported this way |
| **Deploy GreptimeDB** fails, or the status card's `agent` reads `not_configured`/`unavailable`/`unauthorized` | `not_configured`: this deployment has no `STACK_AGENT_URL`/`STACK_AGENT_TOKEN` (only possible if they were removed by hand from `vps.compose.yml`'s `api` environment). `unavailable`: `stack-agent` didn't answer within five seconds — check `docker compose ps stack-agent` and its logs. `unauthorized`: the API's `STACK_AGENT_TOKEN` no longer matches the sidecar's (usually a hand-edited `.env`) | Re-run `appctl deploy update` to restore the wiring, or check `stack-agent`'s own logs and the job's `deploy.output` on the status page for what `docker compose up` reported |
| Test connection / status error just says `timeout expired` / `Connection terminated due to connection timeout` | The host **does** resolve, so this is not a missing overlay — GreptimeDB isn't answering on the PG port (down, still starting, or blocked by a firewall/security group) | Check `docker compose ps greptimedb` and its logs; confirm the configured PG port (default `4003`) is reachable from the API container |
| Explorer/assistant answer `TELEMETRY_NOT_CONFIGURED` (503) | Same as above, surfaced through the API | Same as above |
| Explorer/assistant answer `TELEMETRY_DISABLED` (409) | `telemetry.enabled` is `false` | Turn it on (§4); allow up to five seconds to take effect everywhere |
| `retentionDays` change does not seem applied | The `telemetry.retention.apply` job failed, or no admin login is configured (stored or `GREPTIME_ADMIN_*`) | Check the job queue (`/admin/settings/jobs`) for a failed run; without an admin credential the job is a deliberate no-op — set one (§9 or §3) |
| Tables appear empty even though the app is being used | The export gate is still closed: `telemetry.enabled` was just turned on, or `OTEL_ENABLED` is not set on the `api` service | Wait a few seconds for the gate to open (§4); confirm `OTEL_ENABLED=true` is present on `api` (the overlay sets it, but a custom compose override can drop it) |
| A query or the assistant returns `TELEMETRY_QUERY_TIMEOUT` (504) | The statement outran `telemetry.query.timeoutSeconds` | Narrow the query (add a time filter, reduce the row cap) or raise the setting (≤ 120 s), then retry |
| The nginx assistant route hangs or drops mid-stream | A proxy in front of nginx is buffering the response | Confirm the deployment's own reverse proxy (in front of nginx, on a VPS) does not buffer `/api/admin/telemetry/assistant/stream`; nginx itself already forwards it unbuffered |
| The assistant reports no logs (or an empty `opentelemetry_logs`) even though the app is running | The logs pipeline specifically isn't reaching the store — `OTEL_ENABLED` unset/`false` on the `api` service, `telemetry.enabled` off, or the export gate not yet open | Check `OTEL_ENABLED=true` on `api` (§12 above) and `telemetry.enabled` (§4); confirm with `SELECT count(*) FROM opentelemetry_logs` in the explorer — if traces have rows but logs do not, the app's own log level or exporter, not telemetry, is the next thing to check |
| `PUT`/`DELETE .../connection` answers 409 | Someone else saved the connection first (stale `If-Match`) | Re-read `GET /api/admin/telemetry/connection` for the current `version` and retry |

## 13. Summary checklist

**First enable**

- [ ] `GREPTIME_*` passwords set to real values, not the `.env.example` placeholders (VPS: generated automatically by `appctl deploy`)
- [ ] Containers running (dev: `telemetry.compose.yml`; VPS: shipped automatically — click **Deploy GreptimeDB**, §2.3, if they are not up yet)
- [ ] `GET /api/admin/telemetry/status` reports `configured: true`, `reachable: true`
- [ ] `telemetry.enabled` turned on; retention set deliberately
- [ ] `instanceId` set if this store is shared by more than one deployment
- [ ] A starter query in the explorer returns rows
- [ ] (Optional) assistant configured and answers a test question
- [ ] Open the Telemetry Dashboard and confirm the verdict is not `no_data` (§8)

**Deploying/redeploying the containers from the UI (§2.3, VPS only)**

- [ ] `GET /api/admin/telemetry/stack` reports `agent: available`
- [ ] **Deploy GreptimeDB** / **Redeploy** clicked; job polled to completion
- [ ] On failure, the job's output read and the underlying problem fixed before retrying

**Connection change from the UI (§9)**

- [ ] Test connection passes for the reader (and the admin, if set)
- [ ] Saved; status re-checked (`source: stored`, `reachable: true`)
- [ ] Reverting to the deployment default tested at least once, if this deployment may ever need to

**Password rotation (environment / collector / container, §10)**

- [ ] New passwords written to `.env`
- [ ] `greptimedb`, `otel-collector` and `api` recreated
- [ ] Status re-checked; `reachable: true` with the new credentials
- [ ] Any BI tool's stored credential updated

## See also

- [Telemetry spec](../specs/telemetry.md) — architecture, the two switches, the runtime connection's precedence rule ([§8](../specs/telemetry.md#8-runtime-connection)), stack-agent and the always-on stack ([§10](../specs/telemetry.md#10-deploying-the-stack-stack-agent)), the dashboard's design ([§11](../specs/telemetry.md#11-dashboard)), security model
- [Deploy to a VPS](deploy-to-vps.md) — installing and updating a deployment
- [AI configuration](ai-configuration.md) — enabling AI before configuring the assistant
