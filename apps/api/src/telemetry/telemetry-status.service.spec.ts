import { DEFAULT_SYSTEM_SETTINGS } from '../common/types/settings.types';
import { TelemetryQueryFailedError } from './greptime/greptime.errors';
import {
  parseHumantimeSeconds,
  parseTtlFromCreateDatabase,
  TelemetryStatusService,
} from './telemetry-status.service';

function build(options: { configured?: boolean; admin?: boolean; problem?: string | null } = {}) {
  const greptime = {
    database: 'public',
    configurationProblem: jest.fn().mockReturnValue(options.problem ?? null),
    isConfigured: jest.fn().mockReturnValue(options.configured ?? true),
    isAdminConfigured: jest.fn().mockReturnValue(options.admin ?? true),
    ping: jest.fn().mockResolvedValue({ reachable: true, version: 'PostgreSQL 16.3 GreptimeDB 1.2.1' }),
    queryAdmin: jest.fn().mockResolvedValue({
      fields: [
        { name: 'Database', dataTypeID: 1043 },
        { name: 'Create Database', dataTypeID: 1043 },
      ],
      rows: [['public', "CREATE DATABASE IF NOT EXISTS public\nWITH(\n  ttl = '7days'\n)"]],
    }),
    queryReader: jest.fn().mockResolvedValue({
      fields: [
        { name: 'table_name', dataTypeID: 1043 },
        { name: 'table_rows', dataTypeID: 20 },
      ],
      rows: [
        ['opentelemetry_logs', '1234'],
        ['opentelemetry_traces', null],
      ],
    }),
  };
  const settings = {
    getPolicy: jest.fn().mockResolvedValue({ ...DEFAULT_SYSTEM_SETTINGS.telemetry, retentionDays: 7 }),
  };

  return { service: new TelemetryStatusService(greptime as never, settings as never), greptime };
}

describe('TelemetryStatusService', () => {
  it('reports an unconfigured store without touching it', async () => {
    const { service, greptime } = build({ configured: false });

    await expect(service.getStatus()).resolves.toEqual({
      configured: false,
      reachable: false,
      version: null,
      database: 'public',
      ttl: null,
      retentionDays: 7,
      tables: [],
      error: null,
    });
    expect(greptime.ping).not.toHaveBeenCalled();
  });

  it('says why the deployment\'s own GreptimeDB is unconfigured, in administrator language (issue #570)', async () => {
    const problem =
      'The GreptimeDB deployed with this application has no reader login configured. ' +
      'Update the application to provision it.';
    const { service, greptime } = build({ configured: false, problem });

    const status = await service.getStatus();

    expect(status).toMatchObject({ configured: false, reachable: false, error: problem });
    expect(status.error).not.toMatch(/env|compose|GREPTIME_|appctl|CLI/i);
    expect(greptime.ping).not.toHaveBeenCalled();
  });

  it('reports an unreachable store as a field, not an error', async () => {
    const { service, greptime } = build();
    greptime.ping.mockResolvedValue({ reachable: false, error: 'connect ECONNREFUSED' });

    await expect(service.getStatus()).resolves.toMatchObject({
      configured: true,
      reachable: false,
      error: 'connect ECONNREFUSED',
      tables: [],
    });
    expect(greptime.queryReader).not.toHaveBeenCalled();
  });

  it('reports version, TTL (parsed from "7days") and tables when reachable', async () => {
    const { service, greptime } = build();

    await expect(service.getStatus()).resolves.toEqual({
      configured: true,
      reachable: true,
      version: 'PostgreSQL 16.3 GreptimeDB 1.2.1',
      database: 'public',
      ttl: { raw: '7days', days: 7 },
      retentionDays: 7,
      tables: [
        { name: 'opentelemetry_logs', rows: 1234 },
        { name: 'opentelemetry_traces', rows: null },
      ],
      error: null,
    });
    expect(greptime.queryAdmin).toHaveBeenCalledWith('SHOW CREATE DATABASE "public"', { timeoutMs: 5000 });
    expect(greptime.queryReader).toHaveBeenCalledWith(
      "SELECT table_name, table_rows FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
      { timeoutMs: 5000 },
    );
  });

  it('falls back to the reader for SHOW CREATE DATABASE without an admin credential', async () => {
    const { service, greptime } = build({ admin: false });
    greptime.queryReader.mockResolvedValueOnce({
      fields: [],
      rows: [['public', 'CREATE DATABASE IF NOT EXISTS public']],
    });

    const status = await service.getStatus();

    expect(greptime.queryAdmin).not.toHaveBeenCalled();
    expect(status.ttl).toBeNull();
  });

  it('reports a partial failure without failing the whole status', async () => {
    const { service, greptime } = build();
    greptime.queryAdmin.mockRejectedValue(new TelemetryQueryFailedError('not authorized'));

    await expect(service.getStatus()).resolves.toMatchObject({
      reachable: true,
      ttl: null,
      tables: [{ name: 'opentelemetry_logs', rows: 1234 }, expect.anything()],
      error: 'TTL: not authorized',
    });
  });
});

describe('parseTtlFromCreateDatabase', () => {
  it.each([
    ["WITH(\n  ttl = '7days'\n)", { raw: '7days', days: 7 }],
    ["WITH(ttl = '30days')", { raw: '30days', days: 30 }],
    ["WITH(ttl = '1month 13h 26m 24s')", { raw: '1month 13h 26m 24s', days: 31 }],
    ["WITH(ttl = '1year')", { raw: '1year', days: 365 }],
    ["WITH(ttl = 'forever')", { raw: 'forever', days: null }],
  ])('parses %j', (statement, expected) => {
    expect(parseTtlFromCreateDatabase(statement)).toEqual(expected);
  });

  it('returns null when no TTL is set', () => {
    expect(parseTtlFromCreateDatabase('CREATE DATABASE IF NOT EXISTS public')).toBeNull();
  });
});

describe('parseHumantimeSeconds', () => {
  it('distinguishes minutes (m) from months (M/month)', () => {
    expect(parseHumantimeSeconds('5m')).toBe(300);
    expect(parseHumantimeSeconds('1M')).toBe(2_630_016);
  });

  it('rejects trailing garbage', () => {
    expect(parseHumantimeSeconds('7days and more')).toBeNull();
    expect(parseHumantimeSeconds('')).toBeNull();
  });
});
