// =============================================================================
// Health export writer: CSV, one file per dataset in a zip (H7, #191)
// =============================================================================
//
// `<dataset>.csv` per selected dataset (`profile.csv`, `body.csv`, ...), each
// RFC 4180 with a CRLF after every record, a header row of column keys (unit
// in the key) and a UTF-8 BOM, through the helpers the telemetry export uses.
// Text cells that a spreadsheet would read as a formula are neutralised;
// numeric columns are left alone. The zip streams (archiver), nothing is
// buffered whole.
// =============================================================================

import { Readable } from 'node:stream';

import archiver from 'archiver';

import { csvField, csvRecord, neutralizeFormula, UTF8_BOM } from '../../common/export/csv';
import type { ExportCell, ExportTable, HealthExportData } from '../health-export-data';

function cellText(value: ExportCell): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function* csvLines(table: ExportTable): Generator<string> {
  yield UTF8_BOM + csvRecord(table.columns.map((column) => csvField(neutralizeFormula(column.key)))) + '\r\n';

  for (const row of table.rows) {
    yield csvRecord(
      table.columns.map((column) => {
        const text = cellText(row[column.key] ?? null);
        return csvField(column.numeric ? text : neutralizeFormula(text));
      }),
    ) + '\r\n';
  }
}

/** One dataset as CSV text (tests, and the zip entries). */
export function tableToCsv(table: ExportTable): string {
  return [...csvLines(table)].join('');
}

/** The CSV zip as a byte stream. */
export function csvZipExportStream(data: HealthExportData): Readable {
  const archive = archiver('zip', { zlib: { level: 6 } });

  for (const table of data.tables) {
    archive.append(Readable.from(csvLines(table)), { name: `${table.dataset}.csv`, date: data.exportedAt });
  }

  void archive.finalize().catch((error: unknown) => {
    archive.destroy(error instanceof Error ? error : new Error(String(error)));
  });

  return archive;
}
