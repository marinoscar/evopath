import type { TelemetryQueryRunResult } from '../dto/telemetry-query.dto';
import { parquetRoundTrip } from '../testing/parquet-child';
import { buildParquetColumns } from './telemetry-export.service';

// =============================================================================
// Parquet round trip with the REAL libraries (issue #535)
// =============================================================================
//
// The writer and reader are ESM-only, so they run in a child Node process
// (see testing/parquet-child.ts); this proves the columns the service builds
// are written and read back faithfully.
// =============================================================================

function roundTrip(result: TelemetryQueryRunResult) {
  return parquetRoundTrip(buildParquetColumns(result));
}

describe('Parquet export — real writer and reader', () => {
  it('round-trips types, nulls, nanosecond timestamps and duplicate names', () => {
    const out = roundTrip({
      columns: [
        { name: 'ts', type: 'timestamp' },
        { name: 'n', type: 'int8' },
        { name: 'big', type: 'numeric' },
        { name: 'v', type: 'float8' },
        { name: 'ok', type: 'bool' },
        { name: 'j', type: 'json' },
        { name: 'n', type: 'text' },
      ],
      rows: [
        ['2026-09-27 10:00:00.123456789', '42', '18446744073709551615', 1.5, true, { k: [1] }, 'héllo'],
        [null, null, null, null, null, null, null],
      ],
      rowCount: 2,
      truncated: false,
      elapsedMs: 1,
    });

    expect(out.bytes).toBeGreaterThan(0);
    expect(out.types).toEqual([
      ['ts', 'BYTE_ARRAY', 'UTF8'],
      ['n', 'DOUBLE', null],
      ['big', 'BYTE_ARRAY', 'UTF8'],
      ['v', 'DOUBLE', null],
      ['ok', 'BOOLEAN', null],
      ['j', 'BYTE_ARRAY', 'UTF8'],
      ['n_2', 'BYTE_ARRAY', 'UTF8'],
    ]);
    expect(out.rows).toEqual([
      {
        ts: '2026-09-27 10:00:00.123456789',
        n: 42,
        big: '18446744073709551615',
        v: 1.5,
        ok: true,
        j: '{"k":[1]}',
        n_2: 'héllo',
      },
      { ts: null, n: null, big: null, v: null, ok: null, j: null, n_2: null },
    ]);
  });

  it('writes an empty result', () => {
    const out = roundTrip({
      columns: [{ name: 'a', type: 'text' }],
      rows: [],
      rowCount: 0,
      truncated: false,
      elapsedMs: 1,
    });

    expect(out.rows).toEqual([]);
    expect(out.types).toEqual([['a', 'BYTE_ARRAY', 'UTF8']]);
  });
});
