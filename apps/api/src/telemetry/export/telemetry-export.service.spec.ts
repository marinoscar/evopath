import { Workbook } from 'exceljs';

import type { TelemetryQueryRunResult } from '../dto/telemetry-query.dto';
import { loadParquetWriter } from './parquet-writer.loader';
import {
  buildParquetColumns,
  exactNumber,
  exportFilename,
  renderExport,
  TelemetryExportService,
  toCsv,
  toNdjson,
  toXlsx,
  uniqueColumnNames,
  XLSX_MAX_CELL_CHARS,
} from './telemetry-export.service';

// The real writer is ESM-only and Jest's CommonJS VM cannot `import()` it;
// telemetry-export.parquet.spec.ts runs it for real in a child process.
jest.mock('./parquet-writer.loader', () => ({ loadParquetWriter: jest.fn() }));

function result(partial: Partial<TelemetryQueryRunResult>): TelemetryQueryRunResult {
  const rows = partial.rows ?? [];
  return { columns: [], rows, rowCount: rows.length, truncated: false, elapsedMs: 1, ...partial };
}

const SAMPLE = result({
  columns: [
    { name: 'host', type: 'text' },
    { name: 'n', type: 'int8' },
    { name: 'v', type: 'float8' },
    { name: 'ok', type: 'bool' },
    { name: 'attrs', type: 'json' },
    { name: 'host', type: 'text' },
  ],
  rows: [
    ['a,"b"\nc', '-5', 1.5, true, { k: 1 }, '=HYPERLINK("x")'],
    [null, '9007199254740993', null, false, null, '@sum'],
  ],
});

describe('CSV', () => {
  const csv = toCsv(SAMPLE);

  it('starts with a UTF-8 BOM and uses CRLF, header first', () => {
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.slice(1).split('\r\n')[0]).toBe('host,n,v,ok,attrs,host');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('quotes fields with commas, quotes and newlines (RFC 4180)', () => {
    expect(csv).toContain('"a,""b""\nc",-5,1.5,true,"{""k"":1}",');
  });

  it('writes null as an empty field', () => {
    expect(csv).toContain('\r\n,9007199254740993,,false,,');
  });

  it('neutralises formulas in text columns but not numbers in numeric ones', () => {
    expect(csv).toContain(`,"'=HYPERLINK(""x"")"\r\n`);
    expect(csv).toContain(",'@sum\r\n");
    expect(csv).toContain(',-5,');
    expect(toCsv(result({ columns: [{ name: '-x', type: 'text' }], rows: [['+1']] }))).toBe("﻿'-x\r\n'+1\r\n");
  });

  it('an empty result is a header row only', () => {
    expect(toCsv(result({ columns: [{ name: 'a', type: 'text' }] }))).toBe('﻿a\r\n');
  });
});

describe('NDJSON', () => {
  it('writes one object per line with de-duplicated keys', () => {
    const lines = toNdjson(SAMPLE).split('\n');

    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
    expect(JSON.parse(lines[0])).toEqual({
      host: 'a,"b"\nc',
      n: '-5',
      v: 1.5,
      ok: true,
      attrs: { k: 1 },
      host_2: '=HYPERLINK("x")',
    });
    expect(JSON.parse(lines[1])).toMatchObject({ host: null, n: '9007199254740993', host_2: '@sum' });
  });

  it('uniqueColumnNames avoids colliding with an existing suffixed name', () => {
    expect(uniqueColumnNames(['a', 'a', 'a_2', 'a'])).toEqual(['a', 'a_2', 'a_2_2', 'a_3']);
  });
});

describe('XLSX', () => {
  it('is readable back: one sheet, bold header, numbers where exact', async () => {
    const buffer = await toXlsx(SAMPLE);
    const workbook = new Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['results']);
    const sheet = workbook.getWorksheet('results')!;

    expect(sheet.getRow(1).values).toEqual([undefined, 'host', 'n', 'v', 'ok', 'attrs', 'host']);
    expect(sheet.getRow(1).font?.bold).toBe(true);
    expect(sheet.getRow(2).values).toEqual([undefined, 'a,"b"\nc', -5, 1.5, true, '{"k":1}', '=HYPERLINK("x")']);
    // Past 2^53: kept as text rather than rounded.
    expect(sheet.getCell('B3').value).toBe('9007199254740993');
    expect(sheet.getCell('A3').value).toBeNull();
    // A formula-looking string is a string cell, not a formula.
    expect(sheet.getCell('F2').formula).toBeUndefined();
  });

  it('caps a cell at Excel\'s limit', async () => {
    const buffer = await toXlsx(result({ columns: [{ name: 'a', type: 'text' }], rows: [['x'.repeat(40_000)]] }));
    const workbook = new Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

    expect(String(workbook.getWorksheet('results')!.getCell('A2').value)).toHaveLength(XLSX_MAX_CELL_CHARS);
  });
});

describe('exactNumber', () => {
  it.each([
    [1.5, 1.5],
    ['-5', -5],
    ['0.25', 0.25],
    ['9007199254740991', 9007199254740991],
    ['9007199254740993', null],
    ['18446744073709551615', null],
    ['1.50', null],
    ['abc', null],
    ['', null],
    [Number.NaN, null],
    [true, null],
  ])('%p → %p', (input, expected) => {
    expect(exactNumber(input)).toBe(expected);
  });
});

describe('Parquet', () => {
  it('buildParquetColumns picks BOOLEAN / DOUBLE / STRING per column and keeps nulls', () => {
    const columns = buildParquetColumns(
      result({
        columns: [
          { name: 'ts', type: 'timestamp' },
          { name: 'small', type: 'int8' },
          { name: 'big', type: 'numeric' },
          { name: 'ok', type: 'bool' },
          { name: 'j', type: 'json' },
          { name: 'ts', type: 'text' },
        ],
        rows: [
          ['2026-09-27 10:00:00.123456789', '42', '18446744073709551615', true, { a: 1 }, 'x'],
          [null, null, '3', null, null, null],
        ],
      }),
    );

    expect(columns).toEqual([
      { name: 'ts', type: 'STRING', data: ['2026-09-27 10:00:00.123456789', null], nullable: true },
      { name: 'small', type: 'DOUBLE', data: [42, null], nullable: true },
      { name: 'big', type: 'STRING', data: ['18446744073709551615', '3'], nullable: true },
      { name: 'ok', type: 'BOOLEAN', data: [true, null], nullable: true },
      { name: 'j', type: 'STRING', data: ['{"a":1}', null], nullable: true },
      { name: 'ts_2', type: 'STRING', data: ['x', null], nullable: true },
    ]);
  });

  it('hands the columns to hyparquet-writer and returns its bytes', async () => {
    const parquetWriteBuffer = jest.fn().mockReturnValue(new Uint8Array([80, 65, 82, 49]).buffer);
    jest.mocked(loadParquetWriter).mockResolvedValue({ parquetWriteBuffer });

    const buffer = await renderExport(result({ columns: [{ name: 'a', type: 'int4' }], rows: [[1]] }), 'parquet');

    expect(buffer.toString('latin1')).toBe('PAR1');
    expect(parquetWriteBuffer).toHaveBeenCalledWith({
      columnData: [{ name: 'a', type: 'DOUBLE', data: [1], nullable: true }],
    });
  });
});

describe('TelemetryExportService', () => {
  it('runs the query as an export at the policy cap and names the file', async () => {
    const query = {
      run: jest.fn().mockResolvedValue(
        result({ columns: [{ name: 'a', type: 'text' }], rows: [['x']], truncated: true }),
      ),
    };
    const settings = { getPolicy: jest.fn().mockResolvedValue({ query: { maxRows: 50_000 } }) };
    const service = new TelemetryExportService(query as never, settings as never);

    const file = await service.export('u1', 'SELECT a FROM t', 'ndjson', new Date('2026-09-27T14:25:01Z'));

    expect(query.run).toHaveBeenCalledWith('u1', 'SELECT a FROM t', { source: 'export', maxRows: 50_000 });
    expect(file).toEqual({
      buffer: Buffer.from('{"a":"x"}\n'),
      contentType: 'application/x-ndjson; charset=utf-8',
      filename: 'telemetry-20260927-142501.ndjson',
      rowCount: 1,
      truncated: true,
    });
  });

  it('propagates a query failure', async () => {
    const boom = new Error('refused');
    const service = new TelemetryExportService(
      { run: jest.fn().mockRejectedValue(boom) } as never,
      { getPolicy: jest.fn().mockResolvedValue({ query: { maxRows: 5 } }) } as never,
    );

    await expect(service.export('u1', 'DROP TABLE t', 'csv')).rejects.toBe(boom);
  });

  it('exportFilename zero-pads in UTC', () => {
    expect(exportFilename('xlsx', new Date('2026-01-02T03:04:05Z'))).toBe('telemetry-20260102-030405.xlsx');
  });
});
