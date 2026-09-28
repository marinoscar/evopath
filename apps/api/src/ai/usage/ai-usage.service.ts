import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { AiProviderRegistry } from '../core/provider-registry';
import {
  DEFAULT_AI_USAGE_RANGE_DAYS,
  MAX_AI_USAGE_RANGE_DAYS,
  type AiUsageBucket,
  type AiUsageGroupBy,
  type AiUsageReport,
  type AiUsageSeriesItem,
} from './dto/ai-usage.dto';

// =============================================================================
// AiUsageService — aggregates over `ai_usage_events` (issue #443, epic #420)
// =============================================================================
//
// Two `SELECT`s per report, both over the same `WHERE` and both `GROUP BY
// GROUPING SETS ((key), ())` so the totals row and the per-group rows come
// from ONE scan and always add up (the `job-insights.service.ts` pattern):
//
//   1. counts and token sums per group, with the org-key subtotal as FILTERed
//      aggregates;
//   2. `units` summed per (group, unit name) via `jsonb_each` — the JSONB
//      column is free-form by design, so its keys are only known at read time.
//
// The window is on `created_at`, which the `(created_at)` index serves for the
// admin report and the `(user_id, created_at)` index for a user's own.
//
// ⚠ THE GROUP KEY IS A FIXED SQL FRAGMENT PICKED FROM `GROUP_KEY_SQL` BY AN
// ENUM THE DTO VALIDATED — never text from the request. It must also contain
// no bound parameter: it appears three times in each statement, and Postgres
// only matches `GROUPING(expr)` / `SELECT expr` to `GROUP BY expr` when the
// three are textually the same expression.
//
// Every count/sum is cast at the database (`::int`, `::float8`): `count(*)` is
// `bigint` and `sum(int)` is `bigint`/`numeric`, which Prisma returns as a JS
// `bigint`/`Decimal` that `JSON.stringify` refuses or mangles.
//
// OWNER SCOPING is the caller's job, by passing `userId`: the per-user route
// always passes the authenticated user and has no way to pass anyone else.
// =============================================================================

const DAY_MS = 24 * 60 * 60 * 1000;

/** The key a `user` group takes for events with no user (e.g. catalog discovery). */
export const AI_USAGE_NO_USER_KEY = 'system';

/** Stable reason code for an unusable range (in `details.reason`). */
export const AI_USAGE_RANGE_INVALID = 'AI_USAGE_RANGE_INVALID';

const GROUP_KEY_SQL: Record<AiUsageGroupBy, Prisma.Sql> = {
  day: Prisma.raw(`to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')`),
  user: Prisma.raw(`user_id::text`),
  model: Prisma.raw(`provider || ':' || model_id`),
  provider: Prisma.raw(`provider`),
  keySource: Prisma.raw(`key_source`),
};

const KEY_SOURCE_LABELS: Record<string, string> = {
  user: "User's own key",
  org: 'Organization key',
  admin_discovery: 'Admin key (catalog discovery)',
  none: 'No key (keyless server)',
};

export interface AiUsageQuery {
  from?: string;
  to?: string;
  groupBy: AiUsageGroupBy;
  /** Restrict to one user. The per-user route always sets this to the caller. */
  userId?: string;
  provider?: string;
  model?: string;
}

/** A resolved window: `from`/`to` inclusive UTC days, `start`/`end` the half-open instants. */
export interface AiUsageRange {
  from: string;
  to: string;
  start: Date;
  end: Date;
}

interface AggregateRow {
  is_total: number;
  key: string | null;
  requests: number;
  failed: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_input_tokens: number;
  org_requests: number;
  org_input_tokens: number;
  org_output_tokens: number;
}

interface UnitsRow {
  is_total: number;
  key: string | null;
  unit: string;
  amount: number;
}

@Injectable()
export class AiUsageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: AiProviderRegistry,
  ) {}

  async report(query: AiUsageQuery, now: Date = new Date()): Promise<AiUsageReport> {
    const range = resolveAiUsageRange(query.from, query.to, now);
    const key = GROUP_KEY_SQL[query.groupBy];
    const where = whereSql(range, query);

    const [rows, unitRows] = await Promise.all([
      this.prisma.$queryRaw<AggregateRow[]>(Prisma.sql`
        SELECT
          GROUPING(${key})::int AS is_total,
          ${key} AS key,
          count(*)::int AS requests,
          (count(*) FILTER (WHERE status = 'failed'))::int AS failed,
          coalesce(sum(input_tokens), 0)::float8 AS input_tokens,
          coalesce(sum(output_tokens), 0)::float8 AS output_tokens,
          coalesce(sum(reasoning_tokens), 0)::float8 AS reasoning_tokens,
          coalesce(sum(cached_input_tokens), 0)::float8 AS cached_input_tokens,
          (count(*) FILTER (WHERE key_source = 'org'))::int AS org_requests,
          coalesce(sum(input_tokens) FILTER (WHERE key_source = 'org'), 0)::float8 AS org_input_tokens,
          coalesce(sum(output_tokens) FILTER (WHERE key_source = 'org'), 0)::float8 AS org_output_tokens
        FROM ai_usage_events
        ${where}
        GROUP BY GROUPING SETS ((${key}), ())
      `),
      // `CASE` rather than a WHERE on `jsonb_typeof`: `jsonb_each` raises on a
      // non-object, and a CASE inside the call is the only placement whose
      // evaluation order Postgres guarantees.
      this.prisma.$queryRaw<UnitsRow[]>(Prisma.sql`
        SELECT
          GROUPING(${key})::int AS is_total,
          ${key} AS key,
          u.unit AS unit,
          sum((u.amount)::numeric)::float8 AS amount
        FROM ai_usage_events,
          LATERAL jsonb_each(
            CASE WHEN jsonb_typeof(units) = 'object' THEN units ELSE '{}'::jsonb END
          ) AS u(unit, amount)
        ${where}
          AND jsonb_typeof(u.amount) = 'number'
        GROUP BY GROUPING SETS ((${key}, u.unit), (u.unit))
      `),
    ]);

    const units = new Map<string | null, Record<string, number>>();
    let totalUnits: Record<string, number> = {};

    for (const row of unitRows ?? []) {
      const amount = Number(row.amount);
      if (Number(row.is_total) === 1) {
        totalUnits = { ...totalUnits, [row.unit]: amount };
        continue;
      }
      const bucket = units.get(row.key) ?? {};
      bucket[row.unit] = amount;
      units.set(row.key, bucket);
    }

    let totals = emptyBucket();
    const groups: Array<{ key: string | null; bucket: AiUsageBucket }> = [];

    for (const row of rows ?? []) {
      if (Number(row.is_total) === 1) {
        totals = toBucket(row, totalUnits);
      } else {
        groups.push({ key: row.key, bucket: toBucket(row, units.get(row.key) ?? {}) });
      }
    }

    const series =
      query.groupBy === 'day'
        ? zeroFilledDays(range, groups)
        : await this.labelled(query.groupBy, groups);

    return { range: { from: range.from, to: range.to }, groupBy: query.groupBy, totals, series };
  }

  /** Non-day groups, labelled, most requests first (ties by key, so the order is stable). */
  private async labelled(
    groupBy: Exclude<AiUsageGroupBy, 'day'>,
    groups: Array<{ key: string | null; bucket: AiUsageBucket }>,
  ): Promise<AiUsageSeriesItem[]> {
    const emails = groupBy === 'user' ? await this.emailsFor(groups) : new Map<string, string>();

    const series = groups.map(({ key, bucket }) => {
      switch (groupBy) {
        case 'user':
          return key === null
            ? { key: AI_USAGE_NO_USER_KEY, label: 'System (no user)', ...bucket }
            : { key, label: emails.get(key) ?? key, ...bucket };
        case 'model': {
          const k = key ?? '';
          const sep = k.indexOf(':');
          return { key: k, label: sep >= 0 ? k.slice(sep + 1) : k, ...bucket };
        }
        case 'provider': {
          const k = key ?? '';
          return { key: k, label: this.registry.get(k)?.displayName ?? k, ...bucket };
        }
        case 'keySource': {
          const k = key ?? '';
          return { key: k, label: KEY_SOURCE_LABELS[k] ?? k, ...bucket };
        }
      }
    });

    return series.sort((a, b) => b.requests - a.requests || a.key.localeCompare(b.key));
  }

  private async emailsFor(
    groups: Array<{ key: string | null }>,
  ): Promise<Map<string, string>> {
    const ids = groups.map((g) => g.key).filter((id): id is string => id !== null);

    if (ids.length === 0) return new Map();

    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, email: true },
    });

    return new Map(users.map((u) => [u.id, u.email]));
  }
}

function whereSql(range: AiUsageRange, query: AiUsageQuery): Prisma.Sql {
  const clauses: Prisma.Sql[] = [
    Prisma.sql`created_at >= ${range.start}::timestamptz`,
    Prisma.sql`created_at < ${range.end}::timestamptz`,
  ];

  if (query.userId) clauses.push(Prisma.sql`user_id = ${query.userId}::uuid`);
  if (query.provider) clauses.push(Prisma.sql`provider = ${query.provider}`);
  if (query.model) clauses.push(Prisma.sql`model_id = ${query.model}`);

  return Prisma.sql`WHERE ${Prisma.join(clauses, ' AND ')}`;
}

/**
 * The window a report covers. Pure, so the defaults and bounds are unit
 * testable without a database.
 *
 * Defaults: `to` = today (UTC); `from` = `to` minus 29 days (30 days
 * inclusive). Refused with 400 `AI_USAGE_RANGE_INVALID` when `from` is after
 * `to` or the span exceeds `MAX_AI_USAGE_RANGE_DAYS` — refused, not clamped:
 * a caller who asked for a year and silently got a quarter would compare the
 * wrong numbers (the job-insights argument).
 */
export function resolveAiUsageRange(from: string | undefined, to: string | undefined, now: Date): AiUsageRange {
  const toDay = to ? parseDay(to) : startOfUtcDay(now);
  const fromDay = from ? parseDay(from) : new Date(toDay.getTime() - (DEFAULT_AI_USAGE_RANGE_DAYS - 1) * DAY_MS);

  if (fromDay.getTime() > toDay.getTime()) {
    throw rangeError('`from` must not be after `to`.');
  }

  const days = Math.round((toDay.getTime() - fromDay.getTime()) / DAY_MS) + 1;

  if (days > MAX_AI_USAGE_RANGE_DAYS) {
    throw rangeError(`The range covers ${days} days; at most ${MAX_AI_USAGE_RANGE_DAYS} are allowed.`);
  }

  return {
    from: isoDay(fromDay),
    to: isoDay(toDay),
    start: fromDay,
    end: new Date(toDay.getTime() + DAY_MS),
  };
}

function parseDay(day: string): Date {
  const parsed = new Date(`${day}T00:00:00.000Z`);

  if (Number.isNaN(parsed.getTime()) || isoDay(parsed) !== day) {
    throw rangeError(`"${day}" is not a valid date (YYYY-MM-DD).`);
  }

  return parsed;
}

function rangeError(message: string): BadRequestException {
  return new BadRequestException({ message, details: { reason: AI_USAGE_RANGE_INVALID } });
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function emptyBucket(): AiUsageBucket {
  return {
    requests: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    units: {},
    orgKeyRequests: 0,
    orgKeyInputTokens: 0,
    orgKeyOutputTokens: 0,
  };
}

function toBucket(row: AggregateRow, units: Record<string, number>): AiUsageBucket {
  return {
    requests: Number(row.requests),
    failed: Number(row.failed),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    reasoningTokens: Number(row.reasoning_tokens),
    cachedInputTokens: Number(row.cached_input_tokens),
    units,
    orgKeyRequests: Number(row.org_requests),
    orgKeyInputTokens: Number(row.org_input_tokens),
    orgKeyOutputTokens: Number(row.org_output_tokens),
  };
}

/** Every day of the range, in order, with a zero bucket where nothing was recorded. */
function zeroFilledDays(
  range: AiUsageRange,
  groups: Array<{ key: string | null; bucket: AiUsageBucket }>,
): AiUsageSeriesItem[] {
  const byDay = new Map(groups.map((g) => [g.key, g.bucket]));
  const series: AiUsageSeriesItem[] = [];

  for (let t = range.start.getTime(); t < range.end.getTime(); t += DAY_MS) {
    const day = isoDay(new Date(t));
    series.push({ key: day, label: day, ...(byDay.get(day) ?? emptyBucket()) });
  }

  return series;
}
