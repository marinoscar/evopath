import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { WORKOUT_CONVERTED_MOMENTS } from '../nudges/coach-conversion';
import {
  COACH_STATS_RANGE_INVALID,
  DEFAULT_COACH_STATS_RANGE_DAYS,
  MAX_COACH_STATS_RANGE_DAYS,
  type CoachFunnel,
  type CoachFunnelRow,
  type CoachStats,
  type CoachStatsQuery,
} from '../dto/coach-admin-stats.dto';

// =============================================================================
// Coach engagement aggregates (E7.11, #251; spec §2.8, §2.13)
// =============================================================================
//
// TWO QUERIES, both aggregates; no user id or text leaves the database:
//
//   1. `coach_messages` grouped by (angle, persona, moment, feedback) with
//      counts of rows, opens and conversions, over DELIVERED coach messages
//      (chat replies excluded) in the range. Rolled up here into totals and
//      the three breakdowns. At most 7 x 7 x 12 x 3 groups.
//   2. One row of KPI counts (raw SQL): weekly actives, chat sessions, photo
//      cadence adherence, coach on / opted out.
//
// Range scans use `delivered_at` / `created_at`; there is no dedicated index
// (the page is opened by an administrator, not on a hot path).
// =============================================================================

const DAY_MS = 24 * 60 * 60 * 1000;
const WAU_DAYS = 7;
/** Moments whose message has a conversion target by moment alone (spec §2.8). */
const CONVERTIBLE_MOMENTS = new Set<string>([...WORKOUT_CONVERTED_MOMENTS, 'photo_prompt']);
const NONE = 'none';

export interface CoachStatsRange {
  from: string;
  to: string;
  days: number;
  start: Date;
  /** Exclusive. */
  end: Date;
}

/** One group of query 1. */
export interface CoachFunnelGroup {
  angle: string | null;
  personaId: string | null;
  moment: string | null;
  feedback: string | null;
  _count: { _all: number; openedAt: number; convertedAt: number };
}

interface KpiRow {
  weeklyActiveUsers: number | bigint;
  chatSessions: number | bigint;
  photoDue: number | bigint;
  photoOnCadence: number | bigint;
  enabled: number | bigint;
  optedOut: number | bigint;
}

type Counts = Omit<CoachFunnel, 'openRate' | 'convertRate'>;

function emptyCounts(): Counts {
  return { sent: 0, opened: 0, convertible: 0, converted: 0, up: 0, down: 0 };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 10_000 : null;
}

function withRates(c: Counts): CoachFunnel {
  return { ...c, openRate: ratio(c.opened, c.sent), convertRate: ratio(c.converted, c.convertible) };
}

function addGroup(into: Counts, g: CoachFunnelGroup): void {
  const n = g._count._all;
  into.sent += n;
  into.opened += g._count.openedAt;
  into.converted += g._count.convertedAt;
  // A converted message always had a target (a low-readiness check-in, say),
  // so it counts as convertible even when its moment alone does not.
  into.convertible += g.moment && CONVERTIBLE_MOMENTS.has(g.moment) ? n : g._count.convertedAt;
  if (g.feedback === 'up') into.up += n;
  if (g.feedback === 'down') into.down += n;
}

/** PURE. Rolls the grouped rows up into totals and the three breakdowns (sorted by `sent`, then key). */
export function rollUpFunnel(groups: readonly CoachFunnelGroup[]): Pick<CoachStats, 'totals' | 'byAngle' | 'byPersona' | 'byMoment'> {
  const totals = emptyCounts();
  const by = { angle: new Map<string, Counts>(), personaId: new Map<string, Counts>(), moment: new Map<string, Counts>() };
  for (const g of groups) {
    addGroup(totals, g);
    for (const dim of ['angle', 'personaId', 'moment'] as const) {
      const key = g[dim] ?? NONE;
      let bucket = by[dim].get(key);
      if (!bucket) by[dim].set(key, (bucket = emptyCounts()));
      addGroup(bucket, g);
    }
  }
  const rows = (map: Map<string, Counts>): CoachFunnelRow[] =>
    [...map.entries()]
      .map(([key, c]) => ({ key, ...withRates(c) }))
      .sort((a, b) => b.sent - a.sent || a.key.localeCompare(b.key));
  return { totals: withRates(totals), byAngle: rows(by.angle), byPersona: rows(by.personaId), byMoment: rows(by.moment) };
}

/** Resolves the query to a UTC day range; 400 `COACH_STATS_RANGE_INVALID` when reversed or too long. */
export function resolveCoachStatsRange(query: CoachStatsQuery, now: Date): CoachStatsRange {
  const toDay = query.to ? parseDay(query.to) : startOfUtcDay(now);
  const span = query.days ?? DEFAULT_COACH_STATS_RANGE_DAYS;
  const fromDay = query.from ? parseDay(query.from) : new Date(toDay.getTime() - (span - 1) * DAY_MS);
  if (fromDay.getTime() > toDay.getTime()) throw rangeError('`from` must not be after `to`.');
  const days = Math.round((toDay.getTime() - fromDay.getTime()) / DAY_MS) + 1;
  if (days > MAX_COACH_STATS_RANGE_DAYS) {
    throw rangeError(`The range covers ${days} days; at most ${MAX_COACH_STATS_RANGE_DAYS} are allowed.`);
  }
  return { from: isoDay(fromDay), to: isoDay(toDay), days, start: fromDay, end: new Date(toDay.getTime() + DAY_MS) };
}

@Injectable()
export class CoachAdminStatsService {
  constructor(private readonly prisma: PrismaService) {}

  async stats(query: CoachStatsQuery, now: Date = new Date()): Promise<CoachStats> {
    const range = resolveCoachStatsRange(query, now);
    const [groups, kpi] = await Promise.all([this.funnelGroups(range), this.kpiRow(range)]);
    const funnel = rollUpFunnel(groups);

    const weeklyActiveUsers = Number(kpi?.weeklyActiveUsers ?? 0);
    const chatSessions = Number(kpi?.chatSessions ?? 0);
    const photoDue = Number(kpi?.photoDue ?? 0);
    const photoOnCadence = Number(kpi?.photoOnCadence ?? 0);
    const enabled = Number(kpi?.enabled ?? 0);
    const optedOut = Number(kpi?.optedOut ?? 0);
    const photoRate = ratio(photoOnCadence, photoDue);

    return {
      range: { from: range.from, to: range.to, days: range.days },
      ...funnel,
      kpis: {
        nudgeOpenRate: funnel.totals.openRate,
        conversionRate: funnel.totals.convertRate,
        weeklyActiveUsers,
        chatSessionsPerWau: weeklyActiveUsers > 0 ? Math.round((chatSessions / weeklyActiveUsers) * 100) / 100 : null,
        photoCadenceAdherencePct: photoRate === null ? null : Math.round(photoRate * 1000) / 10,
        weeklyAdherencePct: null,
        optedOut,
        enabled,
        optOutRate: ratio(optedOut, optedOut + enabled),
      },
    };
  }

  private async funnelGroups(range: CoachStatsRange): Promise<CoachFunnelGroup[]> {
    const groups = await this.prisma.coachMessage.groupBy({
      by: ['angle', 'personaId', 'moment', 'feedback'],
      where: {
        role: 'coach',
        kind: { not: 'chat' },
        deliveredAt: { gte: range.start, lt: range.end },
      },
      _count: { _all: true, openedAt: true, convertedAt: true },
    });
    return (groups ?? []) as unknown as CoachFunnelGroup[];
  }

  private async kpiRow(range: CoachStatsRange): Promise<KpiRow | undefined> {
    const end = range.end;
    const wauStart = new Date(Math.max(range.start.getTime(), end.getTime() - WAU_DAYS * DAY_MS));
    const rows = await this.prisma.$queryRaw<KpiRow[]>(Prisma.sql`
      WITH "active" AS (
        SELECT "user_id" FROM "workouts"
         WHERE "status" = 'completed' AND "ended_at" >= ${wauStart} AND "ended_at" < ${end}
        UNION
        SELECT "user_id" FROM "coach_messages"
         WHERE "role" = 'user' AND "kind" = 'chat' AND "created_at" >= ${wauStart} AND "created_at" < ${end}
      ),
      "coach_users" AS (
        SELECT s."user_id", s."value"->'coach' AS "coach"
          FROM "user_settings" s
          JOIN "users" u ON u."id" = s."user_id"
         WHERE u."is_active" AND s."value"->'coach' IS NOT NULL
      ),
      "cadence" AS (
        SELECT "user_id",
               CASE COALESCE("coach"->>'photoCadence', 'biweekly')
                 WHEN 'weekly' THEN 7 WHEN 'biweekly' THEN 14 WHEN 'monthly' THEN 28
               END AS "days"
          FROM "coach_users"
         WHERE "coach"->>'enabled' = 'true'
      )
      SELECT
        (SELECT COUNT(*) FROM "active")::int AS "weeklyActiveUsers",
        (SELECT COUNT(*) FROM (
           SELECT DISTINCT "user_id", ("created_at" AT TIME ZONE 'UTC')::date
             FROM "coach_messages"
            WHERE "role" = 'user' AND "kind" = 'chat' AND "created_at" >= ${wauStart} AND "created_at" < ${end}
         ) d)::int AS "chatSessions",
        (SELECT COUNT(*) FROM "cadence" WHERE "days" IS NOT NULL)::int AS "photoDue",
        (SELECT COUNT(*) FROM "cadence" c
          WHERE c."days" IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM "progress_photos" p
               WHERE p."user_id" = c."user_id"
                 AND p."created_at" < ${end}
                 AND p."created_at" >= ${end}::timestamptz - make_interval(days => c."days")
            ))::int AS "photoOnCadence",
        (SELECT COUNT(*) FROM "coach_users" WHERE "coach"->>'enabled' = 'true')::int AS "enabled",
        (SELECT COUNT(*) FROM "coach_users" WHERE "coach"->>'enabled' = 'false')::int AS "optedOut"
    `);
    return rows?.[0];
  }
}

function parseDay(day: string): Date {
  const parsed = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || isoDay(parsed) !== day) {
    throw rangeError(`"${day}" is not a valid date (YYYY-MM-DD).`);
  }
  return parsed;
}

function rangeError(message: string): BadRequestException {
  return new BadRequestException({ message, details: { reason: COACH_STATS_RANGE_INVALID } });
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
