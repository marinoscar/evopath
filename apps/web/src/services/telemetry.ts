/**
 * Telemetry API client (issue #537, epic #528).
 *
 * The wire shapes mirror the API contract for epic #528:
 *
 *   - `GET  /telemetry/config`                  (#534, any signed-in user)
 *   - `GET  /admin/telemetry/config`            (#534, `telemetry:read`)
 *   - `PUT  /admin/telemetry/config`            (#534, `telemetry:write`, If-Match)
 *   - `GET  /admin/telemetry/status`            (#534, `telemetry:read`)
 *   - `POST /admin/telemetry/query`             (#535, `telemetry:query`)
 *   - `GET  /admin/telemetry/schema`            (#535, `telemetry:query`)
 *   - `POST /admin/telemetry/export`            (#535, `telemetry:query`)
 *   - `POST /admin/telemetry/assistant/stream`  (#536, `telemetry:query` + `ai:use`)
 *
 * The browser only presents and collects. Whether a statement is read-only,
 * how many rows it may return and how long it may run are decided by the API;
 * the SQL typed here is sent verbatim and the server's guard is the gate.
 */
import { api, API_BASE_URL, ApiError, type BlobWithHeaders } from './api';
import { postSse } from './sse';
import type { JobStatusName } from './jobs';

// =============================================================================
// Configuration and status (#534)
// =============================================================================

/** `GET /telemetry/config` — the feature flag every signed-in client reads. */
export interface TelemetryPublicConfig {
  /** A telemetry store is deployed. False hides every telemetry surface. */
  available: boolean;
  /** `telemetry.enabled` — whether this deployment is collecting. */
  enabled: boolean;
  /** `telemetry.assistant.enabled`. Whether AI itself is on is `GET /ai/config`. */
  assistantEnabled: boolean;
}

/** The stored `telemetry` settings namespace — the `PUT` body, verbatim. */
export interface TelemetrySettings {
  enabled: boolean;
  /** 1..3650. */
  retentionDays: number;
  /**
   * `telemetry.instanceId` (#565): the label stamped as the OTel resource
   * attribute `app.instance.id` on every trace, log and metric. `null` follows
   * the default (the app slug, `instanceIdDefault`). When set, it matches
   * `TELEMETRY_INSTANCE_ID_PATTERN`.
   */
  instanceId: string | null;
  query: {
    /** 1..100000. */
    maxRows: number;
    /** 1..120. */
    timeoutSeconds: number;
  };
  assistant: {
    enabled: boolean;
    provider: string | null;
    modelId: string | null;
    shareResults: boolean;
    /** 1..100. */
    maxResultRowsToModel: number;
    /** 1..12. */
    maxSteps: number;
  };
}

/** `GET /admin/telemetry/config` — the settings plus provenance. */
export interface TelemetryAdminConfig extends TelemetrySettings {
  available: boolean;
  /** Whether the GreptimeDB admin credential is set, which retention needs. */
  retentionApplicable: boolean;
  /** What a `null` `instanceId` resolves to: the app slug (`APP_SLUG`). Read-only. */
  instanceIdDefault: string;
  /** `instanceId ?? instanceIdDefault` — the value stamped on exported telemetry. Read-only. */
  instanceIdEffective: string;
  /** Send back as `If-Match`. `0` when nothing is stored yet. */
  version: number;
  updatedAt: string | null;
  updatedBy: { id: string; email: string } | null;
}

/** `GET /admin/telemetry/status` — a diagnosis, always 200. */
export interface TelemetryStatus {
  configured: boolean;
  reachable: boolean;
  version: string | null;
  database: string;
  ttl: { raw: string; days: number | null } | null;
  retentionDays: number;
  tables: { name: string; rows: number | null }[];
  error: string | null;
}

export const TELEMETRY_LIMITS = {
  retentionDays: { min: 1, max: 3650 },
  maxRows: { min: 1, max: 100000 },
  timeoutSeconds: { min: 1, max: 120 },
  maxResultRowsToModel: { min: 1, max: 100 },
  maxSteps: { min: 1, max: 20 },
} as const;

/**
 * Mirrors the API's `TELEMETRY_INSTANCE_ID_PATTERN` (`settings.schema.ts`):
 * 1-63 characters, lowercase letters, digits, `.`, `_` or `-`, starting with a
 * letter or digit. A convenience for inline feedback — the API is the gate.
 */
export const TELEMETRY_INSTANCE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;

/**
 * The `PUT /admin/telemetry/config` body: the stored namespace, except that
 * `instanceId` may be omitted (absent keeps the stored value, `null` resets it
 * to the default, a string overrides it).
 */
export type TelemetrySettingsUpdate = Omit<TelemetrySettings, 'instanceId'> & {
  instanceId?: string | null;
};

export async function getTelemetryConfig(): Promise<TelemetryPublicConfig> {
  return api.get<TelemetryPublicConfig>('/telemetry/config');
}

export async function getTelemetryAdminConfig(): Promise<TelemetryAdminConfig> {
  return api.get<TelemetryAdminConfig>('/admin/telemetry/config');
}

/**
 * Replace the telemetry settings. `expectedVersion` travels as `If-Match`; a
 * stale version answers 409, the same convention as the AI admin config.
 */
export async function updateTelemetryAdminConfig(
  settings: TelemetrySettingsUpdate,
  expectedVersion?: number,
): Promise<TelemetryAdminConfig> {
  return api.put<TelemetryAdminConfig>('/admin/telemetry/config', settings, {
    headers:
      expectedVersion === undefined ? undefined : { 'If-Match': String(expectedVersion) },
  });
}

export async function getTelemetryStatus(): Promise<TelemetryStatus> {
  return api.get<TelemetryStatus>('/admin/telemetry/status');
}

// =============================================================================
// GreptimeDB connection (#558)
// =============================================================================
//
//   - `GET    /admin/telemetry/connection`       (`telemetry:read`)
//   - `PUT    /admin/telemetry/connection`       (`telemetry:write`, If-Match)
//   - `DELETE /admin/telemetry/connection`       (`telemetry:write`, If-Match)
//   - `POST   /admin/telemetry/connection/test`  (`telemetry:write`, always 200)
//
// Passwords are WRITE-ONLY: they appear in request bodies and never in a
// response, which carries only a masked `credentials.<login>` status. Its
// `version` is the stored connection's own counter — NOT `/config`'s.

export const TELEMETRY_CONNECTION_SOURCES = ['stored', 'environment', 'none'] as const;
export type TelemetryConnectionSource = (typeof TELEMETRY_CONNECTION_SOURCES)[number];

export type TelemetryConnectionHostMode = 'auto' | 'custom';

/** GreptimeDB's Postgres-wire port and database when nothing says otherwise. */
export const TELEMETRY_CONNECTION_DEFAULTS = { pgPort: 4003, database: 'public' } as const;

/** Masked, non-secret facts about one password. Never the password. */
export interface TelemetryCredentialStatus {
  configured: boolean;
  /** The credential store's mask (`••••Xk9q`), or null (always null for the environment). */
  hint: string | null;
  updatedAt: string | null;
  updatedByUserId: string | null;
}

/**
 * The GreptimeDB deployed with this application, as the deployment describes
 * it (issue #570). What an automatic host uses. Non-secret: never a password.
 */
export interface TelemetryDeploymentConnection {
  /** The deployment host an automatic connection uses. */
  host: string;
  pgPort: number;
  database: string;
  /** Empty when the deployment provisions no reader login. */
  readerUser: string;
  adminUser: string | null;
  /** The deployment provides a reader user and its password. */
  readerConfigured: boolean;
  /** The deployment provides an admin user and its password. */
  adminConfigured: boolean;
}

/** `GET /admin/telemetry/connection` (and the `PUT` / `DELETE` responses). */
export interface TelemetryConnection {
  source: TelemetryConnectionSource;
  /**
   * The host as CONFIGURED: null when it is automatic (a stored automatic
   * connection, `source` `environment` or `none`); a literal only for a
   * stored custom host.
   */
  host: string | null;
  /** The host actually used — for `source` `none`, the one an automatic host would use. */
  effectiveHost: string;
  /** `auto`: `host` is null and `effectiveHost` is the deployment host; `custom`: a literal. */
  hostMode: TelemetryConnectionHostMode;
  /**
   * The whole connection (port, database, logins, passwords) comes from the
   * deployment: `source` `environment`, or a stored automatic host. Nothing
   * but the host mode is the administrator's to set (#570).
   */
  deploymentManaged: boolean;
  /** What an automatic host uses — present whatever is in force. */
  deployment: TelemetryDeploymentConnection;
  /**
   * Why a deployment-managed connection cannot be fully used (no reader or
   * admin login provisioned), in administrator language; null otherwise.
   */
  problem: string | null;
  pgPort: number;
  database: string;
  readerUser: string;
  adminUser: string | null;
  /** A host, a reader login and its password: telemetry can be read. */
  configured: boolean;
  /** The admin login is usable too, so retention can be applied. */
  adminConfigured: boolean;
  credentials: { reader: TelemetryCredentialStatus; admin: TelemetryCredentialStatus };
  /** Send back as `If-Match`. `0` when nothing is stored. */
  version: number;
  updatedAt: string | null;
  updatedBy: { id: string; email: string } | null;
}

/**
 * AUTOMATIC: the GreptimeDB deployed with this application. The deployment
 * supplies everything else, so nothing else is sent (#570).
 */
export interface TelemetryConnectionAutomaticInput {
  host: null;
}

/**
 * CUSTOM: an external GreptimeDB. An omitted (or empty) password KEEPS the
 * stored one on save, and means "the connection in force's password" on test.
 */
export interface TelemetryConnectionCustomInput {
  host: string;
  /** Omitted: 4003. */
  pgPort?: number;
  /** Omitted: `public`. */
  database?: string;
  readerUser: string;
  readerPassword?: string;
  /** Null: no admin login (a stored admin password is deleted). */
  adminUser: string | null;
  adminPassword?: string;
}

/** The `PUT` / `POST …/test` body. */
export type TelemetryConnectionInput =
  | TelemetryConnectionAutomaticInput
  | TelemetryConnectionCustomInput;

export interface TelemetryConnectionProbe {
  success: boolean;
  latencyMs: number;
  /** `SELECT version()` — reader only. */
  version?: string;
  error?: string;
}

export interface TelemetryConnectionSkipped {
  skipped: true;
}

/** `POST /admin/telemetry/connection/test` — a diagnosis, always 200. */
export interface TelemetryConnectionTestResult {
  /** The host actually probed (the deployment host when the candidate's is automatic). */
  host: string;
  /** `auto`: the deployment's own GreptimeDB and logins were probed; `custom`: the candidate's. */
  hostMode: TelemetryConnectionHostMode;
  reader: TelemetryConnectionProbe;
  admin: TelemetryConnectionProbe | TelemetryConnectionSkipped;
}

export function isTelemetryProbeSkipped(
  probe: TelemetryConnectionProbe | TelemetryConnectionSkipped,
): probe is TelemetryConnectionSkipped {
  return 'skipped' in probe && probe.skipped === true;
}

function ifMatch(expectedVersion: number | undefined) {
  return expectedVersion === undefined ? undefined : { 'If-Match': String(expectedVersion) };
}

export async function getTelemetryConnection(): Promise<TelemetryConnection> {
  return api.get<TelemetryConnection>('/admin/telemetry/connection');
}

export async function updateTelemetryConnection(
  input: TelemetryConnectionInput,
  expectedVersion?: number,
): Promise<TelemetryConnection> {
  return api.put<TelemetryConnection>('/admin/telemetry/connection', input, {
    headers: ifMatch(expectedVersion),
  });
}

/** Forget the stored connection: the deployment default (environment) or none is in force again. */
export async function resetTelemetryConnection(
  expectedVersion?: number,
): Promise<TelemetryConnection> {
  return api.delete<TelemetryConnection>('/admin/telemetry/connection', {
    headers: ifMatch(expectedVersion),
  });
}

export async function testTelemetryConnection(
  input: TelemetryConnectionInput,
): Promise<TelemetryConnectionTestResult> {
  return api.post<TelemetryConnectionTestResult>('/admin/telemetry/connection/test', input);
}

// =============================================================================
// Telemetry services — deploy the GreptimeDB stack (#567)
// =============================================================================
//
//   - `GET  /admin/telemetry/stack`         (`system_settings:read`)
//   - `POST /admin/telemetry/stack/deploy`  (`system_settings:write`, 202; 409 without an agent)
//
// The browser only shows what the API reports and asks it to (re)deploy; the
// deployment itself is a queue job run server-side.

/** Whether the API can reach the deployment agent that manages the containers. */
export type TelemetryStackAgent = 'available' | 'unavailable' | 'unauthorized' | 'not_configured';

export type TelemetryStackServiceName = 'greptimedb' | 'otel-collector';

export type TelemetryStackServiceState =
  | 'running'
  | 'restarting'
  | 'exited'
  | 'created'
  | 'paused'
  | 'dead'
  | 'missing';

export type TelemetryStackServiceHealth = 'healthy' | 'unhealthy' | 'starting';

export interface TelemetryStackService {
  /** Typed loosely so a service the API adds later still renders. */
  name: TelemetryStackServiceName | (string & {});
  state: TelemetryStackServiceState | (string & {});
  health: TelemetryStackServiceHealth | null;
}

/** The latest deploy job. `status` is the queue's own (`JOB_STATUSES` in `services/jobs.ts`). */
export interface TelemetryStackDeploy {
  jobId: string;
  status: JobStatusName | (string & {});
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
  output: string | null;
}

/** `GET /admin/telemetry/stack`. */
export interface TelemetryStack {
  agent: TelemetryStackAgent;
  services: TelemetryStackService[];
  deploy: TelemetryStackDeploy | null;
}

export async function getTelemetryStack(): Promise<TelemetryStack> {
  return api.get<TelemetryStack>('/admin/telemetry/stack');
}

/** Enqueue a (re)deploy of the telemetry services. */
export async function deployTelemetryStack(): Promise<{ jobId: string }> {
  return api.post<{ jobId: string }>('/admin/telemetry/stack/deploy');
}

// =============================================================================
// Explorer (#535)
// =============================================================================

/**
 * The PostgreSQL-wire type name: `bool`, `int2`, `int4`, `int8`, `float4`,
 * `float8`, `numeric`, `text`, `bytea`, `date`, `time`, `timestamp`, `json`
 * or `unknown`. `int8` and `numeric` VALUES arrive as strings (no precision
 * loss in JSON). Timestamps are truncated to microseconds by the wire
 * protocol — `CAST(ts AS STRING)` keeps nanoseconds.
 */
export type TelemetryColumnType =
  | 'bool'
  | 'int2'
  | 'int4'
  | 'int8'
  | 'float4'
  | 'float8'
  | 'numeric'
  | 'text'
  | 'bytea'
  | 'date'
  | 'time'
  | 'timestamp'
  | 'json'
  | 'unknown';

export interface TelemetryColumn {
  name: string;
  /** A {@link TelemetryColumnType}; typed loosely so a new one never breaks the grid. */
  type: TelemetryColumnType | (string & {});
}

/** GreptimeDB's role for a schema column. */
export type TelemetrySemanticType = 'TAG' | 'FIELD' | 'TIMESTAMP';

export interface TelemetrySchemaColumn extends TelemetryColumn {
  semanticType?: TelemetrySemanticType | null;
}

/**
 * The longest statement `POST /admin/telemetry/query` accepts —
 * `TELEMETRY_SQL_MAX_LENGTH` in `apps/api/src/telemetry/dto/telemetry-query.dto.ts`.
 * The API enforces it; the browser uses it only to ignore an oversized SQL
 * handoff into the explorer (#579).
 */
export const TELEMETRY_SQL_MAX_LENGTH = 20_000;

/** `POST /admin/telemetry/query`. Rows are POSITIONAL: names can repeat. */
export interface TelemetryQueryResult {
  columns: TelemetryColumn[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  elapsedMs: number;
}

export interface TelemetrySchemaTable {
  name: string;
  rows: number | null;
  columns: TelemetrySchemaColumn[];
}

export interface TelemetrySchema {
  tables: TelemetrySchemaTable[];
}

export const TELEMETRY_EXPORT_FORMATS = ['csv', 'xlsx', 'parquet', 'ndjson'] as const;
export type TelemetryExportFormat = (typeof TELEMETRY_EXPORT_FORMATS)[number];

export const TELEMETRY_EXPORT_LABELS: Record<TelemetryExportFormat, string> = {
  csv: 'CSV',
  xlsx: 'Excel (.xlsx)',
  parquet: 'Parquet',
  ndjson: 'NDJSON',
};

/**
 * The telemetry REASONS the explorer routes answer with. The envelope's
 * `code` is derived from the HTTP status; the reason is `details.reason`
 * (read it with {@link telemetryErrorReason}).
 */
export const TELEMETRY_ERROR_REASONS = [
  'TELEMETRY_NOT_CONFIGURED', // 503
  'TELEMETRY_UNREACHABLE', // 503
  'TELEMETRY_DISABLED', // 409
  'TELEMETRY_QUERY_REJECTED', // 400 — the SQL guard refused it
  'TELEMETRY_QUERY_FAILED', // 400 — the database reported an error (+ details.sqlState)
  'TELEMETRY_QUERY_TIMEOUT', // 504 (+ details.timeoutMs)
  'TELEMETRY_ASSISTANT_DISABLED', // 409
] as const;
export type TelemetryErrorReason = (typeof TELEMETRY_ERROR_REASONS)[number];

/** `details.reason` of a telemetry `ApiError`, or `null`. */
export function telemetryErrorReason(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const details = err.details;
  if (typeof details === 'object' && details !== null && 'reason' in details) {
    const reason = (details as { reason?: unknown }).reason;
    return typeof reason === 'string' ? reason : null;
  }
  return null;
}

export async function runTelemetryQuery(
  sql: string,
  options: { maxRows?: number; signal?: AbortSignal } = {},
): Promise<TelemetryQueryResult> {
  const body: { sql: string; maxRows?: number } = { sql };
  if (options.maxRows !== undefined) body.maxRows = options.maxRows;
  return api.post<TelemetryQueryResult>('/admin/telemetry/query', body, {
    signal: options.signal,
  });
}

export async function getTelemetrySchema(): Promise<TelemetrySchema> {
  return api.get<TelemetrySchema>('/admin/telemetry/schema');
}

/** `telemetry-<timestamp>.<ext>` — what the server's Content-Disposition names it too. */
export function telemetryExportFilename(format: TelemetryExportFormat, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `telemetry-${stamp}.${format}`;
}

/** Hand a Blob to the browser as a download (object URL + anchor + revoke). */
export function downloadBlob(blob: Blob, filename: string): boolean {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return true;
  } finally {
    // Deferred: revoking synchronously can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * The filename from a `Content-Disposition` header (`filename*=UTF-8''…` or
 * `filename="…"` / `filename=…`), or `null`. Path separators are stripped.
 */
export function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  let name: string | null = null;
  const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (extended) {
    try {
      name = decodeURIComponent(extended[1].trim().replace(/^"|"$/g, ''));
    } catch {
      name = null;
    }
  }
  if (!name) {
    const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
    name = plain ? (plain[2] ?? plain[1]).trim() : null;
  }
  const safe = name?.replace(/[/\\]/g, '_').trim();
  return safe ? safe : null;
}

export interface TelemetryExportResult {
  filename: string;
  /** `X-Telemetry-Row-Count`, or `null` when absent. */
  rowCount: number | null;
  /** `X-Telemetry-Truncated: true` — the export hit the row cap. */
  truncated: boolean;
}

/**
 * `POST /admin/telemetry/export` — fetched as a Blob through the same
 * authenticated client (bearer token, 401 → refresh → retry), then handed to
 * the browser as a download named by `Content-Disposition`. Resolves with the
 * filename and the row-count/truncation headers.
 */
export async function exportTelemetry(
  sql: string,
  format: TelemetryExportFormat,
): Promise<TelemetryExportResult> {
  const { blob, headers } = await api.post<BlobWithHeaders>(
    '/admin/telemetry/export',
    { sql, format },
    { responseType: 'blobWithHeaders' },
  );
  const filename =
    filenameFromContentDisposition(headers.get('Content-Disposition')) ??
    telemetryExportFilename(format);
  downloadBlob(blob, filename);
  const rawCount = headers.get('X-Telemetry-Row-Count');
  const rowCount = rawCount !== null && rawCount.trim() !== '' ? Number(rawCount) : null;
  return {
    filename,
    rowCount: rowCount !== null && Number.isFinite(rowCount) ? rowCount : null,
    truncated: (headers.get('X-Telemetry-Truncated') ?? '').toLowerCase() === 'true',
  };
}

// =============================================================================
// Assistant (#536)
// =============================================================================

export type TelemetryAssistantTool =
  | 'list_tables'
  | 'describe_table'
  | 'run_query'
  | 'get_app_context'
  | 'health_overview'
  | 'get_trace';

export interface TelemetryAssistantStep {
  index: number;
  tool: TelemetryAssistantTool | string;
  input?: { table?: string; sql?: string; window?: string; traceId?: string };
  rowCount?: number;
  truncated?: boolean;
  durationMs: number;
  error?: string;
  /** The model's interim reasoning, only on the first tool call of a round (#571). */
  thought?: string;
}

export type TelemetryReportStatus = 'issue_found' | 'no_issue_found' | 'inconclusive' | 'no_data';
export type TelemetryFindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type TelemetryReportConfidence = 'high' | 'medium' | 'low';

export interface TelemetryReportFinding {
  title: string;
  severity: TelemetryFindingSeverity;
  evidence: string;
  /** Index into {@link TelemetryAssistantReport.queries}, when a query backs it. */
  queryIndex?: number;
}

export interface TelemetryReportQuery {
  title: string;
  sql: string;
}

/** The troubleshooting agent's structured report (#571). */
export interface TelemetryAssistantReport {
  status: TelemetryReportStatus;
  summary: string;
  findings: TelemetryReportFinding[];
  rootCause: string | null;
  confidence: TelemetryReportConfidence;
  recommendations: string[];
  queries: TelemetryReportQuery[];
}

export interface TelemetryAssistantAnswer {
  /** Back-compat: `report.queries[0].sql`. */
  sql: string | null;
  /** Back-compat: `report.summary`, or the raw text when there is no report. */
  explanation: string;
  /** `null` when the model gave no parseable report; absent on an older API. */
  report?: TelemetryAssistantReport | null;
}

export interface TelemetryAssistantTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface TelemetryAssistantRequest {
  /** 1..4000 characters. */
  question: string;
  /** At most 20 turns. */
  history?: TelemetryAssistantTurn[];
}

export interface TelemetryAssistantHandlers {
  onStep?: (step: TelemetryAssistantStep) => void;
  onAnswer?: (answer: TelemetryAssistantAnswer) => void;
  onError?: (error: { code: string; message: string }) => void;
  signal?: AbortSignal;
}

/** An older API sends no `report`; a newer one may send `null`. Both read as `null`. */
function normalizeAssistantAnswer(payload: Record<string, unknown>): TelemetryAssistantAnswer {
  const answer = payload as unknown as TelemetryAssistantAnswer;
  const report = answer.report;
  return {
    ...answer,
    report: report && typeof report === 'object' ? report : null,
  };
}

export function telemetryAssistantStreamUrl(): string {
  return `${API_BASE_URL}/admin/telemetry/assistant/stream`;
}

/**
 * Stream one assistant turn. Resolves when the stream ends (or quietly on
 * abort). REJECTS with `ApiError` when a gate refused the request before the
 * first byte (`TELEMETRY_ASSISTANT_DISABLED`, `AI_DISABLED`, …).
 */
export async function streamTelemetryAssistant(
  request: TelemetryAssistantRequest,
  handlers: TelemetryAssistantHandlers = {},
): Promise<void> {
  await postSse<Record<string, unknown>>({
    url: telemetryAssistantStreamUrl(),
    body: request,
    authorization: () => {
      const token = api.getAccessToken();
      return token ? `Bearer ${token}` : null;
    },
    reauthenticate: () => api.refreshToken(),
    signal: handlers.signal,
    onFrame: (eventName, data) => {
      const payload = typeof data === 'object' && data !== null ? data : {};
      switch (eventName) {
        case 'step':
          handlers.onStep?.(payload as unknown as TelemetryAssistantStep);
          break;
        case 'answer':
          handlers.onAnswer?.(normalizeAssistantAnswer(payload));
          break;
        case 'error':
          handlers.onError?.({
            code: String((payload as { code?: unknown }).code ?? 'ERROR'),
            message: String((payload as { message?: unknown }).message ?? 'The assistant failed'),
          });
          break;
        default:
          break;
      }
    },
  });
}
