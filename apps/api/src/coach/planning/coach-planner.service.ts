import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { addDays, fromDbDate, toDbDate } from '../../check-ins/local-date';
import type { SystemCoachValue } from '../../common/schemas/settings.schema';
import {
  coachSettingsSchema,
  resolveCoachUserSettings,
  type ResolvedCoachUserSettings,
} from '../../common/schemas/user-settings-namespaces.schema';
import { findEvent } from '../../notifications/notification-events';
import { DEFAULT_NOTIFICATION_POLICY, type NotificationPolicy } from '../../notifications/notification-policy';
import { readNotificationPreferences, resolveChannels } from '../../notifications/notification-preferences';
import { PrismaService } from '../../prisma/prisma.service';
import { ProgressPhotoSummaryService } from '../../progress-photos/progress-photo-summary.service';
import { TrainingSignalsService } from '../../programs/signals/signals.service';
import {
  consecutiveIgnoredOf,
  latestOf,
  toCoachPlanningSignals,
  workoutEventOf,
} from './coach-signals';
import { CoachMomentEnqueuer } from './coach-moment-enqueuer';
import { CoachPlanningMetrics } from './coach-planning.metrics';
import { coachNow, localDateOf } from './coach-time';
import {
  COACH_EVENT_KEYS,
  COACH_MOMENTS,
  type CoachEventKey,
  type CoachMoment,
  type CoachPlanningSettings,
  type CoachPlanningState,
  planCoachMoments,
  type PlannedMoment,
  silencesCoach,
  suppressedOf,
  topNudge,
  weeklyReviewOf,
} from './plan-coach-moments';
import { USUAL_WORKOUT_WINDOW_DAYS, usualWorkoutMinuteLocal } from './usual-workout-time';

// =============================================================================
// CoachPlannerService: one user's planning pass (E7.4)
// =============================================================================
//
// Shared by the hourly `coach.sweep` and the per-user `coach.workout_finished`
// job. One pass:
//
//   1. LOADS the inputs: `CoachState` (created lazily), signals from
//      `TrainingSignalsService.forUser` with the range extended 7 days past
//      today (so the week's upcoming sessions are in it), recent completed
//      workouts, recent coach messages, the latest progress photo and the
//      safety-stop state. Ids, dates and counts only; no free text.
//   2. BOOKKEEPING: `nudgesToday` resets on a new local day,
//      `consecutiveIgnored` is recounted from delivered-and-unopened messages,
//      `silencedAt` clears once the user re-engaged after it (opened a
//      message, chatted, logged a workout), `usualWorkoutMinuteLocal` is the
//      4-week median and, for the sweep, `lastSweepAt` is stamped.
//   3. PLANS with the pure `planCoachMoments` and counts every suppression.
//   4. ENQUEUES the top nudge-lane moment and the weekly review through
//      `CoachMomentEnqueuer`; a silencing moment (`back_off`, `win_back`)
//      sets `silencedAt` once it is queued.
//
// THROWS on any failure: the caller isolates users from each other.
// =============================================================================

/** How far back recent coach messages are read (ignored count, opens, today's moments). */
const MESSAGE_WINDOW_DAYS = 14;
const MESSAGE_WINDOW_LIMIT = 50;
/** A training run that ended `blocked_safety` this recently is an active safety stop. */
const SAFETY_STOP_WINDOW_DAYS = 7;
/** `programs.autonomy_paused_reason` values that are a safety stop (not a user pause). */
const SAFETY_PAUSE_REASONS: ReadonlySet<string> = new Set(['safety_text', 'pain_pattern']);
const DAY_MS = 24 * 60 * 60 * 1000;

export type CoachPlanTrigger = 'sweep' | 'workout_finished';

/** What one pass needs besides the user id; the sweep reads it once per page. */
export interface CoachPlanContext {
  now: Date;
  trigger: CoachPlanTrigger;
  /** Health Profile zone (null: UTC). */
  timeZone: string | null;
  /** The raw `user_settings.value` (null: no row). */
  settingsValue: unknown;
  aiEnabled: boolean;
  system: SystemCoachValue;
  notificationPolicy: NotificationPolicy;
  /** `workout_finished` only: the workout that finished. */
  workoutId?: string;
}

export interface CoachPlanOutcome {
  /** The nudge-lane moment queued, if any. */
  queued: CoachMoment | null;
  weeklyReviewQueued: boolean;
  suppressed: number;
}

@Injectable()
export class CoachPlannerService {
  private readonly logger = new Logger(CoachPlannerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly signals: TrainingSignalsService,
    private readonly enqueuer: CoachMomentEnqueuer,
    private readonly metrics: CoachPlanningMetrics,
    private readonly photoSummary: ProgressPhotoSummaryService,
  ) {}

  async planUser(userId: string, ctx: CoachPlanContext): Promise<CoachPlanOutcome> {
    const { now } = ctx;
    const clock = coachNow(now, ctx.timeZone);
    if (clock.zoneFallback) this.metrics.invalidTimeZone();
    const today = clock.date;
    const zone = clock.timeZone;

    const workoutDate = ctx.trigger === 'workout_finished' ? await this.finishedWorkoutDate(userId, ctx.workoutId) : null;
    if (ctx.trigger === 'workout_finished' && !workoutDate) {
      return { queued: null, weeklyReviewQueued: false, suppressed: 0 };
    }

    const state = await this.prisma.coachState.upsert({ where: { userId }, create: { userId }, update: {} });

    const [signals, recentWorkouts, lastWorkout, messages, photo, program, lastRun] = await Promise.all([
      this.signals.forUser(userId, { to: addDays(today, 7) }, now),
      this.prisma.workout.findMany({
        where: { userId, status: 'completed', startedAt: { gte: new Date(now.getTime() - USUAL_WORKOUT_WINDOW_DAYS * DAY_MS) } },
        select: { startedAt: true },
      }),
      this.prisma.workout.findFirst({
        where: { userId, status: 'completed' },
        orderBy: [{ date: 'desc' }, { startedAt: 'desc' }],
        select: { date: true, startedAt: true, endedAt: true },
      }),
      this.prisma.coachMessage.findMany({
        where: { userId, createdAt: { gte: new Date(now.getTime() - MESSAGE_WINDOW_DAYS * DAY_MS) } },
        orderBy: { createdAt: 'desc' },
        take: MESSAGE_WINDOW_LIMIT,
        select: { role: true, moment: true, createdAt: true, deliveredAt: true, openedAt: true },
      }),
      this.photoSummary.summarize(userId),
      this.prisma.program.findFirst({
        where: { userId, status: 'active' },
        select: { autonomyPausedAt: true, autonomyPausedReason: true },
      }),
      this.prisma.trainingPlanRun.findFirst({
        where: { userId, completedAt: { not: null } },
        orderBy: { completedAt: 'desc' },
        select: { status: true, completedAt: true },
      }),
    ]);

    // ---- bookkeeping --------------------------------------------------------
    const coachMessages = messages.filter((m) => m.role === 'coach');
    const lastUserChatAt = messages.find((m) => m.role === 'user')?.createdAt ?? null;
    const lastOpenedAt = latestOf(...messages.map((m) => m.openedAt));
    const lastWorkoutAt = lastWorkout ? (lastWorkout.endedAt ?? lastWorkout.startedAt) : null;
    const lastEngagementAt = latestOf(lastOpenedAt, lastUserChatAt, lastWorkoutAt);

    const reengaged = state.silencedAt !== null && lastEngagementAt !== null && lastEngagementAt > state.silencedAt;
    let silencedAt = reengaged ? null : state.silencedAt;
    const consecutiveIgnored = consecutiveIgnoredOf(coachMessages, lastEngagementAt, now);
    const nudgeDayLocal = state.nudgeDayLocal ? fromDbDate(state.nudgeDayLocal) : null;
    const newDay = nudgeDayLocal !== today;
    const usual = usualWorkoutMinuteLocal(recentWorkouts.map((w) => w.startedAt), zone);

    // ---- plan ---------------------------------------------------------------
    const planningSignals = toCoachPlanningSignals(signals, {
      today,
      lastCompletedWorkoutDate: lastWorkout ? fromDbDate(lastWorkout.date) : null,
      // `CoachState.createdAt` floors it: a user who just turned the coach on is not inactive.
      lastActivityAt: latestOf(lastEngagementAt, state.createdAt),
      lastProgressPhotoDate: photo.lastLocalDate,
      safetyStop: isSafetyStop(program, lastRun, now),
    });
    if (workoutDate) planningSignals.event = workoutEventOf(signals, workoutDate);

    const planningState: CoachPlanningState = {
      lastNudgeAt: state.lastNudgeAt,
      nudgesToday: newDay ? 0 : state.nudgesToday,
      nudgeDayLocal: today,
      consecutiveIgnored,
      pausedUntil: state.pausedUntil,
      silencedAt,
      usualWorkoutMinuteLocal: usual,
      lastWeeklyReviewWeek: state.lastWeeklyReviewWeek,
      momentsSentToday: coachMessages
        .filter((m) => m.moment && localDateOf(m.createdAt, zone) === today)
        .map((m) => m.moment as string)
        .filter(isCoachMoment),
    };
    const user = coachUserSettingsOf(ctx.settingsValue);
    const settings: CoachPlanningSettings = {
      aiEnabled: ctx.aiEnabled,
      system: ctx.system,
      user,
      eventEnabled: coachEventEnabled(ctx.settingsValue, ctx.notificationPolicy),
    };

    const plan = planCoachMoments(planningSignals, planningState, settings, clock);
    const suppressed = suppressedOf(plan);
    for (const moment of suppressed) this.metrics.suppressed(moment.suppressedBy!, moment.moment);

    // ---- enqueue ------------------------------------------------------------
    let queued: CoachMoment | null = null;
    const top = topNudge(plan);
    if (top) {
      const ranked = plan.filter((m) => m.lane === 'nudge' && m.suppressedBy === null);
      const outcome = await this.enqueuer.enqueueNudge(userId, top, ranked, today, ctx.trigger);
      if (outcome.status === 'enqueued') {
        queued = top.moment;
        if (silencesCoach(top.moment)) silencedAt = now;
      }
    }

    let weeklyReviewQueued = false;
    const review: PlannedMoment | null = weeklyReviewOf(plan);
    if (review?.isoWeek) {
      weeklyReviewQueued = (await this.enqueuer.enqueueWeeklyReview(userId, review.isoWeek)).status === 'enqueued';
    }

    // ---- persist ------------------------------------------------------------
    const data: Prisma.CoachStateUpdateInput = {
      consecutiveIgnored,
      silencedAt,
      usualWorkoutMinuteLocal: usual,
    };
    if (newDay) {
      data.nudgesToday = 0;
      data.nudgeDayLocal = toDbDate(today);
    }
    if (ctx.trigger === 'sweep') data.lastSweepAt = now;
    await this.prisma.coachState.update({ where: { userId }, data });

    this.logger.debug(
      `Coach planned user ${userId} (${ctx.trigger}): queued ${queued ?? 'none'}, ` +
        `review ${weeklyReviewQueued ? 'queued' : 'none'}, ${suppressed.length} suppressed`,
    );
    return { queued, weeklyReviewQueued, suppressed: suppressed.length };
  }

  /** The local day of the caller's completed workout; null when it is not theirs or not completed. */
  private async finishedWorkoutDate(userId: string, workoutId: string | undefined): Promise<string | null> {
    if (!workoutId) return null;
    const workout = await this.prisma.workout.findFirst({
      where: { id: workoutId, userId, status: 'completed' },
      select: { date: true },
    });
    return workout ? fromDbDate(workout.date) : null;
  }
}

/** The stored `coach` namespace with defaults; a malformed one is treated as absent (coach off). */
export function coachUserSettingsOf(settingsValue: unknown): ResolvedCoachUserSettings {
  const raw = isRecord(settingsValue) ? settingsValue.coach : undefined;
  const parsed = raw === undefined ? undefined : coachSettingsSchema.safeParse(raw);
  return resolveCoachUserSettings(parsed?.success ? parsed.data : undefined);
}

/**
 * Whether each coach event can reach the user: at least one channel survives
 * the admin policy and the user's preferences. An event this build does not
 * declare yet (E7.5 adds them) is on.
 */
export function coachEventEnabled(
  settingsValue: unknown,
  policy: NotificationPolicy = DEFAULT_NOTIFICATION_POLICY,
): Partial<Record<CoachEventKey, boolean>> {
  const preferences = readNotificationPreferences(settingsValue);
  const out: Partial<Record<CoachEventKey, boolean>> = {};
  for (const key of COACH_EVENT_KEYS) {
    const event = findEvent(key);
    out[key] = !event || resolveChannels(event, preferences, policy).length > 0;
  }
  return out;
}

function isSafetyStop(
  program: { autonomyPausedAt: Date | null; autonomyPausedReason: string | null } | null,
  lastRun: { status: string; completedAt: Date | null } | null,
  now: Date,
): boolean {
  if (program?.autonomyPausedAt && program.autonomyPausedReason && SAFETY_PAUSE_REASONS.has(program.autonomyPausedReason)) {
    return true;
  }
  return (
    lastRun?.status === 'blocked_safety' &&
    lastRun.completedAt !== null &&
    now.getTime() - lastRun.completedAt.getTime() < SAFETY_STOP_WINDOW_DAYS * DAY_MS
  );
}

const MOMENT_SET: ReadonlySet<string> = new Set(COACH_MOMENTS);

function isCoachMoment(value: string): value is CoachMoment {
  return MOMENT_SET.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
