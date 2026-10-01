// =============================================================================
// `ai.coach.nudge`: generate, guard and persist one coach message (E7.5, #245)
// =============================================================================
//
// docs/specs/ai-coach.md §2.6. Enqueued by `CoachMomentEnqueuer` (E7.4) for a
// moment that passed every hard gate; payload `{ userId, moment, momentKey,
// candidates, trigger }`, subject (`user`, userId).
//
// SERVER-ONLY, PERMANENTLY. No `nodeResultSchema`/`persistNodeResult`: the
// call is made with the user's own provider key (or the org key), and no AI
// key may ever reach a worker node (CLAUDE.md AI rule 3).
//
// PROFILE `{ maxRuntimeMs: 2 min, maxAttempts: 2 }`: at most two model calls
// per attempt (the answer and one regeneration). A provider throttle DEFERS
// the job; a terminal AI condition (kill switch, no key, ...) ends it without
// a message; any other error is retried once and then fails, leaving no
// message and no notification (the next sweep plans again).
//
// STEPS
//   1. Cheap re-checks: AI on, system and user coach on, account active, not
//      paused. (Not `silencedAt`: the back-off and win-back messages are sent
//      AFTER the planner set it.) A message already persisted for this
//      `momentKey` (a retry after the write) is only re-delivered.
//   2. `coach.decision` through `AiFeatureModelResolver`; refused unless
//      `ready`/`auto`.
//   3. Context (`nudge-context.ts`): signals, `CoachState`, the last 10 coach
//      titles, the persona card at the rendered intensity under
//      `resolveRegister`, the angle (`AnglePicker` seam, E7.11) and the
//      user's `why`, delimited as data.
//   4. `respondStructured` (strict). `send: false` -> nothing persisted,
//      `app.coach.nudge.suppressed{reason=model_declined}`.
//   5. The content guard; one regeneration naming the failed rules; then the
//      static persona line (`provider = 'static'`).
//   6. Persist the `CoachMessage`, then enqueue `coach.message.deliver`.
//   7. AUDIO (E7.6, spec §2.7). When the user's `audio.enabled`, the system
//      `allowAudio` AND `coach.voice` resolves, the message is written
//      `audioStatus = 'pending'` and `CoachAudioService.start` calls
//      `speak()` (voice: the user's, else the persona's for the rendered
//      level; the user's speed; persona TTS instructions plus the message's
//      `audioInstructions`; input `audioScript`, else the body). Delivery is
//      then NOT enqueued here: `coach.audio.settle` enqueues it when the
//      speech job settles or the 2-minute wait cap elapses. Audio wanted but
//      `coach.voice` unresolved: written `failed` with
//      `data.audioFailure.reason = 'no_voice_model'` and delivered as text.
//      A `speak()` that throws: `failed`, delivered as text. Audio off: text
//      only, `audioStatus = 'none'`, `speak()` never called.
//
// KICKOFF (E7.12). Enqueued by `CoachKickoffListener` on program activation,
// subject (`program`, programId), `momentKey` `kickoff:<programId>`. It skips
// the plain `paused` suppression and runs `kickoffGate` after the momentKey
// check instead: coach off -> nothing; pause, quiet hours, cap and spacing
// re-queue the job for the next allowed instant (`scheduledFor`, at most
// `KICKOFF_MAX_DEFERRALS` times) rather than dropping it. The prompt asks the
// three implementation-intention questions (when, where, fallback). A
// kickoff is never lost to the model: no runnable model, a model error, a
// decline or two guard rejections all deliver the static persona kickoff line.
//
// ⚠ PRIVACY: no prompt, `why`, title, body or reason text in any log line,
// span or metric; ids, enums and rule names only.
// =============================================================================

import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import { Prisma, type Job } from '@prisma/client';
import { z } from 'zod';

import { AiFeatureModelResolver } from '../../../ai/assignments/ai-feature-model-resolver.service';
import { RUNNABLE_FEATURE_STATES } from '../../../ai/assignments/dto/ai-feature-resolution.dto';
import { AiConfigService } from '../../../ai/config/ai-config.service';
import { AiError } from '../../../ai/core/ai-error';
import { AI_RUN_TERMINAL_CODES } from '../../../ai/runtime/ai-response-run.handler';
import { AiService } from '../../../ai/runtime/ai.service';
import { addDays, fromDbDate } from '../../../check-ins/local-date';
import {
  AppMetricsService,
  fallbackAppMetrics,
  type CoachNudgeSuppressionReason,
} from '../../../common/otel/app-metrics.service';
import { resolveServiceName } from '../../../common/otel/service-name';
import type { JobExecutionProfile } from '../../../jobs/job-execution-profile';
import type { JobHandler } from '../../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../../jobs/job-handler.registry';
import { JobsService } from '../../../jobs/jobs.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { TrainingSignalsService } from '../../../programs/signals/signals.service';
import { SystemSettingsService } from '../../../settings/system-settings/system-settings.service';
import { COACH_AUDIO_WAIT_CAP_MS, CoachAudioService, type CoachVoiceModel } from '../../audio/coach-audio.service';
import {
  AI_COACH_NUDGE_JOB_TYPE,
  COACH_MESSAGE_DELIVER_JOB_TYPE,
  COACH_MESSAGE_SUBJECT_TYPE,
  COACH_PROGRAM_SUBJECT_TYPE,
  COACH_USER_SUBJECT_TYPE,
} from '../../coach-job-types';
import { recordCoachKickoff } from '../../coach-kickoff.metrics';
import { CoachContentGuard } from '../../guard/coach-content-guard.service';
import type { CoachGuardContext, CoachGuardReason } from '../../guard/coach-content-guard';
import { coachUserSettingsOf, isSafetyStop } from '../../planning/coach-planner.service';
import { coachNow } from '../../planning/coach-time';
import { kickoffGate } from '../../planning/plan-coach-moments';
import { COACH_INTENSITIES, COACH_MOMENTS, type Intensity } from '../../personas';
import { renderPersonaStyle, resolveRegister, type RenderedPersonaStyle } from '../../personas/resolve-register';
import { COACH_ANGLE_PICKER, type AnglePicker, type CoachAngle } from '../angle-picker';
import { eligibleAnglesFor } from '../../learning/pick-angle';
import { kindForMoment } from '../coach-message-kinds';
import { buildNudgeContext, NUDGE_HISTORY_LIMIT, type NudgeContext } from '../nudge-context';
import { nudgeInstructions, nudgeUserText } from '../nudge-prompt';
import { COACH_NUDGE_SCHEMA_NAME, coachNudgeSchema, type CoachNudgeOutput } from '../nudge-schema';
import { staticFallbackMessage } from '../static-fallback';

export const COACH_DECISION_FEATURE_ID = 'coach.decision';

/** Each model call's own deadline; two fit inside the job's two minutes. */
const CALL_DEADLINE_MS = 50_000;
/** Output tokens one answer may use. */
export const COACH_NUDGE_MAX_OUTPUT_TOKENS = 1_500;
/** A training run that ended `blocked_safety` this recently is an active safety stop (the planner's window). */
const SAFETY_STOP_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
/** `provider` of a message written from the registry, not a model. */
export const STATIC_PROVIDER = 'static';
/** A kickoff is re-queued at most this many times before it is given up (`deferral_limit`). */
export const KICKOFF_MAX_DEFERRALS = 8;
/** The implementation-intention questions a kickoff asks (stored on the message's `data`). */
export const KICKOFF_QUESTIONS = ['when', 'where', 'fallback'] as const;

export const coachNudgePayloadSchema = z
  .object({
    userId: z.uuid(),
    moment: z.enum(COACH_MOMENTS),
    momentKey: z.string().min(1).max(80),
    candidates: z
      .array(z.object({ moment: z.string(), priority: z.number(), reason: z.string() }).passthrough())
      .optional(),
    trigger: z.string().max(40).optional(),
    /** Kickoff only: the activated program. */
    programId: z.uuid().optional(),
    /** Kickoff only: how many times this kickoff was already deferred. */
    deferrals: z.number().int().min(0).optional(),
  })
  .passthrough();

export type CoachNudgePayload = z.infer<typeof coachNudgePayloadSchema>;

/** How one job ended. */
export type CoachNudgeOutcome =
  | { status: 'persisted'; messageId: string; source: 'model' | 'static' }
  | { status: 'redelivered'; messageId: string }
  | { status: 'deferred'; until: Date; reason: string }
  | { status: 'suppressed'; reason: CoachNudgeSuppressionReason };

interface Generated {
  /** The guard-approved answer, or null after two rejections. */
  output: CoachNudgeOutput | null;
  /** `send: false` was answered. */
  declined: boolean;
  /** The model's `reason` for declining (learning metadata; never shown to the user). */
  declineReason: string | null;
  regenerations: number;
  lastReasons: CoachGuardReason[];
}

@Injectable()
export class CoachNudgeHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(CoachNudgeHandler.name);

  readonly type = AI_COACH_NUDGE_JOB_TYPE;

  readonly profile: JobExecutionProfile = { maxRuntimeMs: 120_000, maxAttempts: 2 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly features: AiFeatureModelResolver,
    private readonly aiConfig: AiConfigService,
    private readonly systemSettings: SystemSettingsService,
    private readonly signals: TrainingSignalsService,
    private readonly guard: CoachContentGuard,
    private readonly jobs: JobsService,
    private readonly audio: CoachAudioService,
    @Inject(COACH_ANGLE_PICKER) private readonly anglePicker: AnglePicker,
    @Optional() private readonly metrics: AppMetricsService = fallbackAppMetrics(),
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const parsed = coachNudgePayloadSchema.safeParse(job.payload ?? {});
    if (!parsed.success) {
      this.logger.warn(`Coach nudge job ${job.id} carries no valid payload; nothing to do`);
      return;
    }
    await this.run(job.id, parsed.data, new Date());
  }

  /** One nudge, as of `now`. Throws on a retryable failure. */
  async run(jobId: string, payload: CoachNudgePayload, now: Date): Promise<CoachNudgeOutcome> {
    const tracer = trace.getTracer(resolveServiceName());
    return tracer.startActiveSpan('coach.nudge.generate', async (span) => {
      span.setAttribute('coach.moment', payload.moment);
      try {
        const outcome = await this.generateNudge(jobId, payload, now, span);
        span.setAttribute('coach.outcome', outcome.status === 'suppressed' ? `suppressed:${outcome.reason}` : outcome.status);
        return outcome;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  private suppress(reason: CoachNudgeSuppressionReason, payload: CoachNudgePayload, jobId: string): CoachNudgeOutcome {
    this.metrics.coachNudgeSuppression(reason, payload.moment);
    this.logger.log(`Coach nudge job ${jobId} (${payload.moment}) for user ${payload.userId}: suppressed (${reason})`);
    return { status: 'suppressed', reason };
  }

  private async generateNudge(jobId: string, payload: CoachNudgePayload, now: Date, span: Span): Promise<CoachNudgeOutcome> {
    const { userId, moment } = payload;

    // ---- 1. cheap re-checks -------------------------------------------------
    const [aiEnabled, system] = await Promise.all([this.aiConfig.isEnabled(), this.systemSettings.getCoachPolicy()]);
    if (!aiEnabled || !system.enabled) return this.suppress('coach_off', payload, jobId);

    const row = await this.prisma.userSettings.findUnique({
      where: { userId },
      select: {
        value: true,
        user: { select: { isActive: true, healthProfile: { select: { timeZone: true, dateOfBirth: true } } } },
      },
    });
    const settings = coachUserSettingsOf(row?.value ?? null);
    if (!row || !row.user.isActive || !settings.enabled) return this.suppress('coach_off', payload, jobId);

    const isKickoff = moment === 'kickoff';
    const state = await this.prisma.coachState.findUnique({
      where: { userId },
      select: {
        pausedUntil: true,
        weeklyStreak: true,
        streakPassesLeft: true,
        usualWorkoutMinuteLocal: true,
        lastNudgeAt: true,
        nudgesToday: true,
        nudgeDayLocal: true,
      },
    });
    // A kickoff is deferred past a pause, not dropped (`kickoffGate` below).
    if (!isKickoff && state?.pausedUntil && state.pausedUntil.getTime() > now.getTime()) {
      return this.suppress('paused', payload, jobId);
    }

    const existing = await this.findByMomentKey(userId, payload.momentKey);
    if (existing) {
      if (existing.deliveredAt) return this.suppress('already_sent', payload, jobId);
      if (existing.audioStatus === 'pending') {
        // A retry after the write: the audio's own settle (or this wait cap)
        // delivers; never a second `speak()`.
        const capAt = new Date((existing.createdAt?.getTime() ?? now.getTime()) + COACH_AUDIO_WAIT_CAP_MS);
        await this.audio.enqueueSettle(existing.id, 'timeout', capAt.getTime() > now.getTime() ? capAt : undefined);
      } else {
        await this.enqueueDelivery(existing.id);
      }
      return { status: 'redelivered', messageId: existing.id };
    }

    const timeZone = row.user.healthProfile?.timeZone ?? null;

    if (isKickoff) {
      const decision = kickoffGate(
        {
          aiEnabled,
          system,
          user: settings,
          state: {
            pausedUntil: state?.pausedUntil ?? null,
            lastNudgeAt: state?.lastNudgeAt ?? null,
            nudgesToday: state?.nudgesToday ?? 0,
            nudgeDayLocal: state?.nudgeDayLocal ? fromDbDate(state.nudgeDayLocal) : null,
          },
        },
        coachNow(now, timeZone),
      );
      if (decision.action === 'suppress') return this.suppress(decision.reason, payload, jobId);
      if (decision.action === 'defer') return this.deferKickoff(jobId, payload, decision.until, decision.reason);
    }

    // ---- 2. the model --------------------------------------------------------
    // A kickoff without a runnable model still goes out, as the static line.
    const resolution = await this.features.resolve(userId, COACH_DECISION_FEATURE_ID);
    const runnable = RUNNABLE_FEATURE_STATES.includes(resolution.state) && Boolean(resolution.model);
    if (!runnable) {
      this.logger.log(`Coach nudge job ${jobId}: coach.decision is not runnable (${resolution.state})`);
      if (!isKickoff) return this.suppress('no_model', payload, jobId);
    }
    const model =
      runnable && resolution.model ? { provider: resolution.model.provider, modelId: resolution.model.modelId } : null;
    if (model) span.setAttribute('ai.model', model.modelId);

    // ---- 3. context -----------------------------------------------------------
    const today = coachNow(now, timeZone).date;
    const dob = row.user.healthProfile?.dateOfBirth ?? null;
    const register = resolveRegister(settings, system, { dateOfBirth: dob ? fromDbDate(dob) : null }, now);
    const style = renderPersonaStyle(settings.personaId, clampIntensity(settings.intensity), register);

    const [signals, history, program, lastRun] = await Promise.all([
      this.signals.forUser(userId, { to: addDays(today, 7) }, now),
      this.prisma.coachMessage.findMany({
        where: { userId, role: 'coach' },
        orderBy: { createdAt: 'desc' },
        take: NUDGE_HISTORY_LIMIT,
        select: { kind: true, moment: true, title: true, createdAt: true },
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
    ]);

    const context = buildNudgeContext({
      moment,
      reason: payload.candidates?.find((c) => c.moment === moment)?.reason ?? (isKickoff ? 'program_activated' : 'planned'),
      trigger: payload.trigger ?? 'sweep',
      today,
      now,
      signals,
      state: state
        ? {
            weeklyStreak: state.weeklyStreak,
            streakPassesLeft: state.streakPassesLeft,
            usualWorkoutMinuteLocal: state.usualWorkoutMinuteLocal,
          }
        : null,
      history,
      settings,
      safetyStop: isSafetyStop(program, lastRun, now),
    });

    const angleInput = {
      userId,
      moment,
      personaId: style.persona.id,
      supportive: context.supportive,
      hasWhy: Boolean(settings.why && settings.why.trim()),
    };
    const angle = await this.anglePicker.pick(angleInput);
    // The set the angle was chosen from, recorded for the learning loop's
    // "eligible but not sent" rate (E7.11, spec §2.8). Enums only.
    const eligibleAngles = eligibleAnglesFor(angleInput);
    span.setAttributes({ 'coach.persona': style.persona.id, 'coach.angle': angle ?? 'none', 'coach.intensity': style.intensity });

    const guardContext: CoachGuardContext = {
      personaId: style.persona.id,
      intensity: style.intensity,
      register,
      lockScreenSafe: settings.lockScreenSafe,
      allowedNumbers: context.allowedNumbers,
      supportive: context.supportive,
      angle,
    };

    // ---- 4 and 5. generate and guard -------------------------------------------
    let generated: Generated = { output: null, declined: false, declineReason: null, regenerations: 0, lastReasons: [] };
    let fallbackCause = 'no_model';
    if (model) {
      try {
        generated = await this.generate(userId, jobId, model, style, context, angle, settings.why, guardContext);
        fallbackCause = 'guard_rejected';
      } catch (err) {
        const aiError = err instanceof AiError ? err : null;
        const rateLimit = aiError?.toRateLimitError();
        if (rateLimit) throw rateLimit;
        if (isKickoff) {
          // A kickoff is not lost to a model failure: the static line goes out.
          fallbackCause = aiError ? aiError.code : 'model_error';
          this.logger.warn(`Coach nudge job ${jobId}: kickoff generation failed (${fallbackCause}); static line used`);
        } else if (aiError && AI_RUN_TERMINAL_CODES.has(aiError.code)) {
          this.logger.log(`Coach nudge job ${jobId} ended with ${aiError.code}`);
          return this.suppress('ai_error', payload, jobId);
        } else {
          throw err;
        }
      }
    }

    if (generated.declined && isKickoff) {
      // The kickoff is the one moment the model may not skip: the plan starts now.
      fallbackCause = 'model_declined';
      this.logger.log(`Coach nudge job ${jobId}: the model declined the kickoff; static line used`);
    } else if (generated.declined) {
      // The decision and its reason are recorded (spec §2.6); the reason is the
      // model's short learning note, one line, never shown to the user.
      span.setAttribute('coach.decline_reason_length', generated.declineReason?.length ?? 0);
      this.logger.log(`Coach nudge job ${jobId}: the model declined (reason: ${oneLine(generated.declineReason)})`);
      return this.suppress('model_declined', payload, jobId);
    }

    let source: 'model' | 'static' = 'model';
    let text = generated.output;
    if (!text) {
      const fallback = staticFallbackMessage({
        style,
        moment,
        fill: context.fill,
        lockScreenSafe: settings.lockScreenSafe,
        supportive: context.supportive,
      });
      const check = this.guard.check(fallback, guardContext);
      if (!check.ok) {
        this.logger.warn(`Coach nudge job ${jobId}: the static fallback failed the guard (${check.reasons.join(', ')})`);
        return this.suppress('guard_rejected', payload, jobId);
      }
      source = 'static';
      this.metrics.coachNudgeFallbackUsed(moment);
      this.logger.warn(
        fallbackCause === 'guard_rejected'
          ? `Coach nudge job ${jobId}: two answers rejected by the guard (${generated.lastReasons.join(', ')}); static line used`
          : `Coach nudge job ${jobId}: static line used (${fallbackCause})`,
      );
      text = { send: true, moment, reason: 'static_fallback', ...fallback };
    }

    // ---- 7a. audio: wanted, and can it be spoken? ---------------------------------
    const audioWanted = settings.audio.enabled && system.allowAudio;
    const voiceModel: CoachVoiceModel | null = audioWanted ? await this.audio.resolveVoiceModel(userId) : null;
    const audioStatus = !audioWanted ? 'none' : voiceModel ? 'pending' : 'failed';
    if (audioWanted && !voiceModel) {
      this.metrics.coachAudioFailure('no_voice_model');
      this.logger.log(`Coach nudge job ${jobId}: audio wanted but coach.voice is not runnable; text only`);
    }

    // ---- 6. persist, then deliver ------------------------------------------------
    if (isKickoff) {
      // Narrows the race between two kickoff jobs of one program (a deferred
      // one and a fresh activation's) to the instant between this read and the write.
      const raced = await this.findByMomentKey(userId, payload.momentKey);
      if (raced) return this.suppress('already_sent', payload, jobId);
    }
    const message = await this.prisma.coachMessage.create({
      data: {
        userId,
        role: 'coach',
        kind: kindForMoment(moment),
        moment,
        angle,
        personaId: style.persona.id,
        intensity: style.intensity,
        title: text.title,
        body: text.body,
        pushTitle: text.pushTitle,
        pushBody: text.pushBody,
        // E7.6: `pending` until the speech run settles (step 7); `failed` with
        // a recorded reason when audio is wanted but cannot be spoken.
        audioStatus,
        aiRunId: null,
        provider: source === 'static' || !model ? STATIC_PROVIDER : model.provider,
        model: source === 'static' || !model ? null : model.modelId,
        data: {
          momentKey: payload.momentKey,
          trigger: payload.trigger ?? 'sweep',
          register: context.supportive ? 'supportive' : register.profane ? 'profane' : 'clean',
          lowReadiness: context.lowReadiness,
          eligibleAngles,
          regenerations: generated.regenerations,
          fallback: source === 'static',
          audioInstructions: text.audioInstructions,
          audioScript: text.audioScript,
          ...(audioStatus === 'failed'
            ? { audioFailure: { reason: 'no_voice_model', code: null, at: now.toISOString() } }
            : {}),
          ...(isKickoff ? { programId: payload.programId ?? null, questions: [...KICKOFF_QUESTIONS] } : {}),
        } satisfies Prisma.InputJsonObject,
      },
      select: { id: true },
    });

    // ---- 7b. speak, or deliver now ------------------------------------------------
    if (audioStatus === 'pending' && voiceModel) {
      const started = await this.audio.start({
        userId,
        jobId,
        messageId: message.id,
        model: voiceModel,
        request: this.audio.speechRequest({
          style,
          userVoice: settings.audio.voice,
          speed: settings.audio.speed,
          audioScript: text.audioScript,
          body: text.body,
          audioInstructions: text.audioInstructions,
        }),
        now,
      });
      if (started.status === 'pending') {
        this.logger.log(
          `Coach nudge job ${jobId}: message ${message.id} (${moment}, ${source}) waits for its audio run ${started.runId}`,
        );
        return { status: 'persisted', messageId: message.id, source };
      }
    }

    await this.enqueueDelivery(message.id);
    if (isKickoff) recordCoachKickoff(source === 'static' ? 'fallback' : 'sent');
    this.logger.log(
      `Coach nudge job ${jobId}: message ${message.id} (${moment}, ${source}, ${generated.regenerations} regeneration(s)) queued for delivery`,
    );
    return { status: 'persisted', messageId: message.id, source };
  }

  /** One answer, guarded; one regeneration on a rejection. `output` is null after two rejections. */
  private async generate(
    userId: string,
    jobId: string,
    model: { provider: string; modelId: string },
    style: RenderedPersonaStyle,
    context: NudgeContext,
    angle: CoachAngle | null,
    why: string | null,
    guardContext: CoachGuardContext,
  ): Promise<Generated> {
    const result: Generated = { output: null, declined: false, declineReason: null, regenerations: 0, lastReasons: [] };
    const instructions = nudgeInstructions({
      style,
      moment: context.promptData.moment,
      angle,
      supportive: context.supportive,
      lockScreenSafe: guardContext.lockScreenSafe,
    });

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (attempt === 2) result.regenerations += 1;

      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(new Error('Coach nudge timed out')), CALL_DEADLINE_MS);
      deadline.unref?.();

      try {
        const response = await this.ai.forUser(userId, { jobId }).respondStructured(
          {
            provider: model.provider,
            model: model.modelId,
            schema: coachNudgeSchema,
            schemaName: COACH_NUDGE_SCHEMA_NAME,
            strict: true,
            instructions,
            input: [
              {
                type: 'message',
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: nudgeUserText(context.promptData, why, attempt === 2 ? result.lastReasons : undefined),
                  },
                ],
              },
            ],
            maxOutputTokens: COACH_NUDGE_MAX_OUTPUT_TOKENS,
            metadata: { feature: COACH_DECISION_FEATURE_ID },
          },
          { signal: controller.signal },
        );

        const answer = response.parsed;
        if (!answer.send) {
          result.declined = true;
          result.declineReason = answer.reason;
          return result;
        }

        const check = this.guard.check(answer, guardContext);
        if (check.ok) {
          result.output = answer;
          return result;
        }
        result.lastReasons = check.reasons;
        this.logger.warn(`Coach nudge job ${jobId}: attempt ${attempt} rejected by the guard (${check.reasons.join(', ')})`);
      } finally {
        clearTimeout(deadline);
      }
    }

    return result;
  }

  private findByMomentKey(userId: string, momentKey: string) {
    return this.prisma.coachMessage.findFirst({
      where: { userId, role: 'coach', data: { path: ['momentKey'], equals: momentKey } },
      select: { id: true, deliveredAt: true, audioStatus: true, createdAt: true },
    });
  }

  /**
   * Re-queues a kickoff for `until` (E7.12): a gate that means "not now"
   * defers it. A fresh row (`skipDedup`), because this job still holds the
   * active-dedup key; the run that picks it up re-checks every gate and the
   * momentKey. Bounded by `KICKOFF_MAX_DEFERRALS`.
   */
  private async deferKickoff(jobId: string, payload: CoachNudgePayload, until: Date, reason: string): Promise<CoachNudgeOutcome> {
    const deferrals = payload.deferrals ?? 0;
    if (deferrals >= KICKOFF_MAX_DEFERRALS) return this.suppress('deferral_limit', payload, jobId);
    await this.jobs.enqueue({
      type: AI_COACH_NUDGE_JOB_TYPE,
      reason: 'backfill',
      subjectType: payload.programId ? COACH_PROGRAM_SUBJECT_TYPE : COACH_USER_SUBJECT_TYPE,
      subjectId: payload.programId ?? payload.userId,
      payload: { ...payload, deferrals: deferrals + 1 } as Prisma.InputJsonObject,
      scheduledFor: until,
      skipDedup: true,
    });
    recordCoachKickoff('deferred');
    this.logger.log(`Coach nudge job ${jobId}: kickoff for user ${payload.userId} deferred (${reason}) until ${until.toISOString()}`);
    return { status: 'deferred', until, reason };
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

function oneLine(text: string | null): string {
  return JSON.stringify((text ?? '').replace(/\s+/g, ' ').slice(0, 200));
}

function clampIntensity(value: number): Intensity {
  const level = Math.round(value);
  return (COACH_INTENSITIES as readonly number[]).includes(level) ? (level as Intensity) : 2;
}

