# Admin Doctor

> **Status:** shipped · **Code:** `apps/api/src/doctor/` (contract, registry, service, controller), checks under `apps/api/src/<module>/doctor/`, `apps/web/src/pages/Admin/DoctorPage.tsx` · **API:** `GET /api/admin/doctor` (see `/api/docs`, tag `Doctor`) · **Admin UI:** `/admin/settings/doctor` · **Runbook:** [doctor.md](../runbooks/doctor.md) · **Recipe:** [§4](#4-extending-it-in-a-fork)

The Doctor answers one question for an administrator: is every capability of this deployment configured, reachable and healthy? It runs a set of small, read-only checks, one per fact worth knowing, that each capability's own module contributes, and returns one report. Each row carries a status, a one-line detail and, when something needs attention, a remedy and the settings page that fixes it.

## 1. Purpose

**What it is.** A diagnostic for the running deployment. It covers the database, authentication, maintenance mode, object storage, email, Web Push, AI (providers, per-feature model assignments and web search), the job queue, worker nodes, database backups and telemetry capture.

**What it is not.**

- Not a liveness or readiness probe. `/api/health/*` stays public, cheap and always reachable; see [§6](#6-design-decisions).
- Not an exerciser. It never sends an email or a push, writes an object, calls a model or enqueues a job. The explicit "Test" buttons on each settings page remain the way to prove a capability end to end ([§2.2](#22-the-read-only-rule)).
- Not a monitor. It runs when an administrator asks; nothing polls it, schedules it or alerts from it.
- Not the host-level doctor. `evopathcli deploy doctor` asks "is this server ready to install?" before anything is deployed. The Doctor asks "is the running deployment healthy?" ([§2.9](#29-relation-to-evopathcli-deploy-doctor)).

**The problem it solves.** After a fork is deployed, the things that go wrong are spread over a dozen settings pages and several environment variables: a missing `SECRETS_ENCRYPTION_KEY`, a bucket the key cannot read, SMTP switched off, a worker that is not running, a telemetry collector that stopped exporting. The Doctor lists all of them in one place, in an order that hides consequences behind their causes.

## 2. How it works

### 2.1 The check contract

The contract lives in `apps/api/src/doctor/doctor-check.interface.ts`. A check is an `@Injectable()` with these members:

| Member | Meaning |
|---|---|
| `id` | Stable, dotted, unique across the application (`storage.bucket`). |
| `category` | `core`, `auth`, `maintenance`, `storage`, `email`, `push`, `ai`, `jobs`, `nodes`, `backup`, `telemetry`, or any new string a fork adds. |
| `label` | Short human label shown in the page. |
| `settingsPath` | Optional web route that fixes the problem (`/admin/settings/storage`). |
| `timeoutMs` | Optional per-check ceiling; the default is 5000 ms ([§2.4](#24-the-service)). |
| `dependsOn` | Optional ids of checks that must not `fail` or `skip` for this one to run. |
| `run()` | Returns `{ status, detail, remedy?, error?, data? }`. Read-only. |

**Statuses.** The four values are identical to the CLI doctor's `CheckStatus`.

| Status | Meaning | Rank |
|---|---|---|
| `pass` | Verified healthy. | 0 |
| `skip` | Not evaluated (see below). Needs no remedy. | 1 |
| `warn` | Works, but needs attention. | 2 |
| `fail` | Broken. | 3 |

The order is `pass` < `skip` < `warn` < `fail`. The report's `verdict` is the worst status present; an empty report has verdict `skip`, so a run in which nothing ran never reads as `pass`.

**`skip` has exactly two causes.**

1. A check listed in `dependsOn` did not pass (it ended `fail` or `skip`). The service decides this and never calls `run()`.
2. The capability is intentionally off: AI switched off, telemetry collection off, no stack agent because this is not a VPS deploy. That is an operator's choice, so it is neither `warn` (nothing to fix) nor `pass` (nothing was proven).

**Field rules.**

- `detail` is one line: what was found ("Connected in 12 ms"). The service flattens newlines and cuts it at 500 characters.
- `remedy` is expected on `warn` and `fail`, and names a settings page, a command or an environment variable. When a check omits it, the service supplies `Open <settingsPath> to review.` (or `See the API logs for details.` when there is no `settingsPath`), so a problem never appears without a next step. Each check's own spec asserts it supplies a real one.
- `error` carries the underlying error message when a probe failed.
- `data` holds small scalar facts (counts, versions, latencies).
- **A check never throws.** A crashed probe is a `fail` carrying the error's message. The service also guards every call (a throw becomes a `fail`, a hang becomes a `fail` after `timeoutMs`), but a check that catches its own failure reports a better `detail`.

### 2.2 The read-only rule

A Doctor run must be safe against a production deployment at any time, by anyone holding `system_settings:read`, as often as they like. A check:

- reads, and only reads: a `SELECT`, a `HEAD`, a settings read, `pg_dump --version`;
- writes no object, row or audit event, enqueues no job and calls no model;
- never calls the side-effecting "Test" services. These write probe objects, spend model tokens, send mail and pushes, or audit the attempt:

| Service | Why a check must not call it |
|---|---|
| `StorageConnectionTestService` | Round-trips a probe object and audits the attempt. |
| `AiProviderTestService` | Calls a provider model and spends tokens. |
| `EmailTestSendService` | Sends an email. |
| `PushTestService` | Sends a push notification. |
| `TelemetryConnectionTestService` | Audits the attempt. |

A check may reuse the test services' pure helpers where they exist. `push.vapid` calls `isValidVapidPublicKey`, `isValidVapidSubject` and `privateKeyDerivesPublicKey` from `push-test.service.ts` but never the send.

**No secret material in a result.** Not in `detail`, not in `error`, not in `data`. A check that reads a secret to validate it (the VAPID private key) reports only the verdict. Lengths, counts and "is set" booleans are fine; values, hints and fingerprints are not. `jwt-secret` reports the secret's length and never its value; `telemetry.export` strips userinfo and the query string from the OTLP endpoint before showing it.

### 2.3 The registry

`DoctorCheckRegistry` (`apps/api/src/doctor/doctor-check.registry.ts`) is the one place that knows which checks run. It has `register`, `get` and `list` (registration order).

**Explicit self-registration.** Each check lives in its owning feature module under `<module>/doctor/`, injects the registry and calls `this.registry.register(this)` from its own `onModuleInit`. This is the mechanism and the rationale of `apps/api/src/jobs/job-handler.registry.ts`: "why does the Doctor run this check?" has a grep-able answer (one `register(this)` line), and a check nobody wired up is a missing line in a diff rather than a decorator scan that silently matched nothing. Every `onModuleInit` has run before the first HTTP request, so the Doctor never races a registration.

**Duplicate ids throw.** Where the job registry overwrites, this one fails at boot with both class names. A job `type` is a persisted contract a fork may legitimately shadow; a check id only names a line in a report, so two checks claiming one id is always a copy-paste mistake.

**`DoctorModule` is `@Global()` and imports nothing.** A feature module contributes a check by listing it in `providers`, without importing `DoctorModule`. Every edge stays one-way: features know the registry, the Doctor knows no feature.

### 2.4 The service

`DoctorService.run({ category?, refresh? })` (`apps/api/src/doctor/doctor.service.ts`) owns everything a check should not have to.

**Dependency waves, without a barrier.** Every check whose dependencies have settled starts at once; a dependent starts the moment its last dependency settles. A slow telemetry probe never delays an unrelated storage one.

| Situation | Result |
|---|---|
| A dependency ended `fail` or `skip` | The check is `skip` with detail `Skipped: <dependency label> did not pass`, and `run()` is never called. |
| A dependency ended `warn` or `pass` | The check runs. |
| A `dependsOn` id is not registered | `skip`, detail names the missing id. |
| A check sits on a `dependsOn` cycle | `fail` with a remedy naming the cycle, instead of a hang. Checks outside the cycle that depend on a member are `skip`. |

**Timeouts.** The default ceiling is `DOCTOR_DEFAULT_TIMEOUT_MS` (5000 ms). A check overrides it with `timeoutMs` when its probe legitimately takes longer. A timeout is a `fail` with detail `Timed out after <n>ms` and a remedy. The probe is abandoned, not cancelled, so a probe that can hang must carry its own client-side bound.

| Check | `timeoutMs` | Why |
|---|---|---|
| `backup.pg-client` | 12000 | `pg_dump --version` gets its own 10 s before it counts as hung. |
| `telemetry.tables` | 12000 | A ping plus two reads, each bounded at 5 s by the status service. |
| `telemetry.reachable` | 7000 | The 5 s ping bound plus 2 s. |
| `telemetry.freshness` | 7000 | The 5 s statement bound plus 2 s. |
| `telemetry.stack` | 7000 | The 5 s stack-agent status bound plus 2 s. |

Because a dependent waits for its dependencies, the worst-case latency of a run is the sum of the timeouts along the longest chain: 36 s for the telemetry chain (`export`, `connection`, `reachable`, `tables`, `freshness`). Checks off that chain finish sooner.

**Normalisation.** An outcome with an unknown status becomes a `fail` with detail `The check returned an invalid outcome.` A `warn` or `fail` without a remedy gets the fallback from [§2.1](#21-the-check-contract). `data` is `null` when empty.

**Caching.** The report is cached in memory for `DOCTOR_CACHE_TTL_MS` (15 s), per `category` filter (the unfiltered report is its own key).

- The cache stores the in-flight promise, so concurrent callers share one run, and two administrators opening the page together do not double the probes.
- `refresh=true` bypasses the cache and replaces the entry with the new run.
- A cached report keeps its original `generatedAt`.
- Expired entries are dropped on every run, so arbitrary `category` values cannot grow the map. A run that itself rejects is evicted at once.
- The cache is per API process. Behind several API instances, each has its own.

**Category filter.** `category=<x>` reports only the checks in that category. A check's dependencies in other categories are still evaluated (so a filtered row reads `skip` for the right reason) but are not reported. A category nothing registered returns `checks: []` with verdict `skip`. A malformed category (not `^[a-z0-9][a-z0-9_-]{0,63}$`) is a `400`.

**Order.** Rows are sorted by category (shipped categories in the order of `DOCTOR_CATEGORIES`; a fork's own categories after them), then by registration order.

**Report shape.** `{ verdict, generatedAt, durationMs, checks[] }`. Each row is `{ id, category, label, settingsPath, status, detail, remedy, error, data, durationMs }`. Every nullable field is present as `null` rather than absent. `durationMs` is `0` for a check skipped without running. The body arrives in the usual `{ data, meta }` envelope ([API.md](../API.md#response-envelope)).

**Always `200`.** A failing check is a row, not an error status. The report is read precisely when something is wrong, and a `500` or `503` would withhold the list of what.

### 2.5 Why it is not a queue job

CLAUDE.md requires every long-running activity to be a queue job. The Doctor is a bounded read in the same way as the telemetry dashboard ([telemetry.md §11.6](telemetry.md#116-bounds-caching-and-why-this-is-not-a-queue-job)):

- every probe is bounded by a per-check timeout, and every statement a check issues is a single read;
- nothing outlives the HTTP request that started it: no `@Cron`, no `@OnEvent`, no detached promise;
- the result is a 15-second in-memory cache, not a stored record.

An administrator who opens the page is waiting for the answer, and a queued job would only add a place for the answer to get lost. The one caveat is the abandoned probe after a timeout ([§2.4](#24-the-service)).

### 2.6 Access and maintenance mode

The route is gated on `system_settings:read` and mounted under `admin/`, so it is outside the `nod_` allowlist by construction. No `doctor:read` permission exists; see [§6](#6-design-decisions).

**It is not `@AllowDuringMaintenance()`.** `GET /api/admin/about` is reachable during a window because it reads a file and answers a database liveness probe. The Doctor performs network I/O against object storage, GreptimeDB and the stack agent, and a window (above all the restore swap) is exactly when those dependencies may be mid-change. So while a window is open:

- with `allowAdmins: true` (the default), an Admin session JWT passes and the Doctor works. `maintenance.mode` reports the open window as a `warn`;
- with `allowAdmins: false`, every caller gets the maintenance `503`, and the web page shows its request-error alert. Close the window first ([maintenance runbook](../runbooks/maintenance-mode.md));
- a `pat_` token never passes a window, so scripted use during maintenance needs a session.

### 2.7 Check inventory

This is the single home for the list of checks. Twenty-six checks ship. `dependsOn` and the rules below are taken from the code; "no settings page" means the check has no `settingsPath` (the service's fallback remedy then names the API logs).

#### core

| Id | Label | `dependsOn` | What it verifies | Rules |
|---|---|---|---|---|
| `db.connection` | Database connection | none | The database answers `SELECT 1`, through `DatabaseHealthIndicator`, the same definition the readiness probe and About use. | pass: connected (latency in `data`). warn: round trip over 500 ms. fail: no answer. |
| `db.migrations` | Database migrations | `db.connection` | One `SELECT` on `_prisma_migrations`: no migration is half-applied. | pass: at least one applied, none unfinished or rolled back. fail: a migration started and never finished (names the first), a rolled-back migration never re-applied, none applied at all, or the table unreadable. |
| `secrets.encryption-key` | Secrets encryption key | none | `SECRETS_ENCRYPTION_KEY` is present and a valid 32-byte key, via the assertion bootstrap uses. | pass: valid. fail: missing or malformed (the error describes the key's shape, never its bytes). |

#### auth

| Id | Label | `dependsOn` | What it verifies | Rules |
|---|---|---|---|---|
| `auth.jwt-secret` | JWT signing secret | none | `JWT_SECRET` is a real value. | pass: set and at least 32 characters (length in `data`). warn: shorter than 32. fail: unset or the publicly known fallback value. |
| `auth.providers` | Sign-in providers | none | At least one sign-in provider is enabled, from the list the sign-in page renders. | pass: names the providers. fail: none enabled. |
| `auth.initial-admin` | Administrator access | `db.connection` | Somebody can administer the deployment. Settings page `/admin/settings/users`. | pass: at least one active Admin and `INITIAL_ADMIN_EMAIL` set. warn: active admins but `INITIAL_ADMIN_EMAIL` unset. fail: no active user holds the Admin role. |

#### maintenance

| Id | Label | `dependsOn` | What it verifies | Rules |
|---|---|---|---|---|
| `maintenance.mode` | Maintenance mode | none | The deployment is in service, resolved fresh across the three layers. Settings page `/admin/settings/maintenance`. | pass: off. warn: a window is open (detail names which layer holds it; the remedy differs for the environment layer), or off but the saved setting could not be read. Never `fail`. |

#### storage

| Id | Label | `dependsOn` | What it verifies | Rules |
|---|---|---|---|---|
| `storage.config` | Object storage configuration | none | The active storage configuration is complete (fresh resolve). Settings page `/admin/settings/storage`. | pass: provider, bucket and region (never the credential). fail: fields missing (names them), or the configuration cannot be read (usually a wrong `SECRETS_ENCRYPTION_KEY`). |
| `storage.bucket` | Object storage reachability | `storage.config` | One `HeadObject` on the key `.doctor/read-only-probe-never-written`, which nothing ever writes. | pass: the store answered (latency in `data`). fail, each with its own remedy: endpoint unreachable, credential rejected, bucket missing, region mismatch, credential may not read the bucket, any other store error. |

**Known weakness of `storage.bucket`.** `StorageProvider.exists()` turns a `NotFound` answer into `false`, and the check treats any answer that is not an error as a pass. A `HeadObject` on a missing key answers a bodyless `404` whether or not the bucket exists, so the AWS SDK cannot name the cause. A pass therefore means "the store answered without refusing us", not "uploads will work". Missing-bucket detection fires only when the store returns a body that names `NoSuchBucket`. Every failure remedy points at the settings page's "Test connection", which round-trips a real probe object, for a full diagnosis.

#### email

| Id | Label | `dependsOn` | What it verifies | Rules |
|---|---|---|---|---|
| `email.config` | Email delivery | none | The email settings are complete, read from the admin view. Never sends. Settings page `/admin/settings/email`. | pass: SMTP or SES complete and switched on. warn: no provider chosen (notifications are in-app only), or configured but switched off. fail: the stored row does not validate, or fields missing (from address, SMTP host, an SMTP username with no stored password, SES region, an SES key id with no stored secret). |

#### push

| Id | Label | `dependsOn` | What it verifies | Rules |
|---|---|---|---|---|
| `push.vapid` | Web Push keys | none | The active VAPID configuration can sign a send: the public key is a valid P-256 point, the private key derives it, the subject is a `mailto:` or `https://` URL. Never sends. Settings page `/admin/settings/push`. | pass: valid pair and subject. warn: Web Push not configured or switched off. fail: any of the three problems (detail lists them, never a key). |

#### ai

| Id | Label | `dependsOn` | What it verifies | Rules |
|---|---|---|---|---|
| `ai.enabled` | AI platform | none | Whether the AI platform is switched on (fresh resolve). Settings page `/admin/settings/ai`. | pass: on. skip: off (intentional). Never `warn` or `fail`. |
| `ai.providers` | AI providers and keys | `ai.enabled` | Every enabled provider can serve a call, from key status only, with no model call. | pass: at least one enabled provider and no problem; detail says whether each uses an org key, users' own keys or needs none. fail: AI on but no provider enabled, an enabled provider with no adapter in this build, or no org key while the key policy is `byok_with_org_fallback`. A missing org key under plain `byok` is expected and passes. |
| `ai.feature-assignments` | AI feature model assignments | `ai.enabled` | Every AI feature resolves to an enabled, capable model that a call can reach, from the admin assignments view (`AiAssignmentsAdminService.describe()`) and key status only (`hasOrgKey`, which never decrypts). The features are the three photo features (`gym_scan`, `workout_prefill`, `body_metric_reading`) and the four training roles (`training.researcher`, `training.planner`, `training.critic`, `training.evaluator`). Settings page `/admin/settings/ai/assignments`. | pass: every feature has a model; detail counts how many are assigned, served by the default or auto-picked, and names features waiting on web search. fail: a feature has no enabled, capable model (every call for it fails), or, under `byok_with_org_fallback`, a feature has no capable model on a provider that serves a caller without their own key (org key stored, or provider marked keyless). warn: a stored feature assignment or default is no longer enabled or capable (calls fall through to another model). A feature that needs web search while it is switched off is only counted, never a problem. Under plain `byok` a provider without an org key is expected. `data`: `features`, `assigned`, `viaDefault`, `auto`, `noCapableModel`, `noOrgReachableModel`, `staleAssignments`, `waitingOnWebSearch`, `keyPolicy`. |
| `ai.web-search` | Web search tool | `ai.enabled` | The hosted web-search switch and the models that would use it agree, from the AI policy, the adapters' declared ports (`AiProviderRegistry.supports(id, 'hosted_tools')`) and the assignments view. No model is called and no search runs. Settings page `/admin/settings/ai`. | skip: web search is off (an operator's choice; it is off on a fresh deployment). pass: on and no feature uses it, or on and every web-search feature resolves to a model that can search. warn: on but no enabled provider drives hosted tools (OpenAI does; Azure OpenAI, Gemini and Anthropic map none), a web-search feature has no eligible model, or its stored assignment cannot search. Never `fail`. `data`: `webSearch`, `features`, `hostedToolProviders`. |

**The two AI assignment checks are evopath's own.** They live beside the assignments module in `apps/api/src/ai/assignments/doctor/`, and share one pure helper, `effective-assignment.ts`, that answers the deployment-wide half of the model-resolution precedence without a user: the feature's own assignment, else the default model when it is eligible for the feature, else an auto pick among the eligible models, else nothing.

- **Training roles are AI features.** The training agents' models are covered by `ai.feature-assignments`, because `TrainingModelResolver` resolves the feature `training.<role>`. There is no separate training-model check. See [ai-training-plans.md](ai-training-plans.md).
- **Web search is split out on purpose.** A training feature that needs web search while it is off is counted by `ai.feature-assignments` and judged by `ai.web-search`, so one switch never reports twice. Enabling it is [the training runbook](../runbooks/ai-training-plans.md#2-enable-web-search).
- **Photos have no AI-specific storage check.** Gym scan and photo intake uploads depend on object storage, which the general `storage.config` and `storage.bucket` checks cover.

#### jobs

| Id | Label | `dependsOn` | What it verifies | Rules |
|---|---|---|---|---|
| `jobs.worker` | Background job worker | none | This process's worker configuration, through the shared `parseWorkerMode` and `resolveWorkerConcurrency` parsers. Settings page `/admin/settings/jobs`. | pass: mode `all` or `system` with at least one slot. warn: unrecognised `JOBS_WORKER_MODE` (falls back to `all`), mode `off` (jobs queue until another executor claims them), or concurrency of zero or less. Never `fail`. |
| `jobs.backlog` | Job queue backlog | `db.connection` | The queue is draining, using the stats and the reaper's own stuck predicate plus two reads. | pass: counts of pending, running and failed in the last 24 h. warn: jobs running past the stuck threshold with no live lease, or the oldest due pending job has waited over 15 minutes. Never `fail`. |

#### nodes

| Id | Label | `dependsOn` | What it verifies | Rules |
|---|---|---|---|---|
| `nodes.fleet` | Worker node fleet | `db.connection` | Every enrolled, non-disabled node is heartbeating, from the admin view's derived health. Settings page `/admin/settings/workers`. | pass: no nodes enrolled (the API runs every job itself) or every active node healthy. warn: a stale or offline active node (detail names up to five). A disabled node is excluded from the verdict. Never `fail`. |

#### backup

| Id | Label | `dependsOn` | What it verifies | Rules |
|---|---|---|---|---|
| `backup.schedule` | Database backups | `db.connection` | Backups are scheduled and recently succeeded, from the config and the latest runs. Settings page `/admin/settings/db-backup`. | pass: enabled and the last success is at most 48 h old. fail: the latest terminal run failed or went stale (error carried, cut at 300 characters). warn: schedule off, enabled but never completed, or last success over 48 h old. |
| `backup.pg-client` | PostgreSQL client (`pg_dump`) | none | This process's `pg_dump` can dump the server: runs `pg_dump --version` and reads `server_version_num`. Timeout 12 s. | pass: client can dump the server. warn: `pg_dump` not found or silent (backups cannot run on this API; a worker node may do them). fail: client older than the server, or older than the pinned major (17). Remedies link [the client-version runbook](../runbooks/postgres-client-version.md). |

#### telemetry

The five-check chain runs `export`, `connection`, `reachable`, `tables`, `freshness`; `stack` stands alone.

| Id | Label | `dependsOn` | What it verifies | Rules |
|---|---|---|---|---|
| `telemetry.export` | Telemetry export | none | The three switches that must all be on for this process to export: the `telemetry.enabled` setting, `OTEL_ENABLED`, and the runtime export gate. | skip: collection off (intentional, and the rest of the chain skips with it). fail: collection on but `OTEL_ENABLED` is not `true`. warn: the export gate is closed (no usable GreptimeDB connection yet). pass: exporting (endpoint shown without credentials). |
| `telemetry.connection` | GreptimeDB connection | `telemetry.export` | A reader connection is configured, from the in-memory snapshot. No network. | pass: `host:port/database (source)`. fail: no reader connection configured. |
| `telemetry.reachable` | GreptimeDB reachability | `telemetry.connection` | GreptimeDB answers `SELECT version()` as the reader, through `GreptimeClient.ping()`. Timeout 7 s. | pass: latency and version. fail: no answer. |
| `telemetry.tables` | Telemetry tables and retention | `telemetry.reachable` | Both the traces and logs tables exist, and a retention (TTL) is set. Timeout 12 s. | pass: both present with a finite TTL. fail: store unreadable, or a table missing (tables are created by the first export). warn: no TTL, or one that never expires. |
| `telemetry.freshness` | Telemetry data freshness | `telemetry.tables` | Data is actually arriving, from the dashboard's `lastDataSql` over the reader path (7-day lookback). Settings page `/admin/settings/telemetry/dashboard`. Timeout 7 s. | pass: both the newest trace and the newest log are within the threshold. warn: either side older than the threshold, or absent for 7 days. fail: neither arrived in 7 days. |
| `telemetry.stack` | Telemetry containers | none | On a VPS deploy, the containers the stack agent manages are running, through `GET /v1/telemetry` on the agent. Never a deploy. Timeout 7 s. | skip: no stack agent (not a VPS deploy). pass: every container running. warn: a container stopped or unhealthy, none deployed, or the agent unavailable. fail: the agent refused this API's token. |

**`telemetry.freshness` uses the dashboard's threshold.** Its limit is `DASHBOARD_VERDICT_THRESHOLDS.noDataMinutes` (5 minutes), the same constant behind the dashboard's "no data" banner, so the two cannot disagree. It reads through `GreptimeClient.queryReader` rather than `TelemetryDashboardService.summary` because the summary writes a `telemetry:dashboard` audit row per read, which would break [§2.2](#22-the-read-only-rule).

**`telemetry.stack` is independent on purpose.** The containers are worth inspecting even when collection is off, so it does not depend on `telemetry.export`.

### 2.8 The web page

`/admin/settings/doctor` (`apps/web/src/pages/Admin/DoctorPage.tsx`) is a registry card and nothing else, per the [Settings UI Pattern](settings-ui.md): the last card of the Observability group in `ADMIN_SECTIONS`, permission `system_settings:read`, and a route in `App.tsx` wrapped in `RequirePermission` with the same string. It carries no `feature`, deliberately: it reports on AI and telemetry while they are off (as `skip`), which is when an administrator asks why a capability is missing.

| Part | Behaviour |
|---|---|
| Load | `useDoctor` runs `GET /api/admin/doctor` on mount; the answer may come from the 15 s cache. |
| **Run again** | Calls with `refresh=true`. The previous report stays on screen while it runs, and the button shows progress. |
| Verdict | One alert: "All checks passed", "No problems found; some checks were skipped", or "N problems need attention". |
| Counts | Chips for pass, warning, fail and skipped. |
| Problems only | A switch that filters each category to its `warn` and `fail` rows. |
| Categories | One accordion per category in `DOCTOR_CATEGORIES` order, with the worst status icon and "n/m passed". A category is expanded by default when it holds a `warn` or `fail`; manual toggles reset on **Run again**. A fork's category renders after the shipped ones, title-cased. |
| Rows | `CheckRow` shows the status icon, label, status chip, duration, detail, the remedy as its own sentence, the `error` verbatim in a wrapping `<pre>`, and an **Open settings** link to `settingsPath`. |

**A failing check is not a page error.** The endpoint answers `200` with a `fail` verdict and that renders as the verdict alert and the rows. The page-level error alert, with a **Retry** button, is reserved for a request that actually failed (`403`, network, a maintenance `503`). The `category` filter exists in the client (`services/doctor.ts`) but the page always requests every category.

### 2.9 Relation to `evopathcli deploy doctor`

The contract deliberately mirrors the CLI's pre-install doctor (`apps/cli/src/deploy/checks/types.ts`): the same four statuses, the same one-line `detail`, the same `remedy`, the same read-only rule and the same "never throws". An operator who has read one report can read the other.

| | `evopathcli deploy doctor` | Admin Doctor |
|---|---|---|
| Question | Is this **server** ready to install? | Is the **running deployment** healthy? |
| Runs | On the VPS, before and around install and update | Inside the API, on demand |
| Sees | Docker, Compose, git, node, disk, memory, ports, DNS, the proxy | Database, settings, credentials, queue, nodes, backups, telemetry |
| Needs | A shell on the host | `system_settings:read` in the web app or over HTTP |
| Extra | `required` vs `recommended` decides its exit code | No exit code; the verdict is a field |

They are counterparts, not duplicates. The CLI cannot see settings stored in the database, and the API cannot see the host. When the Doctor shows the API or its dependencies as unreachable, run `evopathcli deploy doctor` on the server.

## 3. Configuration and permissions

The Doctor has no settings, no environment variables and no database tables. The constants are in code: the 5000 ms default timeout and the 15 s cache TTL (`doctor.service.ts`), the thresholds inside each check (`DB_SLOW_LATENCY_MS`, `BACKUP_MAX_AGE_HOURS`, `JOBS_OLDEST_PENDING_WARN_MINUTES`, `JWT_MIN_SECRET_LENGTH`).

**Permission:** `system_settings:read`, the exact string `doctor.controller.ts` enforces and the `Doctor` card declares. The role matrix is in [ARCHITECTURE.md](../ARCHITECTURE.md#72-permission-matrix).

| Route | Purpose | Permission |
|---|---|---|
| `GET /api/admin/doctor` | Run every check (or one `category`) and return the report | `system_settings:read` |

| Query | Type | Effect |
|---|---|---|
| `category` | lowercase identifier | Report only that category; an unknown one returns an empty report |
| `refresh` | `true` or `false` | `true` bypasses the 15 s cache |

An unauthenticated caller gets `401`; Contributor and Viewer get `403`. The per-field response reference is the generated OpenAPI.

## 4. Extending it in a fork

**Add a check.** A check belongs to the module that owns the capability. Four steps:

1. Create `apps/api/src/<module>/doctor/<thing>.doctor-check.ts`. Put the judgement in a pure `decide…` function and keep `run()` to reads.
2. Choose an `id` (dotted, unique; a duplicate throws at boot), a `category` (a shipped one, or a new string for a capability of your own), a `settingsPath` if a page fixes it, and `dependsOn` for anything that makes the check meaningless when it fails.
3. Add the class to the owning module's `providers`. Do not import `DoctorModule`; it is global.
4. Write the spec next to it ([§5](#5-guardrails)).

```ts
import { Injectable, OnModuleInit } from '@nestjs/common';

import { DoctorCheck, DoctorCheckOutcome } from '../../doctor/doctor-check.interface';
import { DoctorCheckRegistry } from '../../doctor/doctor-check.registry';
import { ReportsService } from '../reports.service';

export const REPORTS_SETTINGS_PATH = '/admin/settings/reports';

/** Pure: judges the facts. Reports counts, never content. */
export function decideReportQuota(usage: { used: number; limit: number }): DoctorCheckOutcome {
  const data = { used: usage.used, limit: usage.limit };

  if (usage.used >= usage.limit) {
    return {
      status: 'fail',
      detail: `Report quota exhausted (${usage.used} of ${usage.limit})`,
      remedy: `Raise the quota at ${REPORTS_SETTINGS_PATH}, or purge old reports.`,
      data,
    };
  }

  if (usage.used >= usage.limit * 0.9) {
    return {
      status: 'warn',
      detail: `Report quota at ${usage.used} of ${usage.limit}`,
      remedy: `Raise the quota at ${REPORTS_SETTINGS_PATH} before it runs out.`,
      data,
    };
  }

  return { status: 'pass', detail: `${usage.used} of ${usage.limit} reports used`, data };
}

/** `reports` / `reports.quota` — the report quota has headroom. */
@Injectable()
export class ReportQuotaDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'reports.quota';
  readonly category = 'reports';
  readonly label = 'Report quota';
  readonly settingsPath = REPORTS_SETTINGS_PATH;
  readonly dependsOn = ['db.connection'];

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly reports: ReportsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    return decideReportQuota(await this.reports.usage());
  }
}
```

**A live example in this repository.** `ai.feature-assignments` and `ai.web-search` (`apps/api/src/ai/assignments/doctor/`) follow these steps: pure `decideFeatureAssignments` and `decideWebSearch` functions judge the facts, `run()` only reads, both depend on `ai.enabled`, and both are listed in `AiAssignmentsModule`'s providers.

**Rules to hold to.**

- Read only ([§2.2](#22-the-read-only-rule)). If the only way to prove the capability is to use it, the check verifies the configuration and its remedy points at the page's Test button.
- Use `skip`, not `warn`, for a capability the operator turned off, and say so in `detail`.
- Reuse the feature's own definition of "healthy" (an indicator, a resolver, a parser) rather than copying it, so the Doctor cannot disagree with the feature.
- Catch your own failures and return a `fail` with a real `detail`. Declare `timeoutMs` if a probe can legitimately exceed 5 s, and give the probe its own client-side bound.
- Never put a key, password, token or hint in `detail`, `error` or `data`.

**Add a category.** Use a new string as `category`. It sorts after the shipped ones and the web page renders it title-cased. To give it a display name or position, add it to `DOCTOR_CATEGORIES` in `doctor-check.interface.ts` (the API sort order) and to `DOCTOR_CATEGORIES` in `DoctorPage.tsx` (the labels and order).

**Add a web surface.** None is needed: the page renders whatever the API returns.

## 5. Guardrails

| Invariant | Test |
|---|---|
| Duplicate ids throw; registration order; `list()` returns a copy | `apps/api/src/doctor/doctor-check.registry.spec.ts` |
| Parallel start, dependency waves, `skip` on a failed or skipped dependency (transitively), `warn` does not block, unknown dependency, cycles, timeouts, throws become `fail`, remedy fallback, one-line detail, invalid status, verdict, category order, category filter, unknown category | `apps/api/src/doctor/doctor.service.spec.ts` |
| Cache: TTL, refresh replaces the entry, keyed by category, one shared in-flight run | `apps/api/src/doctor/doctor.service.spec.ts` (`cache`) |
| Permission is exactly `system_settings:read` with no `doctor:read`; `401`, `403` for Viewer and Contributor; admin gets the `{ data, meta }` envelope; every row has the full shape and every `warn`/`fail` a remedy; category filter; `400` on a malformed `category` or `refresh`; the JWT secret and the encryption key never appear in the response | `apps/api/test/doctor/doctor.integration.spec.ts` |
| The two AI assignment checks: every `fail`/`warn`/`skip` branch of `decideFeatureAssignments` and `decideWebSearch`, and the deployment-wide effective assignment | `apps/api/src/ai/assignments/doctor/ai-feature-assignments.doctor-check.spec.ts`, `apps/api/src/ai/assignments/doctor/ai-web-search.doctor-check.spec.ts` |
| Each check: its verdict table, a real remedy on every `warn`/`fail`, that it depends on what it says, that `run()` reads through the intended service (and, where it matters, does not send or audit), that it registers itself, and that no secret is echoed | `apps/api/src/<module>/doctor/*.doctor-check*.spec.ts` (auth, core, maintenance, storage, email, push, ai, jobs, nodes, backup, telemetry; the AI ones sit under `ai/config/doctor/` and `ai/assignments/doctor/`) |
| Card is the last Observability card, carries exactly `system_settings:read`, no `feature` and no `alwaysShow`, is visible while AI and telemetry are off, hidden from a Viewer, and resolves its own title | `apps/web/src/__tests__/config/settingsRegistry.test.ts` |
| Page: title matches its card, loading skeleton, request error with retry, mixed report (verdict, counts, ordered sections, remedy, error, settings link), all-pass, Problems only, Run again sends `refresh=true`, phone width, redirect without `system_settings:read`, category labels | `apps/web/src/__tests__/pages/Admin/DoctorPage.test.tsx` |
| Hook: loads on mount without refresh, a failing verdict is data rather than an error, `403` message, network fallback message, `rerun` sends `refresh=true` and clears a previous error | `apps/web/src/__tests__/hooks/useDoctor.test.ts` |

The read-only rule has no single tripwire suite that scans every check for calls to the test services. It is held by each check's spec (which asserts what `run()` reads) and by review; a new check's spec is where a reviewer looks for it.

## 6. Design decisions

- **Explicit self-registration, not discovery.** A decorator scan hides "why does this run?" and lets a check that was never wired up look identical to one that does not exist. One `register(this)` line is grep-able and shows up in a diff ([§2.3](#23-the-registry)).
- **Duplicate ids throw instead of overwriting.** The job registry lets a fork shadow a persisted `type`. A check id is only a line in a report, so a collision is always a mistake, and overwriting would silently hide the check its author thought they had added.
- **`skip` is its own status.** Folding "AI is off" into `pass` claims something was verified; folding it into `warn` makes a healthy deployment read amber forever. `skip` ranks between the two, so an all-skip report is not green and a report with only intentional skips is not amber.
- **`system_settings:read`, not a new permission.** The report describes configuration, which is the blast radius `system_settings:read` already covers, and every check is read-only, so there is no new capability to grant. A `doctor:read` would protect nothing more and would need a migration, a seed row and a role decision in every fork. `system_settings:write` is not required: running the Doctor changes nothing.
- **Admin-only, not part of `/api/health`.** Health endpoints are public and reachable during maintenance, so orchestrators and load balancers can use them. The Doctor exposes configuration (bucket and endpoint names, admin counts, hosts) and performs network I/O against every dependency, which is neither safe to expose nor cheap enough to answer a probe. Keeping them apart also means a slow storage endpoint can never make the readiness probe fail.
- **Not reachable during maintenance unless admins are allowed.** It probes dependencies a window is usually changing. Reachable-by-default would put network I/O behind the one route set that is meant to stay minimal. The default `allowAdmins: true` already lets an administrator in ([§2.6](#26-access-and-maintenance-mode)).
- **Read-only, with weaker storage and AI verdicts as the price.** Proving uploads work means writing an object; proving a provider works means spending tokens. Those are the Test buttons' jobs. The Doctor says "configured, and the store answered" and sends the operator to the full test, which is why `storage.bucket` has a documented blind spot ([§2.7](#27-check-inventory)).
- **Always `200`.** A `503` from a diagnostic withholds the list of what is wrong, exactly when it is wanted.
- **In-process cache, not a stored report.** Fifteen seconds is long enough that a polling page or two administrators do not multiply the probes, and short enough that "Run again" is rarely needed. A stored report would be stale by the time anyone read it.
- **Dependencies skip rather than cascade failures.** "Bucket unreachable" beneath "storage not configured" is noise and would only time out. `skip` names the cause in its detail and keeps the real problem at the top.

## 7. Verification

```bash
npm test --workspace=api -- doctor
npm run test:run --workspace=web -- Doctor
npm run typecheck --workspace=api
npm run typecheck --workspace=web
```

By hand, with the app running and signed in as an Admin:

1. Open `/admin/settings` and choose **Doctor** (Observability group). The page loads and shows a verdict.
2. Set `JOBS_WORKER_MODE=off` for the `api` container and restart it. **Run again** shows `jobs.worker` as `warn` with its remedy. Restore the value afterwards.
3. Switch AI off at `/admin/settings/ai`. **Run again** shows `ai.enabled` as `skip` and `ai.providers`, `ai.feature-assignments` and `ai.web-search` as `skip` (`Skipped: AI platform did not pass`), and the AI category is not amber.
4. With a bearer token: `curl -H "Authorization: Bearer $TOKEN" "http://localhost:3535/api/admin/doctor?category=core&refresh=true"` returns only `core` rows.
5. A second call within 15 s without `refresh` returns the same `generatedAt`.
6. As a Viewer, the same call answers `403`.

## History

- #182 ported the admin Doctor into this repository and added `ai.feature-assignments` and `ai.web-search`.
- #634 added the admin Doctor: the check contract, registry, service and `GET /api/admin/doctor`, the checks in each owning module, and the `/admin/settings/doctor` page and card.
