import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { SUPPORTIVE_ANGLES } from '../guard/banned-terms';
import { COACH_ANGLES, type CoachAngle } from '../nudges/angle-picker';
import { WORKOUT_CONVERTED_MOMENTS } from '../nudges/coach-conversion';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ANGLE_REWARD_CACHE_TTL_MS,
  ANGLE_REWARD_MATURITY_HOURS,
  ANGLE_REWARD_WINDOW_DAYS,
} from './learning.constants';
import type { AngleRewards, AngleRewardStats } from './pick-angle';

// =============================================================================
// Global per-angle rewards (E7.11, #251; spec §2.8)
// =============================================================================
//
// ONE grouped SQL aggregate over `coach_messages`: counts only, no user id
// leaves the database. Cached in memory per API process for an hour; a
// failure answers `{}` (cold start: uniform choice), never an exception.
//
// WHICH MESSAGES. Delivered coach messages with an angle and a conversion
// target (spec §2.8): the workout moments, `photo_prompt`, and supportive
// messages sent under low readiness (`data.lowReadiness`). Celebrations and
// reviews have no target and are excluded. A message younger than
// `ANGLE_REWARD_MATURITY_HOURS` is excluded too: its window is still open.
// Opened-but-not-converted is simply a send without a conversion.
//
// μ⁻ ("eligible but not sent"). From E7.11 the nudge job records the
// eligible set it chose from in `data.eligibleAngles`, so μ⁻(a) counts
// exactly the messages where `a` was in that set and another angle was sent.
// For OLDER messages (E7.5, no recorded set) eligibility is reconstructed
// from the stored register: `data.register = 'supportive'` -> the supportive
// angles, otherwise every angle. That over-counts `future_self` eligibility
// for users without a `why`; it ages out of the 90-day window.
// =============================================================================

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const ANGLE_SET = new Set<string>(COACH_ANGLES);

/** One row of the grouped aggregate. */
export interface AngleRewardRow {
  angle: string;
  /** `data.eligibleAngles` as stored (a JSON array), or null on older messages. */
  eligible: unknown;
  /** `data.register`, or null. */
  register: string | null;
  sent: number | bigint;
  converted: number | bigint;
}

function emptyStats(): AngleRewardStats {
  return { sent: 0, sentConverted: 0, notSent: 0, notSentConverted: 0 };
}

/** The eligible set a message was chosen from: recorded, else reconstructed from its register. */
export function eligibleOfRow(row: Pick<AngleRewardRow, 'eligible' | 'register'>): CoachAngle[] {
  if (Array.isArray(row.eligible)) {
    return row.eligible.filter((a): a is CoachAngle => typeof a === 'string' && ANGLE_SET.has(a));
  }
  return row.register === 'supportive'
    ? COACH_ANGLES.filter((a) => SUPPORTIVE_ANGLES.includes(a))
    : [...COACH_ANGLES];
}

/** PURE. Folds the grouped rows into per-angle sent / eligible-but-not-sent counts. */
export function aggregateAngleRewards(rows: readonly AngleRewardRow[]): AngleRewards {
  const out: AngleRewards = {};
  const statsOf = (angle: CoachAngle) => (out[angle] ??= emptyStats());
  for (const row of rows) {
    if (!ANGLE_SET.has(row.angle)) continue;
    const sent = Number(row.sent);
    const converted = Number(row.converted);
    const angle = row.angle as CoachAngle;
    const own = statsOf(angle);
    own.sent += sent;
    own.sentConverted += converted;
    for (const other of eligibleOfRow(row)) {
      if (other === angle) continue;
      const stats = statsOf(other);
      stats.notSent += sent;
      stats.notSentConverted += converted;
    }
  }
  return out;
}

@Injectable()
export class AngleStatsService {
  private readonly logger = new Logger(AngleStatsService.name);
  private cache: { at: number; rewards: AngleRewards } | null = null;
  private inflight: Promise<AngleRewards> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** The cached global rewards, recomputed at most once per TTL. Never throws. */
  async rewards(now: Date = new Date()): Promise<AngleRewards> {
    if (this.cache && now.getTime() - this.cache.at < ANGLE_REWARD_CACHE_TTL_MS) return this.cache.rewards;
    if (!this.inflight) {
      this.inflight = this.compute(now)
        .then((rewards) => {
          this.cache = { at: now.getTime(), rewards };
          return rewards;
        })
        .catch((err: unknown) => {
          this.logger.warn(`Angle rewards could not be computed (${(err as Error)?.name ?? 'Error'}); cold start`);
          return this.cache?.rewards ?? {};
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  /** Drops the cache (tests). */
  invalidate(): void {
    this.cache = null;
  }

  private async compute(now: Date): Promise<AngleRewards> {
    const from = new Date(now.getTime() - ANGLE_REWARD_WINDOW_DAYS * DAY_MS);
    const matureBefore = new Date(now.getTime() - ANGLE_REWARD_MATURITY_HOURS * HOUR_MS);
    const targetMoments = [...WORKOUT_CONVERTED_MOMENTS, 'photo_prompt'];
    const rows = await this.prisma.$queryRaw<AngleRewardRow[]>(Prisma.sql`
      SELECT "angle",
             "data"->'eligibleAngles' AS "eligible",
             "data"->>'register' AS "register",
             COUNT(*)::int AS "sent",
             COUNT("converted_at")::int AS "converted"
        FROM "coach_messages"
       WHERE "role" = 'coach'
         AND "angle" IS NOT NULL
         AND "delivered_at" >= ${from}
         AND "delivered_at" < ${matureBefore}
         AND ("moment" IN (${Prisma.join(targetMoments)}) OR ("data"->>'lowReadiness') = 'true')
       GROUP BY 1, 2, 3
    `);
    return aggregateAngleRewards(rows);
  }
}
