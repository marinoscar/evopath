import { Injectable } from '@nestjs/common';
import { Workbook } from 'exceljs';

import type { TelemetryColumnType, TelemetryExportFormat, TelemetryQueryRunResult } from '../dto/telemetry-query.dto';
import { TelemetryQueryService } from '../query/telemetry-query.service';
import { TelemetrySettingsService } from '../telemetry-settings.service';
import { loadParquetWriter, type ParquetColumn } from './parquet-writer.loader';

// =============================================================================
// TelemetryExportService — a query result as a file (issue #535, epic #528)
// =============================================================================
//
// `POST /api/admin/telemetry/export`. Runs the statement through
// `TelemetryQueryService.run` (source `export`, so it is guarded, bounded and
// audited exactly like the explorer) with the row cap at the policy's full
// `telemetry.query.maxRows` (≤ 100 000), then renders it:
//
//   csv      RFC 4180, CRLF, header row, UTF-8 with a BOM so Excel detects
//            the encoding. Text cells that a spreadsheet would read as a
//            formula (= + - @ tab CR) are prefixed with `'` — telemetry
//            carries attacker-controllable strings (routes, user agents,
//            log bodies), and CSV injection is the classic way to turn one
//            into code on an analyst's machine. Numeric columns are left
//            alone, so `-5` stays `-5`.
//   ndjson   one JSON object per row keyed by column name; a repeated name
//            gets `_2`, `_3`, … so no value is silently dropped.
//   xlsx     one sheet `results`, bold header; numbers as numbers where the
//            column is numeric and the value is exactly representable, else
//            text. String cells are never formulas in exceljs, so no
//            injection concern.
//   parquet  `hyparquet-writer` (pure JS, ESM-only — see
//            `parquet-writer.loader.ts`). bool → BOOLEAN; numeric columns →
//            DOUBLE when every value is exact as a double, else STRING;
//            timestamps → STRING (the server's text, verbatim);
//            everything else → STRING (JSON as its text). Nulls preserved.
//
// IN MEMORY, AND BOUNDED: the result is capped by the policy and the build is
// synchronous work over at most 100 000 rows, so it completes inside the
// request (CLAUDE.md queue rule: nothing here outlives it).
// =============================================================================

export interface TelemetryExportFile {
  buffer: Buffer;
  contentType: string;
  filename: string;
  rowCount: number;
  truncated: boolean;
}

export const TELEMETRY_EXPORT_CONTENT_TYPES: Record<TelemetryExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  ndjson: 'application/x-ndjson; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  parquet: 'application/vnd.apache.parquet',
};

/** Excel's hard limit on the characters in one cell. */
export const XLSX_MAX_CELL_CHARS = 32_767;

const NUMERIC_TYPES = new Set<TelemetryColumnType>(['int2', 'int4', 'int8', 'float4', 'float8', 'numeric']);

@Injectable()
export class TelemetryExportService {
  constructor(
    private readonly query: TelemetryQueryService,
    private readonly settings: TelemetrySettingsService,
  ) {}

  async export(userId: string, sql: string, format: TelemetryExportFormat, now = new Date()): Promise<TelemetryExportFile> {
    const policy = await this.settings.getPolicy();
    const result = await this.query.run(userId, sql, { source: 'export', maxRows: policy.query.maxRows });

    return {
      buffer: await renderExport(result, format),
      contentType: TELEMETRY_EXPORT_CONTENT_TYPES[format],
      filename: exportFilename(format, now),
      rowCount: result.rowCount,
      truncated: result.truncated,
    };
  }
}

export async function renderExport(result: TelemetryQueryRunResult, format: TelemetryExportFormat): Promise<Buffer> {
  switch (format) {
    case 'csv':
      return Buffer.from(toCsv(result), 'utf8');
    case 'ndjson':
      return Buffer.from(toNdjson(result), 'utf8');
    case 'xlsx':
      return toXlsx(result);
    case 'parquet':
      return toParquet(result);
  }
}

/** `telemetry-20260927-142501.csv` (UTC). */
export function exportFilename(format: TelemetryExportFormat, now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;

  return `telemetry-${stamp}.${format}`;
}

// --- CSV ---------------------------------------------------------------------

const UTF8_BOM = '﻿';
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

export function toCsv(result: TelemetryQueryRunResult): string {
  const numeric = result.columns.map((column) => NUMERIC_TYPES.has(column.type));
  const lines = [result.columns.map((column) => csvField(neutralizeFormula(column.name)))];

  for (const row of result.rows) {
    lines.push(
      row.map((value, index) => {
        const text = cellText(value);
        return csvField(numeric[index] ? text : neutralizeFormula(text));
      }),
    );
  }

  return UTF8_BOM + lines.map((fields) => fields.join(',')).join('\r\n') + '\r\n';
}

function csvField(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function neutralizeFormula(text: string): string {
  return FORMULA_TRIGGER.test(text) ? `'${text}` : text;
}

/** A value as text: null → empty, objects/arrays → JSON. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);

  return String(value);
}

// --- NDJSON ------------------------------------------------------------------

/** Column names made unique: the second `host` becomes `host_2`, and so on. */
export function uniqueColumnNames(names: string[]): string[] {
  const taken = new Set<string>();

  return names.map((name) => {
    let candidate = name;
    for (let n = 2; taken.has(candidate); n += 1) {
      candidate = `${name}_${n}`;
    }
    taken.add(candidate);
    return candidate;
  });
}

export function toNdjson(result: TelemetryQueryRunResult): string {
  const keys = uniqueColumnNames(result.columns.map((column) => column.name));

  return result.rows
    .map((row) => JSON.stringify(Object.fromEntries(keys.map((key, index) => [key, row[index] ?? null]))) + '\n')
    .join('');
}

// --- XLSX --------------------------------------------------------------------

export async function toXlsx(result: TelemetryQueryRunResult): Promise<Buffer> {
  const workbook = new Workbook();
  workbook.creator = 'telemetry explorer';
  const sheet = workbook.addWorksheet('results');

  const numeric = result.columns.map((column) => NUMERIC_TYPES.has(column.type));

  sheet.addRow(result.columns.map((column) => column.name));
  sheet.getRow(1).font = { bold: true };

  for (const row of result.rows) {
    sheet.addRow(
      row.map((value, index) => {
        if (value === null || value === undefined) return null;
        if (typeof value === 'boolean') return value;
        if (numeric[index]) {
          const exact = exactNumber(value);
          if (exact !== null) return exact;
        }
        return cellText(value).slice(0, XLSX_MAX_CELL_CHARS);
      }),
    );
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/**
 * `value` as a JS number when that loses nothing: a finite number, or a
 * decimal string whose double prints back identically. So `9007199254740993`
 * and `18446744073709551615` (beyond a double's exact integers) stay strings,
 * as does `1.50` (not canonical; kept verbatim rather than reformatted).
 */
export function exactNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(value)) return null;

  const n = Number(value);

  return Number.isFinite(n) && String(n) === value ? n : null;
}

// --- Parquet -----------------------------------------------------------------

/** The column data handed to `parquetWriteBuffer`. Exported for tests. */
export function buildParquetColumns(result: TelemetryQueryRunResult): ParquetColumn[] {
  const names = uniqueColumnNames(result.columns.map((column) => column.name));

  return result.columns.map((column, index) => {
    const values = result.rows.map((row) => row[index] ?? null);

    if (column.type === 'bool' && values.every((v) => v === null || typeof v === 'boolean')) {
      return { name: names[index], type: 'BOOLEAN', data: values, nullable: true };
    }

    if (NUMERIC_TYPES.has(column.type)) {
      const numbers = values.map((v) => (v === null ? null : exactNumber(v)));
      if (numbers.every((n, i) => n !== null || values[i] === null)) {
        return { name: names[index], type: 'DOUBLE', data: numbers, nullable: true };
      }
    }

    return {
      name: names[index],
      type: 'STRING',
      data: values.map((v) => (v === null ? null : cellText(v))),
      nullable: true,
    };
  });
}

export async function toParquet(result: TelemetryQueryRunResult): Promise<Buffer> {
  const { parquetWriteBuffer } = await loadParquetWriter();

  return Buffer.from(parquetWriteBuffer({ columnData: buildParquetColumns(result) }));
}
