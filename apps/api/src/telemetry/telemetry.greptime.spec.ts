import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Workbook } from 'exceljs';

import type { SystemTelemetryValue } from '../common/schemas/settings.schema';
import { buildParquetColumns, TelemetryExportService } from './export/telemetry-export.service';
import { TelemetryConnectionService } from './connection/telemetry-connection.service';
import { GreptimeClient } from './greptime/greptime.client';
import { TelemetryQueryFailedError, TelemetryMultiStatementError } from './greptime/greptime.errors';
import { retentionStatement } from './handlers/telemetry-retention.handler';
import { TelemetryHttpError } from './query/telemetry-query.errors';
import { TelemetryQueryService } from './query/telemetry-query.service';
import { TelemetrySchemaService } from './query/telemetry-schema.service';
import { parquetRoundTrip } from './testing/parquet-child';
import { TelemetryStatusService } from './telemetry-status.service';

// =============================================================================
// Telemetry explorer against a REAL GreptimeDB (issue #535; reused by #538)
// =============================================================================
//
// Excluded from `npm test`; run with `npm run test:greptime` and:
//
//   GREPTIME_TEST_URL        postgres://reader:<pw>@host:4003/public  (a `readonly` user)
//   GREPTIME_TEST_ADMIN_URL  postgres://admin:<pw>@host:4003/public   (seeds the fixture table)
//   GREPTIME_TEST_OUT_DIR    optional: where to save the exported files for inspection
//
// A disposable store:
//
//   docker run -d --name gtx -p 4203:4003 -e GREPTIMEDB_STANDALONE__ENABLE_TELEMETRY=false \
//     greptime/greptimedb:v1.2.1 standalone start --postgres-addr 0.0.0.0:4003 \
//     --user-provider='static_user_provider:cmd:admin=a,reader:readonly=r'
//
// Without GREPTIME_TEST_URL every test is skipped.
// =============================================================================

const READER_URL = process.env.GREPTIME_TEST_URL;
const ADMIN_URL = process.env.GREPTIME_TEST_ADMIN_URL;
const OUT_DIR = process.env.GREPTIME_TEST_OUT_DIR;

const TABLE = 'explorer_fixture_535';
const ORDER_TABLE = 'row_cap_order_554';

/** 20 hosts `h00`…`h19`, `h<i>` at 10:00:<i>; inserted shuffled. */
const ORDER_HOSTS = Array.from({ length: 20 }, (_, i) => `h${String(i).padStart(2, '0')}`);
const NEWEST_FIRST = [...ORDER_HOSTS].reverse();

const POLICY: SystemTelemetryValue = {
  enabled: true,
  retentionDays: 7,
  instanceId: null,
  query: { maxRows: 100, timeoutSeconds: 15 },
  assistant: {
    enabled: false,
    provider: null,
    modelId: null,
    shareResults: true,
    maxResultRowsToModel: 20,
    maxSteps: 6,
  },
};

function clientFor(readerUrl: string, adminUrl?: string): GreptimeClient {
  const reader = new URL(readerUrl);
  const admin = adminUrl ? new URL(adminUrl) : undefined;
  const config = {
    host: reader.hostname,
    pgPort: Number(reader.port || 4003),
    database: reader.pathname.replace(/^\//, '') || 'public',
    readerUser: decodeURIComponent(reader.username),
    readerPassword: decodeURIComponent(reader.password),
    adminUser: admin ? decodeURIComponent(admin.username) : '',
    adminPassword: admin ? decodeURIComponent(admin.password) : '',
    available: true,
  };

  return new GreptimeClient(new TelemetryConnectionService({ get: () => config } as never, {} as never, {} as never));
}

const describeLive = READER_URL ? describe : describe.skip;
// Retention needs the admin credential (`ALTER DATABASE`, `SHOW CREATE
// DATABASE`); skip rather than fail when only GREPTIME_TEST_URL is set.
const itAdmin = ADMIN_URL ? it : it.skip;

describeLive('telemetry explorer — live GreptimeDB', () => {
  let greptime: GreptimeClient;
  let queries: TelemetryQueryService;
  let schema: TelemetrySchemaService;
  let exporter: TelemetryExportService;
  const audit = { auditEvent: { create: jest.fn().mockResolvedValue({}) } };

  beforeAll(async () => {
    greptime = clientFor(READER_URL!, ADMIN_URL);
    const settings = { getPolicy: jest.fn().mockResolvedValue(POLICY) };
    queries = new TelemetryQueryService(greptime, settings as never, audit as never);
    schema = new TelemetrySchemaService(greptime, settings as never);
    exporter = new TelemetryExportService(queries, settings as never);

    if (ADMIN_URL) {
      const t = { timeoutMs: 15_000 };
      await greptime.queryAdmin(
        `CREATE TABLE IF NOT EXISTS ${TABLE} (ts TIMESTAMP(9) TIME INDEX, host STRING PRIMARY KEY, ` +
          'v DOUBLE, n BIGINT, u BIGINT UNSIGNED, ok BOOLEAN, "span_attributes.http.route" STRING)',
        t,
      );
      await greptime.queryAdmin(
        `INSERT INTO ${TABLE} VALUES ` +
          "('2026-09-27 10:00:00.123456789', 'a', 1.5, 9007199254740993, 18446744073709551615, true, '/api/x'), " +
          "('2026-09-27 10:00:01', 'b,\"q\"', NULL, -5, 3, false, '=cmd'), " +
          "('2026-09-27 10:00:02', 'c', 2.5, 7, 4, NULL, NULL)",
        t,
      );

      await greptime.queryAdmin(
        `CREATE TABLE IF NOT EXISTS ${ORDER_TABLE} (ts TIMESTAMP(3) TIME INDEX, host STRING PRIMARY KEY, v BIGINT)`,
        t,
      );
      const shuffled = ORDER_HOSTS.map((host, i) => ({ host, i, key: (i * 7) % 20 })).sort((a, b) => a.key - b.key);
      await greptime.queryAdmin(
        `INSERT INTO ${ORDER_TABLE} VALUES ` +
          shuffled.map(({ host, i }) => `('2026-09-27 10:00:${String(i).padStart(2, '0')}', '${host}', ${i})`).join(', '),
        t,
      );
    }
  });

  afterAll(async () => {
    await greptime?.onModuleDestroy();
  });

  it('runs a row-capped SELECT, keeping int8/UInt64 and timestamps as text', async () => {
    const result = await queries.run(
      'u1',
      `SELECT ts, host, v, n, u, ok, "span_attributes.http.route" FROM ${TABLE} ORDER BY ts; -- trailing`,
    );

    expect(result.columns.map((c) => [c.name, c.type])).toEqual([
      ['ts', 'timestamp'],
      ['host', 'text'],
      ['v', 'float8'],
      ['n', 'int8'],
      ['u', 'numeric'],
      ['ok', 'bool'],
      ['span_attributes.http.route', 'text'],
    ]);
    expect(result.rows[0]).toEqual([
      // The PostgreSQL protocol carries microseconds: GreptimeDB drops the
      // last three digits of a TIMESTAMP(9) on this wire.
      '2026-09-27 10:00:00.123456',
      'a',
      1.5,
      '9007199254740993',
      '18446744073709551615',
      true,
      '/api/x',
    ]);
    expect(result).toMatchObject({ rowCount: 3, truncated: false });
    expect(audit.auditEvent.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'telemetry:query' }) }),
    );
  });

  it('truncates at maxRows using the server-side LIMIT', async () => {
    await expect(queries.run('u1', `SELECT host FROM ${TABLE} ORDER BY ts`, { maxRows: 2 })).resolves.toMatchObject({
      rowCount: 2,
      truncated: true,
    });
  });

  it('caps a WITH and a join with repeated column names', async () => {
    const result = await queries.run(
      'u1',
      `WITH x AS (SELECT host FROM ${TABLE}) SELECT a.host, b.host FROM x a JOIN x b ON a.host = b.host`,
    );

    expect(result.columns).toHaveLength(2);
    expect(result.rowCount).toBe(3);
  });

  it('runs SHOW, DESCRIBE and EXPLAIN unchanged', async () => {
    await expect(queries.run('u1', 'SHOW TABLES')).resolves.toMatchObject({ truncated: false });
    await expect(queries.run('u1', `DESCRIBE ${TABLE}`)).resolves.toMatchObject({ rowCount: 7 });
    await expect(queries.run('u1', `EXPLAIN SELECT * FROM ${TABLE}`)).resolves.toMatchObject({
      columns: [expect.objectContaining({ name: 'plan_type' }), expect.objectContaining({ name: 'plan' })],
    });
  });

  // Issue #554: a `SELECT * FROM (<sql>) LIMIT n` wrapper lost the inner
  // ORDER BY on GreptimeDB. The cap is now a top-level LIMIT.
  describe('the row cap preserves ORDER BY (#554)', () => {
    const hosts = (rows: unknown[][]) => rows.map((row) => row[0]);
    const skipWithoutAdmin = ADMIN_URL ? it : it.skip;

    skipWithoutAdmin('appended: ORDER BY ts DESC comes back newest first', async () => {
      const result = await queries.run('u1', `SELECT host, ts FROM ${ORDER_TABLE} ORDER BY ts DESC`);

      expect(hosts(result.rows)).toEqual(NEWEST_FIRST);
      expect(result).toMatchObject({ rowCount: 20, truncated: false });
    });

    skipWithoutAdmin('appended and truncated: the first maxRows of the ORDER, flagged', async () => {
      const result = await queries.run('u1', `SELECT host FROM ${ORDER_TABLE} ORDER BY ts DESC`, { maxRows: 4 });

      expect(hosts(result.rows)).toEqual(NEWEST_FIRST.slice(0, 4));
      expect(result).toMatchObject({ rowCount: 4, truncated: true });
    });

    skipWithoutAdmin('appended after UNION ALL … ORDER BY: the whole union, in order', async () => {
      const sql =
        `SELECT host, ts FROM ${ORDER_TABLE} WHERE host < 'h10' UNION ALL ` +
        `SELECT host, ts FROM ${ORDER_TABLE} WHERE host >= 'h10' ORDER BY ts DESC`;

      const all = await queries.run('u1', sql);
      expect(hosts(all.rows)).toEqual(NEWEST_FIRST);
      expect(all.truncated).toBe(false);

      const capped = await queries.run('u1', sql, { maxRows: 5 });
      expect(hosts(capped.rows)).toEqual(NEWEST_FIRST.slice(0, 5));
      expect(capped.truncated).toBe(true);
    });

    skipWithoutAdmin('clamped: a caller LIMIT above the cap is lowered, order and OFFSET kept', async () => {
      const limitOffset = await queries.run('u1', `SELECT host FROM ${ORDER_TABLE} ORDER BY ts DESC LIMIT 1000 OFFSET 2`, {
        maxRows: 3,
      });
      expect(hosts(limitOffset.rows)).toEqual(NEWEST_FIRST.slice(2, 5));
      expect(limitOffset.truncated).toBe(true);

      const offsetLimit = await queries.run('u1', `SELECT host FROM ${ORDER_TABLE} ORDER BY ts DESC OFFSET 2 LIMIT 1000`, {
        maxRows: 3,
      });
      expect(hosts(offsetLimit.rows)).toEqual(NEWEST_FIRST.slice(2, 5));
      expect(offsetLimit.truncated).toBe(true);
    });

    skipWithoutAdmin('appended before a bare OFFSET', async () => {
      const result = await queries.run('u1', `SELECT host FROM ${ORDER_TABLE} ORDER BY ts DESC OFFSET 3`, { maxRows: 2 });

      expect(hosts(result.rows)).toEqual(NEWEST_FIRST.slice(3, 5));
      expect(result.truncated).toBe(true);
    });

    skipWithoutAdmin('kept: a caller LIMIT below the cap is sent as written, not truncated', async () => {
      const result = await queries.run('u1', `SELECT host FROM ${ORDER_TABLE} ORDER BY ts DESC LIMIT 3`, { maxRows: 10 });

      expect(hosts(result.rows)).toEqual(NEWEST_FIRST.slice(0, 3));
      expect(result).toMatchObject({ rowCount: 3, truncated: false });
    });

    skipWithoutAdmin('a subquery LIMIT is left alone; the outer ORDER BY holds', async () => {
      const result = await queries.run(
        'u1',
        `SELECT host FROM (SELECT host, ts FROM ${ORDER_TABLE} ORDER BY ts LIMIT 6) s ORDER BY ts DESC`,
      );

      expect(hosts(result.rows)).toEqual(ORDER_HOSTS.slice(0, 6).reverse());
    });

    skipWithoutAdmin('client-only: LIMIT ALL is still capped in the response', async () => {
      const result = await queries.run('u1', `SELECT host FROM ${ORDER_TABLE} ORDER BY ts DESC LIMIT ALL`, {
        maxRows: 4,
      });

      expect(hosts(result.rows)).toEqual(NEWEST_FIRST.slice(0, 4));
      expect(result).toMatchObject({ rowCount: 4, truncated: true });
    });
  });

  it('refuses DROP in the guard, and the read-only user refuses it too', async () => {
    const guarded = await queries.run('u1', `DROP TABLE ${TABLE}`).catch((e: unknown) => e);
    expect((guarded as TelemetryHttpError).reason).toBe('TELEMETRY_QUERY_REJECTED');

    // Bypassing the guard: the database itself is the real control.
    const direct = await greptime.queryReader(`DROP TABLE ${TABLE}`, { timeoutMs: 10_000 }).catch((e: unknown) => e);
    expect(direct).toBeInstanceOf(TelemetryQueryFailedError);
    expect(direct).toMatchObject({ origin: 'server', message: expect.stringMatching(/not authorized/i) });

    const stillThere = await queries.run('u1', `SELECT count(*) FROM ${TABLE}`);
    expect(stillThere.rows[0][0]).toBe('3');
  });

  it('the read-only user is refused every write and admin statement, bypassing the guard entirely', async () => {
    const attempts: [string, string][] = [
      ['INSERT', `INSERT INTO ${TABLE} VALUES ('2026-09-27 10:00:03', 'z', 1, 1, 1, true, NULL)`],
      ['ALTER DATABASE', `ALTER DATABASE ${greptime.database} SET 'ttl'='1d'`],
      ['SET', "SET timezone = 'UTC'"],
    ];

    for (const [, sql] of attempts) {
      const direct = await greptime.queryReader(sql, { timeoutMs: 10_000 }).catch((e: unknown) => e);
      expect(direct).toBeInstanceOf(TelemetryQueryFailedError);
      expect(direct).toMatchObject({ origin: 'server', message: expect.stringMatching(/not authorized/i) });
    }

    // Nothing above touched the table: still exactly the seeded 3 rows.
    const stillThere = await queries.run('u1', `SELECT count(*) FROM ${TABLE}`);
    expect(stillThere.rows[0][0]).toBe('3');
  });

  it('refuses a second statement in the guard; the client refuses its result', async () => {
    const guarded = await queries.run('u1', 'SELECT 1; SELECT 2').catch((e: unknown) => e);
    expect((guarded as TelemetryHttpError).reason).toBe('TELEMETRY_QUERY_REJECTED');

    await expect(greptime.queryReader('SELECT 1; SELECT 2', { timeoutMs: 10_000 })).rejects.toBeInstanceOf(
      TelemetryMultiStatementError,
    );
  });

  it('reports a server-side SQL error as TELEMETRY_QUERY_FAILED with its message', async () => {
    const error = (await queries.run('u1', 'SELECT * FROM no_such_table_535').catch((e: unknown) => e)) as TelemetryHttpError;

    expect(error.reason).toBe('TELEMETRY_QUERY_FAILED');
    expect((error.getResponse() as { message: string }).message).toMatch(/no_such_table_535/);
  });

  it('lists the schema, including flattened attribute columns', async () => {
    const tables = (await schema.getSchema({ fresh: true })).tables;
    const fixture = tables.find((table) => table.name === TABLE);

    expect(fixture?.columns.map((c) => c.name)).toEqual([
      'ts',
      'host',
      'v',
      'n',
      'u',
      'ok',
      'span_attributes.http.route',
    ]);
    expect(fixture?.columns[0]).toMatchObject({ semanticType: 'TIMESTAMP' });
    await expect(schema.tableExists(TABLE)).resolves.toBe(true);
  });

  itAdmin('applies retention via the admin connection and the status service reports it', async () => {
    const settings = { getPolicy: jest.fn().mockResolvedValue(POLICY) };
    const status = new TelemetryStatusService(greptime, settings as never);

    await greptime.queryAdmin(retentionStatement(greptime.database, 9), { timeoutMs: 15_000 });

    const created = await greptime.queryAdmin(`SHOW CREATE DATABASE ${greptime.database}`, { timeoutMs: 10_000 });
    const statement = created.rows[0]?.find(
      (cell): cell is string => typeof cell === 'string' && cell.includes('ttl'),
    );
    expect(statement).toContain("ttl = '9days'");

    const result = await status.getStatus();
    expect(result).toMatchObject({ configured: true, reachable: true, ttl: { raw: '9days', days: 9 } });

    // Idempotent: applying the same TTL again is a no-op, not an error
    // (job-queue.md: a duplicate retry or the daily re-assertion must be
    // harmless).
    await expect(
      greptime.queryAdmin(retentionStatement(greptime.database, 9), { timeoutMs: 15_000 }),
    ).resolves.toBeDefined();
  });

  it('exports every format', async () => {
    const sql = `SELECT ts, host, v, n, u, ok, "span_attributes.http.route" FROM ${TABLE} ORDER BY ts`;
    const save = (name: string, data: Buffer) => {
      if (!OUT_DIR) return;
      mkdirSync(OUT_DIR, { recursive: true });
      writeFileSync(join(OUT_DIR, name), data);
    };

    const csv = await exporter.export('u1', sql, 'csv');
    save('export.csv', csv.buffer);
    expect(csv.buffer.toString('utf8')).toContain(`"b,""q""",,-5,3,false,'=cmd\r\n`);

    const ndjson = await exporter.export('u1', sql, 'ndjson');
    save('export.ndjson', ndjson.buffer);
    expect(ndjson.buffer.toString('utf8').trim().split('\n').map((line) => JSON.parse(line))[0]).toMatchObject({
      host: 'a',
      n: '9007199254740993',
      'span_attributes.http.route': '/api/x',
    });

    const xlsx = await exporter.export('u1', sql, 'xlsx');
    save('export.xlsx', xlsx.buffer);
    const workbook = new Workbook();
    await workbook.xlsx.load(xlsx.buffer as unknown as ArrayBuffer);
    expect(workbook.getWorksheet('results')!.getCell('D3').value).toBe(-5);

    // Parquet: the real writer runs in a child process (ESM-only).
    const result = await queries.run('u1', sql, { source: 'export' });
    const parquet = parquetRoundTrip(buildParquetColumns(result), OUT_DIR ? join(OUT_DIR, 'export.parquet') : undefined);
    expect(parquet.rows).toHaveLength(3);
    // `n` and `u` each hold a value past 2^53, so both columns are STRING.
    expect(parquet.rows[1]).toMatchObject({ host: 'b,"q"', v: null, n: '-5', u: '3', ok: false });
    expect(parquet.types).toContainEqual(['v', 'DOUBLE', null]);
  });
});
