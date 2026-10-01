# Telemetry (GreptimeDB + Telemetry Explorer)

> **Status:** shipped · **Code:** `apps/api/src/telemetry/`, `apps/api/src/telemetry/connection/`, `apps/api/src/telemetry/stack/`, `apps/api/src/telemetry/dashboard/`, `apps/stack-agent/`, `apps/api/src/common/otel/telemetry-gate.ts`, `apps/web/src/pages/Admin/TelemetrySettingsPage.tsx`, `TelemetryExplorerPage.tsx`, `TelemetryDashboardPage.tsx` · **API:** `/api/telemetry/config`, `/api/admin/telemetry/*`, `/api/admin/telemetry/connection*`, `/api/admin/telemetry/stack*`, `/api/admin/telemetry/dashboard/*` (see `/api/docs`) · **Admin UI:** `/admin/settings/telemetry`, `/admin/settings/telemetry/explorer`, `/admin/settings/telemetry/dashboard` · **Runbook:** [telemetry.md](../runbooks/telemetry.md)

This is a two-container overlay — an OTel Collector in front of a GreptimeDB
standalone instance — replacing the earlier Uptrace/ClickHouse/Redis stack.
Admins query telemetry with SQL, export the results, and ask an AI assistant
about them. Traces, logs and metrics live in GreptimeDB alone; nothing is
written to the application's own PostgreSQL database (the collector only
reads its statistics views).

## Decision record

### Options considered

| Option | Containers | OTLP ingest | Retention | SQL + read-only user | Maturity | License |
|---|---|---|---|---|---|---|
| Uptrace (today) | Uptrace + ClickHouse + Redis (3) | Native | ClickHouse TTL, per table | ClickHouse SQL; no built-in read-only role | Mature | BSL (Uptrace), Apache-2.0 (ClickHouse) |
| ClickHouse + collector | Collector + ClickHouse (2) | Via `clickhouseexporter` | `TTL` per table | Full SQL; `READONLY` user profile | Mature, best operational guardrails | Apache-2.0 |
| DuckDB + Parquet | Collector + a writer process (2+) | No mature OTLP→Parquet path | File lifecycle, manual | DuckDB SQL over Parquet; no server, no user model | Early-stage | MIT |
| OpenObserve | OpenObserve (1) | Native | Built-in retention | Its own query language plus a full UI | Mature | AGPL-3.0 |
| SQLite | Collector + SQLite file (2) | No collector exporter | Manual | SQL; single writer, no server-side user model | Mature as a library, not as a telemetry store | Public domain |
| **GreptimeDB** | **Collector + GreptimeDB standalone (2)** | **Native (OTLP/HTTP, protobuf)** | **Database-level `TTL`, inherited by tables** | **Postgres wire protocol; built-in read-only user** | **Maturing (v1.2.1 tested)** | **Apache-2.0** |

### Decision

GreptimeDB is the choice. It ingests OTLP natively, needs only one container
beside the collector, speaks the PostgreSQL wire protocol (so the API reuses
`pg`, the client already in the dependency tree, instead of adding a new
driver), and ships a database-level `TTL` and built-in read-only users out of
the box, so the read-only query surface and the retention policy need no
application-level enforcement. It is Apache-2.0, with no AGPL or BSL
obligation on this repository.

### Rejected alternatives

- **ClickHouse + collector.** Kept as the fallback if GreptimeDB proves
  unworkable in practice: it has the best operational guardrails of any
  option (mature `READONLY` profiles, well-understood `TTL`), but it is
  heavier to run (roughly 1–2 GB RAM once tuned) for a template whose default
  path should stay light, and it does not reduce the container count versus
  GreptimeDB.
- **DuckDB + Parquet.** No mature OTLP→Parquet ingest path exists today:
  `duckdb-otlp`-style writers are early-stage with no write-ahead log, and the
  collector's own `fileexporter` is alpha and only emits JSON or raw proto,
  not Parquet. A workable pipeline would also need its own small-files
  compaction job, which is infrastructure this template would have to own.
- **OpenObserve.** AGPL-3.0, which this template avoids taking on as a
  dependency, and it ships a full UI that would duplicate the Telemetry
  Explorer this project wants to own.
- **SQLite.** Single-writer, and no collector exporter accepts OTLP into it
  directly; every option built on it needs a bespoke ingest process.

## Spike findings

Verified live on 2026-09-27 against `greptime/greptimedb:v1.2.1`
(standalone) and `otel/opentelemetry-collector-contrib:0.145.0`.

### Versions

| Component | Version | Note |
|---|---|---|
| GreptimeDB | v1.2.1 | Standalone mode |
| OTel Collector | collector-contrib 0.145.0 | |
| `@opentelemetry/sdk-logs`, `@opentelemetry/exporter-logs-otlp-http` | 0.221.x / 0.222.0 | Pin `^0.221.0` to match the existing `@opentelemetry/sdk-node ^0.221.0` |
| `@uiw/react-codemirror`, `@codemirror/lang-sql` | 4.25.x / 6.10.x | Web SQL editor for the Telemetry Explorer |
| `pg` (node-postgres) | already in the API's dependencies | Reused for the Postgres wire protocol connection |

### Starting GreptimeDB

Standalone start command, tested:

```
standalone start --http-addr 0.0.0.0:4000 --rpc-bind-addr 0.0.0.0:4001 \
  --mysql-addr 0.0.0.0:4002 --postgres-addr 0.0.0.0:4003 \
  --user-provider='static_user_provider:cmd:admin=<pw>,writer=<pw>,reader:readonly=<pw>'
```

- `GET /health` on port 4000 returns `{}` with HTTP 200; use it as the
  container healthcheck.
- GreptimeDB otherwise phones home for its own usage telemetry, which logs a
  TLS error in a network-restricted environment. Set
  `GREPTIMEDB_STANDALONE__ENABLE_TELEMETRY=false` to disable it (verified:
  the running config then shows `enable_telemetry: false`).
- Data is written under `/greptimedb_data`; that path is where the named
  volume mounts.

### Ingest: collector to GreptimeDB

- GreptimeDB's OTLP endpoint accepts **protobuf only**. The collector's
  `otlphttp` exporter already sends protobuf, so no extra configuration is
  needed on that side.
- Exporter endpoint: `http://greptimedb:4000/v1/otlp`, with headers
  `Authorization: Basic base64(writer:pw)` and
  `X-Greptime-DB-Name: public`.
- **Traces need an additional header**, `x-greptime-pipeline-name:
  greptime_trace_v1`; without it GreptimeDB answers HTTP 400. Traces
  therefore need their own exporter (`otlphttp/greptime_traces`) carrying
  that header; logs and metrics share a second exporter
  (`otlphttp/greptime`) with no pipeline header.
- Basic auth is done through the collector's `basicauth/greptime` extension
  (`client_auth: {username: ${env:GREPTIME_WRITER_USER}, password:
  ${env:GREPTIME_WRITER_PASSWORD}}`), listed in `service.extensions` and
  referenced as `auth: {authenticator: basicauth/greptime}` on both
  exporters.
- Redaction works ahead of ingest: an `attributes` processor with `action:
  delete` on `http.request.header.authorization` stops that column from
  ever being created.

### Tables and column naming

Tables are created on first write, with no schema migration step:

- **`opentelemetry_traces`**: `timestamp` (`TIMESTAMP(9)`, the time index),
  `timestamp_end`, `duration_nano` (`UInt64`), `parent_span_id`, `trace_id`,
  `span_id`, `span_kind` (e.g. `SPAN_KIND_SERVER`), `span_name`,
  `span_status_code` (`STATUS_CODE_ERROR` / `STATUS_CODE_OK` /
  `STATUS_CODE_UNSET`), `span_status_message`, `trace_state`, `scope_name`,
  `scope_version`, `service_name` (tag), `span_events` (`Json`),
  `span_links` (`Json`). Two helper tables,
  `opentelemetry_traces_services` and `opentelemetry_traces_operations`,
  are created alongside it.
- **`opentelemetry_logs`**: `timestamp`, `trace_id`, `span_id`,
  `severity_text`, `severity_number`, `body` (full-text indexed),
  `log_attributes` (`Json`), `trace_flags`, `scope_name`, `scope_version`,
  `scope_attributes` (`Json`), `resource_attributes` (`Json`),
  `resource_schema_url`.
- **Metrics** land in Prometheus-style tables, one per metric name, created
  on first export (not exercised in the spike).
- **Span and resource attributes are flattened into their own columns**,
  named `span_attributes.<key>` and `resource_attributes.<key>` (for
  example `span_attributes.http.route`). New columns are created
  dynamically as new attribute keys arrive. Because the column name
  contains dots, **SQL referencing it must double-quote the identifier**,
  e.g. `SELECT "span_attributes.http.route" FROM opentelemetry_traces`.

### PostgreSQL wire protocol (port 4003) with `pg`

- `SELECT version()` returns `PostgreSQL 16.3 GreptimeDB 1.2.1`; connecting
  to database `public` works with an ordinary `pg` client.
- Subquery wrapping is syntactically accepted for arbitrary user SQL,
  including a `WITH`/CTE inside the subquery: `SELECT * FROM (<user sql>) AS
  q LIMIT n`. On GreptimeDB v1.2.1 that wrapper, and a CTE wrapper,
  deterministically dropped the inner `ORDER BY`, including for `UNION ALL
  … ORDER BY`, so the row cap cannot be applied this way.
- **Bind parameters fail.** `$1`-style placeholders error with `Placeholder
  '$1' was not provided a value`; parameterised queries cannot be used.
  Identifiers (e.g. a table name for `describe_table`) must instead be
  checked against the table list read from `information_schema.tables`,
  then quoted by hand (`` `"` + name.replace(/"/g,'""') + `"` ``).
- **Multi-statement strings execute every statement.** The simple protocol
  returns an array of results for a semicolon-separated string. Any API
  built on this connection must reject a query containing more than one
  statement itself; GreptimeDB will not refuse it.
- **Type OIDs** arrive in `fields[].dataTypeID`: `1043` = varchar, `20` =
  int8, `1700` = numeric (a `UInt64` column reports as numeric), plus the
  timestamp OIDs. Values for int8 and numeric columns come back as strings,
  which must be kept as strings through to JSON so large values (byte
  counts, durations) never lose precision.
- **Schema discovery** works for the read-only user via
  `information_schema.columns` (`table_name`, `column_name`, `data_type`)
  and `information_schema.tables` (`table_name`, `table_rows`).
- **`statement_timeout` cannot be used**: the read-only user gets `User is
  not authorized to perform this action` on `SET statement_timeout`, and
  passing it as a startup parameter is silently ignored (`SHOW
  statement_timeout` still reports `0ms`). Timeouts must therefore be
  enforced **client-side** — `pg`'s `query_timeout` option, or a
  `Promise.race`, followed by destroying the connection on timeout. Killing
  the query server-side (through the admin user) is a follow-up, not
  covered by this spike.

### Read-only user enforcement

The `reader:readonly` user can `SELECT`, `SHOW` and `DESCRIBE`, and can read
`information_schema`. It is refused, each with `User is not authorized to
perform this action`, on `INSERT`, `DROP`, `ALTER DATABASE` and `SET`. This
enforcement is server-side and needs no additional guard in the API beyond
using that role for every user-supplied query.

### Retention (TTL)

- `ALTER DATABASE public SET 'ttl'='7d'` works when run as the admin user;
  `SHOW CREATE DATABASE public` then reports `WITH(ttl = '7days')`.
- Existing tables inherit the database-level setting automatically: `SHOW
  CREATE TABLE opentelemetry_logs` also shows `ttl = '7days'`. One
  database-level `TTL` therefore covers every table, including ones a
  future OTLP export creates later. Accepted formats include `'7d'`,
  `'30d'` and `'365d'`.

### Export libraries

- **Parquet: `hyparquet-writer`** (0.16.x), chosen for being pure
  JavaScript with no WASM dependency and active maintenance.
  `parquetWriteBuffer({ columnData: [{ name, data: [], type:
  'STRING'|'DOUBLE'|'INT64'|'BOOLEAN'|'TIMESTAMP'|'JSON' }] })` returns an
  `ArrayBuffer`. Its output was verified readable by DuckDB, nulls
  included (`duckdb.sql("select * from 'x.parquet'")`). The package is
  **ESM-only**; from CJS NestJS code it must be loaded with `await
  import('hyparquet-writer')` (Node 24 also supports `require(esm)`), and
  Jest needs a mock or a `moduleNameMapper` entry for it.
- **XLSX: `exceljs` 4.4.0.** Its streaming `WorkbookWriter` supports writing
  directly to a stream, avoiding buffering a whole workbook in memory.

### Consequences for the design

- The API's telemetry query path must cap rows with a `LIMIT` added at the
  statement's own top level, never by wrapping it in a subquery (which drops
  the inner `ORDER BY`), and never as a parameterised `pg` query;
  identifiers that need interpolation must be validated against
  `information_schema` first, then quoted, never bound.
- The query endpoint must reject any input containing more than one SQL
  statement before sending it to GreptimeDB, since the wire protocol will
  otherwise execute all of them.
- Query timeouts are the API's responsibility (`pg`'s `query_timeout` plus
  connection teardown), not a setting pushed into GreptimeDB.
- Any UI or export code that lists span or resource attribute columns must
  double-quote the flattened `span_attributes.<key>` / column names, and
  must treat their set as dynamic (new attributes add new columns over
  time).
- Numeric values wide enough to touch `UInt64` (byte counts, nanosecond
  durations) must be carried as strings end-to-end, matching the existing
  `BigInt`-as-decimal-string convention used for `database_backup_runs`
  (see [database-backup.md](database-backup.md)).
- The collector configuration needs two OTLP exporters against GreptimeDB
  (one for traces, carrying the pipeline header; one shared by logs and
  metrics), both authenticated through a `basicauth` extension, not one
  shared exporter.
- Retention is a single `ALTER DATABASE … SET 'ttl'` operation run once
  (or on policy change), not a per-table setting the application must keep
  in sync.
- The read-only SQL role enforced by GreptimeDB itself is the trust
  boundary for the Telemetry Explorer's query surface; the API does not
  need to reimplement statement-type filtering on top of it, only the
  single-statement and timeout guards above.
- Export (Parquet, XLSX) is client-library work in the API process, not a
  GreptimeDB feature; both chosen libraries stream or return in-memory
  buffers small enough for typical query result sizes, consistent with the
  no-buffering discipline the backup engine already follows for larger
  transfers.

## 1. Architecture

```
API (OTel Node SDK)
  │ OTLP/HTTP, gated by telemetryGate (see §2)
  ▼
otel-collector                                          (infra/otel/otel-collector-config.yaml)
  │ memory_limiter → attributes/redact → batch
  │   redact drops: http.request.header.authorization, http.request.header.cookie,
  │                 http.response.header.set-cookie, url.query
  │ basicauth/greptime (GREPTIME_WRITER_USER/PASSWORD)
  ├─ traces  → otlphttp/greptime_traces  (adds x-greptime-pipeline-name: greptime_trace_v1)
  └─ logs, metrics → otlphttp/greptime
  │
  │ metrics/local pipeline: scraped by the collector itself (§11.2)
  │   hostmetrics       host CPU, memory, load, paging, disk, filesystem, network
  │                     via the read-only /hostfs bind mount (host.name from /etc/hostname)
  │   prometheus/self   the collector's own counters (127.0.0.1:8888) and a
  │                     keep-list of GreptimeDB's /metrics
  │   postgresql        the application's PostgreSQL, POSTGRES_HOST:PORT
  │                     (→ transform/postgresql_labels), read-only, every 30 s
  │                     source: `db` on app-network, or the shared `postgres` on devnet
  │   httpcheck         uptime, latency and TLS expiry of three URLs, every 30 s
  │   nginx             the edge's stub_status, internal :8081 listener, every 30 s
  ▼
GreptimeDB standalone v1.2.1                             (infra/compose/telemetry.compose.yml)
  HTTP :4000 (ingest, /health, /dashboard) · Postgres wire :4003
  ▲
  │ Postgres wire protocol, GreptimeClient (apps/api/src/telemetry/greptime/greptime.client.ts)
  │   reader pool  (GREPTIME_READER_*) — explorer, assistant, status
  │   admin pool   (GREPTIME_ADMIN_*)  — retention ALTER DATABASE, SHOW CREATE DATABASE
  ▼
API (TelemetryModule) ──► Admin browser (explorer, assistant, dashboard, settings)
```

The collector also **scrapes PostgreSQL itself** in the `metrics/local`
pipeline, every 30 s, with the `postgresql` receiver. The target is the server
and database the API uses (`POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`),
read from the statistics views as `POSTGRES_MONITOR_USER` (falling back to
`POSTGRES_USER`). The tables and how to read them are in
[§11.2](#112-data-sources-what-is-collected-and-why-no-docker-stats) and
[§11.3](#113-column-findings-verified-live-greptimedb-v121); setup is in the
[runbook](../runbooks/telemetry.md#82-postgresql-metrics).

It also probes uptime with the `httpcheck` receiver and reads nginx's
`stub_status` with the `nginx` receiver, in the same pipeline (§11.2, §11.3;
[runbook](../runbooks/telemetry.md#83-uptime-tls-and-edge-metrics)).

`TelemetryModule` (`apps/api/src/telemetry/telemetry.module.ts`) wires:

- `GreptimeClient` — the only connection to the store (§2).
- `TelemetrySettingsService` — the `telemetry` settings namespace, its 5 s
  cache, and the export gate (§2).
- `TelemetryStatusService` — `GET /api/admin/telemetry/status`.
- `TelemetryRetentionHandler` + `TelemetryRetentionTask` — the retention job
  and its daily cron (§4).
- `TelemetryQueryService`, `TelemetrySchemaService`, `TelemetryExportService`
  — the explorer (§5).
- `TelemetryAssistantService` — the AI assistant (§6), built on `AiModule`.
- `TelemetryDashboardService` — the fixed health dashboard (§11).

Five controllers, all tagged `Telemetry` in the OpenAPI document:
`TelemetryConfigController` (public feature flag), `TelemetryAdminController`
(policy + status), `TelemetryExplorerController` (query/schema/export),
`TelemetryAssistantController` (the SSE route) and
`TelemetryDashboardController` (§11).

The collector also scrapes the host it runs on and the telemetry pipeline
itself, in a separate `metrics/local` pipeline (§11.2, §11.3). Both pipelines
run `transform/promote_labels`, which copies `app.instance.id` and `host.name`
onto every data point so they become label columns on every metric table.

GreptimeDB creates tables on first write, with no migration step: typically
`opentelemetry_traces` (spans), `opentelemetry_logs` (log records), and one
table per exported metric. Span, resource and log attributes are flattened
into their own columns whose names contain dots (`"span_attributes.http
.route"`, `"resource_attributes.service.name"`), created dynamically as new
attribute keys arrive — see the spike findings above for the full column
inventory and quoting rule.

A queued job's spans belong to the trace of the request that enqueued it: the
job row stores the enqueuing `traceparent` (`jobs.trace_context`), and the
server worker's `job.process <type>` span is its child, so a request, the job it
queued and the job's own database and HTTP spans share one `trace_id` in
`opentelemetry_traces` (#132; [job-queue.md, Trace context](job-queue.md#trace-context)).
Worker nodes receive the same `traceparent` on claim. A node never exports
spans itself: it relays its job phases (`job.download`, `job.execute`,
`job.upload`, `job.submit`, `job.secret`) to `POST /api/nodes/{id}/telemetry`,
and the API re-emits each one through its own tracer as a child of the job's
stored context, with `node.id`/`node.name` from the authenticated path and
`telemetry.relay: node` marking it as reported rather than observed. Node spans
therefore land in the same trace as the request that queued the job, through
the same collector and gate. The relay's body is strict, bounded and
rate-limited; spans for jobs the node did not hold are dropped (#133;
[worker-nodes.md, Span relay](worker-nodes.md#span-relay)).

## 2. The two switches

Two independent controls decide whether telemetry data ever leaves this
process, documented in full in `apps/api/src/common/otel/telemetry-gate.ts`:

1. **`OTEL_ENABLED`** (environment, infra). Read once by
   `apps/api/src/instrumentation.ts` before Nest exists: whether the
   OpenTelemetry SDK is installed in this process at all. It cannot change
   without a restart — auto-instrumentation only patches modules required
   after `sdk.start()`. `telemetry.compose.yml` sets it to `true` on the
   `api` service.
2. **`telemetry.enabled`** (system setting, admin UI). Whether what the
   installed SDK produces is actually exported. An administrator flips it at
   runtime with no restart.

The SDK keeps running either way — spans are still created, log records
still correlated, metrics still aggregated — and the gated exporters
(`GatedSpanExporter`, `GatedLogRecordExporter`, `GatedPushMetricExporter`)
simply drop each batch while the gate is closed, acknowledged as success so
nothing retries or logs an export error for it. The gate is read at export
time, not at creation time, so a batch queued while closed and flushed after
the gate opens is still sent.

**The gate starts closed.** Nothing leaves the process until settings have
been read and an administrator's choice is known.

`TelemetrySettingsService.refreshGate()` sets the gate to
`telemetry.enabled && GreptimeClient.isConfigured()` — both conditions,
because with no GreptimeDB there is nowhere for the collector to write. It
runs once on boot and every `TELEMETRY_GATE_REFRESH_MS` (5 s) after, so the
instance that served a `PUT` flips its own gate immediately and every other
instance in a fleet converges within one interval. A failed settings read
leaves the gate at its last value rather than flipping it either way.

## 3. Settings

The `telemetry` system-settings namespace (`systemTelemetrySchema`,
`apps/api/src/common/schemas/settings.schema.ts`), read and written through
`TelemetrySettingsService`:

| Field | Type | Range | Default |
|---|---|---|---|
| `enabled` | boolean | — | `false` |
| `retentionDays` | integer | 1–3650 | `30` |
| `instanceId` | string or `null` | `^[a-z0-9][a-z0-9._-]{0,62}$` | `null` (→ `APP_SLUG`) |
| `query.maxRows` | integer | 1–100000 | `10000` |
| `query.timeoutSeconds` | integer | 1–120 | `30` |
| `assistant.enabled` | boolean | — | `false` |
| `assistant.provider` | string or `null` | — | `null` |
| `assistant.modelId` | string or `null` | — | `null` |
| `assistant.shareResults` | boolean | — | `true` |
| `assistant.maxResultRowsToModel` | integer | 1–100 | `100` |
| `assistant.maxSteps` | integer | 1–20 | `15` |

Everything ships off: a fresh deployment does not collect or retain
observability data nobody asked for merely because the namespace exists, the
same posture `databaseBackup.enabled` and `ai.enabled` take. `assistant` is a
second, narrower switch nested inside the namespace: `assistant.enabled`
answers "may an AI model be pointed at telemetry data", on top of `enabled`
answering "is telemetry collected at all". A compile-time check
(`TELEMETRY_SETTINGS_CARRIES_NO_SECRET`) fails the build if a field named
like a credential (`apiKey`, `password`, `token`, …) is ever added to this
namespace — the assistant's AI key is resolved through `AiKeyResolver`, per
call, and never stored here.

`GET`/`PUT /api/admin/telemetry/config` (`telemetry:read`/`telemetry:write`)
read and replace the namespace with the usual `If-Match` optimistic
concurrency. A successful `PUT` also enqueues a `telemetry.retention.apply`
job so a changed retention reaches GreptimeDB immediately rather than at the
next nightly run. `GET /api/telemetry/config` is the public feature flag
(`@Auth()`, no permission — any signed-in user, like `GET /api/ai/config`):
`available`, `enabled`, `assistantEnabled`, nothing else.

### The instance identifier

`instanceId` labels which deployment of the application produced a given
span, log record or metric batch — distinct from `service.name`
(`OTEL_SERVICE_NAME`, fixed per deployment at boot), which only says which
*program* produced it. Two forks of this template, or two environments of one
fork, can point at one shared telemetry store, and without an identity of
their own their data is indistinguishable. An administrator sets it at
`/admin/settings/telemetry`; `instanceId: null` (the default) resolves to
`APP_SLUG` (`apps/api/src/common/otel/instance-id.ts`), the slug of the
product name in `packages/shared/identity.json` — so a renamed fork reports
under its own name with no setting to touch, and only needs the override for
more than one deployment of the *same* fork sharing a store.

The response also carries `instanceIdDefault` (what `null` resolves to) and
`instanceIdEffective` (what is currently stamped), both read-only, so a form
can show what the default means without hardcoding it. `instanceId` is
optional on `PUT`: absent keeps the stored value, `null` resets to the
default, a string overrides it — the one field in this namespace that is not
part of the "full replace" contract (§ above), because it arrived after the
settings form did and an older client must not reset an administrator's
override merely by saving the page.

**Why export-time stamping, not the SDK resource.** `instrumentation.ts`
hands one `Resource` to `NodeSDK` before `sdk.start()`, and every span, log
record and metric collected afterward holds a reference to that same object —
it is immutable from then on, so a runtime-changeable identity cannot live
there. The gated exporters (`GatedSpanExporter`, `GatedLogRecordExporter`,
`GatedPushMetricExporter`, `apps/api/src/common/otel/telemetry-gate.ts`) are
already the one place every batch passes through on its way out, so they
re-label each batch with the current `instanceId` as they export it — a
shallow copy with a replaced `resource` for metrics, the equivalent for spans
and log records. `TelemetrySettingsService` pushes the resolved value with
`telemetryGate.setInstanceId()` at the same moments it pushes `setEnabled()`:
on boot, every refresh interval, and after a save — so a change reaches every
instance in a fleet within the same window as the export gate itself (§2),
with no restart, and applies starting with the next batch exported.

## 4. Retention

`telemetry.retention.apply` (`TelemetryRetentionHandler`,
`apps/api/src/telemetry/handlers/telemetry-retention.handler.ts`) runs one
statement:

```sql
ALTER DATABASE <GREPTIME_DB> SET 'ttl'='<retentionDays>d'
```

as the GreptimeDB admin user. One database-level TTL covers every telemetry
table, including per-metric and per-attribute tables GreptimeDB creates
later — tables inherit the database's TTL. GreptimeDB enforces it itself
during compaction; the job only states the policy, it deletes nothing
directly.

**The database name is deliberately unquoted.** GreptimeDB v1.2.1 resolves a
double-quoted name in `ALTER DATABASE` literally (`"public"` fails with
"Failed to find schema"), so the statement builder instead restricts the
name to a plain identifier (`^[A-Za-z_][A-Za-z0-9_]*$`) and refuses anything
else, checked again at the job even though `GREPTIME_DB` is already
validated at startup.

**Idempotent**: setting the TTL to the value it already has is a no-op on
the server, so a retry, a duplicate enqueue, or the daily re-assertion are
all harmless. The job is enqueued by every successful
`PUT /api/admin/telemetry/config` and by `TelemetryRetentionTask`
(`@Cron(EVERY_DAY_AT_4AM)`, enqueue-only per the queue-job rule) — daily
re-assertion matters because a fresh GreptimeDB volume starts with no TTL,
and the save-time enqueue may have raced a store that was briefly down.

Retention is **not gated on `telemetry.enabled`**: a deployment that
switched collection off still wants what it already collected to age out. A
deployment without GreptimeDB, or without `GREPTIME_ADMIN_USER`/
`GREPTIME_ADMIN_PASSWORD` configured, completes the job as a no-op with a
log line — a supported configuration, not a failure. The job is
**server-only, permanently**: no `nodeResultSchema`/`persistNodeResult`,
because the statement needs the GreptimeDB admin credential (CLAUDE.md queue
rule 3).

## 5. Explorer

Three routes, all `telemetry:query`, all on `TelemetryExplorerController`:

| Route | Purpose |
|---|---|
| `POST /api/admin/telemetry/query` | Run one read-only statement; returns columns, rows, `truncated` |
| `GET /api/admin/telemetry/schema` | Every table with its columns, row estimates and semantic types |
| `POST /api/admin/telemetry/export` | Run the same statement and return it as a file attachment |

`TelemetryQueryService.run` (`apps/api/src/telemetry/query/telemetry-query
.service.ts`) is the **one entry point** for caller-supplied SQL: the
explorer, the export and the assistant's `run_query` tool all come through
it, so all three get the same guard, bounds and audit trail.

**The SQL guard** (`apps/api/src/telemetry/query/sql-guard.ts`) is defence
in depth on top of GreptimeDB's own read-only user, which already refuses
`INSERT`/`DROP`/`ALTER`/`SET`. It is a small lexer, not a parser: it strips
comments outside quotes, then requires

- **exactly one statement** — GreptimeDB's simple query protocol executes
  every statement in a semicolon-separated string, so a caller-supplied
  second statement is refused here, before it is ever sent; and
- **one of `SELECT`, `WITH`, `SHOW`, `DESCRIBE`/`DESC`, `EXPLAIN`** (not
  `EXPLAIN ANALYZE`, which runs the whole query).

Each `SELECT`/`WITH` is capped at `maxRows + 1` rows by a `LIMIT` at the
statement's top level (parenthesis depth 0, found by the guard's quote- and
comment-aware scan), never by wrapping it as `SELECT * FROM (<statement>)
LIMIT n`. On GreptimeDB v1.2.1 that wrapper, and a CTE wrapper,
deterministically dropped the inner `ORDER BY`, including for `UNION ALL …
ORDER BY`. `applyRowCap` picks one of four strategies. `appended`: with no
top-level `LIMIT`, ` LIMIT <cap>` is added at the end (or just before a bare
top-level `OFFSET`), so it applies after the statement's own `ORDER BY` and
to a whole `UNION`. `clamped`: a top-level `LIMIT <integer>` at or above the
cap has its number replaced by the cap, keeping any `OFFSET` in either
order. `kept`: a smaller literal `LIMIT` is sent unchanged. `client-only`:
`LIMIT ALL`, a non-literal `LIMIT`, `FETCH FIRST`, and SHOW/DESCRIBE/EXPLAIN
are sent unchanged. In every case the service slices the result to
`maxRows` and sets `truncated` when the server returned more, so for
client-only statements the query timeout is the only bound on rows held in
memory before the slice.

**Limits**: the row cap is the caller's `maxRows` (request body, ≤
`telemetry.query.maxRows`), clamped to that setting, which is also the
ceiling and the default; the statement text itself is capped at
`TELEMETRY_SQL_MAX_LENGTH` (20,000 characters). **Timeout**:
`telemetry.query.timeoutSeconds` (1–120 s) is enforced **client-side** in
`GreptimeClient` — GreptimeDB's read-only user cannot `SET
statement_timeout`, and the startup parameter is silently ignored — by
racing the query against a timer and, on timeout, destroying the pooled
connection (`release(true)`) rather than returning a socket with a query
still in flight to the next caller.

**Truncation and JSON-safe types**: `int8`/`numeric` columns arrive from
GreptimeDB as strings (a `UInt64` reports as `numeric`) and stay strings end
to end, so no value loses precision going through JSON. Timestamp columns
are also kept as the server's own text, which **carries microseconds**, not
GreptimeDB's native nanosecond precision — to get nanoseconds, `CAST(ts AS
STRING) AS ts_ns` in the query itself. `toJsonSafe`
(`telemetry-query.service.ts`) additionally turns a `Buffer`/`Uint8Array`
into base64, a `bigint` into a decimal string, a non-finite number into its
name, and recurses through arrays and plain objects.

**Export formats** (`TelemetryExportService`,
`apps/api/src/telemetry/export/telemetry-export.service.ts`), run through
the same guard, bounds and audit as the query endpoint with the row cap at
the full `telemetry.query.maxRows`:

| Format | Notes |
|---|---|
| `csv` | RFC 4180, CRLF, UTF-8 with a BOM. **CSV injection guard**: a text cell starting with `=`, `+`, `-`, `@`, tab or CR is prefixed with `'` — telemetry rows are attacker-reachable (routes, user agents, log bodies), and this is the classic way to turn one into a spreadsheet formula. Numeric columns are left alone. |
| `ndjson` | One JSON object per row; a repeated column name gets `_2`, `_3`, … so no value is silently dropped. |
| `xlsx` | One sheet (`results`), bold header; numbers as numbers where exact, else text (`exceljs` never treats a string cell as a formula, so no injection concern there). |
| `parquet` | `hyparquet-writer` (pure JS, ESM-only, loaded dynamically). Numeric columns become `DOUBLE` when every value is exact as a double, else `STRING`; timestamps stay `STRING` (the server's own text); everything else is `STRING`. |

Both the query and the export run **in memory, bounded** by the row cap —
synchronous work over at most 100,000 rows — and complete inside the request,
which is why neither is a queue job (CLAUDE.md's "every long-running
activity is a queue job" exempts work that cannot outlive the request that
started it).

**Error reasons** (`details.reason` on every failure, `apps/api/src
/telemetry/query/telemetry-query.errors.ts`):

| Reason | Status | Meaning |
|---|---|---|
| `TELEMETRY_NOT_CONFIGURED` | 503 | No telemetry store in this deployment (the overlay is not deployed) |
| `TELEMETRY_UNREACHABLE` | 503 | Configured, but the store did not answer |
| `TELEMETRY_DISABLED` | 409 | `telemetry.enabled` is off |
| `TELEMETRY_QUERY_REJECTED` | 400 | The SQL guard refused the statement |
| `TELEMETRY_QUERY_FAILED` | 400 | GreptimeDB refused or failed the statement (syntax, unknown column, …) |
| `TELEMETRY_QUERY_TIMEOUT` | 504 | The statement outran `telemetry.query.timeoutSeconds` |
| `TELEMETRY_ASSISTANT_DISABLED` | 409 | `telemetry.assistant.enabled` is off |
| `TELEMETRY_ASSISTANT_NOT_CONFIGURED` | 409 | No `assistant.provider`/`assistant.modelId` chosen |
| `TELEMETRY_DASHBOARD_BAD_FILTER` | 400 | `service`/`instance` is not among the values `/filters` reports for the window ([§11](#11-dashboard)) |
| `TELEMETRY_DASHBOARD_BAD_CURSOR` | 400 | The events `cursor` is malformed ([§11](#11-dashboard)) |

`TelemetrySchemaService` caches its two `information_schema` reads for
`TELEMETRY_SCHEMA_CACHE_MS` (30 s), shared by concurrent callers, and also
backs the assistant's `list_tables`/`describe_table` tools.

## 6. AI assistant

`POST /api/admin/telemetry/assistant/stream` (`telemetry:query` **and**
`ai:use` — `@Auth()` on a controller is all-of — plus `AiEnabledGuard`
answering 403 `AI_DISABLED` while the AI platform is off) runs a
troubleshooting agent over the telemetry store: the model investigates a
question about this application's behaviour (errors, slowness, "is
anything wrong?", or simply "write me a query") and answers with a
structured report, streamed as `text/event-stream` frames: `step` (one per
tool call), `answer` (`{ sql, explanation, report }`), `error`, and always a
final `done`. It behaves like `POST /api/ai/responses/stream`
(preconditions run and can fail as ordinary JSON errors before anything is
written; the reply hijacks to SSE only once committed) but lives under
`/api/admin/telemetry`, not `/api/ai`, so the AI kill-switch/RBAC tripwire
suites that enumerate `/api/ai*` do not cover it — the guard is applied
explicitly and pinned by this controller's own spec.

**Method.** `TELEMETRY_ASSISTANT_INSTRUCTIONS` (`buildTelemetryAssistantInstructions`,
which bakes in the turn's step budget) walks the model through an
investigation, not a lookup: orient (`get_app_context`, once), baseline
(`health_overview`, including its resource saturation section), hypothesise
from the question and the baseline (an application fault, or a resource
running out), drill down (`run_query`, `list_tables`, `describe_table`;
`metrics_overview(group)` when a resource is implicated, `compare_nodes` for
work executed on worker nodes), correlate by trace (`get_trace`) and by time
(a tile's `maxAt` against a latency or error spike), verify, then conclude.
The prompt tells the model to run and
analyse the data itself — never to hand the analysis back to the user — and
to treat an empty result as evidence to explain (is the table populated at
all, does its data reach into the window, is the filter column populated)
rather than an answer.

**The eight tools**, all served by `TelemetryAssistantService.buildTools`:

| Tool | Reads |
|---|---|
| `list_tables` | Table names and row estimates (`TelemetrySchemaService`) |
| `describe_table` | One table's columns, types and semantic types |
| `run_query` | The model's own read-only SQL, via `TelemetryQueryService.run` |
| `get_app_context` | API version, runtime, OTel service name/instance id, telemetry settings, an allowlist of platform feature flags (booleans only), the deploy document's non-sensitive facts (version, commit SHA, timestamps, last outcome — never a hostname, path or secret), the store's tables, `metricFamilies` (per catalog group of §11.14: `available`, families and tables present out of the total, and the catalog keys of the families present), and the data range (earliest/latest timestamp, last-24h coverage, services) of traces and logs |
| `health_overview(window)` | A baseline over `15m`/`1h`/`6h`/`24h`/`7d`: per-service span/error counts and latency (avg, max, p95), top failing routes, log counts by severity, top error log messages with a sample trace id, the slowest spans, each table's coverage in the window, and `saturation`: the summary verdict's infrastructure probes (§11.7, `metric-verdict.ts`) — worst filesystem %, worst memory %, database connections %, oldest pending job and last backup, stale nodes and job types without an eligible node, failing uptime checks, soonest TLS expiry, collector export failures — each with a `level` (`ok`/`degraded`/`critical`) against `DASHBOARD_VERDICT_THRESHOLDS`; a probe whose tables are absent is listed in `skipped`, one with no fresh reading in `noReading` |
| `get_trace(traceId)` | Every span and log record of one trace, oldest first (`traceId` must match `TRACE_ID_PATTERN`, 16–32 hex characters) |
| `metrics_overview(group, window)` | One catalog group (`host`, `database`, `queue`, `nodes`, `uptime`, `pipeline`, §11.14) computed by `computeMetricGroup` over the window: `tiles` (key, label, unit, `value`, `previous`, and the current window's `max` with `maxAt`, the start of that bucket — no sparkline, no series), `tables` (each at most `METRICS_TABLE_ROWS_TO_MODEL`, 20, rows), `skipped` (catalog keys whose table or column is absent), `available`, `truncated`, and `unavailable` (why a statement failed) |
| `compare_nodes(window)` | Every worker node's vitals (the catalog's `nodes` table: CPU cores, RSS, heap used/limit/%, state-dir free/size/%, slots) plus the window's reset-aware increase of its `app.nodes.counter` series (lease renew failures, watchdog trips, heartbeat and claim failures, jobs succeeded and failed), the fleet `median` of each vital, per-node `flags` (CPU, RSS or heap over 2× the median, heap ≥ 90% of its limit, state dir < 10% free, slots full, any lease renew failure, watchdog trip, heartbeat or claim failure, no current vitals), fleet health counts (`healthy`/`stale`/`offline`), and the node-offered job types with due work but no eligible node |

`get_app_context`, `health_overview`, `get_trace`, `metrics_overview` and
`compare_nodes` never run model-written SQL: their statements are built
server-side, as pure functions of the table's discovered column set and
(for `get_trace`) a pattern-validated trace id, in `telemetry-assistant.sql.ts`
— or, for everything read from the metric tables, by the dashboard's own
metric catalog and builders (§11.14; `metric-sql.ts`, `metric-verdict.ts`),
with an enum group and window, no request filter, and the compare-nodes table
declared as data in `telemetry-assistant.metrics.ts` (`NODE_COMPARISON_TABLE`:
the catalog's `nodes` table plus counter parts). A section whose table or
columns are absent is skipped, not failed. Metric rows never reach the model:
the catalog's computation turns them into tiles and tables first, and only
those are shaped for it. Every statement these tools and
`run_query` alike produce still goes through `TelemetryQueryService.run`
(`source: 'assistant'`) — the explorer's own guard, row cap, timeout and a
`telemetry:assistant_query` audit row each — and every report query is
re-checked against the SQL guard before being shown to the user (a
statement that fails the re-check is withdrawn with a note in the summary,
never run). The dashboard runs the metric builders without the guard; the
assistant runs the very same statements through it, so
`telemetry-assistant.metrics.spec.ts` passes every one of them (every group
and window, the node comparison, every verdict probe) through
`analyzeStatement` and checks that `applyRowCap` finds their own top-level
`LIMIT`. A metric statement's row cap is `telemetry.query.maxRows`; at most
three statements of one tool run at a time (the reader pool keeps a
connection for the explorer), none starts after three query timeouts, and a
failed one is reported in `unavailable` without losing the rest — a fatal
store failure (not configured, unreachable, disabled) still ends the turn.
Not a queue job: the turn lives exactly as long as the SSE
request, and a closed tab aborts both the provider call and any in-flight
query.

**Data sharing to the model**, bounded three ways regardless of what a
statement returned:

1. Rows only when `telemetry.assistant.shareResults` is on. Off, `run_query`
   shows only the shape (columns, row count); the three server-built tools
   show only the cells in each statement's own `shareable` allowlist — the
   numbers, booleans and timestamps that statement's SQL computed (counts,
   durations, `is_error`), never a value the monitored system wrote (service
   names, routes, trace ids, log bodies) — every other cell is `null`.
   The metric tools apply the same rule to what the catalog computed: tile
   values and table cells with a numeric, boolean or timestamp unit (and an
   uptime row's numeric `statusCode`, like `get_trace`'s `http_status`) are
   shared; tile keys, labels and units, `skipped` keys, `level`s and node
   `flags` are catalog constants and shared too. Every **label value** is
   withheld: mountpoints, host names, database servers and table names,
   **job types**, node names, URLs, scrape jobs, exporters and uptime error
   text. A table's key becomes a stable ordinal in the table's own order
   (`"Mountpoint #1"`, `"Node #2"`: `<key label> #<n>`), so the model can
   still compare rows and cite them; in `health_overview.saturation` the
   offender (`mountpoint`, `host`, `instance`, `jobType`, `url`,
   `exporter`) is `null` and lists (`jobTypes`, `urls`) are `null` beside
   their counts. Job types are withheld although the application declares
   them in code: they are label values like any other, and a fork may name
   them after customers or tenants. With sharing on, lists are capped at
   `METRICS_LIST_MAX` (10) items.
2. At most `telemetry.assistant.maxResultRowsToModel` rows per statement,
   hard-capped at `TELEMETRY_ASSISTANT_ROWS_HARD_CAP` (100) regardless of
   the setting.
3. Each cell truncated to `CELL_MAX_CHARS` (500) and a tool's whole output
   to `TOOL_OUTPUT_MAX_CHARS` (24,000) — rows are dropped from the end of
   the largest section, with a note, to stay under that.

**Streaming and the step budget.** A `step` event's `thought` carries the
model's one-sentence interim reasoning for that round (the first call of
the round only, at most `THOUGHT_MAX_CHARS` — 1,000 — characters), so the
user sees the investigation as it happens. Every tool output carries how
much budget is left (`stepsLeft`), and the output of the round before the
last carries `budget`, a warning that the next step is the model's last and
must be the report — no further tool calls run. `telemetry.assistant.maxSteps`
(1–20, default 15; the ceiling is the AI runtime's own
`AI_TOOL_LOOP_MAX_STEPS`) bounds the whole turn's model round-trips; if the
budget runs out before a report, the answer falls back to the model's last
interim text (or its last successful query) with `status: "inconclusive"`
and a note.

**The report.** The model's final message is JSON: `status`
(`issue_found`/`no_issue_found`/`inconclusive`/`no_data`), a `summary`,
`findings` (title, `severity`, evidence, an optional `queryIndex` into
`queries`), `rootCause` (or `null`), `confidence`, `recommendations`, and up
to `REPORT_MAX_QUERIES` (5) supporting `queries` (title, sql) the user can
re-run in the explorer. `parseReport`/`guardReport` parse and bound every
field leniently (an unparseable finding or a query that fails the SQL guard
is dropped, not fatal) and re-check every query's SQL. For a caller reading
only the legacy shape, `answer.sql` is `report.queries[0].sql` (or `null`)
and `answer.explanation` is the summary; a model that still replies with
the legacy `{ sql, explanation }` shape is accepted and lifted into a
minimal report (`fromLegacy`). The web explorer no longer runs
`answer.sql` automatically — the answer's primary query is only inserted
into the editor; the report's own "Insert" / "Insert & run" buttons act on
any of its `queries` on demand.

`history` in the request carries up to `TELEMETRY_ASSISTANT_HISTORY_MAX_TURNS`
(20) earlier turns, each at most `TELEMETRY_ASSISTANT_HISTORY_CONTENT_MAX`
(8,000) characters; the web app replays an answered turn as a compact
rendering of its report (status, summary, finding titles, root cause,
recommendations, first query), bounded to `ASSISTANT_HISTORY_ANSWER_MAX`
(6,000) characters.

**Untrusted tool output.** Telemetry rows are attacker-reachable (a log
body, an HTTP route, a user agent; for the metric tools an uptime error
message, a URL, a node name). The assistant's system prompt tells the
model that everything a tool returns is data from the monitored system,
never instructions, and the blast radius is bounded by construction: the
tools can only read, through the read-only store user, and a report's SQL
is only ever shown to the user, never executed by this service.

Every conversation turn is audited as `telemetry:assistant` (question
length, provider, model, steps, tool calls, stop reason); every statement —
the model's `run_query` calls and the server-built ones alike — is
separately audited as `telemetry:assistant_query` through the shared query
service. No provider SDK is imported in the telemetry module — the call
goes through `AiService`, spending the caller's own key or the organisation
key per the AI platform's key policy (CLAUDE.md AI rule 1) — held only
between resolution and the adapter call, request-scoped, not a job.

## 7. Security model

- **Three GreptimeDB accounts**, set from `.env` with no compose-level
  default (`docker compose` fails outright, naming the missing key, rather
  than booting a store with a well-known password):
  - `GREPTIME_WRITER_USER`/`PASSWORD` — collector ingest only; held by the
    collector's `basicauth/greptime` extension, never by the API.
  - `GREPTIME_READER_USER`/`PASSWORD` — a GreptimeDB `readonly` user.
    Everything user-driven (status, explorer, assistant) runs on it, and
    GreptimeDB itself refuses `INSERT`/`DROP`/`ALTER`/`SET` for it — verified
    server-side enforcement, not an application-level assumption.
  - `GREPTIME_ADMIN_USER`/`PASSWORD` — used only for the retention `ALTER
    DATABASE` and `SHOW CREATE DATABASE`; a route never runs caller-supplied
    SQL on it.
- **Redaction happens ahead of ingest**, in the collector, not the API: the
  `attributes/redact` processor deletes
  `http.request.header.authorization`, `http.request.header.cookie`,
  `http.response.header.set-cookie` and `url.query` before a batch reaches
  GreptimeDB, so a deleted attribute never becomes a column at all — it
  cannot be un-redacted by a later query.
- **`telemetry:read`/`telemetry:write`/`telemetry:query` are Admin-only**,
  seeded that way in `ROLE_PERMISSIONS` (`apps/api/prisma/seed-data.ts`):
  `read`/`write` gate the deployment-wide policy (whether telemetry is
  collected, its retention, its bounds), the same "narrow, operational
  surface" posture as `storage_config:*`/`ai_config:*`; `query` is the
  separate act of actually running SQL, exporting results or invoking the
  assistant against telemetry data — comparable to `db_backup:restore`.
- **No AI key ever reaches the browser or a log line.** The assistant
  resolves a key through `AiKeyResolver` exactly like every other AI call;
  see [AI Platform §2](ai-platform.md).
- **`get_app_context` is allowlist-built, not a settings dump.** It reads an
  explicit, named set of facts (API version, runtime, OTel service
  name/instance id, telemetry settings, a fixed list of feature flags as
  booleans, the deploy document's non-sensitive fields, table/data-range
  summaries) — never the settings objects or the deploy document
  serialised wholesale — so a field added to a settings namespace or the
  deploy document later does not reach the model until this tool's allowlist
  is deliberately extended to include it. No hostname, file path or
  credential is in that allowlist.
- **Same-origin.** The assistant stream is proxied by nginx like every other
  API route: `infra/nginx/nginx.conf`'s `location /api/admin/telemetry
  /assistant/stream` block forwards it unbuffered, with a long read timeout
  and 15 s heartbeats, matching the AI response stream's needs.
- **Never a credential in the settings namespace.** See §3's compile-time
  proof.
- Every admin write and every query/export/assistant call is an audit
  event: `telemetry:config_update`, `telemetry:query`, `telemetry:export`,
  `telemetry:assistant_query`, `telemetry:assistant`,
  `telemetry:connection_update`, `telemetry:connection_reset`,
  `telemetry:stack_deploy` (§10) — including refused and failed queries, so a
  rejected `DROP` is on record.
- **The stored GreptimeDB connection's passwords are encrypted at rest**,
  under credential purpose `telemetry_greptime` (§8) — the same store and
  cipher as every other runtime-configured credential (SMTP, storage, AI,
  VAPID); see
  [SECURITY-ARCHITECTURE.md §10](../SECURITY-ARCHITECTURE.md#10-encrypted-credential-storage).

## 8. Runtime connection

The GreptimeDB connection the API uses — host, PG port, database, reader and
admin logins — is resolved at runtime by `TelemetryConnectionService`
(`apps/api/src/telemetry/connection/telemetry-connection.service.ts`), not
fixed at boot from `GREPTIME_*` alone. An administrator can point the API at
a different GreptimeDB, or rotate the reader/admin passwords, from
`/admin/settings/telemetry`'s Connection section, with no restart.

**One precedence rule, no per-field merge — the host mode decides who owns
the whole connection:**

1. a connection is **stored** with a **custom** host (a literal an
   administrator typed: GreptimeDB lives somewhere this deployment did not
   put it) → the row is the connection, **wholly**: host, port, database,
   both users, and the two passwords from the encrypted credential store.
   Nothing is borrowed from the environment, field by field or otherwise.
2. a connection is **stored** with an **automatic** host (`host: null`) —
   "the GreptimeDB deployed with this application" → the **deployment** is
   the connection, wholly: `GREPTIME_HOST` (else the compose service name),
   `GREPTIME_PG_PORT`, `GREPTIME_DB`, and the `GREPTIME_READER_*`/
   `GREPTIME_ADMIN_*` logins. The deployment provisioned that GreptimeDB's
   users, so it is the only party that knows their passwords — an
   administrator never supplies them. An automatic save stores only
   `{ host: null }` and deletes any stored reader/admin passwords; a
   connection test in automatic mode ignores submitted credentials
   entirely. `source` still reads `stored` (a row exists, has a version,
   "revert" applies) with `hostMode: 'auto'` and `deploymentManaged: true`.
3. nothing is **stored** → the **`GREPTIME_*` deployment default** (§7's
   three accounts, read through `config/configuration.ts`'s `greptime`
   block), when it names a host. Also automatic and deployment-managed:
   it is the same GreptimeDB rule 2 resolves to (`source: environment`).
4. otherwise **none** — telemetry is unavailable.

`GET /api/admin/telemetry/connection` reports `source` (`stored`/
`environment`/`none`), `hostMode` (`auto`/`custom`), `deploymentManaged`
(true for rules 2–3), `deployment` (the deployment's own GreptimeDB —
`host`, `pgPort`, `database`, `readerUser`, `adminUser`,
`readerConfigured`, `adminConfigured` — whatever is in force, so a form
switching back to automatic can say what it will get), and `problem` (why a
deployment-managed connection cannot be used, in administrator language, or
null; always null for a custom host). A per-field merge — host from the
form, password from the environment — was rejected: it is a connection
nobody configured, and it cannot be explained on a status page.

**Why the environment stays a source at all.** `GREPTIME_*` cannot go away:
the telemetry overlay provisions the GreptimeDB container's own users and the
OTel collector's writer login from the same variables, so they are set on
every deployment that runs the overlay regardless of whether a connection is
ever saved. Keeping them as the default means an operator never types the
reader/admin credentials twice, and every existing deployment keeps working
unchanged after upgrading to this feature — nothing switches to "not
configured" merely because the row does not exist yet.

**Why the writer login and the HTTP port are not configurable here.** Only
the OTel collector (ingest) and the GreptimeDB container (user provisioning)
use `GREPTIME_WRITER_*`/`GREPTIME_HTTP_PORT`; the API never writes telemetry
and never speaks GreptimeDB's HTTP API. Storing a write-capable credential
the API has no use for would widen what a compromise of the application
database yields, for nothing — least privilege excludes it by design, not by
oversight. Provisioning the GreptimeDB server itself (starting its container)
stays a separate concern from reaching it: the API only holds the credentials
to *reach* a store, never the Docker socket needed to stand one up — see §10
for how an administrator now does that from the admin UI.

**Storage.** `telemetry_connection` is a `system_settings` row of its own,
not a namespace inside `global`, for the same reason the email settings have
one (§3's `email` row): the generic `PUT /api/system-settings` must not be
able to clobber or silently carry it forward, it must stay out of
`GET /api/system-settings`, and it needs an `If-Match` version counter that a
concurrent save of an unrelated setting cannot conflict with. An automatic
save stores exactly `{ host: null }` — no port, database or usernames; a
custom save stores the whole row (host, port, database, both usernames). The
row itself carries no password field — a compile-time check
(`TELEMETRY_CONNECTION_CARRIES_NO_SECRET`) fails the build if one is ever
added — the two passwords live only in the encrypted credential store, under
purpose `telemetry_greptime`, names `reader`/`admin`
(`TELEMETRY_GREPTIME_CREDENTIAL_PURPOSE`; see
[SECURITY-ARCHITECTURE.md §10](../SECURITY-ARCHITECTURE.md#10-encrypted-credential-storage)).

**Refresh and pool rebuild.** `TelemetryConnectionService` keeps a
non-secret snapshot of the resolved connection (source, host, port, database,
and per login whether a password is set plus a version marker), because the
synchronous accessors `isConfigured()`/`isAdminConfigured()` the export gate
and retention job depend on cannot await a database read. The snapshot
refreshes once at boot, every `TELEMETRY_CONNECTION_REFRESH_MS` (5 s) after
on an unref'd interval, and immediately (awaited) on the instance that
served an admin save — so that instance's own next call already sees the new
connection, and every other instance in a fleet converges within one
interval. A failed refresh keeps the last snapshot rather than flipping to
"unconfigured" on a database blip, the same posture `TelemetrySettingsService`
takes for the export gate. Passwords are **never** cached in the snapshot:
`resolveCredentials` reads the password from the credential store at the
moment a pool is built and hands it straight to `pg`.

`GreptimeClient` keys its connection pools by a **fingerprint** — source,
host, port, database, user and the login's password version, joined —
computed per role (`reader`/`admin`) from the current snapshot. A pool is
built lazily and rebuilt whenever the fingerprint for its role changes; a
save that only changes an unrelated field (say, the admin password) leaves
the reader pool untouched. This is what makes a saved connection, or a
rotated password, take effect with no process restart.

**Routes**, all on `TelemetryConnectionController`
(`apps/api/src/telemetry/connection/telemetry-connection.controller.ts`):

| Route | Permission | Notes |
|---|---|---|
| `GET /api/admin/telemetry/connection` | `telemetry:read` | Non-secret: `source`, `hostMode`, `deploymentManaged`, `deployment`, `problem`, fields, whether each password is present with a masked hint for a stored custom one |
| `PUT /api/admin/telemetry/connection` | `telemetry:write` | Replaces the stored connection wholly; optional `If-Match` → 409 on conflict |
| `DELETE /api/admin/telemetry/connection` | `telemetry:write` | Deletes the row and both stored passwords — reverts to the deployment default (or none) |
| `POST /api/admin/telemetry/connection/test` | `telemetry:write` | Always 200; tests the connection **in the request body**, not necessarily the stored one; response adds `hostMode` |

**Save semantics.** The host decides the shape of the save. **Custom** — a
literal `host` — is saved as before: `readerUser`/`adminUser` (or null) are
required, `readerPassword`/`adminPassword` are write-only (omitted or blank
keeps the stored password; a save with none stored and none sent is a 400 —
the deployment's password is never copied into the store), and
`adminUser: null` removes the admin login and its stored password. **
Automatic** — `host` omitted, null or blank — stores only `{ host: null }`;
every other field of the body is accepted (older clients still send them)
and **ignored**, and any stored reader/admin password is deleted. Nothing is
required, and there is nothing left for a form to submit. Either way the
response reports `effectiveHost` and `hostMode: 'auto' | 'custom'`; the UI
leaves the host field empty and shows the deployment's host as a summary
instead of credential fields, so a value is typed only for an external
GreptimeDB. Every successful save or reset re-applies the export gate (a
store may have just become reachable, or gone away) and enqueues
`telemetry.retention.apply` (the admin login may have just become usable),
exactly as a policy save does (§3). Each is audited — field **names** and
which passwords were set/cleared, never a value — as
`telemetry:connection_update` (PUT) or `telemetry:connection_reset` (DELETE).

**Test connection.** `POST .../connection/test` runs the reader's
`SELECT version()` and, when `adminUser` is set, the admin's
`SHOW CREATE DATABASE <database>`, each on a throwaway `pg` client (never a
pooled one), bounded to 5 s to connect and 5 s to answer. A blank/absent
host in the test body is **automatic**: the deployment's own GreptimeDB is
probed with the deployment's port, database, logins and passwords — any
submitted credentials are **ignored**, and a login the deployment does not
provide shows up in that probe's `error`. For a custom host the body is
probed as sent. It always answers
200 with a per-role `{ success, ... }` (and `admin.skipped` when no admin
user is given), so the caller reads the outcome from the body, not the HTTP
status — the same shape `TelemetryConnectionTestResultDto` documents. A
blank password in the test body means "the password the connection **in
force** would use for that login right now", so an operator can test a
username/host change without retyping a password they are keeping.

**Unresolvable host.** Before either probe runs, the test resolves the
target host once, under `GREPTIME_DNS_TIMEOUT_MS` (15 s) — longer than
Docker's ~5 s `EAI_AGAIN` window, which otherwise loses the race to the 5 s
connect timeout above and is reported as a bare "timeout expired". When the
host does not resolve, both probes fail with `GreptimeDB host "<host>" could
not be resolved (getaddrinfo EAI_AGAIN <host>): …`, naming
`telemetry.compose.yml`, without a client ever being created; the request
can then take up to ~15 s to answer. `GreptimeClient` (the pooled connection
behind status, the explorer and the assistant) makes the same check, but
only *after* a connect attempt times out, never on the success path — so the
same unresolvable-host case there is reported the same way instead of
"Connection terminated due to connection timeout", at the cost of that one
request taking up to ~20 s (`greptime-host.ts`).

### Rejected alternative: environment-only, with better error messages

Before this feature, GreptimeDB was configurable only through `GREPTIME_*`,
and a wrong or rotated password showed up as `reachable: false` on the
status card (§10 troubleshooting) — diagnosable, but only fixable with a
`.env` edit and a container recreate (runbook §8), on every host running the
deployment. That was rejected as the long-term shape once GreptimeDB itself
needed to be relocatable or rotatable without a deploy: every other runtime
credential in this template (storage, AI, SMTP, VAPID) already lives in the
admin UI plus the encrypted credential store, and leaving GreptimeDB as the
one exception would mean explaining, to every operator, why this one store
alone still needs an SSH session to reconfigure.

## 9. BI access

`GREPTIME_BIND_PG_PORT` (default `14003`) is GreptimeDB's Postgres wire port,
bound to `127.0.0.1` only on a VPS deployment
(`infra/compose/vps.telemetry.compose.yml`) — nothing about the telemetry
store is ever published on a public interface. An analyst reaches it through
an SSH tunnel and a read-only login (`GREPTIME_READER_USER`), from any tool
that speaks the PostgreSQL wire protocol — Grafana, Metabase, Superset, Power
BI, Excel, DBeaver — or GreptimeDB's Prometheus-compatible HTTP API for a
metrics-only consumer. See the [telemetry runbook](../runbooks/telemetry.md)
for the exact commands and per-tool notes.

**Filtering or grouping by deployment.** Once more than one deployment shares
a store, every query should filter or group by `app.instance.id` (§ above),
the same way it would filter by any other resource attribute. In GreptimeDB,
resource attributes are flattened into their own columns named
`resource_attributes.<key>` (§"Tables and column naming" above), so the
identifier is `"resource_attributes.app.instance.id"` on the traces and logs
tables — the dotted name needs double-quoting, exactly like any other
flattened attribute column:

```sql
SELECT "resource_attributes.app.instance.id" AS instance,
       count(*) AS spans
FROM opentelemetry_traces
WHERE "timestamp" > now() - INTERVAL '1 hour'
GROUP BY instance;
```

A per-metric table follows the same flattening, but its exact column set is
created on first export and not fixed by this spec — verify the column name
in your deployment's schema browser (the explorer's schema tab, or
`information_schema.columns`) before building a dashboard panel or BI report
against it.

## 10. Deploying the stack (stack-agent)

**The telemetry stack ships with every VPS deployment.** `observability` used
to be an opt-in group; `effectiveGroups()`
(`apps/cli/src/deploy/compose-files.ts`) now unions it into every install,
update, uninstall and health run, so `telemetry.compose.yml` and
`vps.telemetry.compose.yml` are always in the compose file list and the
`GREPTIME_*` keys are always in scope for the environment wizard. A
deployment recorded before this change gains the stack on its next `evopathcli
deploy update`, with no flag. `--group observability` is still accepted, as a
harmless no-op, so an existing script or habit does not break.

Shipping the containers does not turn export on: `telemetry.enabled` (§2)
still gates whether anything is collected, and the GreptimeDB connection
(§8) still has to be reachable. Deploying the stack only makes "reachable"
achievable without a shell session.

### The problem this solves

Before this feature, a fresh install had no `greptimedb` container until an
operator ran `evopathcli deploy update --group observability` from a shell, and
recovering from a stopped or removed container needed the same. That
contradicts CLAUDE.md's Settings UI posture — everything about a deployment's
telemetry should be reachable from `/admin/settings/telemetry` — and left the
admin UI's connection test reporting an unresolvable host with no way to fix
it from there.

### `stack-agent`: the one holder of the Docker socket

`apps/stack-agent` is a small, zero-runtime-dependency Node service, the
**only** process in the stack that mounts `/var/run/docker.sock`
(`infra/compose/vps.compose.yml`). It exposes three routes and nothing else:

| Route | Auth | Does |
|---|---|---|
| `GET /health` | none | Liveness probe |
| `GET /v1/telemetry` | bearer `STACK_AGENT_TOKEN` | `docker compose ps` of `greptimedb` and `otel-collector` |
| `POST /v1/telemetry/up` | bearer `STACK_AGENT_TOKEN` | `docker compose up -d --no-build greptimedb otel-collector` |

**No route takes a parameter** — not a path segment, query string, header or
body (the body is drained up to 1 KB and discarded). The project name, the
compose files and the working directory come from the agent's own
container's compose labels (`apps/stack-agent/src/compose.ts`), so it cannot
be redirected at a different project. It answers `/v1/*` only with a
constant-time bearer check, and refuses everything with `503
not_configured` when `STACK_AGENT_TOKEN` is unset or shorter than 32
characters. It is single-flight (`up` refuses a second call with `409` while
one is running), caps the output it returns, and scrubs its own token from
anything it might echo back.

**The security trade-off, stated plainly.** Access to the Docker socket is
root-equivalent on the host: whoever can talk to it can start a privileged
container that mounts `/`. `vps.compose.yml` confines that access to this one
small, purpose-built process — published on no port, reachable only from
`app-network`, read-only root filesystem, every capability dropped,
`no-new-privileges`, 128 MB memory limit — rather than to the API, which is
the internet-facing process handling arbitrary requests. What remains is the
residual risk any socket holder carries: a compromise of `stack-agent` itself
is a compromise of the host, which is why the agent does as little as
possible and accepts no input that could steer what it runs.

**Rejected alternative: the socket in the API container.** Mounting
`/var/run/docker.sock` into the API service directly was rejected. The API is
a large, internet-facing NestJS process with a broad route surface, request
body parsing, third-party dependencies and (per the AI platform rules)
provider SDKs; any bug in any of that would hand an attacker the host, not
just telemetry. A dedicated sidecar with no HTTP body handling beyond a
1 KB drain, no dependencies beyond Node's own `http`/`child_process`, and no
parameters at all shrinks that same capability down to a process small enough
to read in one sitting.

### The admin deploy flow

`GET /api/admin/telemetry/stack` (`system_settings:read`) and `POST
/api/admin/telemetry/stack/deploy` (`system_settings:write`) are on
`TelemetryStackController`
(`apps/api/src/telemetry/stack/telemetry-stack.controller.ts`) — deliberately
`system_settings:*`, not `telemetry:*`: starting containers on the host is a
deployment action with the same reach as the rest of the system-wide
deployment settings, not a telemetry-policy edit.

- `GET` asks `stack-agent` for the two containers' state (bounded to five
  seconds) and reads the most recent `telemetry.stack.deploy` job. It always
  answers 200: `agent` is `available`, `unavailable`, `unauthorized` or
  `not_configured` — a missing or unreachable agent is a state, not an error.
  `agentError` is `string | null`: the agent's secret-free error message when
  `agent` is `unavailable` or `unauthorized`, otherwise `null`. The Doctor has
  no check for the agent, because telemetry capture never uses it.
- `POST /deploy` enqueues `telemetry.stack.deploy`
  (`apps/api/src/telemetry/stack/telemetry-stack-deploy.handler.ts`) and
  answers `202` at once — an image pull can take up to ten minutes, far
  longer than an admin request should stay open (CLAUDE.md queue rule 1).
  The job has no subject, so the queue's active-dedup index makes a second
  click return the job already in flight rather than starting another. It is
  **never auto-retried** (`maxAttempts: 1`): a failed `up` is a deployment
  problem an administrator must read, not one the queue should hide behind a
  retry. The job is **server-only, permanently** — no `nodeResultSchema` /
  `persistNodeResult` — because `stack-agent` listens only on the
  deployment's internal network and its bearer token controls the host's
  Docker daemon, which a worker node must never hold (CLAUDE.md queue rule
  3). `POST` answers `409` with `details.reason: STACK_AGENT_NOT_CONFIGURED`
  when this deployment has no `stack-agent` (`STACK_AGENT_URL`/
  `STACK_AGENT_TOKEN` unset).
- On success, the handler nudges the telemetry connection snapshot and the
  export gate to refresh, and enqueues `telemetry.retention.apply` (a fresh
  GreptimeDB volume has no TTL yet), so the admin page turns green on its
  next poll without a restart.
- Every deploy request is audited as `telemetry:stack_deploy` (target type
  `job`), whether or not the job later succeeds.
- The API reaches the agent over `STACK_AGENT_URL` (`http://stack-agent:8090`
  on a VPS) and `STACK_AGENT_TOKEN`, both set by `vps.compose.yml` — never
  configured in the admin UI, since they name an internal sidecar, not an
  external service.

The **Telemetry services** section of `/admin/settings/telemetry`
(`apps/web/src/components/telemetry/TelemetryServicesSection.tsx`) shows the
two containers and a **Deploy GreptimeDB** / **Redeploy** button, polls the
job while it runs, and shows the tail of its output on failure. Every message
shown to an administrator is about "the telemetry services" or "GreptimeDB" —
never compose, a compose file or the CLI. This is the same posture the
connection error messages already took (§8's unresolvable-host handling): an
administrator should never need to know this template runs on Docker Compose
to operate telemetry from the admin UI.

The section words the agent states differently. For `unavailable` it shows
"The deployment agent isn't responding, so these services can't be redeployed
from here. Telemetry collection is unaffected." plus the `agentError` reason.
`not_configured` keeps its own text, since there is no agent to be
unresponsive.

### `STACK_AGENT_TOKEN`

Generated as 32 hex bytes, without a prompt, on every VPS install and update
(`apps/cli/src/deploy/env-metadata.ts`) — it carries no `group`, so it is
generated whether or not `--group observability` was ever passed. Only
`stack-agent` and the API read it; a hand-set real value is kept, never
overwritten. `vps.compose.yml` refuses to start `stack-agent` or `api`
without it (`:?` compose interpolation).

## 11. Dashboard

`/admin/settings/telemetry/dashboard` answers "is anything wrong, right now?"
without anyone writing SQL: a health verdict, headline tiles, API and log
timelines, the routes and error messages responsible, a feed of recent
error/warning logs, and the infrastructure under the application (host,
database, job queue, worker nodes, uptime, the telemetry pipeline — #127) —
all read-only, over the same GreptimeDB store as the explorer.

### 11.1 Purpose and triage model

The dashboard is deliberately narrow: it answers "is anything wrong, and
roughly where" for THIS application's own traces, logs and Node runtime
metrics, not a general-purpose observability tool. It is not a replacement
for the [Explorer](#5-explorer) (arbitrary SQL) or the
[AI assistant](#6-ai-assistant) (an investigation) — it is the page an
administrator opens first, to decide whether either of those is worth
opening at all.

The triage flow it is built for: read the verdict banner (§11.7) → if not
`healthy`, read its reasons (which rule fired, the worst offender) → look at
the tile or panel the reason names → optionally zoom into the window that
looks bad. Each panel fetches independently (§11.9), so a failing or slow
panel never blocks the rest of the page from telling its part of the story.

The **triage model** is a set of actions on every panel and the verdict
banner, so the dashboard is an entry point into the deeper tools rather than
a dead end:

- **"Open in Explorer"** on every panel (Key indicators, API requests, log
  severity, Top failing routes, Top errors, Recent events, and each
  infrastructure section of §11.9): hands the Explorer the `sql` that
  panel's own API response reported (§11.4), first statement only when it is
  a list — for Key indicators that is the current-vs-previous totals query
  the tiles come from, for an infrastructure section the first statement of
  its `/metrics` group (§11.14). The Explorer loads
  it into the editor and does **not** run it (§11.9's cross-link below);
  disabled until the panel has data (and so has `sql`).
- **"Ask assistant"** on every panel, and **"Explain this"** on the verdict
  banner: opens the shared `AssistantPanel` with a question built by
  `buildAssistantQuestion` (`components/telemetry/dashboard/assistantPrompt.ts`)
  describing what that panel currently shows, prefilled into the input and
  **never sent** — the reader edits it and presses Ask. Offered only where
  `useTelemetryAssistantAvailable` (below) says the assistant may be shown.
- **"View trace"**, in the event detail dialog only (not the row itself,
  since the row is already a button and a nested control would be
  unreachable for assistive technology): shown only when the event's
  `traceId` matches `/^[0-9a-f]{32}$/` (`traceLink.ts`'s `isTraceId`, a
  genuine W3C trace id), and opens the one browser-built statement in this
  whole feature — every other handoff carries `sql` the API already ran and
  reported; this one does not exist as a dashboard endpoint, so it is
  written client-side (see the safety argument below).
- **Report queries** the assistant surfaces ("Insert" / "Insert and run" in
  its own UI) open in the Explorer loaded, not run, when reached from the
  dashboard's assistant — the same "never auto-run a handed statement" rule
  as every other handoff here.
- **Cross-links**: the Dashboard header links to the Explorer and the
  Explorer header links back to the Dashboard; the Telemetry settings page
  offers "Open dashboard" whenever telemetry is on (a store is deployed and
  collection is on) and the viewer holds `telemetry:query` — the dashboard
  route's own gates, re-checked rather than assumed (`TelemetryCrossLink`).

**Assistant availability** is one condition, `useTelemetryAssistantAvailable`
(`hooks/useTelemetryAssistantAvailable.ts`), shared by the Dashboard and the
Explorer so the two can never disagree: the Telemetry assistant switch is on
(`GET /api/telemetry/config` → `assistantEnabled`), AI is on for the
deployment (`GET /api/ai/config` → `enabled`), and the viewer holds `ai:use`.
This only hides the control — the API enforces every one of those on
`POST /admin/telemetry/assistant/stream` regardless.

**The handed-over SQL, and why "load, don't run" everywhere**: every
statement — from a panel's "Open in Explorer", the assistant's report
queries, and "View trace" — reaches the Explorer via `location.state.sql`
(the router navigation `explorerHandoff()` builds) or, for a plain link,
`?sql=<URL-encoded>` (`state` wins when both are present). The Explorer reads
it **once** on mount, puts it in the editor, shows a dismissible "Query
loaded from the Telemetry Dashboard. Review it and press Run." notice, and
clears the handoff from both `location.state` and the URL with a `replace`
navigation so a reload does not repeat it. Anything blank, not a string, or
longer than `TELEMETRY_SQL_MAX_LENGTH` (20,000 characters — the same DTO
bound the API enforces, `apps/api/src/telemetry/dto/telemetry-query.dto.ts`)
is ignored and the Explorer opens as usual. The statement never runs until
the reader presses Run: a dashboard panel and an assistant report are both
untrusted enough (server-composed from data, or model-composed) that this
feature does not add a second way to execute SQL without a human looking at
it first — the Explorer's own SQL guard is still the thing that decides
whether a run is allowed.

`buildAssistantQuestion`'s bounds keep the prefill a caption, not an essay:
at most 2,000 characters overall, any one message (a log body, an error
line, a verdict reason) clipped to 200, at most five list entries per
panel, and at most one sample trace id. An infrastructure section (the
`metrics` kind, #127) lists at most five of its tiles and at most five table
rows in all, failing rows first (a URL or scrape job that is down, a job type
with no eligible node), each row's key and cells clipped to 80 characters;
it names the Host filter, the one panel kind the filter applies to.

### 11.2 Data sources: what is collected, and why no Docker stats

The dashboard's tiles read three kinds of data already in the store:

- **Server spans** (`opentelemetry_traces`, `span_kind = 'SPAN_KIND_SERVER'`)
  — requests, status classes, latency, routes.
- **Log records** (`opentelemetry_logs`) — severity bands, error messages,
  the events feed.
- **Node runtime metrics** (`v8js_memory_heap_used_bytes`,
  `nodejs_eventloop_delay_p99_seconds`) — the optional runtime tiles, present
  only when the runtime-metrics instrumentation is on.

The collector additionally scrapes six sources itself and writes them to
the store as metric tables. The dashboard reads them through the metric
catalog (`GET …/dashboard/metrics`, §11.14) and the infrastructure verdict
rules (§11.7); they are also queryable in the Explorer and available to the
assistant (inventory in §11.3):

| Source | Receiver | What it describes |
|---|---|---|
| The host | `hostmetrics` (30 s) | CPU, memory, load, paging, disk, filesystem, and network (see the caveat below) |
| The collector | `prometheus/self`, job `otel-collector` | Points accepted, refused, sent and failed; exporter queue size and capacity |
| GreptimeDB | `prometheus/self`, job `greptimedb` | HTTP/OTLP request counts and latency, rows ingested, write stalls, memory and CPU limits, process CPU/RSS |
| PostgreSQL | `postgresql` (30 s), `metrics/local` | Connections against the maximum, commits, rollbacks, deadlocks, database, table and index sizes, cache hits, temp files, scans, rows, vacuum, background-writer and checkpoint activity, locks |
| Uptime and TLS | `httpcheck` (30 s, `GET`), `metrics/local` | Status class and code, duration, error cause and TLS certificate time remaining, for three URLs |
| The nginx edge | `nginx` (30 s), `metrics/local` | Requests, accepted and handled connections, current connections by state, from `stub_status` on the internal `:8081` listener |

**How the host is read.** `telemetry.compose.yml` bind-mounts the host's `/`
read-only at `/hostfs`, and the `hostmetrics` receiver runs with
`root_path: /hostfs`, so it reads the host's `/proc`, `/sys` and mount table
instead of the container's. No new agent, no privileged container, no
`pid: host` and no Docker socket (mitigations:
[SECURITY-ARCHITECTURE.md](../SECURITY-ARCHITECTURE.md)). The filesystem
scraper excludes pseudo and container filesystems (`overlay`, `tmpfs`,
`/var/lib/docker/...`, `/run`, `/proc`, ...), so only real disks produce series.

**Network caveat.** `system_network_*` describes the **collector container's**
interfaces (`eth0` on the compose network, `lo`), not the host's NICs. It still
answers "is the telemetry path moving bytes". CPU, memory, load, paging and
disk are kernel-global and are the host's.

**PostgreSQL.** The `postgresql` receiver reads the application's server (`POSTGRES_HOST:POSTGRES_PORT`) read-only over the statistics views, through the optional `pg_monitor` login (`POSTGRES_MONITOR_USER`/`POSTGRES_MONITOR_PASSWORD`, blank falls back to the application login). The dashboard reads them through the metric catalog's `database` group (§11.14); they are also reached through the Explorer, the assistant or a BI tool (§9). Operator procedure: [the telemetry runbook](../runbooks/telemetry.md#82-postgresql-metrics).

**Uptime and TLS.** `httpcheck` sends a `GET` to three targets every 30 s:

| Target | Answers |
|---|---|
| `http://nginx/api/health/live` | Is the app up through the edge? |
| `http://api:3000/api/health/live` | Is the API up alone? Up here but down via nginx means a proxy fault. |
| `${env:UPTIME_PUBLIC_URL}` | Is the public origin reachable, and how long is its certificate valid? |

The probe uses liveness, which touches no database, so a PostgreSQL outage or
a maintenance-mode readiness `503` does not read as the API being down.
`httpcheck.tls.cert_remaining` is enabled explicitly (it is off by default).
Certificates are verified: an expired or mismatched certificate fails the
handshake, so no `cert_remaining` row is written and an `httpcheck_error` row
names the cause.

`UPTIME_PUBLIC_URL` is not an `.env` key; each overlay sets it:

- `telemetry.compose.yml`: `http://nginx/nginx-health`, an edge-only check
  with no TLS rows. It is not `APP_URL`, because the development
  `APP_URL=http://localhost:3535` would resolve to the collector itself.
- `vps.telemetry.compose.yml`: `${APP_URL:-http://nginx}/api/health/live`.
  `evopathcli deploy` derives `APP_URL=https://<domain>`, so TLS expiry works with
  no setup.

Two VPS caveats. The collector reaches its own domain through NAT hairpin, so a
network that blocks hairpin shows `httpcheck_error` rows for that URL only.
`--skip-proxy` installs derive `APP_URL=https://localhost`, so the public check
fails there; that is expected.

**The nginx edge.** `stub_status` is served by a second `server` block on
`:8081`, reachable only from private ranges and published by no compose file
(protections: [SECURITY-ARCHITECTURE.md](../SECURITY-ARCHITECTURE.md#nginx-status-listener)).
The public listener answers `404` for `/nginx_status`; without that explicit
location the SPA fallback would return `200`. Operator procedure:
[the telemetry runbook](../runbooks/telemetry.md#83-uptime-tls-and-edge-metrics).

**Docker container stats are rejected as a source**: reading them means
talking to the Docker socket, which this template deliberately confines to
`stack-agent` alone (see [§10](#10-deploying-the-stack-stack-agent) and
[SECURITY-ARCHITECTURE.md](../SECURITY-ARCHITECTURE.md)). Handing the
collector, or the API, a second path to that socket is exactly the
blast-radius increase the sidecar exists to avoid. Per-container CPU and
memory are therefore not collected.

### 11.3 Column findings (verified live, GreptimeDB v1.2.1)

Verified against a running store on 2026-09-27; see the header comment of
`apps/api/src/telemetry/dashboard/telemetry-dashboard.sql.ts` for the full
account. These override the issue text where they differ:

| Table | Finding |
|---|---|
| `opentelemetry_traces` | `"span_attributes.http.route"` is **empty on server spans** (the Fastify HTTP instrumentation never sets it; only NestJS-internal spans carry it, and those are missing for a request rejected before the handler) — so routes are grouped by a **normalized `"span_attributes.url.path"`** instead (always present; the collector has already redacted the query string). Numeric, UUID and 24+ hex path segments become `:id`. |
| `opentelemetry_traces` | Status is `"span_attributes.http.response.status_code"` (bigint). `"span_attributes.http.status_code"` does **not** exist; `span_status_code` is `STATUS_CODE_UNSET` for 4xx, so status classes come from the numeric column, never from `span_status_code`. |
| `opentelemetry_traces` | Service is `service_name`; instance is `"resource_attributes.app.instance.id"` — a genuine flattened column, present only once an instance id has actually been written (§11.6 covers what happens when it has not). |
| `opentelemetry_logs` | Severity comes from **`severity_number`** (OTel standard), not `severity_text` (lower-case pino labels): error `>= 17` (17 error, 21 fatal), warn `13..16`, info `9..12`, other `< 9` or `NULL`. |
| `opentelemetry_logs` | Service and instance are **not** flattened columns here: they are keys of the JSON column `resource_attributes`, read with `json_get_string(resource_attributes, '["service.name"]')` / `'["app.instance.id"]'` — a bare `'service.name'` path returns `NULL` because `.` is a path separator in that function. |
| `opentelemetry_logs` | `trace_id`/`span_id` may be `''` for a log emitted outside a request. |
| Runtime metric tables | Prometheus-style columns (`greptime_timestamp`, `greptime_value`, `service_name`, …) with `app_instance_id` and `host_name` label columns on rows written since the collector began promoting them (`NULL` on older rows). For API metrics `host_name` is the API container's hostname (the SDK host detector), not the host's. The dashboard's instance filter still does not apply to the runtime tiles. `v8js_memory_heap_used_bytes` has one row per heap space per export, so it is summed per export before being averaged per bucket. Both are exported every 60 s, so a bucket finer than a minute is half empty. |

Host and pipeline metric tables (verified live, collector 0.145.0: 83 tables
about 70 s after start). Every metric table has `greptime_timestamp`
(`TIMESTAMP`) and `greptime_value` (`Float64` field); every other column is a
tag. Host tables carry `host_name` (the host's real name) and no
`service_name`/`job`.

| Group | Tables (tag columns beyond `host_name`) |
|---|---|
| CPU | `system_cpu_time_seconds_total`, `system_cpu_utilization_ratio` (`cpu`, `state`); `system_cpu_load_average_1m`, `_5m`, `_15m` |
| Memory | `system_memory_usage_bytes`, `system_memory_utilization_ratio` (`state`: used, free, cached, buffered, slab_reclaimable, slab_unreclaimable) |
| Filesystem | `system_filesystem_usage_bytes` (`device`, `mode`, `mountpoint`, `state`, `type`); `system_filesystem_utilization_ratio` (same, no `state`); `system_filesystem_inodes_usage` |
| Disk | `system_disk_io_bytes_total` (`device`, `direction`); `system_disk_io_time_seconds_total`, `_merged_total`, `_operation_time_seconds_total`, `_operations_total`, `_pending_operations`, `_weighted_io_time_seconds_total` |
| Network (collector container) | `system_network_io_bytes_total` (`device`, `direction`); `system_network_packets_total`, `_errors_total`, `_dropped_total`, `_connections` |
| Paging | `system_paging_operations_total` (`direction`, `type`); `system_paging_faults_total` |
| Collector self (`service_name` = `otelcol-contrib`) | `otelcol_exporter_sent_metric_points_total`, `otelcol_exporter_send_failed_metric_points_total` (`exporter`, `host_name`, `instance`, `job`, `service_instance_id`, `service_name`, `service_version`); `otelcol_exporter_queue_size`, `_queue_capacity`; `otelcol_receiver_accepted_metric_points_total`, `_refused_metric_points_total`, `_failed_metric_points_total` (`receiver`, `transport`); `otelcol_processor_*`, `otelcol_scraper_*`, `otelcol_process_*` |
| GreptimeDB self (`job`/`service_name` = `greptimedb`, `instance` = `greptimedb:4000`) | `greptime_servers_http_requests_total` (`code`, `db`, `method`, `path`), `greptime_servers_http_requests_elapsed_bucket` (`le`), `greptime_mito_write_stalling_count` (`worker`), `greptime_mito_region_count`, `greptime_mito_write_buffer_bytes`, `greptime_mito_flush_*`, `greptime_frontend_otlp_metrics_rows_total`, `greptime_app_version`, `greptime_cpu_limit_in_millicores`, `greptime_memory_limit_in_bytes`, `process_resident_memory_bytes` and other `process_*` |
| Scrape health | `up` and `scrape_*`, from the Prometheus receiver |

Two findings shape the configuration:

- GreptimeDB turns **data point** attributes into label columns but keeps
  only a fixed few resource attributes (`service.name`, `service.version`,
  `deployment.environment`, `service.instance.id`) and silently drops
  `host.name` and `app.instance.id`. `transform/promote_labels` copies those
  two onto each data point. A table that predates them gains the columns, with
  `NULL` in old rows.
- A data point `service.name` lands in the same `service_name` column as the
  resource one, so it is not copied.

#### PostgreSQL metric tables

Every table has `greptime_timestamp`, `greptime_value` and the tags
`host_name`, `instance`, `service_instance_id`. `instance` and
`service_instance_id` both hold `POSTGRES_HOST:POSTGRES_PORT` (for example
`db:5432`) and identify the database server. `host_name` is the collector's
host, the machine that scraped, which for a managed database is not the
machine that serves. There are no `service_name` or job columns.

| Scope | Tables | Extra tags |
|---|---|---|
| Per database | `postgresql_backends`, `postgresql_commits_total`, `postgresql_rollbacks_total`, `postgresql_deadlocks_total`, `postgresql_db_size_bytes`, `postgresql_blks_hit_total`, `postgresql_blks_read_total`, `postgresql_temp_files_total`, `postgresql_temp_io_bytes_total`, `postgresql_table_count` | `postgresql_database_name` |
| Per table | `postgresql_table_size_bytes`, `postgresql_table_vacuum_count_total`, `postgresql_sequential_scans_total` | `postgresql_database_name`, `postgresql_table_name` (`public.users`) |
| Per table | `postgresql_operations_total` | as above, plus `operation` (`ins`, `upd`, `del`, `hot_upd`) |
| Per table | `postgresql_rows` | as above, plus `state` (`live`, `dead`) |
| Per index | `postgresql_index_scans_total`, `postgresql_index_size_bytes` | `postgresql_database_name`, `postgresql_table_name` (bare, `users`), `postgresql_index_name` |
| Server-wide | `postgresql_connection_max`, `postgresql_database_count`, `postgresql_bgwriter_buffers_allocated_total`, `postgresql_bgwriter_maxwritten_total` | none |
| Server-wide | `postgresql_bgwriter_buffers_writes_total` | `source` |
| Server-wide | `postgresql_bgwriter_checkpoint_count_total`, `postgresql_bgwriter_duration_milliseconds_total` | `type` |
| Server-wide | `postgresql_database_locks` | `lock_type`, `mode`, `relation` |

- `postgresql.wal.age` appears only with WAL archiving, and replication
  metrics only with replicas; neither has a table otherwise.
- The receiver keeps per-table and per-index metrics, which suits one
  application schema. It enables `postgresql.deadlocks`,
  `postgresql.database.locks`, `blks_hit`, `blks_read`, `temp.io`,
  `temp_files` and `sequential_scans`, and disables `postgresql.blocks_read`
  (eight series per table; `blks_hit`/`blks_read` answer the cache-hit
  question once per database).
- `transform/postgresql_labels` copies `postgresql.database.name`,
  `schema.name`, `table.name` and `index.name` from resource to datapoint
  attributes. GreptimeDB drops resource attributes, so without the copy every
  table's series would share labels and overwrite one another.
- The receiver always opens its first connection to the `postgres`
  maintenance database, whatever `databases` lists. A role without `CONNECT`
  there yields no metrics. The collector opens about two short connections per
  scrape.

#### Uptime, TLS and nginx metric tables

Every table has `greptime_timestamp` and `greptime_value` (`Float64`), and
String tags. `host_name` is the real host. There are no `service_name` or job
columns.

| Table | Tags | Notes |
|---|---|---|
| `httpcheck_status` | `host_name`, `http_method`, `http_status_class`, `http_status_code`, `http_url` | Five rows per URL per scrape, one per class `1xx` to `5xx`. Value `1` on the matched class, and only that row has `http_status_code` (a string such as `'200'`). All five are `0` when the request errored. |
| `httpcheck_duration_milliseconds` | `host_name`, `http_url` | Request duration. |
| `httpcheck_error` | `error_message`, `host_name`, `http_url` | Value `1`. Created and written only on failure; no table or no recent rows means no errors. |
| `httpcheck_tls_cert_remaining_seconds` | `host_name`, `http_tls_cn`, `http_tls_issuer`, `http_url` | `https` targets only. Negative means expired. The `http.tls.san` list is dropped by GreptimeDB. |
| `nginx_requests_total` | `host_name` | Cumulative requests. |
| `nginx_connections_accepted_total`, `nginx_connections_handled_total` | `host_name` | Cumulative connections. |
| `nginx_connections_current` | `host_name`, `state` | `state` is `active`, `reading`, `writing` or `waiting`. |

### 11.4 Routes

Six routes, all under `TelemetryDashboardController`, all gated by
`telemetry:query` — the same permission as the Explorer, because the
dashboard reads telemetry DATA, not policy (`telemetry:read`/`write` gate the
deployment-wide policy instead; see [§7](#7-security-model)):

| Route | Purpose |
|---|---|
| `GET /api/admin/telemetry/dashboard/summary` | The verdict and headline tiles (requests/min, 5xx rate, p95, error/warning logs, latest data), plus optional runtime tiles |
| `GET /api/admin/telemetry/dashboard/timeseries` | `panel=api` (status classes + p95 per bucket) or `panel=logs` (severity bands per bucket) |
| `GET /api/admin/telemetry/dashboard/top` | `kind=routes` (top 5xx offenders) or `kind=errors` (top error messages) |
| `GET /api/admin/telemetry/dashboard/events` | Log events, newest first, keyset-paginated |
| `GET /api/admin/telemetry/dashboard/filters` | Distinct `service`/`instance` values seen in the window, and the `hosts` the host metrics report (`host_name` of `system_cpu_load_average_1m`) |
| `GET /api/admin/telemetry/dashboard/metrics` | `group=host\|database\|queue\|nodes\|uptime\|pipeline`: one group of the metric catalog — tiles, series and per-key tables (§11.14). Also takes `host` |

Every response carries `range`, `generatedAt`, `truncated` and `sql` (the
exact statement(s) run, primary first) — the same seam each panel's
"Open in Explorer" action uses (§11.1), and useful on its own for anyone
who wants to paste the statement into a BI tool. A shared window query
(`range` or `from`/`to`, `service`, `instance`, `buckets`) is validated by
`refineWindow` (`apps/api/src/telemetry/dto/telemetry-dashboard.dto.ts`):
either `range` or `from`+`to`, never both; `from < to`; `to` at most one
minute ahead (clock skew); span at most 30 days. `/metrics` adds `host`
(1–200 characters), validated like `service`/`instance` against the window's
`/filters` `hosts`; an unknown value is the same 400
`TELEMETRY_DASHBOARD_BAD_FILTER` with `details.field: "host"`.

### 11.5 SQL safety

Unlike the Explorer, **nothing here is caller-supplied SQL**: every
statement is a template function in `telemetry-dashboard.sql.ts`, filled
only with

- fixed identifiers (table/column names), quoted with doubled `"`;
- `Date`s the request validation already produced, rendered as ISO literals;
- `service`/`instance` values the service has already checked against the
  distinct values seen in the range (`/filters`, cached 60 s);
- the event search text, reduced by `likeContainsPattern` (control
  characters stripped, capped at 200 characters, `\`/`%`/`_` escaped, `'`
  doubled) and used only inside `ILIKE '%…%' ESCAPE '\'`;
- a pagination cursor whose timestamp and span id are checked against strict
  regular expressions before they are ever concatenated.

**The metric catalog (§11.14) follows the same discipline.** Its builders
(`apps/api/src/telemetry/metrics/metric-sql.ts`) share the literal helpers
with the templates above (`dashboard/sql-literals.ts`: `ident`, `literal`,
`timestampLiteral`, `bucketInterval`, `positive`). Identifiers are catalog
constants or column names the store itself reported in
`information_schema.columns` (the `lag` partition of a counter is every tag
column of its table); label predicates are catalog constants (`state =
'idle'`); `service`/`instance`/`host` are values already matched against the
window's distinct values. A builder whose table or column is absent returns
`null` and nothing is sent.

**No bind parameters**: GreptimeDB's Postgres wire refuses `$1` (a spike
finding). Every statement carries a literal top-level `LIMIT`, never a
subquery wrapper for the row cap — the same "wrapping drops the inner
`ORDER BY`" finding the Explorer's row cap already works around (§5).

**Streaming (SSE) routes are excluded from latency, not from counts.** Every
SSE route of this API ends in `/stream` (`GET
/api/notifications/stream`, `POST /api/ai/responses/stream`, `POST
/api/admin/telemetry/assistant/stream`); its server span lasts as long as the
subscription (observed: `GET /api/notifications/stream` at a p95 of several
seconds), which would push the window's overall p95 past the verdict
threshold on connection lifetime, not responsiveness. The exclusion is a
`CASE` inside the percentile's `ORDER BY`, applied only to: the p95 tile
(current, previous, sparkline), the API time-series p95 line, and the
verdict's "slowest route" offender. Streams still count in requests, status
classes and error rates, and the top-routes table keeps its own per-route
p95 for a stream (that number is honest there: it is the stream's own row).

### 11.6 Bounds, caching, and why this is not a queue job

Every route runs the same five-step flow
(`apps/api/src/telemetry/dashboard/telemetry-dashboard.service.ts`):
preconditions (`requireQueryablePolicy`: 503 not configured, 409 disabled —
checked **before** the cache, so a disabled store never serves a cached
answer) → resolve the window and bucket size → the 15-second **result
cache**, keyed by route and normalized parameters (a relative `range` keys by
its name, not its resolved instants), with concurrent identical requests
sharing one in-flight promise → on a miss, which tables/columns exist
(`TelemetrySchemaService`, cached 30 s, so a fresh store degrades to empty
panels instead of failing) and the distinct-values check for
`service`/`instance` (cached 60 s) → an audit row per store read
(`telemetry:dashboard`, action `TELEMETRY_DASHBOARD_AUDIT_ACTION`), including
failures; **a cache hit is not audited**, since nothing was read from the
store. The instance filter never applies to a runtime tile when
`tracesHaveInstance` is false for traces, or never for the metric tables
(§11.3).

**Not a queue job**, per CLAUDE.md's "every long-running activity is a queue
job": every statement is bounded by the policy's client-side timeout and a
literal `LIMIT`, and none outlives the HTTP request that started it — no
`@Cron`, no `@OnEvent`, no detached promise. The two caches expire lazily on
read, capped at 500 entries each (oldest evicted first).

### 11.7 Verdict rules

`computeVerdict` (`apps/api/src/telemetry/dashboard/telemetry-dashboard
.verdict.ts`) is one pure function over numbers the summary has already
computed — four traffic rules, each with a **volume guard** so a quiet
deployment does not flap red on one failed request, and nine infrastructure
rules (#126). The level reported is the worst rule that fired; `reasons`
carries one line per fired rule with its value, the threshold it crossed, and
the worst offender (route, message, mountpoint, host, server, job type or URL,
cut to 80 characters). Every threshold lives in
`DASHBOARD_VERDICT_THRESHOLDS`:

| Rule | Degraded | Critical | Volume guard |
|---|---|---|---|
| 5xx rate | > 2 % | > 5 % | ≥ 20 requests in the window |
| p95 latency (streams excluded, §11.5) | > 1000 ms | > 3000 ms | ≥ 20 requests in the window |
| Error logs vs. the previous window | ≥ 3× | ≥ 10× | ≥ 10 error logs now (a previous count of 0 counts as 1, so the very first burst still ranks as a ratio) |
| No data | — | — | `now − latest trace/log > 5 min` **overrides every other rule**: the other rules would be judging silence |
| Disk utilization (worst mountpoint) | ≥ 85 % | ≥ 95 % | `system_filesystem_utilization_ratio` exists |
| Memory utilization (worst host, `state = used`) | ≥ 90 % | ≥ 97 % | `system_memory_utilization_ratio` exists |
| DB connections (`postgresql_backends` summed ÷ `postgresql_connection_max`, worst server) | ≥ 80 % | ≥ 95 % | both tables exist |
| Oldest due pending job (worst job type) | ≥ 10 min | ≥ 30 min | `app_jobs_oldest_pending_age_seconds` exists |
| Worker nodes | any `stale` node | a node-offered job type with pending work and no eligible node (`app_nodes_types_no_eligible_node = 1`), naming the types | `app_nodes_count` or the no-eligible table exists |
| TLS certificate (soonest URL) | < 14 days | < 7 days (negative = expired) | `httpcheck_tls_cert_remaining_seconds` exists (`https://` targets only) |
| Uptime check | the latest check of a URL failed (non-2xx or error) | every check of a URL in the lookback failed (≥ 2 checks) | `httpcheck_status` exists |
| Collector exports (window) | any failed metric point | failed ≥ 10 % of sent + failed, naming the exporter | `otelcol_exporter_*_metric_points_total` exist |
| Last successful backup | > 26 h | > 50 h | `app_backup_last_success_timestamp_seconds` has a reading |

**How the infrastructure inputs are gathered** (`apps/api/src/telemetry/metrics/metric-verdict.ts`):
the summary adds **one small statement per rule family** — host, database,
queue, nodes, uptime, TLS, pipeline — to its existing `Promise.all`, inside
the same 15-second result cache and audit row. A statement whose tables are
all absent is not run, and a rule without its input is skipped, so a store
without, say, PostgreSQL metrics simply has no database rule. Gauges are read
over the last 10 minutes before `to` (`VERDICT_PROBE_LOOKBACK_MS`), and only
**fresh** keys count: a key whose newest reading is more than 150 s older
than its part's newest (`VERDICT_FRESH_MS`) has stopped reporting — a drained
job type under delta temporality (§11.13), an unmounted filesystem, a URL no
longer probed. Collector failures are counted over the dashboard window.
`service`/`instance` filters do not apply: the infrastructure is shared. The
infrastructure rules are overridden by "no data" like every other rule.

### 11.8 Error reasons

`TELEMETRY_DASHBOARD_BAD_FILTER` (400, `service`/`instance` not among the
window's distinct values) and `TELEMETRY_DASHBOARD_BAD_CURSOR` (400, a
malformed events `cursor`) are dashboard-specific; every store-level reason
(`TELEMETRY_NOT_CONFIGURED`, `TELEMETRY_UNREACHABLE`, `TELEMETRY_DISABLED`,
`TELEMETRY_QUERY_FAILED`, `TELEMETRY_QUERY_TIMEOUT`) is shared with the
Explorer. Full table: [§5](#5-explorer).

### 11.9 Web page

`TelemetryDashboardPage.tsx` (`/admin/settings/telemetry/dashboard`) is
appended to `ADMIN_SECTIONS` (Observability), gated the same way as the
Explorer card: `telemetry:query` plus the `telemetry` feature (a store is
deployed and collection is on) — see the [Settings UI pattern](../../CLAUDE.md#mandatory-settings-ui-pattern).
The route itself re-checks the permission with `RequirePermission`, and the
page checks it again as defence, not the gate.

- **URL contract** (`dashboardState.ts`): everything a reader might want to
  share or return to lives in the query string — `range` (default `1h`) or a
  zoomed `from`/`to` (wins over `range`, which stays in the URL alongside it
  so "Reset zoom" returns to the preset), `service`/`instance`, `sev`
  (log severities, default `error,warn`), `q` (events search), `refresh`
  (`30` or `off`, default on). Anything invalid falls back to its default
  rather than erroring, so a mangled link still opens a working dashboard;
  defaults are left out of the URL entirely.
- **Per-panel independence**: each panel (`useTelemetryDashboard.ts`) fetches
  on its own, aborts an in-flight request when a newer one starts (a filter
  change, a refresh tick, a Retry), keeps its last good result on screen
  while refreshing (`isRefreshing`) rather than blanking it, and reports its
  own failure with a Retry that refetches only that panel — a slow or
  failing endpoint never blocks the rest of the page. A **store-level**
  failure on the summary (`TELEMETRY_DISABLED`, `TELEMETRY_NOT_CONFIGURED`,
  `TELEMETRY_UNREACHABLE`) instead replaces the whole page with one alert
  linking to Telemetry settings, since nothing on the page could work anyway.
- **Auto-refresh**: every 30 s (`?refresh=off` to stop), through
  `useVisiblePolling` — paused while the tab is hidden, and refreshed at once
  on return, so a backgrounded tab is never quietly stale nor burning
  requests nobody sees. The events feed additionally skips a refresh tick
  once the reader has paged past the first page, so rows they scrolled to do
  not collapse under them every 30 seconds.
- **Zoom**: dragging (or, on touch, tapping) across the API or log timeline
  sets `from`/`to` to that span (`ZoomBrush.tsx`, `bucketWindow`); a "Reset
  zoom" chip in the filter bar drops back to the preset range.
- **Infrastructure sections** (#127): below the Recent events feed, six
  first-class panels over `GET …/metrics` (§11.14), one request per group
  (`useDashboardMetrics`, on the same per-panel engine and refresh tick), in
  this order:

  | Section | `group` | Tiles | Chart | Table(s) |
  |---|---|---|---|---|
  | Infrastructure | `host` | CPU, memory, load 1m, worst filesystem | CPU % and memory % | Filesystems per mountpoint, used % as a bar beside its number |
  | Database | `database` | Connections used %, database size, commits/s, cache hit % | Connections vs max connections | Largest tables |
  | Job queue | `queue` | Pending depth, oldest pending, failure ratio, duration p95, last backup age | Jobs settled/min by outcome (succeeded green, failed red) | Job types |
  | Worker nodes | `nodes` | Healthy, stale, offline, types with no eligible node | — | Nodes (CPU, RSS, heap % bar, disk free %, slots used/total); node-offered job types, "None eligible" first |
  | Uptime & dependencies | `uptime` | nginx active connections, nginx requests/s, TLS days left, check duration | nginx connections by state | Uptime targets: Up/Down, status, latency, TLS days left, failed checks, last error — failing URLs first |
  | Telemetry pipeline | `pipeline` | Points failed, exporter queue used %, points refused, scrape targets down | — | Scrape targets: Up/Down per job |

  Which tiles, series and tables a section draws is declared as data
  (`SECTION_SPECS` in `components/telemetry/dashboard/metrics/MetricSections.tsx`)
  over three generic renderers: the headline `KpiTiles` (reused as is),
  `MetricSeriesChart` (one line per series and `groupBy` value, one unit per
  chart, `null` a gap) and `MetricTable` (every cell formatted by its
  column's unit through `format.ts` — `%`, `bytes`, `bytes/s`, `count`,
  `per_s`, `per_min`, `ms`, `seconds`, `hours`, `days`, `cores`, `load`,
  `text`, `boolean`, `timestamp` — `null` as "—"). Anything the response
  lacks is left out, never shown empty: a skipped family or table is named
  only as a count in a caption ("2 metrics of this section are not collected
  in this store"), a truncated list says so, and a group with
  `available: false` hides its whole section — the page then adds one line,
  "Not collected in this telemetry store: …", naming the hidden sections.
  Before its first answer a section shows its skeleton; a failure is that
  section's own, with its own Retry.
- **Host filter** (`?host=`, #127): a Host select beside Service and Instance
  (in the tablet popover and the phone Filters dialog likewise), listing
  `/filters` `hosts`, and offered only once there are any (or the URL
  carries one) — with no host metrics it would filter nothing. It is sent to
  `/metrics` only, since the API applies it to the collector's tables alone
  (§11.14 Filters); every other panel's request is unchanged.
- **Verdict reasons link to their section** (#127): a reason written by one
  of the infrastructure rules (§11.7 — disk, memory, DB connections, queue
  age, backup, nodes, TLS, uptime, collector exports) gets a "Show
  <section>" link after it, when that section is on screen. It scrolls to
  the section's region (`id="telemetry-section-<group>"`, `tabIndex=-1`,
  with a scroll margin for the sticky AppBar) and moves focus there, so a
  screen reader lands on the section's heading. The mapping reads the API's
  reason wording (`verdictReasonGroup` in `metrics/metricSections.ts`); the
  traffic and no-data reasons get no link.

### 11.10 Responsive layout

Layout is decided inside this page alone (phone `< sm`, tablet `sm`–`lg`,
desktop `≥ lg`) — none of the shell's five coupled breakpoint gates
(CLAUDE.md, [settings-ui.md](settings-ui.md#breakpoint-gates)) is touched:

| Element | Phone (`< sm`) | Tablet (`sm`–`lg`) | Desktop (`≥ lg`) |
|---|---|---|---|
| Filter bar | Sticky compact bar (range chip + Filters); a full-screen dialog holds every control, applied as a draft on "Apply" | Range as a `Select`; service/instance/refresh behind a "Filters" popover | Everything inline; range as a `ToggleButtonGroup` |
| Tiles/timelines | Half the buckets (30 vs. 60) — 60 bars in ~340 px are slivers | Full bucket count | Full bucket count |
| Timeline zoom | Tap a bucket to select it | Drag or tap | Drag to select a span |
| Top problems (routes/errors) | One panel, a Routes/Errors toggle, a card list | Two panels, stacked | Two panels, side by side |
| Events feed | A card list (severity chip + relative time, two-line message) | A table without the service column | A full table (time, severity, service, message) |
| Panel actions (§11.1) | Folded into one `⋮` menu | Icon buttons | Icon buttons |
| Assistant (§11.1) | Full-screen `Dialog` | Overlay `Drawer` with a backdrop (Escape or a backdrop click closes it) | Persistent, docked 400px-wide `Drawer` below the AppBar; the page pads its content by that width so nothing sits underneath it |
| Host filter (#127) | In the Filters dialog, applied with the draft | In the Filters popover | Inline after Instance |
| Infrastructure sections (#127) | Full width; tiles two per row; chart then table stacked, 200 px chart with its legend below; a wide table scrolls sideways inside its own box | Full width; tiles three per row; chart then table stacked | Full width; tiles six per row; chart (5/12) beside its table (7/12) when a section has both |

Each panel's header keeps its actions row consistent across panels and
layouts: "Ask assistant" first (only where offered), then "Open in
Explorer", as icon buttons from `sm` up and folded into the `⋮` menu on
phones. Below `sm`, `DashboardPanel` renders `[title …… ⋮]` on one row and
moves `headerExtra` (severity chips, the Top problems Routes/Errors toggle)
to its own full-width row underneath, in that DOM order so focus order
matches the screen; from `sm` up the header, chips and actions all sit on
one row (tablet's 820 px already fits them).

Closing the assistant returns focus to whatever control opened it — the
panel's own header button on tablet/desktop, or, on a phone, the `⋮` button
that opened the menu the "Ask assistant" item came from (the menu item
itself is gone by the time the assistant closes).

Any event row opens the full record (body, exact timestamp, service, trace
id, span id) in a dialog — full-screen on phones; MUI's `Dialog` traps focus
and restores it to the row on close.

**Known gap**: dragging to zoom a timeline has no keyboard equivalent today;
a keyboard user reaches the same window through the range and filter
controls instead, just not by selecting a span on the chart itself.

### 11.11 Tests

- `apps/api/src/telemetry/dashboard/telemetry-dashboard.sql.spec.ts` — every
  SQL template, literal-escaping and the SSE exclusion.
- `apps/api/src/telemetry/dashboard/telemetry-dashboard.verdict.spec.ts` —
  the four traffic rules and their volume guards, and each infrastructure
  rule at both levels, its offender and its absence (#126).
- `apps/api/src/telemetry/metrics/metric-sql.spec.ts` — snapshots of every
  catalog family and table, with and without filters, the uptime, host and
  verdict-probe statements, absent-table skips, and guard acceptance.
- `apps/api/src/telemetry/metrics/metric-catalog.spec.ts` — the catalog's
  invariants against the verified table shapes
  (`apps/api/src/telemetry/testing/metric-schema.fixture.ts`).
- `apps/api/src/telemetry/metrics/metric-group.spec.ts` — tiles, series,
  tables, ratios, histogram quantiles, delta-gauge freshness and row caps.
- `apps/api/src/telemetry/metrics/metric-verdict.spec.ts` and
  `metric-values.spec.ts` — probe rows to verdict inputs; quantile
  interpolation and value parsing.
- `apps/api/src/telemetry/dashboard/telemetry-dashboard.service.spec.ts` —
  window resolution, caching (including the shared in-flight promise),
  filter validation, the audit row.
- `apps/api/src/telemetry/dashboard/telemetry-dashboard.greptime.spec.ts` —
  the real-database tier, over an actual GreptimeDB. With
  `GREPTIME_TEST_ADMIN_URL` on a store without catalog tables (CI) it creates
  look-alikes of every verified metric table, seeds 40 minutes of rows
  (including a counter reset) and checks every group, `/filters` `hosts` and
  the verdict probes end to end.
- `apps/api/test/telemetry/telemetry-dashboard.integration.spec.ts` — routes,
  RBAC (`telemetry:query`), error shapes.
- `apps/web/src/__tests__/pages/Admin/TelemetryDashboardPage.test.tsx` — the
  page, its panels and the responsive layout, over
  `apps/web/src/__tests__/mocks/fixtures/telemetryDashboard.ts`.
- `apps/web/src/__tests__/pages/Admin/TelemetryDashboardPage.drilldown.test.tsx`
  — the triage model: "Open in Explorer" and "Ask assistant" per panel,
  "Explain this" on the verdict banner, "View trace" gated on a real trace
  id, the assistant frame per layout, and focus returning to the invoking
  control.
- `apps/web/src/__tests__/components/telemetry/dashboard/assistantPrompt.test.ts`
  — `buildAssistantQuestion` per panel kind and its length/count bounds.
- `apps/web/src/__tests__/pages/Admin/TelemetryDashboardPage.metrics.test.tsx`
  (#127) — the infrastructure sections in order below the application
  panels, a hidden unavailable group and the "not collected" line, one
  `/metrics` request per group, a section's own error and Retry, the Host
  filter (sent to `/metrics` only, from the URL, hidden without hosts, in the
  phone dialog), verdict reasons linking to and focusing their section, and
  each section's "Open in Explorer" and "Ask assistant".
- `apps/web/src/__tests__/components/telemetry/dashboard/metrics/` (#127) —
  each section's tiles, chart and tables, and the unavailable, skipped,
  truncated, empty, loading and error states (`MetricSections.test.tsx`);
  unit-aware cells, virtual columns, row order and status as icon + word
  (`MetricTable.test.tsx`); the chart's accessible name and line cap
  (`MetricSeriesChart.test.tsx`); the reason-to-section mapping
  (`metricSections.test.ts`). `format.test.ts` covers every metric unit;
  `apps/web/src/__tests__/services/telemetryDashboard.test.ts` and
  `apps/web/src/__tests__/hooks/useTelemetryDashboard.test.tsx` the
  `/metrics` query (with `host`) and `useDashboardMetrics`.
- `apps/web/src/__tests__/components/telemetry/dashboard/traceLink.test.ts` —
  `isTraceId` and `traceExplorerSql`, including the injection argument above.
- `apps/web/src/__tests__/components/telemetry/explorerHandoff.test.ts` — the
  `state`-vs-`?sql=` precedence, the `TELEMETRY_SQL_MAX_LENGTH` bound, and
  that a handoff is read once and cleared.
- `apps/web/src/__tests__/hooks/useTelemetryAssistantAvailable.test.tsx` — the
  shared availability condition (assistant switch, AI switch, `ai:use`).
- `tests/visual/specs/telemetry-dashboard.spec.ts` — 15 pixel baselines: the
  `critical` (every infrastructure section available, #127) and `no_data`
  (every section hidden) verdicts at 390×844 (phone), 820×1180 (tablet) and
  1440×900 (desktop), each in light and dark, plus the phone Filters dialog,
  the phone full-screen assistant dialog and the tablet overlay assistant
  drawer (the prefilled question is part of the picture). Every `/api` call
  is answered with fixtures through `page.route()`
  (`tests/visual/support/telemetryDashboard.ts`), with `Date.now()` pinned
  (`page.clock.setFixedTime`) and the time zone/locale pinned so relative
  times, bars and axis ticks never move; `?refresh=off` stops auto-refresh
  mid-shot. Generated and verified in the pinned
  `mcr.microsoft.com/playwright:v1.62.1-noble` container, per
  [TESTING.md](../TESTING.md).
- `tests/e2e/specs/telemetry-dashboard.spec.ts` — against a running stack,
  **not run in CI**: opening the dashboard from the Console, zooming a
  timeline by drag or tap, filtering by service, "Open in Explorer" loading
  SQL without a query run, "Ask assistant" opening prefilled, the
  Dashboard↔Explorer↔settings cross-links, and no horizontal scroll at
  phone/tablet/desktop widths. Each test skips with a stated reason —
  telemetry not deployed and switched on in this stack, a fresh store with
  no data yet for a step that needs it, or the assistant unavailable — rather
  than failing when the stack cannot support it.

### 11.12 Design decisions

- **A fixed dashboard, not a saved-query builder.** The Explorer already
  covers "run whatever SQL you want"; a dashboard whose statements are
  server-authored templates cannot be misused as an injection surface and
  needs no query-editor UI. The cost is inflexibility, accepted deliberately:
  anyone who needs a different cut of the data has the Explorer, and a
  one-click path into it from every panel (§11.1).
- **A handed-over statement or question is never auto-run or auto-sent.**
  "Open in Explorer", "View trace" and a report query all load their SQL
  into the Explorer's editor and stop there; "Ask assistant" and "Explain
  this" prefill the assistant's input and stop there. Every one of these
  statements is composed by something other than the reader — a dashboard
  panel's own aggregation, or an AI-drafted report — and none of them has
  been reviewed yet; requiring a press of Run or Ask keeps a human in the
  loop before anything executes or reaches a model, and keeps the Explorer's
  own SQL guard the single place that decides whether a run is allowed.
- **A verdict with volume guards, not a raw error-rate threshold.** An
  unguarded "> 5% error rate" flags red on a single failed request in a
  quiet deployment. Requiring a minimum sample size before a rule may fire
  was chosen over, for example, a longer lookback window, because it keeps
  the verdict responsive to a real burst without smoothing it away.
- **Fixed thresholds, not per-deployment configuration.** A configurable
  verdict threshold is a second settings surface for a feature meant to give
  a same-day answer with no setup; the thresholds (§11.7) are chosen to be
  reasonable defaults for a typical web API, not tuned per deployment. A
  fork that disagrees changes `DASHBOARD_VERDICT_THRESHOLDS` directly.
  Rejected: a settings namespace, deferred until real usage shows the
  defaults are wrong for common cases.
- **Errors grouped by their literal first 200 characters**, not a
  normalized message template (stack trace stripped, ids redacted). Message
  templating is real work (a fork's error messages are not this template's
  to normalize) and the literal grouping is honest about what it does: two
  errors differing only in an embedded id show up as two rows, which is a
  known limitation an administrator can see immediately rather than a
  silent miscount.
- **`host.name` from the host's `/etc/hostname`.** Inside a container every
  in-process source (`os.Hostname()`, the `system` resource detector, even
  `/hostfs/proc/sys/kernel/hostname`, since the UTS namespace is the reader's)
  returns the container id, which changes on every recreate. The config's
  `file` provider reads `/hostfs/etc/hostname` at startup. Whitespace is
  stripped, because the value arrives with its trailing newline. The collector
  refuses to start when the file is missing, rather than labelling the host
  with a container id. Rejected: `resourcedetection` (container id) and a
  `HOST_NAME` variable (a second source of truth to configure).
- **Host metrics get their own pipeline.** Only in `metrics/local` is it true
  that the data describes this machine, so only there is `host.name` stamped.
  An OTLP sender keeps whatever `host.name` it reported.
- **Network is the collector's namespace, and stays.** `/proc/net` resolves to
  `/proc/self/net`, the reader's network namespace. Host NIC throughput would
  need `network_mode: host`, rejected: the collector must sit on the compose
  network and stay unpublished. The series remain because they show whether
  the telemetry path is moving bytes.
- **`rslave` on the VPS overlay only.** It makes a disk mounted after the
  collector started appear under `/hostfs`; without it the filesystem scraper
  reports the root disk's usage under the new mount point. It needs a shared
  `/`, which systemd hosts have, and fails on private-`/` hosts such as Docker
  Desktop, so `telemetry.compose.yml` leaves propagation at the default.
- **A keep-list for GreptimeDB's `/metrics`.** Every metric becomes its own
  table and GreptimeDB exports about 130; the `metric_relabel_configs`
  keep-list retains about 30 (version, HTTP/OTLP front door, write stalls,
  limits, process). `/metrics` needs no credentials, so the scrape config
  carries none. The collector's own metrics are exposed on `127.0.0.1:8888`
  only and are not published.
- **Host metric tiles live in the metric catalog, not the summary.** The
  summary's fixed tiles (§11.1) still read spans, logs and the two runtime
  metrics; host, database, queue, node, uptime and pipeline data is served per
  group by `/metrics` (§11.14), and reaches the summary only as verdict
  inputs (§11.7).

- **Liveness, not readiness, for uptime.** Readiness reads the database and
  returns `503` during maintenance mode, so a PostgreSQL outage would read as
  the API being down. Liveness answers "is the process serving".
- **Three targets, so a fault can be placed.** The API alone against the app
  through nginx separates an API fault from a proxy fault; the public origin
  adds DNS, TLS and the host proxy. Rejected: one public-only probe, which
  cannot tell those apart.
- **`UPTIME_PUBLIC_URL` set by the overlays, not an `.env` key.** The VPS
  overlay derives it from `APP_URL`, which `evopathcli deploy` already sets, so
  TLS expiry needs no configuration. Rejected: a new variable to fill in.
- **An internal listener for `stub_status`, not a public location.** The
  status page counts every request, so it is served on `:8081`, which no
  compose file publishes, behind an allow-list of private ranges. Rejected:
  a location on the public server guarded only by `allow`/`deny`, one
  misconfigured proxy away from exposure.

### 11.13 Application metrics

> **Code:** `apps/api/src/common/otel/app-metrics.service.ts`, `app-metrics.module.ts`

`AppMetricsModule` (global) exposes `AppMetricsService`, the one place the application's own metrics are defined: meter scope `app`, every name prefixed `app.`. Jobs, backups, auth, AI and notifications call its typed `record*` methods. The only other code that creates `app.*` instruments is the node fleet gauges (`nodes/node-fleet-metrics.service.ts`, see Gauges below), and it takes its names from the same `APP_METRIC_NAMES` table. With `OTEL_ENABLED` unset the service is a no-op.

#### Table naming (verified live, GreptimeDB v1.2.1)

Verified on 2026-09-29 by exporting one point per instrument (cumulative temporality, OTLP protobuf) to a throwaway GreptimeDB. The rules:

| Instrument | Table(s) | Rule |
|---|---|---|
| Counter | `<name>_total` | Dots become `_`; `_total` is appended. A curly-brace unit (`{job}`) adds no suffix. |
| Histogram | `<name>_<unit>_bucket`, `_sum`, `_count` | Unit `s` gives `_seconds`, `By` gives `_bytes`. The `_bucket` table has a string `le` tag (`"0.05"`, `"1"`, `"inf"`). |
| Gauge, unit `s` or `By` | `<name>_seconds` / `<name>_bytes` | Same unit suffix. |
| Gauge, curly-brace unit | `<name>` | No suffix. |

Every table has `greptime_timestamp`, `greptime_value`, `service_name`, a `job` tag (the service name again; not the queue `job_type`) and one tag per attribute. Through the collector, `transform/promote_labels` (§11.2) also adds `app_instance_id` and `host_name` (the API container's hostname), so a series can be told apart per deployment and per API replica; the verification above exported straight to GreptimeDB and so showed neither.

#### Metric reference

| Metric | Table(s) | Kind | Unit | Attributes (values) | Recorded |
|---|---|---|---|---|---|
| `app.jobs.enqueued` | `app_jobs_enqueued_total` | counter | `{job}` | `job_type` | A job row is created. |
| `app.jobs.claimed` | `app_jobs_claimed_total` | counter | `{job}` | `job_type`, `executor` (`server`, `node`) | A worker or node claims a job. |
| `app.jobs.settled` | `app_jobs_settled_total` | counter | `{job}` | `job_type`, `outcome` (`succeeded`, `failed`, `retry-scheduled`, `rate-limit-deferred`, `claim-lost`, `write-failed`), `executor` (`server`, `node`, `unknown`) | A claimed job reaches a settlement outcome. Counted automatically; handlers add nothing. |
| `app.jobs.duration` | `app_jobs_duration_seconds_{bucket,sum,count}` | histogram | `s` | same as `app.jobs.settled` | With `settled`, only when `startedAt` is known. Buckets 0.05 to 3600. |
| `app.jobs.reaped` | `app_jobs_reaped_total` | counter | `{job}` | `outcome` (`requeued`, `failed`); `job_type` on `failed` only | The lease reaper recovers an expired job. |
| `app.backup.runs` | `app_backup_runs_total` | counter | `{run}` | `outcome` (`completed`, `failed`) | A backup run settles. |
| `app.backup.duration` | `app_backup_duration_seconds_{bucket,sum,count}` | histogram | `s` | `outcome` | With `runs`. |
| `app.backup.size` | `app_backup_size_bytes_{bucket,sum,count}` | histogram | `By` | `outcome` (`completed`) | A backup completes. |
| `app.auth.logins` | `app_auth_logins_total` | counter | `{login}` | `provider` (`google`), `outcome` (`success`, `allowlist_rejected`, `disabled`) | An OAuth sign-in resolves. |
| `app.auth.refreshes` | `app_auth_refreshes_total` | counter | `{refresh}` | `outcome` (`success`, `invalid`, `reuse_detected`, `expired`, `user_inactive`, `device_revoked`) | A refresh-token rotation is attempted. |
| `app.ai.requests` | `app_ai_requests_total` | counter | `{request}` | `provider`, `model`, `operation`, `status` (`succeeded`, `failed`, `cancelled`), `key_source` | An AI usage event is recorded. |
| `app.ai.tokens` | `app_ai_tokens_total` | counter | `{token}` | `provider`, `model`, `operation`, `token_type` (`input`, `output`) | With the usage event. |
| `app.ai.request.duration` | `app_ai_request_duration_seconds_{bucket,sum,count}` | histogram | `s` | `provider`, `model`, `operation`, `status`, `key_source` | With the usage event. |
| `app.notifications.deliveries` | `app_notifications_deliveries_total` | counter | `{delivery}` | `channel`, `event`, `outcome` (`sent`, `failed`, `rate_limited`, `error`) | A channel delivery attempt ends. |
| `app.health.documents.purges` | `app_health_documents_purges_total` | counter | `{document}` | `outcome` (`purged`, `failed`) | A `health.document.purge` attempt erases a file or fails (and is retried). |
| `app.health.documents.downloads` | `app_health_documents_downloads_total` | counter | `{download}` | `disposition` (`inline`, `attachment`) | `GET /api/health/documents/:id/download` issues a signed link. |
| `app.health.documents.deletes` | `app_health_documents_deletes_total` | counter | `{document}` | `scope` (`file`, `record`), `values` (`kept`, `deleted`) | The owner deletes a health document: `file` queues the file's purge, `record` removes the metadata of a file already gone. |
| `app.health.exports` | `app_health_exports_total` | counter | `{export}` | `format` (`json`, `csv`, `xlsx`, `pdf`), `outcome` (`completed`, `failed`) | A `health.export` attempt writes its file or fails. |
| `app.health.export.duration` | `app_health_export_duration_seconds_{bucket,sum,count}` | histogram | `s` | `format`, `outcome` | With `exports`. |
| `app.health.export.size` | `app_health_export_size_bytes_{bucket,sum,count}` | histogram | `By` | `format` | An export completes. |
| `app.health.summary.generations` | `app_health_summary_generations_total` | counter | `{summary}` | `outcome` (`ready`, `rejected`, `failed`, `skipped`, `deferred`) | An `ai.health.summary` job ends. |
| `app.health.summary.duration` | `app_health_summary_duration_seconds_{bucket,sum,count}` | histogram | `s` | `outcome` | Wall time of one `ai.health.summary` job. |
| `app.health.summary.regenerations` | `app_health_summary_regenerations_total` | counter | `{regeneration}` | none | An answer asked for again after a post-check rejection. |
| `app.health.summary.post_check_rejections` | `app_health_summary_post_check_rejections_total` | counter | `{answer}` | none | An answer the post-check rejected. |
| `app.health.summary.tokens` | `app_health_summary_tokens_total` | counter | `{token}` | `token_type` (`input`, `output`) | Tokens the health summary used. |
| `app.coach.guard.rejected` | `app_coach_guard_rejected_total` | counter | `{rejection}` | `reason` (`profanity`, `banned_term`, `insult_target`, `lock_screen`, `invented_number`, `length`, `supportive_register`) | The coach content guard refuses a message; one count per failed rule, never the text. |
| `app.coach.settings.updated` | `app_coach_settings_updated_total` | counter | `{update}` | `persona` (the selected persona id) | A user saves coach settings through `PUT /api/coach/settings`. |
| `app.coach.photo.added` | `app_coach_photo_added_total` | counter | `{photo}` | none | A user adds a progress photo. Counts only; nothing about the photo. |
| `app.coach.photo.deleted` | `app_coach_photo_deleted_total` | counter | `{photo}` | none | A user deletes a progress photo. |
| `app.coach.nudge.sent` | `app_coach_nudge_sent_total` | counter | `{message}` | `moment` (a coach moment, or `unknown`) | `coach.message.deliver` delivers a coach message. |
| `app.coach.nudge.suppressed` | `app_coach_nudge_suppressed_total` | counter | `{nudge}` | `reason` (`model_declined`, `coach_off`, `paused`, `no_model`, `ai_error`, `guard_rejected`, `already_sent`), `moment` | An `ai.coach.nudge` job ends without a message. The planner's own suppressions are a different, un-prefixed metric (`coach.nudge.suppressed`, below). |
| `app.coach.nudge.fallback` | `app_coach_nudge_fallback_total` | counter | `{message}` | `moment` | A static persona line replaces a model message after two guard rejections. |
| `app.coach.nudge.opened` | `app_coach_nudge_opened_total` | counter | `{message}` | `moment` | A coach message is opened for the first time. |
| `app.coach.nudge.converted` | `app_coach_nudge_converted_total` | counter | `{message}` | `moment`, `target` (`workout`, `check_in`, `photo`), `angle` (a learning-loop angle, or `none`) | A delivered message is followed by its target action inside the conversion window. |
| `app.coach.feedback` | `app_coach_feedback_total` | counter | `{feedback}` | `value` (`up`, `down`, `cleared`) | A user rates a coach message or removes the rating. |
| `app.coach.angle.picked` | `app_coach_angle_picked_total` | counter | `{angle}` | `angle` (`loss_aversion`, `identity`, `humor`, `challenge`, `data`, `future_self`, `social_proof_self`) | The learning loop picks an angle for a nudge. |
| `app.coach.audio.generated` | `app_coach_audio_generated_total` | counter | `{message}` | none | A coach message's spoken version becomes ready. |
| `app.coach.audio.failed` | `app_coach_audio_failed_total` | counter | `{message}` | `reason` (`provider_error`, `refusal`, `timeout`, `no_voice_model`) | A message is delivered as text only after its audio failed. |
| `app.coach.audio.purged` | `app_coach_audio_purged_total` | counter | `{object}` | none | `coach.audio.purge` deletes voice notes past the retention window; adds the batch count. |
| `app.coach.chat.turns` | `app_coach_chat_turns_total` | counter | none | `coach.outcome` (`model`, `safety`, `fallback`) | A chat turn is answered. |
| `app.coach.chat.safety_hits` | `app_coach_chat_safety_hits_total` | counter | none | `coach.screen` (`distress`, `symptom`, `pain`) | A safety screen matches a chat message. |
| `app.coach.chat.tool_calls` | `app_coach_chat_tool_calls_total` | counter | none | `coach.tool`, `coach.status` | The chat model calls a tool. |
| `app.coach.chat.errors` | `app_coach_chat_errors_total` | counter | none | `coach.reason` (an AI error code, `cancelled`, `internal`) | A chat turn fails. |
| `app.coach.weekly_review.sent` | `app_coach_weekly_review_sent_total` | counter | none | `coach.source` (`model`, `static`) | A weekly review is persisted and queued for delivery. |
| `app.coach.weekly_review.skipped` | `app_coach_weekly_review_skipped_total` | counter | none | `coach.reason` (`invalid_payload`, `invalid_week`, `coach_off`, `paused`, `not_due`, `stale`, `already_sent`) | An `ai.coach.weekly_review` job ends without a review. |
| `app.coach.weekly_review.fallback` | `app_coach_weekly_review_fallback_total` | counter | none | `coach.reason` (`no_model`, `ai_error`, `guard_rejected`) | Static persona prose replaces the model's review text. |
| `app.coach.weekly_streak.updated` | `app_coach_weekly_streak_updated_total` | counter | none | `coach.change` (`advanced`, `pass_used`, `reset`, `held`) | The weekly review updates the weekly streak. |
| `app.coach.weekly_streak.length` | `app_coach_weekly_streak_length_{bucket,sum,count}` | histogram | none | none | The weekly streak, in weeks, after each review. |
| `coach.moment.planned` | `coach_moment_planned_total` | counter | none | `coach.moment` | The planner enqueues an eligible moment. No `app.` prefix: created by `coach/planning/coach-planning.metrics.ts`. |
| `coach.nudge.suppressed` | `coach_nudge_suppressed_total` | counter | none | `coach.reason` (`coach_off`, `quiet_hours`, `daily_cap`, `spacing`, `paused`, `silenced`, `safety_supportive_only`, `pref_off`, `already_sent`, `handler_missing`), `coach.moment` | A planner gate removes a moment, or its handler is not registered in this process. Un-prefixed. |
| `coach.sweep.users` | `coach_sweep_users_total` | counter | none | none | Adds the number of users a sweep pass planned. Un-prefixed. |
| `coach.sweep.user_error` | `coach_sweep_user_error_total` | counter | none | none | The sweep skips a user after an error. Un-prefixed. |
| `coach.time_zone.invalid` | `coach_time_zone_invalid_total` | counter | none | none | A planning pass falls back to UTC for an unknown time zone. Un-prefixed. |
| `app.jobs.queue.depth` | `app_jobs_queue_depth` | gauge | `{job}` | `job_type`, `status` (`pending`, `running`) | Observed at collection. |
| `app.jobs.oldest_pending.age` | `app_jobs_oldest_pending_age_seconds` | gauge | `s` | `job_type` | Observed at collection; due pending jobs only (`scheduled_for` null or past). |
| `app.backup.last_success.timestamp` | `app_backup_last_success_timestamp_seconds` | gauge | `s` | none | Unix seconds of the last completed backup. |
| `app.backup.last_success.size` | `app_backup_last_success_size_bytes` | gauge | `By` | none | Size of that backup. |
| `app.nodes.count` | `app_nodes_count` | gauge | `{node}` | `status` (`online`, `draining`, `offline`, `disabled`), `health` (`healthy`, `stale`, `offline`) | Worker nodes by status and derived health. All seven valid pairs are observed, zeros included. |
| `app.nodes.cpu.utilization` | `app_nodes_cpu_utilization` | gauge | `{core}` | `node_id`, `node_name` | The node's reported `cpuPercent / 100` (1.5 = one and a half cores). |
| `app.nodes.memory.rss` | `app_nodes_memory_rss_bytes` | gauge | `By` | `node_id`, `node_name` | The node process's resident set size. |
| `app.nodes.heap.used` | `app_nodes_heap_used_bytes` | gauge | `By` | `node_id`, `node_name` | V8 heap in use. |
| `app.nodes.heap.limit` | `app_nodes_heap_limit_bytes` | gauge | `By` | `node_id`, `node_name` | V8 heap limit. |
| `app.nodes.event_loop.delay.p99` | `app_nodes_event_loop_delay_p99_seconds` | gauge | `s` | `node_id`, `node_name` | The reported `eventLoopDelayP99Ms / 1000`. |
| `app.nodes.state_dir.free` | `app_nodes_state_dir_free_bytes` | gauge | `By` | `node_id`, `node_name` | Free space on the filesystem that holds the node's state directory. |
| `app.nodes.state_dir.total` | `app_nodes_state_dir_total_bytes` | gauge | `By` | `node_id`, `node_name` | Size of that filesystem. |
| `app.nodes.slots.used` | `app_nodes_slots_used` | gauge | `{slot}` | `node_id`, `node_name` | Job slots in use. |
| `app.nodes.slots.total` | `app_nodes_slots_total` | gauge | `{slot}` | `node_id`, `node_name` | Job slots offered. |
| `app.nodes.uptime` | `app_nodes_uptime_seconds` | gauge | `s` | `node_id`, `node_name` | Node process uptime. |
| `app.nodes.counter` | `app_nodes_counter` | gauge | `{event}` | `node_id`, `node_name`, `counter` (`claims`, `empty_polls`, `claim_failures`, `succeeded`, `failed`, `rate_limited`, `lease_renewals`, `lease_renew_failures`, `heartbeat_failures`, `watchdog_trips`) | The node's cumulative counters. They reset when the node process restarts, so read them with a reset-aware rate. |
| `app.nodes.types.no_eligible_node` | `app_nodes_types_no_eligible_node` | gauge | `{type}` | `job_type` | For each node-offered type with due pending jobs: `1` when no `online`, `healthy` node lists the type as eligible, else `0`. See [worker-nodes.md](worker-nodes.md#fleet-metrics). |

The coach metrics created outside `AppMetricsService` (`coach/chat/`, `coach/review/`, `coach/planning/`) carry no unit and dotted attribute names (`coach.reason`); their table names follow the counter rule above and are not verified live. Attribute columns with dots need double-quoting in SQL.

Tables verified live: `app_jobs_enqueued_total`, `app_jobs_duration_seconds_{bucket,sum,count}`, `app_backup_size_bytes_{bucket,sum,count}`, `app_jobs_oldest_pending_age_seconds`, `app_jobs_queue_depth`, `app_backup_last_success_timestamp_seconds`, `app_backup_last_success_size_bytes`. The remaining tables follow the same rules.

#### Gauges

- The gauges are registered only when `OTEL_ENABLED` is set. The four queue and backup gauges live in `AppMetricsService`. The `app.nodes.*` gauges live in `apps/api/src/nodes/node-fleet-metrics.service.ts`, the one sanctioned sibling: it needs `NodeOffloadService` and the fleet policy, which the global module cannot import without a cycle. It takes its meter, clock and gate from `AppMetricsService.gaugeContext()` and its names from `APP_METRIC_NAMES`.
- Their callbacks read PostgreSQL only while the telemetry gate is open (see [§2](#2-the-two-switches)). A closed gate costs no query.
- Readings are cached for 30 seconds (`GAUGE_CACHE_TTL_MS`) with one read in flight.
- Every API replica reports the same database-wide values. Take the maximum per timestamp, never the sum.
- Gauges are exported with delta temporality (`GatedPushMetricExporter.selectAggregationTemporality`); counters and histograms keep the OTLP default, cumulative. A gauge has no temporality on the wire, so the only effect is that a collection exports exactly the attribute sets its callback observed. Under cumulative, `@opentelemetry/sdk-metrics` 2.x re-exports every attribute set it has ever seen at its last value, so an offline node or a drained job type would keep reporting a frozen reading.
- Per-node series (`node_id`, `node_name`) are capped at 200 nodes per collection: nodes that are not `offline`, with vitals newer than 3 × `nodes.staleHeartbeatSeconds`, newest first. `node_id` is the row UUID and `node_name` is sanitised to the label shape. Both are bounded by that cap rather than by `MAX_DISTINCT_VALUES`.

#### Labels

- Attribute keys are snake_case (`job_type`), so they are plain column names.
- A value is at most 64 characters of `[A-Za-z0-9_.:/@+-]`; an email-shaped value is rejected.
- Each key admits at most 100 distinct values per process (`MAX_DISTINCT_VALUES`); later values become `other`.
- Never a user id, email or URL.

#### Not instrumented

- Backup settlements made by the stale-sweep.
- Controller-level auth cases (missing profile, missing cookie).

Tests: `apps/api/src/common/otel/app-metrics.service.spec.ts`, `apps/api/src/nodes/node-fleet-metrics.service.spec.ts`, the gauge-temporality case in `apps/api/src/common/otel/telemetry-gate.spec.ts`, and the hook-site specs beside each caller.

- **PostgreSQL is scraped by the collector, not instrumented in the API.**
  The `postgresql` receiver reads the statistics views from outside the
  application, so the numbers exist even when the API is down. Rejected:
  a `pg_stat_*` poller inside the API, which would put a periodic task and a
  second database role in the process that serves users.
- **A least-privilege monitor login, with a fallback.** `POSTGRES_MONITOR_USER`
  and `POSTGRES_MONITOR_PASSWORD` name a role holding only `pg_monitor`. Blank
  falls back to `POSTGRES_USER`/`POSTGRES_PASSWORD`, so telemetry works on any
  server with no new role, at the price of handing the collector the
  application's credentials. The CLI marks both `allowBlank` and `essential`
  (asked as a pair, so a password is never paired with the wrong user), and
  `deploy update` never prompts for them.
- **TLS follows `POSTGRES_SSL` with the API's rule.** Exactly `true` means
  `sslmode=require` (encrypted, certificate not verified); anything else is
  plaintext. Compose cannot negate a variable and the receiver's switch is
  inverted (`tls.insecure`), so the config looks up a constant by name
  (`POSTGRES_TLS_INSECURE_WHEN_SSL_true`, defined in `telemetry.compose.yml`)
  and every other spelling falls to the insecure default. Rejected: a new
  `POSTGRES_TLS_INSECURE` setting, a second source of truth for one fact.
- **The collector joins `devnet`.** On a multi-app VPS the database is the
  shared `postgres` container on `devnet`; without the network the receiver
  cannot resolve it. Nothing is published on the host, but the collector's
  unauthenticated OTLP receivers (4317/4318) become reachable from other
  containers on `devnet`. See [SECURITY-ARCHITECTURE.md](../SECURITY-ARCHITECTURE.md#collector-on-devnet).
- **Per-table and per-index metrics stay on; `blocks_read` goes off.** One
  application schema keeps the per-table series count small, and eight series
  per table for a question `blks_hit`/`blks_read` already answer is the one
  multiplier worth removing.
- **An unreachable database does not stop the collector.** It keeps running
  and logs a scrape error every 30 s; the other pipelines are unaffected.

### 11.14 Metric catalog and the `/metrics` route

> **Code:** `apps/api/src/telemetry/metrics/` — `metric-catalog.ts` (the
> declarations), `metric-sql.ts` (the builders), `metric-group.ts` (rows to
> tiles, series and tables), `metric-verdict.ts` (the summary's probes),
> `metric-values.ts` (parsing, histogram quantile).

`METRIC_FAMILIES`, `METRIC_RATIOS` and `METRIC_TABLES` declare, as data, what
the dashboard reads from the metric tables of §11.3 and §11.13. Each family
has a key, label, group, table, kind (`gauge`, `counter`, `histogram`),
display unit, value transform (a SQL value expression such as
`1 - "greptime_value"`, a `scale`, or `ageHours`), the label column it is
split by, fixed label predicates, required columns, the request filters it
honours and, where a verdict rule reads it, the thresholds (taken from
`DASHBOARD_VERDICT_THRESHOLDS`). A ratio divides families bucket by bucket; a
table reads one value per key (mountpoint, table, job type, node, URL, scrape
job) from one or more tables.

| Group | Families (tiles, series) | Ratios | Tables |
|---|---|---|---|
| `host` | CPU utilization (`1 − idle`, averaged over CPUs), memory utilization (`state = used`), load 1m, filesystem utilization per mountpoint, disk IO bytes/s, network IO bytes/s (collector namespace, §11.2) | — | Filesystems: used %, used and free bytes |
| `database` | Connections, max connections, size per database, commits/s, rollbacks/s, deadlocks | Connections used %, cache hit ratio (`hit ÷ (hit + read)` of increases) | Largest tables by size (up to 500) |
| `queue` | Queue depth (tiles `pending`, `running`), oldest pending job (max over types), jobs settled/min by outcome, job duration p95 (histogram), last successful backup (hours ago) | Job failure ratio (`failed ÷ (succeeded + failed)`) | Job types: pending, running, oldest pending, succeeded, failed, duration p95 |
| `nodes` | Nodes by health (tiles `healthy`, `stale`, `offline`), job types without an eligible node | — | Nodes: CPU cores, RSS, heap used/limit and %, state-dir free/size and free %, slots; node-offered job types |
| `uptime` | Check duration per URL, TLS days left per URL, nginx requests/s, nginx connections by state (tile `active`) | — | Uptime targets: up, status code, checks, failed checks, last error, duration, TLS days left |
| `pipeline` | Metric points sent/s and failed by exporter, exporter queue size, points refused by receiver, GreptimeDB write stalls, scrape targets down (`up = 0`, by `job`) | Exporter queue used % | Scrape targets: up, by `job` |

**Semantics.** A **gauge** is combined across series per timestamp (sum for
"how many", max for "the worst", min for the soonest expiry) and then per
bucket. A **counter** (`_total`) is a reset-aware increase: each point minus
its predecessor **in the same series** (`lag` partitioned by every tag
column), a drop counting the new value (a restart), the first point of a
series contributing nothing — conservative, never an invented spike; the
tile is the window's increase as a rate (`per_s`, `per_min`) or a `count`.
A **histogram** quantile is interpolated from the increases per `le`
(Prometheus `histogram_quantile` style; the `+Inf` bucket answers the highest
finite bound). API gauges are delta-temporality (§11.13): a group whose latest
bucket is more than one bucket older than the family's newest has stopped
reporting and is left out of the tile, and a listed tile group with no current
reading reads 0 (nothing pending); a table's `last` cell older than its part's
newest reading by 150 s is `null`.

**Filters.** `host` applies to collector-scraped tables (`host_name` is the
real host); `service` and `instance` apply to the API's `app_*` tables
(`service_name`, `app_instance_id`; the API's `host_name` is its container).
A filter set on a table lacking its column matches nothing, like the
traces' instance filter.

**Response** (`TelemetryDashboardMetricsDto`):

```json
{
  "range": { "from": "…", "to": "…", "bucketSeconds": 60 },
  "generatedAt": "…",
  "truncated": false,
  "sql": ["SELECT date_bin(…)", "…"],
  "group": "host",
  "available": true,
  "tiles": [{ "key": "cpuUtilization", "label": "CPU utilization", "value": 24.1, "previous": 19.8, "unit": "%", "sparkline": [ … ] }],
  "series": [{ "key": "filesystemUtilization", "label": "Filesystem utilization: /", "unit": "%", "dimension": "mountpoint", "groupBy": "/", "points": [{ "t": "…", "v": 35.6 }] }],
  "tables": [{ "key": "filesystems", "label": "Filesystems", "columns": [{ "key": "key", "label": "Mountpoint", "unit": "text" }, …], "rows": [{ "key": "/", "utilizationPct": 35.6, …, "lastSeenAt": "…" }] }],
  "skipped": []
}
```

- `tiles` reuse the summary's tile shape; a tile key with a group suffix
  (`queueDepth.pending`) is one of the family's `tileGroups`. Units: `%`,
  `bytes`, `bytes/s`, `count`, `per_s`, `per_min`, `ms`, `seconds`, `hours`,
  `days`, `cores`, `load` (and `text`, `boolean`, `timestamp` for columns).
- `series` has one entry per family and group value (`dimension` is the label
  column, `groupBy` its value), one point per bucket of the current window,
  `null` where nothing was measured.
- `sql` lists **every** statement run, in order ("Open in Explorer" takes the
  first); `skipped` lists catalog keys whose table or column is absent;
  `available` is false when nothing of the group exists yet.

**Bounds.** Metric buckets are the window's bucket size but at least 60 s
(`METRIC_MIN_BUCKET_SECONDS`: the tables are written every 30–60 s). Each
family statement covers the previous and current windows and is capped at
rows per group × 20 groups + 1 (`METRIC_MAX_GROUPS`, ordered by group so the
cut drops whole trailing groups); a table at 50 keys
(`METRIC_TABLE_MAX_ROWS`, key-major order so no part is cut) unless its
catalog spec sets its own `maxRows` — `largestTables` returns up to 500
(`LARGEST_TABLES_MAX_ROWS`: every table of a realistic schema, still bounded)
so the web can offer Top 10/20/50/All, while the assistant's
`metrics_overview` still hands the model at most 20 rows per table; a
histogram at 4,000 rows. Any cut sets `truncated`. The route shares the dashboard's flow
(§11.6): preconditions, window, 15-second result cache keyed by
`group`/`host` too, schema and distinct-value checks, one audit row
(`route: "metrics"`) per store read. Each group runs 4–9 statements at once
on the reader pool.

**Design decisions.**

- **A declarative catalog, not per-panel code.** A new metric is one entry;
  the builders, freshness rules and response shape follow. Rejected: a
  hand-written statement per tile, which is where the SQL-safety argument of
  §11.5 would erode.
- **Reset-aware `lag` over max − min.** `max − min` per series overcounts
  nothing but undercounts a restart to zero and hides the post-restart
  increase; `lag` partitioned by every tag column counts both, and is
  verified on GreptimeDB v1.2.1.
- **Skipped, never failed.** A table appears only once its source has
  written; a fresh or partial deployment shows what it has and names the
  rest in `skipped`.
- **One statement per group family, key-major tables.** A per-part
  `LIMIT` inside a `UNION ALL` would need a subquery wrapper, which drops
  the inner `ORDER BY` (#554); ordering the whole union by key and capping at
  keys × parts keeps every part of the first 50 keys.

## History

- #528: epic, Telemetry Explorer on GreptimeDB.
- #529: spike and decision record (this document's first version).
- #530: GreptimeDB telemetry overlay replaces Uptrace.
- #531: VPS deploy carries the telemetry overlay behind the `observability`
  group, with GreptimeDB's Postgres wire port bound to loopback only.
- #532: logs over OTLP behind a runtime telemetry gate.
- #533: telemetry settings namespace and permissions.
- #534: the telemetry module — settings service, status endpoint, and the
  `telemetry.retention.apply` job.
- #535: the Telemetry Explorer — query, schema and export endpoints, the SQL
  guard.
- #536: the telemetry AI assistant over SSE.
- #537: the Telemetry Explorer and settings pages in the admin web app.
- #538: the GreptimeDB tier in the API test suite.
- #539: this document's remaining sections.
- #554: row cap moved to a top-level LIMIT so ORDER BY survives.
- #558: the GreptimeDB connection becomes admin-configurable at runtime
  (`TelemetryConnectionService`, `/api/admin/telemetry/connection`), with
  `GREPTIME_*` kept as the deployment default.
- #565: admin-configurable instance identifier, stamped as `app.instance.id`.
- #567: the telemetry stack ships with every VPS deployment
  (`effectiveGroups`); `stack-agent`, the sidecar holding the Docker socket,
  lets an administrator (re)deploy GreptimeDB and the collector from
  `/admin/settings/telemetry` with no shell step.
- #570: the host mode, not "stored vs. environment", decides who owns the
  whole connection. A stored automatic host (`{ host: null }`) now takes
  port, database, logins and passwords from the deployment, wholly — a
  stored custom host's own credentials are never borrowed for it. `GET`
  adds `deploymentManaged`, `deployment` and `problem`; the connection test
  adds `hostMode` and ignores submitted credentials in automatic mode. The
  Connection form hides port/database/login fields for a blank host and
  shows a "Managed by the deployment" summary instead.
- #571: the assistant becomes a troubleshooting agent — three new
  server-built tools (`get_app_context`, `health_overview`, `get_trace`), an
  investigator prompt and streamed interim thoughts, a step-budget warning,
  and a structured report with back-compatible `sql`/`explanation`;
  `assistant.maxSteps` raised to 1–20 (default 15); the web explorer no
  longer auto-runs the answer's SQL.
- #576: epic, the Telemetry Dashboard (§11) — a triage page over the
  existing GreptimeDB store, plus a drill-down path into the Explorer and
  the assistant.
- #577: the dashboard API — `TelemetryDashboardController`'s five routes,
  the SQL templates and safety model (§11.5), the verdict rules (§11.7),
  bounds and caching (§11.6).
- #578: the dashboard page itself — registry card, panels, URL-held state
  and the phone/tablet/desktop layout (§11.9, §11.10).
- #579: the triage model ships — "Ask assistant" and "Open in Explorer" on
  every panel, "Explain this" on the verdict banner, "View trace" on a log
  event, prefilled report queries from the assistant, and the Dashboard ↔
  Explorer ↔ settings cross-links (§11.1); the shared
  `useTelemetryAssistantAvailable` condition and `AssistantContainer` frame,
  reused from the Explorer.
- #580: this document's §11 written and verified against the shipped code,
  including the drill-down actions above.
- #122: the collector scrapes the host (`hostmetrics` over a read-only
  `/hostfs` mount), its own pipeline counters and a keep-list of GreptimeDB's
  `/metrics`; `app.instance.id` and `host.name` become label columns on every
  metric table (§11.2, §11.3, §11.12).
- #125: first-party application metrics (`AppMetricsService`): job, backup, auth, AI and notification counters and histograms, and cached queue and backup gauges (§11.13).
- #123: the collector scrapes the application's PostgreSQL (`postgresql` receiver in `metrics/local`), with an optional `pg_monitor` login and the collector on `devnet`.
- #131: worker-node fleet gauges (`app.nodes.*`), and delta temporality for every gauge (§11.13).
- #124: the collector probes uptime and TLS expiry (`httpcheck` receiver on the app through nginx, the API directly and the public origin) and scrapes nginx's `stub_status` from an internal-only `:8081` listener (`nginx` receiver) (§11.2, §11.3, §11.12).
- #132: trace context carried from enqueue to execution: `jobs.trace_context`, the server worker's `job.process` span as its child, and `traceparent` on node claim assignments (§1).
- #133: node span relay: worker nodes post job phase spans to `POST /api/nodes/{id}/telemetry`, re-emitted by the API under the job's trace (§1).
- #126: the metric catalog and `GET /api/admin/telemetry/dashboard/metrics` (host, database, queue, nodes, uptime and pipeline groups, §11.14), `hosts` on `/filters` and the `host` filter, nine infrastructure verdict rules gathered by one probe per rule family in the summary (§11.7), and the shared SQL literal helpers (§11.5).
- #128: the assistant reads metrics (§6) — `metrics_overview(group, window)` and `compare_nodes(window)` over the metric catalog and builders, a `saturation` section in `health_overview` from the verdict probes, `metricFamilies` in `get_app_context`, label values withheld (ordinals instead) when `shareResults` is off, and a method that checks saturation in the baseline and correlates it with latency and error spikes.
- #127: the dashboard's six infrastructure sections (Infrastructure,
  Database, Job queue, Worker nodes, Uptime & dependencies, Telemetry
  pipeline) over `/metrics`, each its own panel with "Open in Explorer" and
  "Ask assistant" and hidden when its group is not collected; the Host
  filter; verdict reasons linking to their section (§11.9, §11.10).
- #176: per-table row caps in the metric catalog (`maxRows`, default 50);
  `largestTables` returns up to 500 rows so the dashboard can show every
  table (§11.14).
