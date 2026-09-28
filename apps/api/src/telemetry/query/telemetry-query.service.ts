import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import type { TelemetryColumnType, TelemetryQueryRunResult } from '../dto/telemetry-query.dto';
import { GreptimeClient } from '../greptime/greptime.client';
import { TelemetrySettingsService } from '../telemetry-settings.service';
import { analyzeStatement, applyRowCap } from './sql-guard';
import { requireQueryablePolicy, toTelemetryHttpError } from './telemetry-availability';
import { TelemetryHttpError } from './telemetry-query.errors';

// =============================================================================
// TelemetryQueryService — every ad-hoc SQL read of the telemetry store
// (issue #535, epic #528)
// =============================================================================
//
// THE ONE ENTRY POINT for caller-supplied SQL: the explorer (`POST …/query`),
// the export (`POST …/export`) and the assistant's tools (#536) all come
// through `run`, so all three are held to the same guard, the same bounds and
// the same audit trail.
//
//   1. preconditions — store configured (503), `telemetry.enabled` (409);
//   2. `analyzeStatement` — exactly one read-only statement (400);
//   3. the row cap — the caller's `maxRows`, clamped to
//      `telemetry.query.maxRows`; `applyRowCap` gives a SELECT a top-level
//      `LIMIT maxRows + 1` (appended, or the caller's own LIMIT clamped) so
//      the SERVER stops there and the extra row is how `truncated` is known.
//      Never a `SELECT * FROM (<sql>) LIMIT n` wrapper: GreptimeDB drops the
//      inner ORDER BY through one (#554). What the text cannot bound
//      (`LIMIT ALL`, SHOW, …) is sliced here after the fact;
//   4. `GreptimeClient.queryReader` — the READ-ONLY user (the real control),
//      with `telemetry.query.timeoutSeconds` enforced client-side (504);
//   5. the result made JSON-safe (see `toJsonSafe`);
//   6. an audit row — for failures too, so a refused `DROP` is on record.
//
// NOT A QUEUE JOB, deliberately (CLAUDE.md, "every long-running activity is a
// queue job"): the statement is bounded by the policy's timeout (≤ 120 s) and
// its row cap (≤ 100 000), and the work cannot outlive the request — when the
// timeout fires the connection is destroyed.
// =============================================================================

export type TelemetryQuerySource = 'explorer' | 'assistant' | 'export';

export interface TelemetryQueryRunOptions {
  /** Row cap for this call; clamped to `telemetry.query.maxRows`, which is also the default. */
  maxRows?: number;
  /** Who is asking. Chooses the audit action. Default `explorer`. */
  source?: TelemetryQuerySource;
  /** Abandons the statement when aborted (the assistant's client went away, #536). */
  signal?: AbortSignal;
}

/** Audit `action` per source. */
export const TELEMETRY_QUERY_AUDIT_ACTIONS: Record<TelemetryQuerySource, string> = {
  explorer: 'telemetry:query',
  export: 'telemetry:export',
  assistant: 'telemetry:assistant_query',
};

/** How much of the SQL text an audit row keeps. */
export const TELEMETRY_AUDIT_SQL_MAX = 4_000;

/** PostgreSQL type OID → the simplified name the explorer shows. */
const TYPE_NAMES: Record<number, TelemetryColumnType> = {
  16: 'bool',
  17: 'bytea',
  20: 'int8',
  21: 'int2',
  23: 'int4',
  25: 'text',
  114: 'json',
  700: 'float4',
  701: 'float8',
  1043: 'text',
  1082: 'date',
  1083: 'time',
  1114: 'timestamp',
  1184: 'timestamp',
  1700: 'numeric',
  3802: 'json',
};

export function columnTypeName(dataTypeID: number): TelemetryColumnType {
  return TYPE_NAMES[dataTypeID] ?? 'unknown';
}

/**
 * A wire value as something `JSON.stringify` reproduces faithfully:
 * Buffer → base64, bigint → decimal string, Date → ISO string, non-finite
 * number → its name (JSON would silently turn it into null), arrays and
 * plain objects recursively. `int8`/`numeric`/timestamps already arrive as
 * strings from `GreptimeClient` and stay that way.
 */
export function toJsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return null;

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'bigint':
      return value.toString();
    case 'object':
      break;
    default:
      return String(value);
  }

  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Array.isArray(value)) return value.map(toJsonSafe);

  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toJsonSafe(v)]));
}

@Injectable()
export class TelemetryQueryService {
  private readonly logger = new Logger(TelemetryQueryService.name);

  constructor(
    private readonly greptime: GreptimeClient,
    private readonly settings: TelemetrySettingsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Runs one read-only statement for `userId`. Throws `TelemetryHttpError`
   * (see `telemetry-query.errors.ts`) for every expected failure.
   */
  async run(userId: string, sql: string, opts: TelemetryQueryRunOptions = {}): Promise<TelemetryQueryRunResult> {
    const source = opts.source ?? 'explorer';

    // Preconditions are not audited: nothing was attempted against the store.
    const policy = await requireQueryablePolicy(this.greptime, this.settings);
    const maxRows = clampRows(opts.maxRows, policy.query.maxRows);

    const started = Date.now();
    let outcome: TelemetryQueryRunResult;

    try {
      const statement = analyzeStatement(sql);
      const capped = applyRowCap(statement, maxRows + 1);

      // 'client-only': the server may return more than maxRows + 1 rows. The
      // slice below still caps the RESPONSE; the rows are held in memory in
      // the meantime, bounded only by the policy timeout. Streaming rows off
      // the socket and hanging up past the cap was considered and not done:
      // it would replace `GreptimeClient.run`'s one-shot query (and its
      // multi-statement check) for statements that are rare — `LIMIT ALL`,
      // `LIMIT <expression>`, `FETCH FIRST`, SHOW/DESCRIBE/EXPLAIN.
      if (capped.strategy === 'client-only' && statement.kind === 'select') {
        this.logger.debug('Telemetry query has no server-side row cap; capping client-side');
      }

      const result = await this.greptime.queryReader(capped.sql, {
        timeoutMs: policy.query.timeoutSeconds * 1000,
        signal: opts.signal,
      });
      const elapsedMs = Date.now() - started;

      const truncated = result.rows.length > maxRows;
      const rows = (truncated ? result.rows.slice(0, maxRows) : result.rows).map((row) => row.map(toJsonSafe));

      outcome = {
        columns: result.fields.map((field) => ({ name: field.name, type: columnTypeName(field.dataTypeID) })),
        rows,
        rowCount: rows.length,
        truncated,
        elapsedMs,
      };
    } catch (error) {
      const mapped = toTelemetryHttpError(error);
      const elapsedMs = Date.now() - started;

      await this.audit(userId, source, sql, {
        rowCount: 0,
        truncated: false,
        elapsedMs,
        error: error instanceof Error ? error.message : String(error),
        ...(mapped instanceof TelemetryHttpError ? { reason: mapped.reason } : {}),
      }).catch((auditError: unknown) => {
        // Never let a failed audit write replace the error the caller needs.
        this.logger.warn(
          `Could not audit a failed telemetry query: ${auditError instanceof Error ? auditError.message : String(auditError)}`,
        );
      });

      throw mapped;
    }

    // Outside the try: a failed audit write is a 500, not a "failed query".
    await this.audit(userId, source, sql, {
      rowCount: outcome.rowCount,
      truncated: outcome.truncated,
      elapsedMs: outcome.elapsedMs,
    });

    return outcome;
  }

  private async audit(
    userId: string,
    source: TelemetryQuerySource,
    sql: string,
    meta: { rowCount: number; truncated: boolean; elapsedMs: number; error?: string; reason?: string },
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action: TELEMETRY_QUERY_AUDIT_ACTIONS[source],
        targetType: 'telemetry_store',
        targetId: this.greptime.database,
        meta: {
          sql: sql.length > TELEMETRY_AUDIT_SQL_MAX ? `${sql.slice(0, TELEMETRY_AUDIT_SQL_MAX)}…` : sql,
          ...(sql.length > TELEMETRY_AUDIT_SQL_MAX ? { sqlLength: sql.length } : {}),
          source,
          ...meta,
        } as Prisma.InputJsonValue,
      },
    });
  }
}

function clampRows(requested: number | undefined, ceiling: number): number {
  const wanted = requested !== undefined && Number.isFinite(requested) ? Math.floor(requested) : ceiling;

  return Math.max(1, Math.min(wanted, ceiling));
}
