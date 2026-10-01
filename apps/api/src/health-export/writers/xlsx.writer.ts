// =============================================================================
// Health export writer: XLSX (H7, #191)
// =============================================================================
//
// One sheet per selected dataset, named by its title ("Wellness / mood" with
// the slash Excel forbids replaced). Row 1 is the bold, frozen header of
// human column names with the unit (`Weight (kg)`). Numbers are numbers;
// text is text, and exceljs never writes a string cell as a formula, so no
// injection concern. Written with exceljs' streaming workbook writer.
// =============================================================================

import { PassThrough, type Readable } from 'node:stream';

import { stream as excelStream } from 'exceljs';

import type { HealthExportData } from '../health-export-data';
import { appSlug } from '../health-export.constants';

/** Excel's hard limit on the characters in one cell. */
const XLSX_MAX_CELL_CHARS = 32_767;

/** Excel forbids `\ / ? * [ ] :` in a sheet name and caps it at 31 characters. */
export function sheetName(title: string): string {
  return title.replace(/[\\/?*[\]:]/g, '-').replace(/\s+-\s+/g, ' - ').slice(0, 31);
}

async function writeWorkbook(data: HealthExportData, out: PassThrough): Promise<void> {
  const workbook = new excelStream.xlsx.WorkbookWriter({ stream: out, useStyles: true, useSharedStrings: false });
  workbook.creator = appSlug();
  workbook.created = data.exportedAt;

  for (const table of data.tables) {
    const sheet = workbook.addWorksheet(sheetName(table.title), {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    sheet.columns = table.columns.map((column) => ({
      header: column.header,
      key: column.key,
      width: Math.min(40, Math.max(10, column.header.length + 2)),
    }));
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).commit();

    for (const row of table.rows) {
      const values: Record<string, string | number | boolean | null> = {};
      for (const column of table.columns) {
        const value = row[column.key] ?? null;
        values[column.key] = typeof value === 'string' ? value.slice(0, XLSX_MAX_CELL_CHARS) : value;
      }
      sheet.addRow(values).commit();
    }

    sheet.commit();
  }

  await workbook.commit();
}

/** The workbook as a byte stream. */
export function xlsxExportStream(data: HealthExportData): Readable {
  const out = new PassThrough();
  writeWorkbook(data, out).catch((error: unknown) => {
    out.destroy(error instanceof Error ? error : new Error(String(error)));
  });
  return out;
}
