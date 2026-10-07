import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { EvoPathMetricsService, fallbackEvoPathMetrics } from '../../app-metrics/domain-metrics.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SUPPORTIVE_ANGLES } from '../guard/banned-terms';
import { COACH_ANGLES, DefaultAnglePicker, type AnglePicker, type AnglePickInput, type CoachAngle } from '../nudges/angle-picker';
import { AngleStatsService } from './angle-stats.service';
import { ANGLE_USER_HISTORY_DAYS, ANGLE_USER_HISTORY_LIMIT } from './learning.constants';
import { eligibleAnglesFor, personaAngleBias, pickAngle, type AngleHistory } from './pick-angle';

// =============================================================================
// BanditAnglePicker: the learning loop behind COACH_ANGLE_PICKER (E7.11, #251)
// =============================================================================
//
// 1. Eligible angles: persona exclusions, `future_self` only with a `why`,
//    the supportive register (`eligibleAnglesFor`), all before scoring.
// 2. The user's own angle history over the last `ANGLE_USER_HISTORY_DAYS`
//    (the novelty penalty), one indexed read on (user_id, created_at).
// 3. The cached global rewards (`AngleStatsService`; `{}` on failure).
// 4. `pickAngle` with `Math.random` (tests inject a seeded rng).
//
// Any failure, or an empty eligible set, falls back to `DefaultAnglePicker`:
// a nudge never fails because the learning loop could not run.
//
// PRIVACY: ids and enums only in logs and metrics; no per-user scores.
// =============================================================================

const DAY_MS = 24 * 60 * 60 * 1000;
const ANGLE_SET = new Set<string>(COACH_ANGLES);

/** Optional DI tokens for tests; production uses `Math.random` and the wall clock. */
export const COACH_ANGLE_RNG = Symbol('COACH_ANGLE_RNG');
export const COACH_ANGLE_CLOCK = Symbol('COACH_ANGLE_CLOCK');

@Injectable()
export class BanditAnglePicker implements AnglePicker {
  private readonly logger = new Logger(BanditAnglePicker.name);
  private readonly fallback = new DefaultAnglePicker();

  constructor(
    private readonly prisma: PrismaService,
    private readonly stats: AngleStatsService,
    @Optional() private readonly metrics: EvoPathMetricsService = fallbackEvoPathMetrics(),
    @Optional() @Inject(COACH_ANGLE_RNG) private readonly rng: () => number = Math.random,
    @Optional() @Inject(COACH_ANGLE_CLOCK) private readonly clock: () => Date = () => new Date(),
  ) {}

  async pick(input: AnglePickInput): Promise<CoachAngle | null> {
    const angle = await this.choose(input);
    if (angle) this.metrics.coachAnglePicked(angle);
    return angle;
  }

  private async choose(input: AnglePickInput): Promise<CoachAngle | null> {
    const eligible = eligibleAnglesFor(input);
    if (eligible.length === 0) return this.fallback.pick(input);

    try {
      const now = this.clock();
      const [history, rewards] = await Promise.all([this.history(input.userId, now), this.stats.rewards(now)]);
      const angle = pickAngle(history, eligible, this.rng, { now, rewards, bias: personaAngleBias(input.personaId) });
      if (!angle) return this.fallback.pick(input);
      // Belt and braces: the guard's supportive rule must never fire on a picked angle.
      if (input.supportive && !SUPPORTIVE_ANGLES.includes(angle)) return this.fallback.pick(input);
      return angle;
    } catch (err) {
      this.logger.warn(
        `Angle bandit failed for user ${input.userId} (${(err as Error)?.name ?? 'Error'}); default angle used`,
      );
      return this.fallback.pick(input);
    }
  }

  private async history(userId: string, now: Date): Promise<AngleHistory[]> {
    const rows = await this.prisma.coachMessage.findMany({
      where: {
        userId,
        role: 'coach',
        angle: { not: null },
        createdAt: { gte: new Date(now.getTime() - ANGLE_USER_HISTORY_DAYS * DAY_MS) },
      },
      orderBy: { createdAt: 'desc' },
      take: ANGLE_USER_HISTORY_LIMIT,
      select: { angle: true, deliveredAt: true, createdAt: true },
    });
    return rows
      .filter((r): r is typeof r & { angle: CoachAngle } => typeof r.angle === 'string' && ANGLE_SET.has(r.angle))
      .map((r) => ({ angle: r.angle, at: r.deliveredAt ?? r.createdAt }));
  }
}
