import { Injectable } from '@nestjs/common';

import type { TelemetrySchema, TelemetrySchemaTable } from '../dto/telemetry-query.dto';
import { GreptimeClient, quoteLiteral } from '../greptime/greptime.client';
import { TelemetrySettingsService } from '../telemetry-settings.service';
import { requireQueryablePolicy, toTelemetryHttpError } from './telemetry-availability';

// =============================================================================
// TelemetrySchemaService — which tables and columns the store has
// (issue #535, epic #528)
// =============================================================================
//
// Feeds the explorer's schema tree and editor autocompletion, and — through
// `tableExists` / `describeTable` — lets the assistant (#536) validate an
// identifier before quoting it into SQL (there are no bind parameters, spike
// #529).
//
// Two `information_schema` reads on the reader connection, filtered to the
// configured database (from configuration, quoted). Cached for
// `TELEMETRY_SCHEMA_CACHE_MS`: tables appear on first write and attribute
// columns as new attributes arrive, so a short cache is fresh enough and saves
// a round trip per keystroke of autocompletion.
//
// Not audited: this reads metadata, not telemetry. The same preconditions as
// a query apply (503 unconfigured, 409 disabled).
// =============================================================================

export const TELEMETRY_SCHEMA_CACHE_MS = 30_000;

@Injectable()
export class TelemetrySchemaService {
  private cache: { value: TelemetrySchema; readAt: number } | null = null;
  private inflight: Promise<TelemetrySchema> | null = null;

  constructor(
    private readonly greptime: GreptimeClient,
    private readonly settings: TelemetrySettingsService,
  ) {}

  /** Every table with its columns, both sorted by name / position. */
  async getSchema(opts: { fresh?: boolean } = {}): Promise<TelemetrySchema> {
    const policy = await requireQueryablePolicy(this.greptime, this.settings);

    if (!opts.fresh && this.cache && Date.now() - this.cache.readAt < TELEMETRY_SCHEMA_CACHE_MS) {
      return this.cache.value;
    }

    // Concurrent callers share one read.
    if (!this.inflight) {
      this.inflight = this.read(policy.query.timeoutSeconds * 1000)
        .then((value) => {
          this.cache = { value, readAt: Date.now() };
          return value;
        })
        .finally(() => {
          this.inflight = null;
        });
    }

    return this.inflight;
  }

  /** Whether `name` is exactly (case-sensitively) a table of the telemetry database. */
  async tableExists(name: string): Promise<boolean> {
    return (await this.describeTable(name)) !== null;
  }

  /** One table's schema, or null when there is no such table. */
  async describeTable(name: string): Promise<TelemetrySchemaTable | null> {
    const schema = await this.getSchema();

    return schema.tables.find((table) => table.name === name) ?? null;
  }

  invalidateCache(): void {
    this.cache = null;
  }

  private async read(timeoutMs: number): Promise<TelemetrySchema> {
    const database = quoteLiteral(this.greptime.database);

    try {
      const [tables, columns] = await Promise.all([
        this.greptime.queryReader(
          `SELECT table_name, table_rows FROM information_schema.tables WHERE table_schema = ${database}`,
          { timeoutMs },
        ),
        this.greptime.queryReader(
          'SELECT table_name, column_name, data_type, semantic_type, ordinal_position ' +
            `FROM information_schema.columns WHERE table_schema = ${database}`,
          { timeoutMs },
        ),
      ]);

      return groupSchema(tables.rows, columns.rows);
    } catch (error) {
      throw toTelemetryHttpError(error);
    }
  }
}

/**
 * Builds the response from `[table_name, table_rows]` and
 * `[table_name, column_name, data_type, semantic_type, ordinal_position]`
 * rows. A column whose table is not in the table list still gets its table
 * (a view, or a table created between the two reads).
 */
export function groupSchema(tableRows: unknown[][], columnRows: unknown[][]): TelemetrySchema {
  const tables = new Map<string, { rows: number | null; columns: { name: string; type: string; semanticType: string | null; position: number }[] }>();

  const ensure = (name: string) => {
    let table = tables.get(name);
    if (!table) {
      table = { rows: null, columns: [] };
      tables.set(name, table);
    }
    return table;
  };

  for (const [name, rows] of tableRows) {
    ensure(String(name)).rows = toCount(rows);
  }

  for (const [table, column, type, semantic, position] of columnRows) {
    ensure(String(table)).columns.push({
      name: String(column),
      type: type === null || type === undefined ? 'unknown' : String(type),
      semanticType: semantic === null || semantic === undefined || semantic === '' ? null : String(semantic),
      position: toCount(position) ?? Number.MAX_SAFE_INTEGER,
    });
  }

  return {
    tables: [...tables.entries()]
      .sort(([a], [b]) => compare(a, b))
      .map(([name, table]) => ({
        name,
        rows: table.rows,
        columns: table.columns
          .sort((a, b) => a.position - b.position || compare(a.name, b.name))
          .map(({ name: column, type, semanticType }) => ({ name: column, type, semanticType })),
      })),
  };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toCount(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;

  const n = typeof value === 'number' ? value : Number(value);

  return Number.isFinite(n) ? n : null;
}
