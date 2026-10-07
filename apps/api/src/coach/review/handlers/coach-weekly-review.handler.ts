// =============================================================================
// `ai.coach.weekly_review`: one user's weekly review (E7.10, #250)
// =============================================================================
//
// docs/specs/ai-coach.md §2.10 and §2.11. Enqueued by the planner
// (`CoachMomentEnqueuer.enqueueWeeklyReview`, E7.4) at local Sunday 18:00 or
// the first sweep after, until Monday 18:00. Payload `{ userId, isoWeek }`,
// subject (`user`, userId).
//
// SERVER-ONLY, PERMANENTLY. No `nodeResultSchema`/`persistNodeResult`: the
// prose is written with the user's own provider key (or the org key), and no
// AI key may ever reach a worker node (CLAUDE.md AI rule 3).
//
// PROFILE `{ maxRuntimeMs: 3 min, maxAttempts: 2 }`: one model call, or two
// when the in-app register is profane (the email is always clean, AC 6a).
//
// STEPS
//   1. Cheap re-checks: AI on, system and user coach on, account active, not
//      paused; the week has ended locally (Sunday) and is not stale.
//   2. Idempotency per ISO week: a `weekly_review` message for `isoWeek`
//      already persisted is only re-delivered (never regenerated);
//      `CoachState.lastWeeklyReviewWeek === isoWeek` ends the job.
//   3. Deterministic stats (`weekly-review-stats.ts`) from
//      `TrainingSignalsService.forUser` over exactly the ISO week (the numbers
//      `GET /api/training/signals?from=<Mon>&to=<Sun>` answers), the next
//      week's sessions, check-in days, the photo count (counts only, from
//      `ProgressPhotoSummaryService`) and the active activity goals as of the
//      week's Sunday (F9, `GoalProgressService`; a failed read is logged and
//      the review goes out without goals).
//   4. The weekly streak (`updateWeeklyStreak`): target = planned sessions
//      due in the week; a protected week (safety stop, pain pattern, a pause
//      reaching into the week) or a week with no plan never breaks it.
//   5. Prose from `coach.decision` (`respondStructured`), in persona, guarded
//      (`guardWeeklyReviewProse`: the `invented_number` rule against the
//      stats block). A guard rejection, a model that is not runnable or an AI
//      failure after the last attempt falls back to the static persona
//      review (`provider = 'static'`): the weekly cadence never skips. A
//      provider throttle defers the job.
//   6. ONE transaction: advance `CoachState` (streak, passes and
//      `lastWeeklyReviewWeek`, guarded so a second run cannot double-count)
//      and create the `weekly_review` message. Then, OUTSIDE it, enqueue
//      `coach.message.deliver` (which raises `coach.weekly_review`: email +
//      browser + push, outside the daily cap).
//
// ⚠ PRIVACY: no prompt, stats or prose in any log line, span or metric; ids,
// the ISO week, enums and rule names only.
// =============================================================================

import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import { Prisma, type Job } from '@prisma/client';
import { z } from 'zod';

import { GoalProgressService } from '../../../activity/goal-progress.service';
import { AiFeatureModelResolver } from '../../../ai/assignments/ai-feature-model-resolver.service';
import { RUNNABLE_FEATURE_STATES } from '../../../ai/assignments/dto/ai-feature-resolution.dto';
import { AiConfigService } from '../../../ai/config/ai-config.service';
import { AiError } from '../../../ai/core/ai-error';
import { AI_RUN_TERMINAL_CODES } from '../../../ai/runtime/ai-response-run.handler';
import { AiService } from '../../../ai/runtime/ai.service';
import { CheckInsService } from '../../../check-ins/check-ins.service';
import { addDays, fromDbDate, localDateInZone, toDbDate } from '../../../check-ins/local-date';
import { EvoPathMetricsService, fallbackEvoPathMetrics } from '../../../app-metrics/domain-metrics.service';
import { resolveServiceName } from '../../../common/otel/telemetry-identity';
import type { JobExecutionProfile } from '../../../jobs/job-execution-profile';
import type { JobHandler } from '../../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../../jobs/job-handler.registry';
import { JobsService } from '../../../jobs/jobs.service';
import { MemoryContextService } from '../../../memory/memory-context.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { TrainingSignalsService } from '../../../programs/signals/signals.service';
import { daysFrom } from '../../../programs/today/resolve-today';
import { ProgressPhotoSummaryService } from '../../../progress-photos/progress-photo-summary.service';
import { SystemSettingsService } from '../../../settings/system-settings/system-settings.service';
import {
  AI_COACH_WEEKLY_REVIEW_JOB_TYPE,
  COACH_MESSAGE_DELIVER_JOB_TYPE,
  COACH_MESSAGE_SUBJECT_TYPE,
} from '../../coach-job-types';
import { CoachContentGuard } from '../../guard/coach-content-guard.service';
import type { CoachGuardContext, CoachGuardResult } from '../../guard/coach-content-guard';
import { COACH_DECISION_FEATURE_ID, STATIC_PROVIDER } from '../../nudges/handlers/coach-nudge.handler';
import { FALLBACK_TITLES } from '../../nudges/static-fallback';
import { coachUserSettingsOf, isSafetyStop } from '../../planning/coach-planner.service';
import { LOW_READINESS_STREAK_MIN_DAYS, PAIN_STREAK_MIN_SESSIONS } from '../../planning/coach-signals';
import { coachNow } from '../../planning/coach-time';
import { COACH_INTENSITIES, type Intensity } from '../../personas';
import {
  renderPersonaStyle,
  resolveRegister,
  type CoachRegister,
  type RenderedPersonaStyle,
} from '../../personas/resolve-register';
import {
  CoachReviewMetrics,
  type WeeklyReviewFallbackReason,
  type WeeklyReviewSkipReason,
} from '../coach-review.metrics';
import {
  guardWeeklyReviewProse,
  WEEKLY_REVIEW_DATA_VERSION,
  type WeeklyReviewMessageData,
} from '../weekly-review-data';
import { staticWeeklyReview } from '../weekly-review-fallback';
import { weeklyReviewInstructions, weeklyReviewPromptData, weeklyReviewUserText } from '../weekly-review-prompt';
import {
  COACH_WEEKLY_REVIEW_SCHEMA_NAME,
  coachWeeklyReviewSchema,
  WEEKLY_REVIEW_MAX_WINS,
  type CoachWeeklyReviewProse,
} from '../weekly-review-schema';
import {
  buildWeeklyReviewGoals,
  buildWeeklyReviewStats,
  isoWeekMonday,
  weeklyReviewAllowedNumbers,
  type WeeklyReviewGoal,
  type WeeklyReviewStats,
} from '../weekly-review-stats';
import { stripMarkdown } from '../../text/strip-markdown';
import { updateWeeklyStreak } from '../weekly-streak';

/** Each model call's own deadline; two fit inside the job's three minutes. */
const CALL_DEADLINE_MS = 70_000;
/** Output tokens one answer may use. */
export const COACH_WEEKLY_REVIEW_MAX_OUTPUT_TOKENS = 1_500;
/** A review job this many days after the week's Sunday is stale (the planner's window is one day). */
export const WEEKLY_REVIEW_STALE_AFTER_DAYS = 7;
/** Check-in days read (covers the reviewed week from any day up to the stale limit). */
const CHECK_IN_LOOKBACK_DAYS = 14;
const SAFETY_STOP_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKLY_REVIEW_KIND = 'weekly_review';

export const coachWeeklyReviewPayloadSchema = z
  .object({
    userId: z.uuid(),
    isoWeek: z.string().regex(/^\d{4}-W\d{2}$/),
  })
  .passthrough();

export type CoachWeeklyReviewPayload = z.infer<typeof coachWeeklyReviewPayloadSchema>;

export type CoachWeeklyReviewOutcome =
  | { status: 'persisted'; messageId: string; source: 'model' | 'static' }
  | { status: 'redelivered'; messageId: string }
  | { status: 'skipped'; reason: WeeklyReviewSkipReason };

/** The clean register the email is always written in (spec §2.10). */
const CLEAN_REGISTER: CoachRegister = { profane: false, reason: 'toggle_off' };

/** Thrown inside the write transaction when another run already recorded this week. */
class AlreadyReviewedError extends Error {}

interface ModelRef {
  provider: string;
  modelId: string;
}

interface ProseResult {
  prose: CoachWeeklyReviewProse;
  fallback: WeeklyReviewFallbackReason | null;
}

@Injectable()
export class CoachWeeklyReviewHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(CoachWeeklyReviewHandler.name);

  readonly type = AI_COACH_WEEKLY_REVIEW_JOB_TYPE;

  readonly profile: JobExecutionProfile = { maxRuntimeMs: 180_000, maxAttempts: 2 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly features: AiFeatureModelResolver,
    private readonly aiConfig: AiConfigService,
    private readonly systemSettings: SystemSettingsService,
    private readonly signals: TrainingSignalsService,
    private readonly checkIns: CheckInsService,
    private readonly photos: ProgressPhotoSummaryService,
    private readonly guard: CoachContentGuard,
    private readonly jobs: JobsService,
    private readonly metrics: CoachReviewMetrics,
    @Optional() private readonly appMetrics: EvoPathMetricsService = fallbackEvoPathMetrics(),
    // Optional so a fork without activity goals (or a test) reviews without them.
    @Optional() private readonly goals?: GoalProgressService,
    // User memory (#325): the memory block in the prose prompt. Optional: absent, none is sent.
    @Optional() private readonly memoryContext?: MemoryContextService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const parsed = coachWeeklyReviewPayloadSchema.safeParse(job.payload ?? {});
    if (!parsed.success) {
      this.metrics.skipped('invalid_payload');
      this.logger.warn(`Coach weekly review job ${job.id} carries no valid payload; nothing to do`);
      return;
    }
    const lastAttempt = (job.attempts ?? 1) >= this.profile.maxAttempts;
    await this.run(job.id, parsed.data, new Date(), lastAttempt);
  }

  /** One review, as of `now`. Throws on a retryable failure unless `lastAttempt`. */
  async run(
    jobId: string,
    payload: CoachWeeklyReviewPayload,
    now: Date,
    lastAttempt = false,
  ): Promise<CoachWeeklyReviewOutcome> {
    const tracer = trace.getTracer(resolveServiceName());
    return tracer.startActiveSpan('coach.weekly_review.generate', async (span) => {
      span.setAttribute('coach.iso_week', payload.isoWeek);
      try {
        const outcome = await this.review(jobId, payload, now, lastAttempt, span);
        span.setAttribute('coach.outcome', outcome.status === 'skipped' ? `skipped:${outcome.reason}` : outcome.status);
        return outcome;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  private skip(reason: WeeklyReviewSkipReason, payload: CoachWeeklyReviewPayload, jobId: string): CoachWeeklyReviewOutcome {
    this.metrics.skipped(reason);
    this.logger.log(`Coach weekly review job ${jobId} (${payload.isoWeek}) for user ${payload.userId}: skipped (${reason})`);
    return { status: 'skipped', reason };
  }

  private async review(
    jobId: string,
    payload: CoachWeeklyReviewPayload,
    now: Date,
    lastAttempt: boolean,
    span: Span,
  ): Promise<CoachWeeklyReviewOutcome> {
    const { userId, isoWeek } = payload;

    // ---- 1. cheap re-checks -------------------------------------------------
    const weekStart = isoWeekMonday(isoWeek);
    if (!weekStart) return this.skip('invalid_week', payload, jobId);
    const weekEnd = addDays(weekStart, 6);

    const [aiEnabled, system] = await Promise.all([this.aiConfig.isEnabled(), this.systemSettings.getCoachPolicy()]);
    if (!aiEnabled || !system.enabled) return this.skip('coach_off', payload, jobId);

    const row = await this.prisma.userSettings.findUnique({
      where: { userId },
      select: {
        value: true,
        user: { select: { isActive: true, healthProfile: { select: { timeZone: true, dateOfBirth: true } } } },
      },
    });
    const settings = coachUserSettingsOf(row?.value ?? null);
    if (!row || !row.user.isActive || !settings.enabled) return this.skip('coach_off', payload, jobId);

    const state = await this.prisma.coachState.findUnique({
      where: { userId },
      select: { pausedUntil: true, weeklyStreak: true, streakPassesLeft: true, lastWeeklyReviewWeek: true },
    });
    if (state?.pausedUntil && state.pausedUntil.getTime() > now.getTime()) return this.skip('paused', payload, jobId);

    const timeZone = row.user.healthProfile?.timeZone ?? null;
    const today = coachNow(now, timeZone).date;
    // The current week is never reviewed until its Sunday (spec §2.11, partial weeks).
    if (today < weekEnd) return this.skip('not_due', payload, jobId);
    if (daysFrom(weekEnd, today) > WEEKLY_REVIEW_STALE_AFTER_DAYS) return this.skip('stale', payload, jobId);

    // ---- 2. idempotency per ISO week ------------------------------------------
    const existing = await this.prisma.coachMessage.findFirst({
      where: { userId, role: 'coach', kind: WEEKLY_REVIEW_KIND, data: { path: ['isoWeek'], equals: isoWeek } },
      select: { id: true, deliveredAt: true },
    });
    if (existing) {
      if (existing.deliveredAt) return this.skip('already_sent', payload, jobId);
      await this.enqueueDelivery(existing.id);
      return { status: 'redelivered', messageId: existing.id };
    }
    if (state?.lastWeeklyReviewWeek === isoWeek) return this.skip('already_sent', payload, jobId);

    // ---- 3. deterministic stats -------------------------------------------------
    const [week, nextWeek, checkIns, photosAdded, everCompleted, program, lastRun, goals] = await Promise.all([
      this.signals.forUser(userId, { from: weekStart, to: weekEnd }, now),
      this.signals.forUser(userId, { from: addDays(weekStart, 7), to: addDays(weekStart, 13) }, now),
      this.checkIns.list(userId, CHECK_IN_LOOKBACK_DAYS),
      this.photos.countInRange(userId, weekStart, weekEnd),
      this.prisma.workout.findFirst({
        where: { userId, status: 'completed', date: { lte: toDbDate(weekEnd) } },
        select: { id: true },
      }),
      this.prisma.program.findFirst({
        where: { userId, status: 'active' },
        select: { autonomyPausedAt: true, autonomyPausedReason: true },
      }),
      this.prisma.trainingPlanRun.findFirst({
        where: { userId, completedAt: { not: null, gte: new Date(now.getTime() - SAFETY_STOP_WINDOW_DAYS * DAY_MS) } },
        orderBy: { completedAt: 'desc' },
        select: { status: true, completedAt: true },
      }),
      this.reviewGoals(userId, weekStart, weekEnd, now),
    ]);

    const safetyStop = isSafetyStop(program, lastRun, now);
    const painStreak = week.pain.some((p) => p.consecutiveFlaggedSessions >= PAIN_STREAK_MIN_SESSIONS);
    const lowReadiness = week.readiness.lowStreak >= LOW_READINESS_STREAK_MIN_DAYS;
    const pausedInWeek = state?.pausedUntil ? localDateInZone(state.pausedUntil, timeZone) >= weekStart : false;
    const supportive = safetyStop || painStreak || lowReadiness;

    // ---- 4. the weekly streak --------------------------------------------------
    const streak = updateWeeklyStreak(
      { weeklyStreak: state?.weeklyStreak ?? 0, streakPassesLeft: state?.streakPassesLeft ?? 0 },
      {
        completed: week.adherence.totals.completed,
        target: week.adherence.totals.planned,
        protectedWeek: safetyStop || painStreak || pausedInWeek,
      },
    );

    const stats = buildWeeklyReviewStats({
      isoWeek,
      weekStart,
      week,
      nextWeek,
      checkInDates: checkIns.items.map((item) => item.date),
      photosAdded,
      streak: { weeklyStreak: streak.weeklyStreak, streakPassesLeft: streak.streakPassesLeft, change: streak.change },
      hasCompletedWorkout: everCompleted !== null,
      goals,
    });

    // ---- 5. prose --------------------------------------------------------------
    const dob = row.user.healthProfile?.dateOfBirth ?? null;
    const register = resolveRegister(settings, system, { dateOfBirth: dob ? fromDbDate(dob) : null }, now);
    const intensity = clampIntensity(settings.intensity);
    const style = renderPersonaStyle(settings.personaId, intensity, register);
    const cleanStyle = register.profane ? renderPersonaStyle(settings.personaId, intensity, CLEAN_REGISTER) : style;
    const profaneApp = register.profane && !supportive;
    span.setAttributes({ 'coach.persona': style.persona.id, 'coach.intensity': style.intensity });

    const allowedNumbers = weeklyReviewAllowedNumbers(stats);
    const baseGuard = {
      personaId: style.persona.id,
      lockScreenSafe: settings.lockScreenSafe,
      allowedNumbers,
      supportive,
    };
    const appGuard: CoachGuardContext = { ...baseGuard, intensity: style.intensity, register, surface: 'app' };
    const emailGuard: CoachGuardContext = {
      ...baseGuard,
      intensity: cleanStyle.intensity,
      register: CLEAN_REGISTER,
      surface: 'email',
    };

    const resolution = await this.features.resolve(userId, COACH_DECISION_FEATURE_ID);
    const model: ModelRef | null =
      RUNNABLE_FEATURE_STATES.includes(resolution.state) && resolution.model
        ? { provider: resolution.model.provider, modelId: resolution.model.modelId }
        : null;
    if (model) span.setAttribute('ai.model', model.modelId);
    else this.logger.log(`Coach weekly review job ${jobId}: coach.decision is not runnable (${resolution.state})`);

    const app = await this.prose(jobId, userId, model, style, 'app', stats, supportive, appGuard, lastAttempt);
    let email: ProseResult;
    if (profaneApp) {
      // AC 6a: a second structured call at the clean register for the email.
      email = await this.prose(jobId, userId, model, cleanStyle, 'email', stats, supportive, emailGuard, lastAttempt);
    } else {
      const check = guardWeeklyReviewProse(app.prose, emailGuard);
      email = check.ok ? app : { prose: staticWeeklyReview(cleanStyle, stats, supportive), fallback: 'guard_rejected' };
    }
    for (const reason of new Set([app.fallback, email.fallback])) if (reason) this.metrics.fallback(reason);

    // ---- push teaser: lock-screen-safe, never stats ---------------------------------
    const pushTitle = FALLBACK_TITLES.weekly_review;
    const teaser = `${style.persona.name} has your weekly review.`;
    // Plain text on a lock screen: the headline's markdown is stripped (#343).
    let pushBody = settings.lockScreenSafe ? teaser : truncate(stripMarkdown(email.prose.headline), 140);
    if (!this.guard.check({ pushTitle, pushBody }, { ...emailGuard, register: CLEAN_REGISTER }, []).ok) pushBody = teaser;

    // ---- 6. persist (one transaction), then deliver ------------------------------------
    const source: 'model' | 'static' = app.fallback === null ? 'model' : 'static';
    const data: WeeklyReviewMessageData = {
      version: WEEKLY_REVIEW_DATA_VERSION,
      isoWeek,
      stats,
      prose: app.prose,
      emailProse: email.prose,
      register: supportive ? 'supportive' : profaneApp ? 'profane' : 'clean',
      fallback: { app: app.fallback !== null, email: email.fallback !== null },
    };

    await this.prisma.coachState.upsert({ where: { userId }, create: { userId }, update: {} });
    let messageId: string;
    try {
      messageId = await this.prisma.$transaction(async (tx) => {
        const advanced = await tx.coachState.updateMany({
          where: { userId, OR: [{ lastWeeklyReviewWeek: null }, { lastWeeklyReviewWeek: { not: isoWeek } }] },
          data: {
            weeklyStreak: streak.weeklyStreak,
            streakPassesLeft: streak.streakPassesLeft,
            lastWeeklyReviewWeek: isoWeek,
          },
        });
        if (advanced.count === 0) throw new AlreadyReviewedError();

        const message = await tx.coachMessage.create({
          data: {
            userId,
            role: 'coach',
            kind: WEEKLY_REVIEW_KIND,
            moment: 'weekly_review',
            angle: null,
            personaId: style.persona.id,
            intensity: style.intensity,
            title: stripMarkdown(app.prose.headline),
            body: app.prose.intro,
            pushTitle,
            pushBody,
            audioStatus: 'none',
            aiRunId: null,
            provider: source === 'static' ? STATIC_PROVIDER : model!.provider,
            model: source === 'static' ? null : model!.modelId,
            data: data as unknown as Prisma.InputJsonObject,
          },
          select: { id: true },
        });
        return message.id;
      });
    } catch (error) {
      if (error instanceof AlreadyReviewedError) return this.skip('already_sent', payload, jobId);
      throw error;
    }

    this.metrics.streak(streak.change, streak.weeklyStreak);
    this.metrics.sent(source);
    await this.enqueueDelivery(messageId);
    this.logger.log(
      `Coach weekly review job ${jobId}: message ${messageId} (${isoWeek}, ${source}, streak ${streak.change}) queued for delivery`,
    );
    return { status: 'persisted', messageId, source };
  }

  /**
   * One surface's prose: the model's guarded answer, or the static review. A
   * provider throttle is rethrown (the queue defers); any other non-terminal
   * error is rethrown unless this is the last attempt.
   */
  private async prose(
    jobId: string,
    userId: string,
    model: ModelRef | null,
    style: RenderedPersonaStyle,
    surface: 'app' | 'email',
    stats: WeeklyReviewStats,
    supportive: boolean,
    guardContext: CoachGuardContext,
    lastAttempt: boolean,
  ): Promise<ProseResult> {
    const fallback = (reason: WeeklyReviewFallbackReason): ProseResult => ({
      prose: this.safeStatic(style, stats, supportive, guardContext),
      fallback: reason,
    });
    if (!model) return fallback('no_model');

    let answer: CoachWeeklyReviewProse;
    try {
      answer = await this.call(userId, jobId, model, style, surface, stats, supportive);
    } catch (err) {
      const aiError = err instanceof AiError ? err : null;
      const rateLimit = aiError?.toRateLimitError();
      if (rateLimit) throw rateLimit;
      if (aiError && AI_RUN_TERMINAL_CODES.has(aiError.code)) {
        this.logger.log(`Coach weekly review job ${jobId} (${surface}) ended with ${aiError.code}; static review used`);
        return fallback('ai_error');
      }
      if (!lastAttempt) throw err;
      this.logger.warn(`Coach weekly review job ${jobId} (${surface}): AI failed on the last attempt; static review used`);
      return fallback('ai_error');
    }

    const check: CoachGuardResult = this.countedGuard(answer, guardContext);
    if (check.ok) return { prose: answer, fallback: null };
    this.logger.warn(
      `Coach weekly review job ${jobId} (${surface}): rejected by the guard (${check.reasons.join(', ')}); static review used`,
    );
    return fallback('guard_rejected');
  }

  private async call(
    userId: string,
    jobId: string,
    model: ModelRef,
    style: RenderedPersonaStyle,
    surface: 'app' | 'email',
    stats: WeeklyReviewStats,
    supportive: boolean,
  ): Promise<CoachWeeklyReviewProse> {
    const memoryBlock = this.memoryContext ? await this.memoryContext.buildBlock(userId, { audience: 'coach' }) : '';
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new Error('Coach weekly review timed out')), CALL_DEADLINE_MS);
    deadline.unref?.();
    try {
      const response = await this.ai.forUser(userId, { jobId }).respondStructured(
        {
          provider: model.provider,
          model: model.modelId,
          schema: coachWeeklyReviewSchema,
          schemaName: COACH_WEEKLY_REVIEW_SCHEMA_NAME,
          strict: true,
          instructions: weeklyReviewInstructions({ style, supportive, surface }),
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'text', text: weeklyReviewUserText(weeklyReviewPromptData(stats, supportive), memoryBlock) }],
            },
          ],
          maxOutputTokens: COACH_WEEKLY_REVIEW_MAX_OUTPUT_TOKENS,
          metadata: { feature: COACH_DECISION_FEATURE_ID },
        },
        { signal: controller.signal },
      );
      const parsed = response.parsed;
      return {
        headline: parsed.headline.trim(),
        intro: parsed.intro.trim(),
        wins: parsed.wins.map((w) => w.trim()).filter((w) => w.length > 0).slice(0, WEEKLY_REVIEW_MAX_WINS),
        focus: parsed.focus.trim(),
        nextWeekPlanPrompt: parsed.nextWeekPlanPrompt.trim(),
      };
    } finally {
      clearTimeout(deadline);
    }
  }

  /** The guard with its counter (`app.coach.guard.rejected{reason}`), once per distinct rule. */
  private countedGuard(prose: CoachWeeklyReviewProse, ctx: CoachGuardContext): CoachGuardResult {
    const result = guardWeeklyReviewProse(prose, ctx);
    for (const reason of result.reasons) this.appMetrics.coachGuardRejection(reason);
    return result;
  }

  /** The static review; should the persona's line ever fail the guard, the clean default coach review. */
  private safeStatic(
    style: RenderedPersonaStyle,
    stats: WeeklyReviewStats,
    supportive: boolean,
    ctx: CoachGuardContext,
  ): CoachWeeklyReviewProse {
    const prose = staticWeeklyReview(style, stats, supportive);
    if (guardWeeklyReviewProse(prose, ctx).ok) return prose;
    this.logger.warn('Coach weekly review: the static persona review failed the guard; the default coach line is used');
    return staticWeeklyReview(renderPersonaStyle('coach', 2, CLEAN_REGISTER), stats, supportive);
  }

  /** The week's activity goals (F9); [] without goals or when the read fails (never blocks the review). */
  private async reviewGoals(userId: string, weekStart: string, weekEnd: string, now: Date): Promise<WeeklyReviewGoal[]> {
    if (!this.goals) return [];
    try {
      const progress = await this.goals.progressForUser(userId, weekEnd, now);
      const dayHits = new Map<string, number>();
      for (const p of progress.filter((g) => g.goal.period === 'day')) {
        const history = await this.goals.historyForGoal(userId, p.goalId, 7, weekEnd, now);
        dayHits.set(p.goalId, history.filter((h) => h.periodStart >= weekStart && h.hit).length);
      }
      return buildWeeklyReviewGoals(progress, dayHits);
    } catch (error) {
      this.logger.warn(`Coach weekly review: goal progress unavailable for user ${userId} (${error instanceof Error ? error.name : 'error'})`);
      return [];
    }
  }

  private async enqueueDelivery(messageId: string): Promise<void> {
    await this.jobs.enqueue({
      type: COACH_MESSAGE_DELIVER_JOB_TYPE,
      reason: 'backfill',
      subjectType: COACH_MESSAGE_SUBJECT_TYPE,
      subjectId: messageId,
      payload: { messageId },
    });
  }
}

function clampIntensity(value: number): Intensity {
  const level = Math.round(value);
  return (COACH_INTENSITIES as readonly number[]).includes(level) ? (level as Intensity) : 2;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

