# Runbook: Run Worker Nodes

Use this to run machines that execute the application's background jobs
remotely: one machine by hand, or a fleet in containers. Audience: operators
with an account holding `nodes:read` and `nodes:write`. The design and its
rejected alternatives are [`docs/specs/worker-nodes.md`](../specs/worker-nodes.md);
every `evopathcli node` flag is in
[`apps/cli/README.md`, "Running a worker node"](../../apps/cli/README.md#running-a-worker-node).

Source of truth for every claim below:

- `apps/cli/src/commands/node.ts` — the `evopathcli node` subcommands and flags.
- `apps/cli/src/node/` — the engine, `capabilities.ts` (the startup self-test),
  `install-deps.ts`, `worker-env.ts` (every `EVOPATHCLI_*` variable).
- `apps/cli/src/tui/screens/node.tsx` — the interactive dashboard.
- `infra/compose/worker.compose.yml`, `worker.build.compose.yml`,
  `.env.worker.example` — the container fleet.
- `apps/api/src/nodes/` — registration, claim, lease and the per-job secret
  broker the server side runs.

---

## 1. Before you start

A worker node is a machine running `evopathcli node start` that claims jobs from the application's
queue, runs them locally, and submits results. The **same handler code** runs
on the API server or on a node — a node is an option, never a requirement, and
a deployment with no nodes at all still executes every job type it enqueues.

Nodes coordinate through nothing but the database. Two workers never receive
the same job because the claim is a `FOR UPDATE SKIP LOCKED` on one table, so
you scale by starting more of them and configuring none of them to know about
the others.

### 1.1 Prerequisites

| Requirement | Why |
|---|---|
| Node.js 20+ | The CLI's runtime floor |
| Outbound HTTPS to the application | The only network access a node needs — no inbound ports, ever |
| An account with `nodes:read` and `nodes:write` | To enroll and register |

A worker needs **no persisted** database access, no VPN, and no inbound
firewall rule. It downloads and uploads job data through short-lived presigned
URLs the server issues, so it never holds storage credentials at all, ever.
The one exception on the database side is `db.backup.run` (below): if your
fleet is going to take database backups, the node needs a **network route**
to PostgreSQL, and the credential it uses to connect is brokered per job, held
in memory only, and never written to disk (section 5.1).

## 2. Which procedure you want

- **One or two machines you log into**: section 3.
- **More than one or two workers**: containers, section 4.

Both then use sections 5 to 8 (capabilities, dependencies, memory, daily
operation).

## 3. Run a worker on one machine

```bash
# 1. Enroll — device login, then mint a node credential for this machine.
evopathcli node enroll

# 2. Register — create (or re-attach to) this machine's row in the fleet.
evopathcli node register --concurrency 4

# 3. Check everything before committing to it.
evopathcli node doctor

# 4. Run it.
evopathcli node start --daemon
```

Step 3 is worth not skipping. `doctor` reports three independent things an
operator routinely conflates, and a failure in one never masks the others:

- **This machine** — runtime, capabilities for the advertised job types, and
  whether the state directory is writable.
- **The server** — reachable, credential accepted, permissions present. It
  distinguishes *cannot reach the server* from *reached it and was refused*,
  which look identical in a stack trace and have entirely different fixes.
- **The worker** — whether a daemon is actually running here.

### 3.1 Survive a reboot

```bash
evopathcli node service install
loginctl enable-linger $USER      # ← do not skip this
```

This writes a systemd **user** unit — no root needed, and a worker has no
reason to run as root. Two details in the generated unit matter:

**`Restart=on-failure` is not decoration.** The memory watchdog exits
*deliberately* when the heap crosses its threshold, after draining cleanly and
writing a snapshot. Without a supervisor that successful drain leaves the
worker down — a self-healing mechanism turned into an outage.

**`loginctl enable-linger` is the step people miss.** Without it a user unit
stops when your last session ends, so a worker on a box you SSH into dies when
you log out. That reads as a crash and is actually policy.

`service install` on Windows or macOS, or on a Linux box with no per-user
systemd, prints guidance rather than a stack trace — including how to enable
systemd on WSL 2.

## 4. Run a fleet in containers

Containers are the recommended shape for more than one or two workers.

```bash
cd infra/compose
cp .env.worker.example .env.worker      # server URL + node credential
docker compose --env-file .env.worker -f worker.compose.yml up -d --scale worker=4
```

That is the whole configuration. Only `EVOPATHCLI_SERVER_URL` and `EVOPATHCLI_TOKEN`
are required: with no config file the worker builds its settings from the
environment and starts. Each replica registers as its own node, named after
its container hostname (which Docker makes unique), and the replicas
load-balance through the server's `FOR UPDATE SKIP LOCKED` claim, so two
replicas never receive the same job. Every variable either file may set is in
the generated table in
[`apps/cli/README.md`, "Worker environment variables"](../../apps/cli/README.md#worker-environment-variables).

> **Leave `EVOPATHCLI_NODE_NAME` and `EVOPATHCLI_NODE_ID` empty when scaling.** Setting
> either makes every replica reattach to the same node row, and the server's
> per-node claim cap is then shared between processes that each believe they
> own it.

| Setting | Why it is there |
|---|---|
| `restart: unless-stopped` | The memory valve exits deliberately; without this a clean drain leaves the worker down |
| `stop_grace_period: 300s` | Long enough for a real drain before Docker escalates to `SIGKILL`; a job killed mid-flight waits out its lease before it is retried anywhere |
| Exec-form `ENTRYPOINT` | Shell form wraps PID 1 in `/bin/sh -c`, which does not forward `SIGTERM` — the drain would never run |
| A volume at `/var/lib/worker` | State survives a restart, so a replica re-attaches instead of leaking a node row |

If the container cannot write its config file back (a read-only home is
common), the worker warns and keeps going.

The worker makes only **outbound** connections: no ports, no inbound firewall
rule, and no database access.

To build the image from a checkout instead of pulling it:

```bash
docker compose -f worker.compose.yml -f worker.build.compose.yml up --build
```

CI publishes `ghcr.io/<owner>/<repo>-worker` beside the api and web images on
every tag, using the same tag conventions.

## 5. Capabilities and the startup self-test

The worst failure a worker has is starting successfully and then failing every
job it claims: it looks healthy to every orchestrator and dashboard while
draining the queue into the failed pile, and each failure charges the job an
attempt.

So a headless worker probes its capabilities at startup and compares them
against what its eligible job types declare:

- A missing **required** capability → **hard exit** (code `70`), naming the
  capability and the type. In a container that is a visible crash-loop with a
  clear reason, which is strictly better than a node quietly failing
  everything.
- A missing **degradable** capability → warn and continue.

The template's example job type hashes a stream and needs nothing native. The
one entry that is real is the database backup:

| Type | Required | Degradable |
|---|---|---|
| `db.backup.run` | `pg_dump` | `psql` |

A node without `pg_dump` therefore never declares `db.backup.run` — which
matters more for this type than for any other, because it is configured never
to retry: a claim it cannot fulfil is a backup that simply did not happen.
`psql` is degradable because it is used only to read the server version and the
newest applied migration; without it the backup is taken, uploaded and verified
with those two audit fields left `null`.

A node also needs a **network route** to the database, which nothing on this
machine can check for you at startup. `evopathcli node doctor --db-host
db.internal:5432` probes it, as a warning rather than a failure — see
"Health checks, dependencies and running as a service" in [`apps/cli/README.md`](../../apps/cli/README.md#running-a-worker-node).

Beyond those, the **structure** is the deliverable, and it is the documented
place a fork declares that its `video.transcode` type needs `ffmpeg`.

### 5.1 Take database backups on a node

`db.backup.run` needing a real PostgreSQL connection — not a presigned URL —
is the one place a worker node's "no persisted database access" rule (above)
gets an exception rather than an exemption. Three things an operator turning
this on needs to know, none of them a code change:

1. **The connection is per job, not per node.** A node never holds a database
   password in its config file or its state directory. When it holds a
   `db.backup.run` job it calls `POST /api/nodes/{id}/jobs/{jobId}/secret`, gets one
   short-lived credential back, holds it in memory for the life of that job,
   and drops it. `apps/cli/src/node/executors/db-backup-run.test.ts` asserts
   this statically — the executor imports no config writer at all.
2. **Two independent switches, both off by default, must both be on** before
   any node is ever offered the job type: `nodes.jobSecretBrokerEnabled` ("may
   this deployment broker credentials to nodes at all?") and
   `databaseBackup.nodeOffloadEnabled` ("may *this* workload leave the API
   server?"). They are separate on purpose — a deployment can trust its fleet
   with credentials in general while still keeping backups on the server, or
   vice versa. Both live in the admin UI, not in an environment variable.
3. **The database role this API connects as needs `CREATEROLE`** to mint the
   short-lived, read-only role each backup job uses. `GET
   /api/admin/db-backup/node-credential-preflight` tells you, without
   changing anything, whether it already has that grant — and if it does not
   (the ordinary case on managed PostgreSQL, where the application role is
   deliberately not a superuser), it hands back a paste-ready `ALTER ROLE …
   CREATEROLE;` (or a dedicated minter role, the least-privilege option) in
   its response rather than failing. Run one of those once, as whatever
   account administers your database. Auditing issued roles and cleaning up
   an orphan by hand is [`docs/runbooks/node-job-secrets.md`](../runbooks/node-job-secrets.md).

Until all three are true, `db.backup.run` runs on the API server. Nothing
about turning this on is required to take backups at all.

### 5.2 Declare a requirement in a fork

In `apps/cli/src/node/capabilities.ts`:

```ts
export const PROBED_BINARIES = ['ffmpeg'];

export const JOB_TYPE_REQUIREMENTS = {
  'video.transcode': {
    required: [binaryCapability('ffmpeg')],
    degradable: [binaryCapability('exiftool')],
  },
};
```

## 6. Install dependencies

```bash
evopathcli node install-deps --dry-run   # print the plan, change nothing
evopathcli node install-deps
```

⚠️ **This ships as a framework, not as a set of real installs.** The template
has no native dependencies to install, and inventing some would mean a fork had
to work out which of the steps were real. What you get is the structure —
ordered steps, per-step `skipped | installed | failed | unsupported`, distro
detection, an explicit sudo announcement before anything runs, and a working
`--dry-run`. Add your own steps in `apps/cli/src/node/install-deps.ts` beside
the two generic ones.

## 7. Memory

Three mechanisms, all on by default, all with one thing in common: they assume
a supervisor is watching.

**Heap tuning.** The worker re-execs itself once at startup with a RAM-aware
`--max-old-space-size`, because Node's default old-space limit is low for a
machine dedicated to being a worker. The original process becomes a
signal-forwarding shim, so a container `SIGTERM` still reaches the worker and
still drains. Set `EVOPATHCLI_HEAP_LIMIT_MB=0` when a cgroup or a PaaS already
manages memory — a second opinion there is worse than none.

**The watchdog** samples memory and, once the samples span a real window,
reports a least-squares growth trend in MB/hour. That trend is the difference
between "it died" and "it was climbing 40 MB/hour for six hours".

**The pre-OOM valve** fires once when `heapUsed / heapLimit` crosses the
threshold (default `0.9`): snapshot → log → drain → exit `71`.

> ⚠️ **The valve requires a supervisor.** It exits deliberately after a clean
> drain. Without `Restart=on-failure` or `restart: unless-stopped`, a
> *successful* drain leaves the worker down — a self-healing mechanism turned
> into an outage. `evopathcli node service install` sets this for you.

### 7.1 Diagnose a leak

```bash
evopathcli node heap-snapshot     # asks the LIVE daemon
```

Ask the running worker, not a fresh one. Restarting to attach a diagnostic flag
discards exactly the accumulated state that names the retainer — which is also
why the valve writes its snapshot *before* draining rather than after.

Snapshots land in `<state dir>/heap-snapshots`, newest five kept, and are
skipped with a clear reason when free disk is under 1.5× the live heap: a
snapshot must never be the thing that fills the volume. Open one in Chrome
DevTools → Memory → Load.

| Exit code | Meaning |
|---|---|
| `0` | Clean stop |
| `70` | A required capability for an advertised job type is missing |
| `71` | The pre-OOM valve fired — restart it |

## 8. Day-to-day operation

```bash
evopathcli node status              # live snapshot from the running worker
evopathcli node logs --follow       # attach to the daemon's event stream
evopathcli node set-concurrency 8   # applies live; persists either way
evopathcli node stop
```

Attaching is **read-only** and passive: inspecting a worker never perturbs it,
and detaching leaves it running untouched.

In a real terminal, `evopathcli` with no arguments opens the interactive menu;
**Worker node (this machine)** offers a live dashboard (status, concurrency,
job types, totals, heartbeat age, active jobs and the event stream),
`doctor`, the log, `register` and `enroll`. With no worker running, press `s`
to start a detached one and attach.

### 8.1 What lands in the logs

JSONL under `<state dir>/logs/node.log`, one rollover generation at 5 MiB,
written synchronously so the lines immediately before a crash survive it.

**Secrets are redacted before anything reaches disk** — tokens, API keys,
passwords, and presigned storage URLs — recursively, through nested objects and
arrays. That last one matters: a presigned URL is a bearer capability over an
object, and log files are things people attach to issues.

### 8.2 Vitals on the heartbeat

Every heartbeat (every 15 s, and immediately after a concurrency change)
carries a `vitals` snapshot of the worker process, so an administrator can spot
a node that is alive but unwell before it stops heartbeating:

| Field | What it is |
|---|---|
| `cpuPercent` | Process CPU since the previous heartbeat; `100` is one full core, so a busy multi-core worker can exceed it |
| `rssBytes`, `heapUsedBytes`, `heapLimitBytes` | Process memory and the V8 heap ceiling (the same numbers the memory watchdog in §7 acts on) |
| `eventLoopDelayP99Ms` | p99 event-loop delay since the previous heartbeat; a high value means something is blocking the worker |
| `stateDirFreeBytes`, `stateDirTotalBytes` | The filesystem holding the state directory (`EVOPATHCLI_STATE_DIR`) |
| `slotsUsed`, `slotsTotal` | Jobs running now / the current concurrency |
| `uptimeSeconds` | How long this worker process has been running |
| `counters` | Totals since the process started: `claims`, `emptyPolls`, `claimFailures`, `succeeded`, `failed`, `rateLimited`, `leaseRenewals`, `leaseRenewFailures`, `heartbeatFailures`, and `watchdogTrips` (0 or 1: the valve exits the process) |
| `cliVersion`, `nodeVersion` | The `evopathcli` and Node.js versions |

The counters reset on every restart. Each field is best-effort: one the worker
cannot read (for example the disk figures on an unusual filesystem) is simply
left out, and nothing about collecting vitals can stop a heartbeat. There is
nothing to configure.

**Where to see them.** The server stores the latest snapshot on the node's row:
`GET /api/admin/nodes` and `GET /api/admin/nodes/{id}` (`nodes:read`) return it
as `lastVitals`, stamped with the server's own `lastVitalsAt`. Vitals are for
display only; no scheduling decision reads them.

**Against an older server.** A server that predates vitals may refuse the
unknown `vitals` key with a `400`. The worker then resends that heartbeat
without vitals, stops sending them for the rest of the process, and logs one
warning (`server refused heartbeat vitals; not sending them again this
process`). The node stays online; upgrade the server and restart the worker to
get vitals back.

### 8.3 Job spans sent to the server

After each job settles, the worker sends the server the timing of the job's
phases. The server records them as trace spans under the request that queued
the job, so a trace in the explorer shows the node's work next to the
server's:

| Span | Covers | Attributes |
|---|---|---|
| `job.download` | Fetching the input object (types with an input) | `bytes` |
| `job.secret` | Obtaining the job's brokered credential (e.g. `db.backup.run`) | none |
| `job.execute` | Running the job | `attempt` |
| `job.upload` | The streamed upload (`db.backup.run`) | `bytes` |
| `job.submit` | Posting the result, or reporting the failure | none |

Each span holds only a start time, a duration, `ok`/`error`, and the numbers
above. A failed phase adds the error's class name, plus an HTTP status or
system error code (`MissingJobInputError`, `ApiError.409`,
`Error.ECONNREFUSED`). It never carries the error message, a URL, a path or
the credential. The server takes the node's identity from the authenticated
route, not from anything the worker sends.

Sending is best-effort and never delays or fails a job. Spans wait in a
bounded in-memory queue (500 spans, oldest dropped first) and go out in
batches of up to 50. A refused batch (`400`, `403`, `429`) or a network error
is dropped silently. There is nothing to configure.

**Against an older server.** A server without the relay answers `404`. The
worker then stops sending spans for the rest of the process and logs one
warning (`server has no span relay (older API); not sending job spans again
this process`). Jobs are unaffected; upgrade the server and restart the worker
to get node spans.

**Spans missing from a trace.** The server keeps spans only for a job the node
holds, or settled in the last 10 minutes, on the same API replica that
recorded the settle. A batch is refused when a span ends more than five minutes
in the future by the server's clock (a worker clock running ahead) or started
more than 24 hours ago, and when one node sends more than 60 batches or 1000
spans a minute. Check the worker's clock (NTP) first. Tracing must also be on at the
server (`OTEL_ENABLED`); see [telemetry.md](telemetry.md).

## Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| `A worker is already running here (pid N)` | A live daemon holds this state directory | `evopathcli node stop`, or use a different `EVOPATHCLI_STATE_DIR` |
| Starts, then exits with code `70` | An advertised job type is missing a required capability | The message names both — install it, or drop the type from `--types` |
| `doctor` says reachable but refused (401) | The credential was revoked or belongs to another server | `evopathcli node enroll` again |
| `doctor` says refused (403) | The account lacks `nodes:read`/`nodes:write` | Ask an administrator to grant them |
| `doctor` says 404 on `/api/nodes` | The server predates worker nodes | Upgrade the server |
| The node shows online in the admin UI but does nothing | It has no executor for any advertised type | `evopathcli node status` lists what it can actually run |
| Jobs fail immediately with a rate-limit message | A provider is throttling | Nothing to do — the server defers those without charging an attempt |
| The worker vanishes when you log out | No systemd lingering | `loginctl enable-linger $USER` |

## Summary checklist

**One machine**

- [ ] `evopathcli node enroll` stored a `nod_` credential
- [ ] `evopathcli node register` created or reattached the node (it says which)
- [ ] `evopathcli node doctor` reports this machine, the server and the worker
      without failures
- [ ] `evopathcli node start --daemon` running, or `evopathcli node service install`
      plus `loginctl enable-linger $USER`

**A container fleet**

- [ ] `.env.worker` sets `EVOPATHCLI_SERVER_URL` and `EVOPATHCLI_TOKEN`, and leaves
      `EVOPATHCLI_NODE_NAME`/`EVOPATHCLI_NODE_ID` empty
- [ ] `restart: unless-stopped` and `stop_grace_period` kept in
      `worker.compose.yml`
- [ ] Nodes appear at `/admin/settings/workers`

**Database backups on a node (optional)**

- [ ] `pg_dump` on the node's `PATH`, and a network route to PostgreSQL
      (`evopathcli node doctor --db-host <host:port>`)
- [ ] `nodes.jobSecretBrokerEnabled` and `databaseBackup.nodeOffloadEnabled`
      both on, and the node-credential pre-flight answers `ok`
      ([`node-job-secrets.md`](../runbooks/node-job-secrets.md))
