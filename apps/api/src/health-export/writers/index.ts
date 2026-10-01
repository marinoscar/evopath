// =============================================================================
// Health export writers (H7, #191): one byte stream per format
// =============================================================================

import type { Readable } from 'node:stream';

import type { HealthExportData } from '../health-export-data';
import type { HealthExportFormat } from '../health-export.constants';
import { csvZipExportStream } from './csv.writer';
import { jsonExportStream } from './json.writer';
import { pdfExportStream } from './pdf.writer';
import { xlsxExportStream } from './xlsx.writer';

/** The export file for `format`, as a stream that errors if rendering fails. */
export function renderHealthExport(data: HealthExportData, format: HealthExportFormat): Readable {
  switch (format) {
    case 'json':
      return jsonExportStream(data);
    case 'csv':
      return csvZipExportStream(data);
    case 'xlsx':
      return xlsxExportStream(data);
    case 'pdf':
      return pdfExportStream(data);
  }
}
