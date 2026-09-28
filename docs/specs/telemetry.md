# Telemetry (GreptimeDB + Telemetry Explorer)

> **Status:** shipped · **Code:** `apps/api/src/telemetry/`, `apps/api/src/telemetry/connection/`, `apps/api/src/telemetry/stack/`, `apps/api/src/telemetry/dashboard/`, `apps/stack-agent/`, `apps/api/src/common/otel/telemetry-gate.ts`, `apps/web/src/pages/Admin/TelemetrySettingsPage.tsx`, `TelemetryExplorerPage.tsx`, `TelemetryDashboardPage.tsx` · **API:** `/api/telemetry/config`, `/api/admin/telemetry/*`, `/api/admin/telemetry/connection*`, `/api/admin/telemetry/stack*`, `/api/admin/telemetry/dashboard/*` (see `/api/docs`) · **Admin UI:** `/admin/settings/telemetry`, `/admin/settings/telemetry/explorer`, `/admin/settings/telemetry/dashboard` · **Runbook:** [telemetry.md](../runbooks/telemetry.md)

This is a two-container overlay — an OTel Collector in front of a GreptimeDB
standalone instance — replacing the earlier Uptrace/ClickHouse/Redis stack.
Admins query telemetry with SQL, export the results, and ask an AI assistant
about them. The application's own PostgreSQL database takes no telemetry
load: traces, logs and metrics live in GreptimeDB alone.

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

GreptimeDB creates tables on first write, with no migration step: typically
`opentelemetry_traces` (spans), `opentelemetry_logs` (log records), and one
table per exported metric. Span, resource and log attributes are flattened
into their own columns whose names contain dots (`"span_attributes.http
.route"`, `"resource_attributes.service.name"`), created dynamically as new
attribute keys arrive — see the spike findings above for the full column
inventory and quoting rule.

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
(`health_overview`), hypothesise from the question and the baseline, drill
down (`run_query`, `list_tables`, `describe_table`), correlate by trace
(`get_trace`), verify, then conclude. The prompt tells the model to run and
analyse the data itself — never to hand the analysis back to the user — and
to treat an empty result as evidence to explain (is the table populated at
all, does its data reach into the window, is the filter column populated)
rather than an answer.

**The six tools**, all served by `TelemetryAssistantService.buildTools`:

| Tool | Reads |
|---|---|
| `list_tables` | Table names and row estimates (`TelemetrySchemaService`) |
| `describe_table` | One table's columns, types and semantic types |
| `run_query` | The model's own read-only SQL, via `TelemetryQueryService.run` |
| `get_app_context` | API version, runtime, OTel service name/instance id, telemetry settings, an allowlist of platform feature flags (booleans only), the deploy document's non-sensitive facts (version, commit SHA, timestamps, last outcome — never a hostname, path or secret), the store's tables, and the data range (earliest/latest timestamp, last-24h coverage, services) of traces and logs |
| `health_overview(window)` | A baseline over `15m`/`1h`/`6h`/`24h`/`7d`: per-service span/error counts and latency (avg, max, p95), top failing routes, log counts by severity, top error log messages with a sample trace id, the slowest spans, and each table's coverage in the window |
| `get_trace(traceId)` | Every span and log record of one trace, oldest first (`traceId` must match `TRACE_ID_PATTERN`, 16–32 hex characters) |

`get_app_context`, `health_overview` and `get_trace` never run model-written
SQL: their statements are built server-side, as pure functions of the
table's discovered column set and (for `get_trace`) a pattern-validated
trace id, in `telemetry-assistant.sql.ts` — a section whose table or columns
are absent is skipped, not failed. Every statement these tools and
`run_query` alike produce still goes through `TelemetryQueryService.run`
(`source: 'assistant'`) — the explorer's own guard, row cap, timeout and a
`telemetry:assistant_query` audit row each — and every report query is
re-checked against the SQL guard before being shown to the user (a
statement that fails the re-check is withdrawn with a note in the summary,
never run). Not a queue job: the turn lives exactly as long as the SSE
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
body, an HTTP route, a user agent). The assistant's system prompt tells the
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
deployment recorded before this change gains the stack on its next `appctl
deploy update`, with no flag. `--group observability` is still accepted, as a
harmless no-op, so an existing script or habit does not break.

Shipping the containers does not turn export on: `telemetry.enabled` (§2)
still gates whether anything is collected, and the GreptimeDB connection
(§8) still has to be reachable. Deploying the stack only makes "reachable"
achievable without a shell session.

### The problem this solves

Before this feature, a fresh install had no `greptimedb` container until an
operator ran `appctl deploy update --group observability` from a shell, and
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
timelines, the routes and error messages responsible, and a feed of recent
error/warning logs — all read-only, over the same GreptimeDB store as the
explorer.

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
  severity, Top failing routes, Top errors, Recent events): hands the
  Explorer the `sql` that panel's own API response reported (§11.4), first
  statement only when it is a list — for Key indicators that is the
  current-vs-previous totals query the tiles come from. The Explorer loads
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
panel, and at most one sample trace id.

### 11.2 Data sources, and why no CPU/memory/disk

The dashboard reads exactly three kinds of data already in the store:

- **Server spans** (`opentelemetry_traces`, `span_kind = 'SPAN_KIND_SERVER'`)
  — requests, status classes, latency, routes.
- **Log records** (`opentelemetry_logs`) — severity bands, error messages,
  the events feed.
- **Node runtime metrics** (`v8js_memory_heap_used_bytes`,
  `nodejs_eventloop_delay_p99_seconds`) — the optional runtime tiles, present
  only when the runtime-metrics instrumentation is on.

**There is no CPU, memory or disk tile for the host or container**, because
this template collects none of that today: the OTel Node SDK instruments the
process (traces, logs, the two runtime metrics above), not the machine it
runs on. Adding host-level metrics is a real follow-up, not a design
rejection: the natural next step is the collector's `hostmetricsreceiver`
(CPU, memory, disk, network, filesystem), scraping through a **read-only**
bind mount of the host's `/proc`, `/sys` and root filesystem (commonly
`/hostfs`) into the collector container — no new agent, no privileged
container, and no change to what the API or the dashboard authenticate as.
**Docker container stats were considered and rejected as a source**: reading
them means talking to the Docker socket, which this template deliberately
confines to `stack-agent` alone (see [§10](#10-deploying-the-stack-stack-agent)
and [SECURITY-ARCHITECTURE.md](../SECURITY-ARCHITECTURE.md)) — handing the
collector, or the API, a second path to that socket is exactly the blast-radius
increase the sidecar exists to avoid.

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
| Runtime metric tables | Prometheus-style columns (`greptime_timestamp`, `greptime_value`, `service_name`, …) with **no instance column** — the instance filter does not apply to the runtime tiles. `v8js_memory_heap_used_bytes` has one row per heap space per export, so it is summed per export before being averaged per bucket. Both are exported every 60 s, so a bucket finer than a minute is half empty. |

### 11.4 Routes

Five routes, all under `TelemetryDashboardController`, all gated by
`telemetry:query` — the same permission as the Explorer, because the
dashboard reads telemetry DATA, not policy (`telemetry:read`/`write` gate the
deployment-wide policy instead; see [§7](#7-security-model)):

| Route | Purpose |
|---|---|
| `GET /api/admin/telemetry/dashboard/summary` | The verdict and headline tiles (requests/min, 5xx rate, p95, error/warning logs, latest data), plus optional runtime tiles |
| `GET /api/admin/telemetry/dashboard/timeseries` | `panel=api` (status classes + p95 per bucket) or `panel=logs` (severity bands per bucket) |
| `GET /api/admin/telemetry/dashboard/top` | `kind=routes` (top 5xx offenders) or `kind=errors` (top error messages) |
| `GET /api/admin/telemetry/dashboard/events` | Log events, newest first, keyset-paginated |
| `GET /api/admin/telemetry/dashboard/filters` | Distinct `service`/`instance` values seen in the window |

Every response carries `range`, `generatedAt`, `truncated` and `sql` (the
exact statement(s) run, primary first) — the same seam each panel's
"Open in Explorer" action uses (§11.1), and useful on its own for anyone
who wants to paste the statement into a BI tool. A shared window query
(`range` or `from`/`to`, `service`, `instance`, `buckets`) is validated by
`refineWindow` (`apps/api/src/telemetry/dto/telemetry-dashboard.dto.ts`):
either `range` or `from`+`to`, never both; `from < to`; `to` at most one
minute ahead (clock skew); span at most 30 days.

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
computed — four rules, each with a **volume guard** so a quiet deployment
does not flap red on one failed request. The level reported is the worst
rule that fired; `reasons` carries one line per fired rule with its value,
the threshold it crossed, and the worst offender (route or message, cut to
80 characters):

| Rule | Degraded | Critical | Volume guard |
|---|---|---|---|
| 5xx rate | > 2 % | > 5 % | ≥ 20 requests in the window |
| p95 latency (streams excluded, §11.5) | > 1000 ms | > 3000 ms | ≥ 20 requests in the window |
| Error logs vs. the previous window | ≥ 3× | ≥ 10× | ≥ 10 error logs now (a previous count of 0 counts as 1, so the very first burst still ranks as a ratio) |
| No data | — | — | `now − latest trace/log > 5 min` **overrides every other rule**: the other rules would be judging silence |

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
  the four rules and their volume guards.
- `apps/api/src/telemetry/dashboard/telemetry-dashboard.service.spec.ts` —
  window resolution, caching (including the shared in-flight promise),
  filter validation, the audit row.
- `apps/api/src/telemetry/dashboard/telemetry-dashboard.greptime.spec.ts` —
  the real-database tier, over an actual GreptimeDB.
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
- `apps/web/src/__tests__/components/telemetry/dashboard/traceLink.test.ts` —
  `isTraceId` and `traceExplorerSql`, including the injection argument above.
- `apps/web/src/__tests__/components/telemetry/explorerHandoff.test.ts` — the
  `state`-vs-`?sql=` precedence, the `TELEMETRY_SQL_MAX_LENGTH` bound, and
  that a handoff is read once and cleared.
- `apps/web/src/__tests__/hooks/useTelemetryAssistantAvailable.test.tsx` — the
  shared availability condition (assistant switch, AI switch, `ai:use`).
- `tests/visual/specs/telemetry-dashboard.spec.ts` — 15 pixel baselines: the
  `critical` and `no_data` verdicts at 390×844 (phone), 820×1180 (tablet) and
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
- **No host CPU/memory/disk today** (§11.2): rejected implementing it now in
  favour of shipping the request/log/runtime picture first; the
  `hostmetricsreceiver` path is a scoped follow-up, not blocked on anything
  in this change.

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
