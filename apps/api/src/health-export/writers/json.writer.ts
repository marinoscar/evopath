// =============================================================================
// Health export writer: JSON (H7, #191)
// =============================================================================
//
// `{ schemaVersion, exportedAt, range, includeHistory, profile, datasets }`,
// streamed one row at a time so a long history is never one big string.
// `profile` is null unless the profile dataset was selected; `datasets` holds
// one array per other selected dataset, keyed by dataset name, each row keyed
// by the column keys (unit in the key: `weight_kg`). Values are canonical.
// =============================================================================

import { Readable } from 'node:stream';

import { z } from 'zod';

import type { HealthExportData } from '../health-export-data';
import { HEALTH_EXPORT_DATASETS, HEALTH_EXPORT_SCHEMA_VERSION } from '../health-export.constants';

const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * The file's shape, version 1: the contract a reader of the JSON export can
 * validate against. `datasets` holds only the selected datasets (never
 * `profile`, which is the top-level object).
 */
export const healthExportJsonFileSchema = z
  .object({
    schemaVersion: z.literal(HEALTH_EXPORT_SCHEMA_VERSION),
    exportedAt: z.iso.datetime(),
    range: z.object({ from: date, to: date }).strict(),
    includeHistory: z.boolean(),
    profile: z
      .object({
        name: z.string().nullable(),
        dateOfBirth: date.nullable(),
        ageYears: z.number().int().nullable(),
        sexAtBirth: z.string().nullable(),
        heightCm: z.number().nullable(),
        unitSystem: z.string().nullable(),
        timeZone: z.string().nullable(),
      })
      .strict()
      .nullable(),
    datasets: z
      .partialRecord(z.enum(HEALTH_EXPORT_DATASETS.filter((d) => d !== 'profile') as [string, ...string[]]), z.array(z.record(z.string(), cell)))
      .refine((value) => !('profile' in value), 'profile is not a dataset array'),
  })
  .strict();

function* jsonChunks(data: HealthExportData): Generator<string> {
  const head = {
    schemaVersion: HEALTH_EXPORT_SCHEMA_VERSION,
    exportedAt: data.exportedAt.toISOString(),
    range: data.range,
    includeHistory: data.includeHistory,
    profile: data.profile,
  };

  // The head object, left open so `datasets` can stream after it.
  yield JSON.stringify(head).slice(0, -1) + ',"datasets":{';

  const tables = data.tables.filter((table) => table.dataset !== 'profile');
  for (const [index, table] of tables.entries()) {
    yield `${index > 0 ? ',' : ''}${JSON.stringify(table.dataset)}:[`;
    for (const [rowIndex, row] of table.rows.entries()) {
      yield (rowIndex > 0 ? ',' : '') + JSON.stringify(row);
    }
    yield ']';
  }

  yield '}}\n';
}

/** The JSON export as a byte stream. */
export function jsonExportStream(data: HealthExportData): Readable {
  return Readable.from(jsonChunks(data), { objectMode: false });
}
