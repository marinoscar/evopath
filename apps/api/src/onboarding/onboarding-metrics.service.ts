import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import {
  ACTIVATION_WINDOW_DAYS,
  OnboardingMetricsResponse,
} from './dto/onboarding-metrics.dto';

// =============================================================================
// OnboardingMetricsService — new-user activation, aggregated (#212)
// =============================================================================
//
// ONE read-only `SELECT`, aggregates only: no per-user row ever leaves the
// database. Bounded by the cohort (users created in the last `days` days, at
// most a year), so it is an on-demand read, not a queue job.
//
// Definitions:
//   * cohort     users.created_at >= now - days
//   * eligible   cohort users with created_at <= now - 7 days (window closed)
//   * activated  eligible users whose FIRST completed workout, MIN(ended_at),
//                is within 7 days of created_at
//   * median     percentile_cont(0.5) of hours from created_at to the first
//                completed workout, over cohort users that have one
//   * steps      the same "done" rules as the user checklist
//                (`OnboardingService.userBlock`): a health-profile row, a gym,
//                a completed workout, and for `ai_plan` a program plus,
//                while the system coach switch is on, a saved `coach`
//                user-settings namespace ("Meet your coach", E7.12).
// =============================================================================

interface MetricsRow {
  cohort_size: number;
  eligible: number;
  activated: number;
  median_hours: number | null;
  health_profile: number;
  gym: number;
  first_workout: number;
  ai_plan: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class OnboardingMetricsService {
  constructor(
    private readonly prisma: PrismaService,
    // Optional: absent reads as "the coach is on" (the switch's default).
    @Optional() private readonly systemSettings?: SystemSettingsService,
  ) {}

  async metrics(days: number, now: Date = new Date()): Promise<OnboardingMetricsResponse> {
    const cohortStart = new Date(now.getTime() - days * DAY_MS);
    const eligibleBefore = new Date(now.getTime() - ACTIVATION_WINDOW_DAYS * DAY_MS);
    const activationWindow = `${ACTIVATION_WINDOW_DAYS} days`;
    const requireCoach = await this.coachEnabled();

    const rows = await this.prisma.$queryRaw<MetricsRow[]>(Prisma.sql`
      WITH cohort AS (
        SELECT id, created_at
        FROM users
        WHERE created_at >= ${cohortStart}::timestamptz
          AND created_at <= ${now}::timestamptz
      ),
      first_workout AS (
        SELECT w.user_id, MIN(w.ended_at) AS first_at
        FROM workouts w
        JOIN cohort c ON c.id = w.user_id
        WHERE w.status = 'completed'
        GROUP BY w.user_id
      )
      SELECT
        count(*)::int AS cohort_size,
        (count(*) FILTER (WHERE c.created_at <= ${eligibleBefore}::timestamptz))::int AS eligible,
        (count(*) FILTER (
          WHERE c.created_at <= ${eligibleBefore}::timestamptz
            AND f.first_at <= c.created_at + ${activationWindow}::interval
        ))::int AS activated,
        percentile_cont(0.5) WITHIN GROUP (
          ORDER BY GREATEST(EXTRACT(EPOCH FROM (f.first_at - c.created_at)), 0)::double precision / 3600.0
        ) FILTER (WHERE f.first_at IS NOT NULL) AS median_hours,
        (count(*) FILTER (
          WHERE EXISTS (SELECT 1 FROM health_profiles h WHERE h.user_id = c.id)
        ))::int AS health_profile,
        (count(*) FILTER (
          WHERE EXISTS (SELECT 1 FROM gyms g WHERE g.user_id = c.id)
        ))::int AS gym,
        (count(*) FILTER (WHERE f.user_id IS NOT NULL))::int AS first_workout,
        (count(*) FILTER (
          WHERE EXISTS (SELECT 1 FROM programs p WHERE p.user_id = c.id)
            AND (
              NOT ${requireCoach}::boolean
              OR EXISTS (
                SELECT 1 FROM user_settings us
                WHERE us.user_id = c.id AND jsonb_typeof(us.value -> 'coach') = 'object'
              )
            )
        ))::int AS ai_plan
      FROM cohort c
      LEFT JOIN first_workout f ON f.user_id = c.id
    `);

    const row = rows[0];
    const cohortSize = toInt(row?.cohort_size);
    const eligible = toInt(row?.eligible);
    const activated = toInt(row?.activated);
    const median = row?.median_hours;

    const step = (id: OnboardingMetricsResponse['steps'][number]['id'], completed: number) => ({
      id,
      completed,
      rate: ratio(completed, cohortSize),
    });

    return {
      windowDays: days,
      activationWindowDays: ACTIVATION_WINDOW_DAYS,
      cohortSize,
      eligible,
      activated,
      activationRate: ratio(activated, eligible),
      medianHoursToFirstWorkout:
        median === null || median === undefined ? null : Math.round(Number(median) * 10) / 10,
      steps: [
        step('health_profile', toInt(row?.health_profile)),
        step('gym', toInt(row?.gym)),
        step('first_workout', toInt(row?.first_workout)),
        step('ai_plan', toInt(row?.ai_plan)),
      ],
    };
  }

  /** The system coach switch, as the checklist reads it; a failed read keeps the plain program rule. */
  private async coachEnabled(): Promise<boolean> {
    if (!this.systemSettings) return true;
    try {
      return (await this.systemSettings.getCoachPolicy()).enabled;
    } catch {
      return false;
    }
  }
}

function toInt(value: number | bigint | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function ratio(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}
