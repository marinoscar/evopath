import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// GET /api/admin/telemetry/status — response (issue #534, epic #528)
// =============================================================================
//
// A diagnosis, never an error: an unconfigured or unreachable store is
// reported in these fields with a 200, so the admin page can say what is
// wrong instead of rendering a failure.
// =============================================================================

export const telemetryTtlSchema = z.object({
  /** The TTL exactly as `SHOW CREATE DATABASE` prints it, e.g. `7days` or `1month 13h 26m 24s`. */
  raw: z.string(),
  /** `raw` in whole days (rounded), or null for `forever` / an unparseable value. */
  days: z.number().int().nullable(),
});

export const telemetryTableSchema = z.object({
  name: z.string(),
  /** GreptimeDB's row estimate from `information_schema.tables`, or null when not reported. */
  rows: z.number().nullable(),
});

export const telemetryStatusSchema = z.object({
  /** GreptimeDB is configured (admin UI or deployment default) — see `GET /api/admin/telemetry/connection`. */
  configured: z.boolean(),
  /** A `SELECT version()` round trip succeeded just now. */
  reachable: z.boolean(),
  /** e.g. `PostgreSQL 16.3 GreptimeDB 1.2.1`, or null when unreachable. */
  version: z.string().nullable(),
  /** The GreptimeDB database telemetry is written to. */
  database: z.string(),
  /** The database-level TTL currently in force, or null when none is set or it could not be read. */
  ttl: telemetryTtlSchema.nullable(),
  /** `telemetry.retentionDays` — what the TTL should be. */
  retentionDays: z.number().int(),
  /** Every table in the database, by name. Empty when unreachable. */
  tables: z.array(telemetryTableSchema),
  /** Why `reachable` is false, or a partial failure (the TTL or table list could not be read). */
  error: z.string().nullable(),
});

export class TelemetryStatusDto extends createZodDto(telemetryStatusSchema) {}
export type TelemetryStatus = z.infer<typeof telemetryStatusSchema>;
export type TelemetryTtl = z.infer<typeof telemetryTtlSchema>;
