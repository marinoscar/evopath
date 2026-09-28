import { Injectable, Logger } from '@nestjs/common';

import type { TelemetryStatus, TelemetryTtl } from './dto/telemetry-status.dto';
import { GreptimeClient, quoteIdent, quoteLiteral } from './greptime/greptime.client';
import { TelemetrySettingsService } from './telemetry-settings.service';

// =============================================================================
// TelemetryStatusService — GET /api/admin/telemetry/status (issue #534)
// =============================================================================
//
// What the telemetry store looks like right now: is it configured, does it
// answer, which version, which TTL is in force, and which tables exist.
//
// ALWAYS ANSWERS. An unconfigured deployment, an unreachable store, a missing
// admin credential, or one of the two follow-up reads failing are all FIELDS
// of the response (`configured`, `reachable`, `ttl: null`, `error`), never a
// 500 — the admin page is where an operator goes to find out what is wrong,
// so it must be able to render while things are wrong.
//
// Connections: `SHOW CREATE DATABASE` on the admin connection when it is
// configured (the reader is used as a fallback — GreptimeDB lets a readonly
// user SHOW), `information_schema.tables` on the reader. The database name
// comes from configuration and is quoted; there are no bind parameters.
// =============================================================================

/** Per-statement ceiling for the status reads. A status page must not hang. */
export const TELEMETRY_STATUS_TIMEOUT_MS = 5_000;

@Injectable()
export class TelemetryStatusService {
  private readonly logger = new Logger(TelemetryStatusService.name);

  constructor(
    private readonly greptime: GreptimeClient,
    private readonly settings: TelemetrySettingsService,
  ) {}

  async getStatus(): Promise<TelemetryStatus> {
    const { retentionDays } = await this.settings.getPolicy();
    const database = this.greptime.database;

    const base: TelemetryStatus = {
      configured: this.greptime.isConfigured(),
      reachable: false,
      version: null,
      database,
      ttl: null,
      retentionDays,
      tables: [],
      error: null,
    };

    if (!base.configured) {
      // The deployment's own GreptimeDB lacking a login is something an
      // administrator must be told in their terms (issue #570); any other
      // unconfigured state is just `configured: false`.
      return { ...base, error: this.greptime.configurationProblem() };
    }

    const ping = await this.greptime.ping();

    if (!ping.reachable) {
      return { ...base, error: ping.error ?? 'GreptimeDB did not answer.' };
    }

    const errors: string[] = [];

    const [ttl, tables] = await Promise.all([
      this.readTtl(database).catch((error: unknown) => {
        errors.push(`TTL: ${message(error)}`);
        return null;
      }),
      this.readTables(database).catch((error: unknown) => {
        errors.push(`tables: ${message(error)}`);
        return [];
      }),
    ]);

    if (errors.length > 0) {
      this.logger.warn(`Telemetry status partially unavailable: ${errors.join('; ')}`);
    }

    return {
      ...base,
      reachable: true,
      version: ping.version ?? null,
      ttl,
      tables,
      error: errors.length > 0 ? errors.join('; ') : null,
    };
  }

  private async readTtl(database: string): Promise<TelemetryTtl | null> {
    const sql = `SHOW CREATE DATABASE ${quoteIdent(database)}`;
    const options = { timeoutMs: TELEMETRY_STATUS_TIMEOUT_MS };
    const result = this.greptime.isAdminConfigured()
      ? await this.greptime.queryAdmin(sql, options)
      : await this.greptime.queryReader(sql, options);

    for (const row of result.rows) {
      for (const cell of row) {
        if (typeof cell !== 'string') continue;

        const ttl = parseTtlFromCreateDatabase(cell);
        if (ttl) return ttl;
      }
    }

    return null;
  }

  private async readTables(database: string): Promise<TelemetryStatus['tables']> {
    const result = await this.greptime.queryReader(
      'SELECT table_name, table_rows FROM information_schema.tables ' +
        `WHERE table_schema = ${quoteLiteral(database)} ORDER BY table_name`,
      { timeoutMs: TELEMETRY_STATUS_TIMEOUT_MS },
    );

    return result.rows.map(([name, rows]) => ({
      name: String(name),
      rows: toCount(rows),
    }));
  }
}

/**
 * The TTL out of a `SHOW CREATE DATABASE` statement, e.g.
 * `CREATE DATABASE IF NOT EXISTS public\nWITH(\n  ttl = '7days'\n)` →
 * `{ raw: '7days', days: 7 }`. Null when the statement sets no TTL.
 */
export function parseTtlFromCreateDatabase(statement: string): TelemetryTtl | null {
  const match = /\bttl\s*=\s*'([^']*)'/i.exec(statement);
  if (!match) return null;

  const raw = match[1].trim();
  const seconds = parseHumantimeSeconds(raw);

  return { raw, days: seconds === null ? null : Math.round(seconds / 86_400) };
}

/**
 * GreptimeDB prints durations with Rust's `humantime` (`7days`, `30days`,
 * `1month 13h 26m 24s`, `1year`). Its month is 30.44 days and its year 365.25
 * days, which is why 31 days does not print as `31days`. Returns seconds, or
 * null for `forever`/`instant`/anything unrecognised.
 */
export function parseHumantimeSeconds(value: string): number | null {
  const UNITS: Record<string, number> = {
    ns: 1e-9, nsec: 1e-9, nanos: 1e-9,
    us: 1e-6, usec: 1e-6, micros: 1e-6,
    ms: 1e-3, msec: 1e-3, millis: 1e-3,
    s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
    m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
    h: 3_600, hr: 3_600, hrs: 3_600, hour: 3_600, hours: 3_600,
    d: 86_400, day: 86_400, days: 86_400,
    w: 604_800, week: 604_800, weeks: 604_800,
    M: 2_630_016, month: 2_630_016, months: 2_630_016,
    y: 31_557_600, year: 31_557_600, years: 31_557_600,
  };

  const text = value.trim();
  if (text === '') return null;

  const pattern = /(\d+)\s*([a-zA-Z]+)/g;
  let total = 0;
  let consumed = '';
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const unit = UNITS[match[2]] ?? UNITS[match[2].toLowerCase()];
    if (unit === undefined) return null;

    total += Number(match[1]) * unit;
    consumed += match[0];
  }

  // Everything but whitespace must have been a `<number><unit>` pair.
  if (consumed.replace(/\s+/g, '') !== text.replace(/\s+/g, '')) return null;

  return total;
}

function toCount(value: unknown): number | null {
  if (value === null || value === undefined) return null;

  const n = typeof value === 'number' ? value : Number(value);

  return Number.isFinite(n) ? n : null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
