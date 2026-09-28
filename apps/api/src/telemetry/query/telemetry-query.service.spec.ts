import { HttpStatus } from '@nestjs/common';

import type { SystemTelemetryValue } from '../../common/schemas/settings.schema';
import {
  TelemetryMultiStatementError,
  TelemetryNotConfiguredError,
  TelemetryQueryFailedError,
  TelemetryQueryTimeoutError,
} from '../greptime/greptime.errors';
import { TelemetryHttpError } from './telemetry-query.errors';
import {
  columnTypeName,
  TELEMETRY_AUDIT_SQL_MAX,
  TelemetryQueryService,
  toJsonSafe,
} from './telemetry-query.service';

const POLICY: SystemTelemetryValue = {
  enabled: true,
  retentionDays: 7,
  instanceId: null,
  query: { maxRows: 3, timeoutSeconds: 12 },
  assistant: {
    enabled: false,
    provider: null,
    modelId: null,
    shareResults: true,
    maxResultRowsToModel: 20,
    maxSteps: 6,
  },
};

function setup(overrides: { configured?: boolean; policy?: Partial<SystemTelemetryValue> } = {}) {
  const greptime = {
    isConfigured: jest.fn().mockReturnValue(overrides.configured ?? true),
    database: 'public',
    queryReader: jest.fn().mockResolvedValue({ fields: [], rows: [] }),
  };
  const settings = { getPolicy: jest.fn().mockResolvedValue({ ...POLICY, ...overrides.policy }) };
  const prisma = { auditEvent: { create: jest.fn().mockResolvedValue({}) } };
  const service = new TelemetryQueryService(greptime as never, settings as never, prisma as never);

  const auditMeta = () => prisma.auditEvent.create.mock.calls.at(-1)?.[0].data;

  return { service, greptime, settings, prisma, auditMeta };
}

async function failure(promise: Promise<unknown>): Promise<TelemetryHttpError> {
  const error = await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TelemetryHttpError);
  return error as TelemetryHttpError;
}

function bodyOf(error: TelemetryHttpError) {
  return error.getResponse() as { message: string; details: Record<string, unknown> };
}

describe('TelemetryQueryService', () => {
  describe('preconditions', () => {
    it('503 TELEMETRY_NOT_CONFIGURED without a store, and never reads the policy', async () => {
      const { service, settings, greptime, prisma } = setup({ configured: false });

      const error = await failure(service.run('u1', 'SELECT 1'));

      expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(bodyOf(error).details.reason).toBe('TELEMETRY_NOT_CONFIGURED');
      expect(settings.getPolicy).not.toHaveBeenCalled();
      expect(greptime.queryReader).not.toHaveBeenCalled();
      expect(prisma.auditEvent.create).not.toHaveBeenCalled();
    });

    it('409 TELEMETRY_DISABLED when telemetry is off', async () => {
      const { service, greptime } = setup({ policy: { enabled: false } });

      const error = await failure(service.run('u1', 'SELECT 1'));

      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(bodyOf(error).details.reason).toBe('TELEMETRY_DISABLED');
      expect(greptime.queryReader).not.toHaveBeenCalled();
    });
  });

  describe('a successful query', () => {
    it('appends a top-level LIMIT maxRows + 1, uses the policy timeout, and maps columns', async () => {
      const { service, greptime } = setup();
      greptime.queryReader.mockResolvedValue({
        fields: [
          { name: 'ts', dataTypeID: 1114 },
          { name: 'n', dataTypeID: 20 },
          { name: 'x', dataTypeID: 99999 },
        ],
        rows: [['2026-09-27 10:00:00.123456789', '9007199254740993', null]],
      });

      const result = await service.run('u1', 'SELECT ts, n, x FROM t;');

      expect(greptime.queryReader).toHaveBeenCalledWith(
        'SELECT ts, n, x FROM t LIMIT 4',
        { timeoutMs: 12_000 },
      );
      expect(result).toMatchObject({
        columns: [
          { name: 'ts', type: 'timestamp' },
          { name: 'n', type: 'int8' },
          { name: 'x', type: 'unknown' },
        ],
        rows: [['2026-09-27 10:00:00.123456789', '9007199254740993', null]],
        rowCount: 1,
        truncated: false,
      });
      expect(typeof result.elapsedMs).toBe('number');
    });

    it('detects truncation from the extra row and drops it', async () => {
      const { service, greptime } = setup();
      greptime.queryReader.mockResolvedValue({
        fields: [{ name: 'n', dataTypeID: 23 }],
        rows: [[1], [2], [3], [4]],
      });

      const result = await service.run('u1', 'SELECT n FROM t');

      expect(result.rows).toEqual([[1], [2], [3]]);
      expect(result).toMatchObject({ rowCount: 3, truncated: true });
    });

    it('is not truncated at exactly maxRows', async () => {
      const { service, greptime } = setup();
      greptime.queryReader.mockResolvedValue({ fields: [{ name: 'n', dataTypeID: 23 }], rows: [[1], [2], [3]] });

      await expect(service.run('u1', 'SELECT n FROM t')).resolves.toMatchObject({ rowCount: 3, truncated: false });
    });

    it('clamps a caller maxRows to the policy, and honours a smaller one', async () => {
      const { service, greptime } = setup();

      await service.run('u1', 'SELECT 1', { maxRows: 1_000 });
      await service.run('u1', 'SELECT 1', { maxRows: 1 });
      await service.run('u1', 'SELECT 1', { maxRows: 0 });

      expect(greptime.queryReader.mock.calls.map((call) => /LIMIT (\d+)$/.exec(call[0])?.[1])).toEqual(['4', '2', '2']);
    });

    it('never wraps: the LIMIT goes after the statement\'s own ORDER BY (#554)', async () => {
      const { service, greptime } = setup();

      await service.run('u1', 'SELECT ts FROM t ORDER BY ts DESC');

      expect(greptime.queryReader).toHaveBeenCalledWith('SELECT ts FROM t ORDER BY ts DESC LIMIT 4', {
        timeoutMs: 12_000,
      });
    });

    it('clamps a caller LIMIT above the cap and still detects truncation', async () => {
      const { service, greptime } = setup();
      greptime.queryReader.mockResolvedValue({ fields: [{ name: 'n', dataTypeID: 23 }], rows: [[1], [2], [3], [4]] });

      const result = await service.run('u1', 'SELECT n FROM t ORDER BY n LIMIT 500 OFFSET 2');

      expect(greptime.queryReader).toHaveBeenCalledWith('SELECT n FROM t ORDER BY n LIMIT 4 OFFSET 2', {
        timeoutMs: 12_000,
      });
      expect(result).toMatchObject({ rows: [[1], [2], [3]], rowCount: 3, truncated: true });
    });

    it('keeps a caller LIMIT below the cap unchanged, and is not truncated', async () => {
      const { service, greptime } = setup();
      greptime.queryReader.mockResolvedValue({ fields: [{ name: 'n', dataTypeID: 23 }], rows: [[1], [2]] });

      const result = await service.run('u1', 'SELECT n FROM t ORDER BY n LIMIT 2;');

      expect(greptime.queryReader).toHaveBeenCalledWith('SELECT n FROM t ORDER BY n LIMIT 2', { timeoutMs: 12_000 });
      expect(result).toMatchObject({ rowCount: 2, truncated: false });
    });

    it('caps client-side when the text cannot be bounded (LIMIT ALL)', async () => {
      const { service, greptime } = setup();
      greptime.queryReader.mockResolvedValue({
        fields: [{ name: 'n', dataTypeID: 23 }],
        rows: [[1], [2], [3], [4], [5], [6]],
      });

      const result = await service.run('u1', 'SELECT n FROM t LIMIT ALL');

      expect(greptime.queryReader).toHaveBeenCalledWith('SELECT n FROM t LIMIT ALL', { timeoutMs: 12_000 });
      expect(result).toMatchObject({ rows: [[1], [2], [3]], rowCount: 3, truncated: true });
    });

    it('sends SHOW unwrapped and still trims to maxRows', async () => {
      const { service, greptime } = setup();
      greptime.queryReader.mockResolvedValue({
        fields: [{ name: 'Tables', dataTypeID: 1043 }],
        rows: [['a'], ['b'], ['c'], ['d'], ['e']],
      });

      const result = await service.run('u1', 'show tables');

      expect(greptime.queryReader).toHaveBeenCalledWith('show tables', { timeoutMs: 12_000 });
      expect(result).toMatchObject({ rowCount: 3, truncated: true });
    });

    it('makes every value JSON-safe', async () => {
      const { service, greptime } = setup();
      greptime.queryReader.mockResolvedValue({
        fields: [{ name: 'v', dataTypeID: 17 }],
        rows: [[Buffer.from('hi')], [BigInt('12345678901234567890')], [new Date('2026-09-27T00:00:00Z')]],
      });

      const result = await service.run('u1', 'SELECT v FROM t');

      expect(result.rows).toEqual([['aGk='], ['12345678901234567890'], ['2026-09-27T00:00:00.000Z']]);
      expect(() => JSON.stringify(result)).not.toThrow();
    });

    it.each([
      ['explorer', 'telemetry:query'],
      ['export', 'telemetry:export'],
      ['assistant', 'telemetry:assistant_query'],
    ] as const)('audits a %s run as %s', async (source, action) => {
      const { service, greptime, auditMeta } = setup();
      greptime.queryReader.mockResolvedValue({ fields: [{ name: 'n', dataTypeID: 23 }], rows: [[1]] });

      await service.run('u1', 'SELECT n FROM t', { source });

      expect(auditMeta()).toEqual({
        actorUserId: 'u1',
        action,
        targetType: 'telemetry_store',
        targetId: 'public',
        meta: { sql: 'SELECT n FROM t', source, rowCount: 1, truncated: false, elapsedMs: expect.any(Number) },
      });
    });

    it('truncates long SQL in the audit row and records its length', async () => {
      const { service, auditMeta } = setup();
      const sql = `SELECT '${'x'.repeat(TELEMETRY_AUDIT_SQL_MAX)}'`;

      await service.run('u1', sql);

      const meta = auditMeta().meta as { sql: string; sqlLength: number };
      expect(meta.sql).toHaveLength(TELEMETRY_AUDIT_SQL_MAX + 1);
      expect(meta.sql.endsWith('…')).toBe(true);
      expect(meta.sqlLength).toBe(sql.length);
    });
  });

  describe('failures', () => {
    it('400 TELEMETRY_QUERY_REJECTED for a guard refusal, audited, never sent', async () => {
      const { service, greptime, auditMeta } = setup();

      const error = await failure(service.run('u1', 'DROP TABLE t'));

      expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(bodyOf(error)).toMatchObject({
        message: expect.stringContaining('DROP statements are not allowed'),
        details: { reason: 'TELEMETRY_QUERY_REJECTED' },
      });
      expect(greptime.queryReader).not.toHaveBeenCalled();
      expect(auditMeta()).toMatchObject({
        action: 'telemetry:query',
        meta: {
          sql: 'DROP TABLE t',
          rowCount: 0,
          truncated: false,
          reason: 'TELEMETRY_QUERY_REJECTED',
          error: expect.stringContaining('DROP'),
        },
      });
    });

    it('400 TELEMETRY_QUERY_REJECTED for a multi-statement result', async () => {
      const { service, greptime } = setup();
      greptime.queryReader.mockRejectedValue(new TelemetryMultiStatementError());

      const error = await failure(service.run('u1', 'SELECT 1'));

      expect(bodyOf(error).details.reason).toBe('TELEMETRY_QUERY_REJECTED');
    });

    it('504 TELEMETRY_QUERY_TIMEOUT on a timeout, audited', async () => {
      const { service, greptime, auditMeta } = setup();
      greptime.queryReader.mockRejectedValue(new TelemetryQueryTimeoutError(12_000));

      const error = await failure(service.run('u1', 'SELECT 1', { source: 'assistant' }));

      expect(error.getStatus()).toBe(HttpStatus.GATEWAY_TIMEOUT);
      expect(bodyOf(error).details).toEqual({ reason: 'TELEMETRY_QUERY_TIMEOUT', timeoutMs: 12_000 });
      expect(auditMeta()).toMatchObject({
        action: 'telemetry:assistant_query',
        meta: { reason: 'TELEMETRY_QUERY_TIMEOUT' },
      });
    });

    it('400 TELEMETRY_QUERY_FAILED with the server message for a server error', async () => {
      const { service, greptime } = setup();
      greptime.queryReader.mockRejectedValue(new TelemetryQueryFailedError('Table not found: nope', '42P01', 'server'));

      const error = await failure(service.run('u1', 'SELECT * FROM nope'));

      expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(bodyOf(error)).toEqual({
        message: 'Table not found: nope',
        details: { reason: 'TELEMETRY_QUERY_FAILED', sqlState: '42P01' },
      });
    });

    it('503 TELEMETRY_UNREACHABLE for a connection failure', async () => {
      const { service, greptime } = setup();
      greptime.queryReader.mockRejectedValue(
        new TelemetryQueryFailedError('Could not connect to GreptimeDB: ECONNREFUSED', 'ECONNREFUSED', 'connection'),
      );

      const error = await failure(service.run('u1', 'SELECT 1'));

      expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(bodyOf(error).details.reason).toBe('TELEMETRY_UNREACHABLE');
    });

    it('503 TELEMETRY_NOT_CONFIGURED if the client says so mid-flight', async () => {
      const { service, greptime } = setup();
      greptime.queryReader.mockRejectedValue(new TelemetryNotConfiguredError('reader'));

      expect(bodyOf(await failure(service.run('u1', 'SELECT 1'))).details.reason).toBe('TELEMETRY_NOT_CONFIGURED');
    });

    it('rethrows an unknown error unchanged (a 500), audited', async () => {
      const { service, greptime, prisma } = setup();
      const boom = new Error('boom');
      greptime.queryReader.mockRejectedValue(boom);

      await expect(service.run('u1', 'SELECT 1')).rejects.toBe(boom);
      expect(prisma.auditEvent.create).toHaveBeenCalledTimes(1);
    });

    it('a failed audit write does not replace the query error', async () => {
      const { service, prisma } = setup();
      prisma.auditEvent.create.mockRejectedValue(new Error('db down'));

      const error = await failure(service.run('u1', 'DELETE FROM t'));

      expect(bodyOf(error).details.reason).toBe('TELEMETRY_QUERY_REJECTED');
    });

    it('a failed audit write after a successful query is surfaced', async () => {
      const { service, prisma } = setup();
      prisma.auditEvent.create.mockRejectedValue(new Error('db down'));

      await expect(service.run('u1', 'SELECT 1')).rejects.toThrow('db down');
      expect(prisma.auditEvent.create).toHaveBeenCalledTimes(1);
    });
  });
});

describe('columnTypeName', () => {
  it.each([
    [16, 'bool'],
    [20, 'int8'],
    [21, 'int2'],
    [23, 'int4'],
    [700, 'float4'],
    [701, 'float8'],
    [1700, 'numeric'],
    [25, 'text'],
    [1043, 'text'],
    [1114, 'timestamp'],
    [1184, 'timestamp'],
    [114, 'json'],
    [3802, 'json'],
    [17, 'bytea'],
    [0, 'unknown'],
  ])('%i → %s', (oid, name) => {
    expect(columnTypeName(oid)).toBe(name);
  });
});

describe('toJsonSafe', () => {
  it('converts nested values and non-finite numbers', () => {
    expect(
      toJsonSafe({
        a: [1, BigInt(2), Buffer.from([0xff])],
        b: { c: new Date('2026-01-01T00:00:00Z'), d: undefined },
        e: Number.NaN,
        f: Number.POSITIVE_INFINITY,
        g: new Uint8Array([1, 2]),
        h: new Date('invalid'),
      }),
    ).toEqual({
      a: [1, '2', '/w=='],
      b: { c: '2026-01-01T00:00:00.000Z', d: null },
      e: 'NaN',
      f: 'Infinity',
      g: 'AQI=',
      h: null,
    });
  });
});
