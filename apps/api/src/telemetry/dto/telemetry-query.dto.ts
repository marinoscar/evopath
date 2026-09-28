import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// Telemetry explorer — request and response shapes (issue #535, epic #528)
// =============================================================================
//
//   POST /api/admin/telemetry/query    TelemetryQueryRequestDto  → TelemetryQueryResultDto
//   GET  /api/admin/telemetry/schema                              → TelemetrySchemaDto
//   POST /api/admin/telemetry/export   TelemetryExportRequestDto → file (binary)
// =============================================================================

/** Longest SQL text accepted. Telemetry queries are hand-written or model-written, never generated in bulk. */
export const TELEMETRY_SQL_MAX_LENGTH = 20_000;

/** The absolute ceiling `maxRows` may ask for; the policy's `query.maxRows` clamps it further. */
export const TELEMETRY_QUERY_MAX_ROWS_CEILING = 100_000;

const sqlSchema = z
  .string()
  .min(1)
  .max(TELEMETRY_SQL_MAX_LENGTH)
  .describe(
    'One read-only statement: SELECT, WITH, SHOW, DESCRIBE or EXPLAIN. Comments are allowed; a ' +
      'trailing semicolon is ignored; a second statement is refused. Columns such as ' +
      '`"span_attributes.http.route"` must be double-quoted.',
  );

export const telemetryQueryRequestSchema = z.object({
  sql: sqlSchema,
  maxRows: z
    .number()
    .int()
    .min(1)
    .max(TELEMETRY_QUERY_MAX_ROWS_CEILING)
    .optional()
    .describe('Row cap for this query. Clamped to the `telemetry.query.maxRows` setting, which is also the default.'),
});

export class TelemetryQueryRequestDto extends createZodDto(telemetryQueryRequestSchema) {}

export const TELEMETRY_COLUMN_TYPES = [
  'bool',
  'int2',
  'int4',
  'int8',
  'float4',
  'float8',
  'numeric',
  'text',
  'bytea',
  'date',
  'time',
  'timestamp',
  'json',
  'unknown',
] as const;

export const telemetryColumnSchema = z.object({
  /** As the server named it. GreptimeDB suffixes a repeated name (`host`, `host:1`), but do not rely on uniqueness. */
  name: z.string(),
  /**
   * Wire type, simplified. `int8` and `numeric` values are STRINGS (they
   * exceed JavaScript's safe integers — durations in ns, UInt64); `timestamp`,
   * `date` and `time` values are the server's text (microseconds on this wire:
   * `CAST(ts AS STRING)` returns a TIMESTAMP(9)'s nanoseconds as `text`);
   * `json` values are parsed;
   * `bytea` values are base64.
   */
  type: z.enum(TELEMETRY_COLUMN_TYPES),
});

export const telemetryQueryResultSchema = z.object({
  columns: z.array(telemetryColumnSchema),
  /** Positional: `rows[i][j]` is the value of `columns[j]`. */
  rows: z.array(z.array(z.unknown())),
  /** `rows.length`. */
  rowCount: z.number().int(),
  /** More rows matched than the cap allowed; `rows` holds the first `rowCount`. */
  truncated: z.boolean(),
  /** Wall-clock time of the round trip to the telemetry store. */
  elapsedMs: z.number().int(),
});

export class TelemetryQueryResultDto extends createZodDto(telemetryQueryResultSchema) {}
export type TelemetryColumn = z.infer<typeof telemetryColumnSchema>;
export type TelemetryColumnType = TelemetryColumn['type'];
export type TelemetryQueryRunResult = z.infer<typeof telemetryQueryResultSchema>;

export const telemetrySchemaColumnSchema = z.object({
  name: z.string(),
  /** GreptimeDB's SQL type, e.g. `timestamp(9)`, `string`, `double`, `json`. */
  type: z.string(),
  /** `TAG`, `FIELD` or `TIMESTAMP`, or null when the store does not report it. */
  semanticType: z.string().nullable(),
});

export const telemetrySchemaTableSchema = z.object({
  name: z.string(),
  /** GreptimeDB's row estimate, or null when not reported. */
  rows: z.number().nullable(),
  columns: z.array(telemetrySchemaColumnSchema),
});

export const telemetrySchemaSchema = z.object({
  tables: z.array(telemetrySchemaTableSchema),
});

export class TelemetrySchemaDto extends createZodDto(telemetrySchemaSchema) {}
export type TelemetrySchema = z.infer<typeof telemetrySchemaSchema>;
export type TelemetrySchemaTable = z.infer<typeof telemetrySchemaTableSchema>;

export const TELEMETRY_EXPORT_FORMATS = ['csv', 'ndjson', 'xlsx', 'parquet'] as const;
export type TelemetryExportFormat = (typeof TELEMETRY_EXPORT_FORMATS)[number];

export const telemetryExportRequestSchema = z.object({
  sql: sqlSchema,
  format: z.enum(TELEMETRY_EXPORT_FORMATS),
});

export class TelemetryExportRequestDto extends createZodDto(telemetryExportRequestSchema) {}
