import { HttpStatus } from '@nestjs/common';

import { TelemetryQueryTimeoutError } from '../greptime/greptime.errors';
import { TelemetryHttpError } from './telemetry-query.errors';
import { groupSchema, TELEMETRY_SCHEMA_CACHE_MS, TelemetrySchemaService } from './telemetry-schema.service';

const TABLES = {
  fields: [],
  rows: [
    ['opentelemetry_traces', '42'],
    ['opentelemetry_logs', null],
  ],
};

const COLUMNS = {
  fields: [],
  rows: [
    ['opentelemetry_traces', 'span_name', 'string', 'FIELD', '3'],
    ['opentelemetry_traces', 'timestamp', 'timestamp(9)', 'TIMESTAMP', '1'],
    ['opentelemetry_traces', 'span_attributes.http.route', 'string', 'FIELD', '20'],
    ['opentelemetry_logs', 'body', 'string', 'FIELD', '6'],
    ['opentelemetry_logs', 'timestamp', 'timestamp(9)', 'TIMESTAMP', '1'],
  ],
};

function setup(opts: { configured?: boolean; enabled?: boolean } = {}) {
  const greptime = {
    isConfigured: jest.fn().mockReturnValue(opts.configured ?? true),
    database: "pub'lic",
    queryReader: jest.fn((sql: string) =>
      Promise.resolve(sql.includes('information_schema.tables') ? TABLES : COLUMNS),
    ),
  };
  const settings = {
    getPolicy: jest.fn().mockResolvedValue({ enabled: opts.enabled ?? true, query: { maxRows: 10, timeoutSeconds: 9 } }),
  };

  return { service: new TelemetrySchemaService(greptime as never, settings as never), greptime };
}

describe('TelemetrySchemaService', () => {
  afterEach(() => jest.useRealTimers());

  it('groups columns by table, sorted by table name and column position', async () => {
    const { service } = setup();

    await expect(service.getSchema()).resolves.toEqual({
      tables: [
        {
          name: 'opentelemetry_logs',
          rows: null,
          columns: [
            { name: 'timestamp', type: 'timestamp(9)', semanticType: 'TIMESTAMP' },
            { name: 'body', type: 'string', semanticType: 'FIELD' },
          ],
        },
        {
          name: 'opentelemetry_traces',
          rows: 42,
          columns: [
            { name: 'timestamp', type: 'timestamp(9)', semanticType: 'TIMESTAMP' },
            { name: 'span_name', type: 'string', semanticType: 'FIELD' },
            { name: 'span_attributes.http.route', type: 'string', semanticType: 'FIELD' },
          ],
        },
      ],
    });
  });

  it('filters on the configured database, quoted, with the policy timeout', async () => {
    const { service, greptime } = setup();

    await service.getSchema();

    for (const [sql, options] of greptime.queryReader.mock.calls as unknown as [string, unknown][]) {
      expect(sql).toContain("WHERE table_schema = 'pub''lic'");
      expect(options).toEqual({ timeoutMs: 9_000 });
    }
  });

  it('caches for 30 seconds and shares concurrent reads', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const { service, greptime } = setup();

    await Promise.all([service.getSchema(), service.getSchema()]);
    expect(greptime.queryReader).toHaveBeenCalledTimes(2);

    await service.getSchema();
    expect(greptime.queryReader).toHaveBeenCalledTimes(2);

    jest.setSystemTime(1_000_000 + TELEMETRY_SCHEMA_CACHE_MS + 1);
    await service.getSchema();
    expect(greptime.queryReader).toHaveBeenCalledTimes(4);

    await service.getSchema({ fresh: true });
    expect(greptime.queryReader).toHaveBeenCalledTimes(6);
  });

  it('tableExists / describeTable match exactly', async () => {
    const { service } = setup();

    await expect(service.tableExists('opentelemetry_logs')).resolves.toBe(true);
    await expect(service.tableExists('OPENTELEMETRY_LOGS')).resolves.toBe(false);
    await expect(service.tableExists('opentelemetry_logs; DROP TABLE x')).resolves.toBe(false);
    await expect(service.describeTable('nope')).resolves.toBeNull();
    await expect(service.describeTable('opentelemetry_logs')).resolves.toMatchObject({ name: 'opentelemetry_logs' });
  });

  it('503 when not configured, 409 when disabled', async () => {
    const unconfigured = await setup({ configured: false }).service.getSchema().catch((e: unknown) => e);
    const disabled = await setup({ enabled: false }).service.getSchema().catch((e: unknown) => e);

    expect((unconfigured as TelemetryHttpError).getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect((disabled as TelemetryHttpError).getStatus()).toBe(HttpStatus.CONFLICT);
  });

  it('maps a store failure and does not cache it', async () => {
    const { service, greptime } = setup();
    greptime.queryReader.mockRejectedValueOnce(new TelemetryQueryTimeoutError(9_000));

    const error = await service.getSchema().catch((e: unknown) => e);

    expect((error as TelemetryHttpError).getStatus()).toBe(HttpStatus.GATEWAY_TIMEOUT);
    await expect(service.getSchema()).resolves.toMatchObject({ tables: expect.any(Array) });
  });
});

describe('groupSchema', () => {
  it('creates a table seen only in the column list and tolerates missing metadata', () => {
    expect(groupSchema([], [['t', 'a', null, '', null]])).toEqual({
      tables: [{ name: 't', rows: null, columns: [{ name: 'a', type: 'unknown', semanticType: null }] }],
    });
  });
});
