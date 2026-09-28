/**
 * Shared telemetry fixtures — issue #537, epic #528. Shapes follow the API
 * contract (#534 config/status, #535 query/schema/export, #536 assistant).
 *
 * `GET /telemetry/config` answers DISABLED by default (no store deployed);
 * a test that needs the explorer overrides it, or renders with
 * `wrapperOptions: { telemetryEnabled: true }` (see `utils/test-utils.tsx`).
 */
import type {
  TelemetryAdminConfig,
  TelemetryConnection,
  TelemetryConnectionTestResult,
  TelemetryDeploymentConnection,
  TelemetryPublicConfig,
  TelemetryQueryResult,
  TelemetrySchema,
  TelemetryStack,
  TelemetryStatus,
} from '../../../services/telemetry';

export const mockTelemetryPublicConfigDisabled: TelemetryPublicConfig = {
  available: false,
  enabled: false,
  assistantEnabled: false,
};

export const mockTelemetryPublicConfigEnabled: TelemetryPublicConfig = {
  available: true,
  enabled: true,
  assistantEnabled: true,
};

export const mockTelemetryAdminConfig: TelemetryAdminConfig = {
  enabled: true,
  retentionDays: 30,
  // Follows the default (#565): the app slug.
  instanceId: null,
  query: { maxRows: 10000, timeoutSeconds: 30 },
  assistant: {
    enabled: true,
    provider: 'openai',
    modelId: 'gpt-5-mini',
    shareResults: false,
    maxResultRowsToModel: 100,
    maxSteps: 8,
  },
  available: true,
  retentionApplicable: true,
  instanceIdDefault: 'my-app',
  instanceIdEffective: 'my-app',
  version: 7,
  updatedAt: '2026-09-01T10:00:00.000Z',
  updatedBy: { id: 'admin-user-id', email: 'admin@example.com' },
};

export const mockTelemetryStatus: TelemetryStatus = {
  configured: true,
  reachable: true,
  version: 'PostgreSQL 16.3 GreptimeDB 1.2.1',
  database: 'telemetry',
  ttl: { raw: '30days', days: 30 },
  retentionDays: 30,
  tables: [
    { name: 'opentelemetry_traces', rows: 12345 },
    { name: 'opentelemetry_logs', rows: 678 },
  ],
  error: null,
};

export const mockTelemetryStatusUnconfigured: TelemetryStatus = {
  configured: false,
  reachable: false,
  version: null,
  database: 'telemetry',
  ttl: null,
  retentionDays: 30,
  tables: [],
  error: null,
};

export const mockTelemetrySchema: TelemetrySchema = {
  tables: [
    {
      name: 'opentelemetry_traces',
      rows: 12345,
      columns: [
        { name: 'timestamp', type: 'timestamp', semanticType: 'TIMESTAMP' },
        { name: 'trace_id', type: 'text', semanticType: 'FIELD' },
        { name: 'span_name', type: 'text', semanticType: 'TAG' },
        { name: 'span_attributes.http.route', type: 'text', semanticType: 'FIELD' },
      ],
    },
    {
      name: 'opentelemetry_logs',
      rows: null,
      columns: [
        { name: 'timestamp', type: 'timestamp', semanticType: 'TIMESTAMP' },
        { name: 'body', type: 'text', semanticType: 'FIELD' },
      ],
    },
  ],
};

export const mockTelemetryQueryResult: TelemetryQueryResult = {
  columns: [
    { name: 'service_name', type: 'text' },
    { name: 'trace_id', type: 'text' },
    { name: 'service_name', type: 'text' },
  ],
  rows: [
    ['api', 'abc123', 'api-dup'],
    ['web', 'def456', null],
  ],
  rowCount: 2,
  truncated: false,
  elapsedMs: 42,
};

// -----------------------------------------------------------------------------
// GreptimeDB connection (#558, #570). The default handler answers the STORED
// AUTOMATIC one: the deployment supplies the whole connection.
// -----------------------------------------------------------------------------

/** The GreptimeDB deployed with this application, both logins provisioned. */
export const mockTelemetryDeployment: TelemetryDeploymentConnection = {
  host: 'greptimedb',
  pgPort: 4003,
  database: 'public',
  readerUser: 'readonly',
  adminUser: 'admin',
  readerConfigured: true,
  adminConfigured: true,
};

/** A deployment-supplied password: present, but never described by a hint. */
const deploymentPassword = { configured: true, hint: null, updatedAt: null, updatedByUserId: null };
const noPassword = { configured: false, hint: null, updatedAt: null, updatedByUserId: null };

/** Stored automatic marker (`{ host: null }`): deployment-managed, revert has nothing to do. */
export const mockTelemetryConnectionAutomaticStored: TelemetryConnection = {
  source: 'stored',
  host: null,
  effectiveHost: 'greptimedb',
  hostMode: 'auto',
  deploymentManaged: true,
  deployment: mockTelemetryDeployment,
  problem: null,
  pgPort: 4003,
  database: 'public',
  readerUser: 'readonly',
  adminUser: 'admin',
  configured: true,
  adminConfigured: true,
  credentials: { reader: deploymentPassword, admin: deploymentPassword },
  version: 3,
  updatedAt: '2026-09-01T10:00:00.000Z',
  updatedBy: { id: 'admin-user-id', email: 'admin@example.com' },
};

/** Nothing stored: the deployment's own GreptimeDB (`GREPTIME_*`). */
export const mockTelemetryConnectionAutomaticEnvironment: TelemetryConnection = {
  ...mockTelemetryConnectionAutomaticStored,
  source: 'environment',
  version: 0,
  updatedAt: null,
  updatedBy: null,
};

/** A stored custom host: an external GreptimeDB with its passwords in the credential store. */
export const mockTelemetryConnectionCustomStored: TelemetryConnection = {
  source: 'stored',
  host: 'greptime.internal',
  effectiveHost: 'greptime.internal',
  hostMode: 'custom',
  deploymentManaged: false,
  deployment: mockTelemetryDeployment,
  problem: null,
  pgPort: 4004,
  database: 'telemetry',
  readerUser: 'ext_reader',
  adminUser: 'ext_admin',
  configured: true,
  adminConfigured: true,
  credentials: {
    reader: {
      configured: true,
      hint: '••••x9fQ',
      updatedAt: '2026-09-01T10:00:00.000Z',
      updatedByUserId: 'admin-user-id',
    },
    admin: {
      configured: true,
      hint: '••••Ab12',
      updatedAt: '2026-09-01T10:00:00.000Z',
      updatedByUserId: 'admin-user-id',
    },
  },
  version: 5,
  updatedAt: '2026-09-01T10:00:00.000Z',
  updatedBy: { id: 'admin-user-id', email: 'admin@example.com' },
};

/** Deployment-managed, but the deployment provisions no admin login. */
export const mockTelemetryConnectionAutomaticProblem: TelemetryConnection = {
  ...mockTelemetryConnectionAutomaticEnvironment,
  deployment: { ...mockTelemetryDeployment, adminUser: null, adminConfigured: false },
  problem:
    'The deployment provisions no GreptimeDB admin login, so retention cannot be applied. Set GREPTIME_ADMIN_USER and GREPTIME_ADMIN_PASSWORD in the deployment.',
  adminUser: null,
  adminConfigured: false,
  credentials: { reader: deploymentPassword, admin: noPassword },
};

/** The historical names: the default (stored automatic) and the deployment default. */
export const mockTelemetryConnectionStored = mockTelemetryConnectionAutomaticStored;
export const mockTelemetryConnectionEnvironment = mockTelemetryConnectionAutomaticEnvironment;

export const mockTelemetryConnectionNone: TelemetryConnection = {
  source: 'none',
  host: null,
  effectiveHost: 'greptimedb',
  hostMode: 'auto',
  deploymentManaged: false,
  deployment: {
    host: 'greptimedb',
    pgPort: 4003,
    database: 'public',
    readerUser: '',
    adminUser: null,
    readerConfigured: false,
    adminConfigured: false,
  },
  problem: null,
  pgPort: 4003,
  database: 'public',
  readerUser: '',
  adminUser: null,
  configured: false,
  adminConfigured: false,
  credentials: { reader: noPassword, admin: noPassword },
  version: 0,
  updatedAt: null,
  updatedBy: null,
};

export const mockTelemetryConnectionTestResult: TelemetryConnectionTestResult = {
  host: 'greptimedb',
  hostMode: 'auto',
  reader: { success: true, latencyMs: 12, version: 'PostgreSQL 16.3 GreptimeDB 1.2.1' },
  admin: { success: false, latencyMs: 8, error: 'password authentication failed for user "admin"' },
};

// Telemetry services (#567): `GET /admin/telemetry/stack`.

/** Both services up and healthy, the last deploy long settled. */
export const mockTelemetryStackRunning: TelemetryStack = {
  agent: 'available',
  services: [
    { name: 'greptimedb', state: 'running', health: 'healthy' },
    { name: 'otel-collector', state: 'running', health: null },
  ],
  deploy: {
    jobId: 'job-deploy-0',
    status: 'succeeded',
    createdAt: '2026-09-01T10:00:00.000Z',
    finishedAt: '2026-09-01T10:02:00.000Z',
    error: null,
    output: null,
  },
};

/** The agent is reachable but nothing has been deployed yet. */
export const mockTelemetryStackMissing: TelemetryStack = {
  agent: 'available',
  services: [
    { name: 'greptimedb', state: 'missing', health: null },
    { name: 'otel-collector', state: 'missing', health: null },
  ],
  deploy: null,
};

/** No deployment agent (a development stack). */
export const mockTelemetryStackUnavailable: TelemetryStack = {
  agent: 'not_configured',
  services: [],
  deploy: null,
};
