import { Injectable } from '@nestjs/common';

import { AiConfigService } from '../../ai/config/ai-config.service';
import { addDays, toDbDate } from '../../check-ins/local-date';
import { CheckInsService } from '../../check-ins/check-ins.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TrainingSignalsService } from '../../programs/signals/signals.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { coachUserSettingsOf } from './coach-planner.service';
import { nextSessionOf, weeklyTargetOf } from './coach-signals';
import { localDateOf } from './coach-time';
import type { CoachStateView } from './dto/coach-state.dto';

// =============================================================================
// CoachStateService: read and update `CoachState` (E7.4; spec §2.2)
// =============================================================================
//
// The row is created lazily (by the sweep, or the first settings write); a
// read with no row answers the defaults and creates nothing. Every number in
// the header comes from the signals service or `CoachState`, never a model.
// =============================================================================

@Injectable()
export class CoachStateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly signals: TrainingSignalsService,
    private readonly checkIns: CheckInsService,
    private readonly aiConfig: AiConfigService,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  /** The `/coach` header for the caller (only ever the caller's own data). */
  async view(userId: string, now: Date = new Date()): Promise<CoachStateView> {
    const today = await this.checkIns.today(userId, now);
    const [state, signals, unreadCount, aiEnabled, system, settingsRow] = await Promise.all([
      this.prisma.coachState.findUnique({ where: { userId } }),
      this.signals.forUser(userId, { to: addDays(today, 7) }, now),
      this.prisma.coachMessage.count({
        where: { userId, role: 'coach', deliveredAt: { not: null }, openedAt: null },
      }),
      this.aiConfig.isEnabled(),
      this.systemSettings.getCoachPolicy(),
      this.prisma.userSettings.findUnique({ where: { userId }, select: { value: true } }),
    ]);
    const user = coachUserSettingsOf(settingsRow?.value ?? null);

    return {
      enabled: aiEnabled && system.enabled && user.enabled,
      pausedUntil: state?.pausedUntil?.toISOString() ?? null,
      silencedAt: state?.silencedAt?.toISOString() ?? null,
      weeklyTarget: weeklyTargetOf(signals, today),
      weeklyStreak: state?.weeklyStreak ?? 0,
      streakPassesLeft: state?.streakPassesLeft ?? 0,
      nextSession: nextSessionOf(signals, today),
      unreadCount,
      chatClearedAt: state?.chatClearedAt?.toISOString() ?? null,
    };
  }

  /**
   * Counts one delivered nudge against the daily cap and the spacing gate
   * (for the delivery step, E7.5): `nudgesToday` + 1 on the same local day,
   * else 1 on a new one; `lastNudgeAt` = `at`. Creates the row when missing.
   */
  async recordNudgeSent(userId: string, at: Date, timeZone: string | null): Promise<void> {
    const day = toDbDate(localDateOf(at, timeZone));
    await this.prisma.coachState.upsert({ where: { userId }, create: { userId }, update: {} });
    const sameDay = await this.prisma.coachState.updateMany({
      where: { userId, nudgeDayLocal: day },
      data: { nudgesToday: { increment: 1 }, lastNudgeAt: at },
    });
    if (sameDay.count === 0) {
      await this.prisma.coachState.update({ where: { userId }, data: { nudgesToday: 1, nudgeDayLocal: day, lastNudgeAt: at } });
    }
  }
}
