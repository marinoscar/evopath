import { BadRequestException, ConflictException, Injectable, Logger, Optional } from '@nestjs/common';
import { SpanStatusCode, trace, type Span } from '@opentelemetry/api';

import { GoalProgressService } from '../../activity/goal-progress.service';
import { AiFeatureModelResolver } from '../../ai/assignments/ai-feature-model-resolver.service';
import { RUNNABLE_FEATURE_STATES } from '../../ai/assignments/dto/ai-feature-resolution.dto';
import { AiError } from '../../ai/core/ai-error';
import { toErrorEvent } from '../../ai/http/ai-sse';
import type { AiToolCallStatus, AiToolLoopResult, AiToolStep } from '../../ai/runtime/ai-runtime.types';
import { AiService } from '../../ai/runtime/ai.service';
import { CheckInsService } from '../../check-ins/check-ins.service';
import { resolveCoachUserSettings } from '../../common/schemas/user-settings-namespaces.schema';
import { AppMetricsService, fallbackAppMetrics } from '../../common/otel/app-metrics.service';
import { resolveServiceName } from '../../common/otel/service-name';
import { HealthProfileService } from '../../health-profile/health-profile.service';
import { MemoryExtractionScheduler } from '../../memory/extraction/memory-extraction.scheduler';
import { MemoryContextService, type MemoryChatContext } from '../../memory/memory-context.service';
import { MemoryService } from '../../memory/memory.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TrainingSignalsService } from '../../programs/signals/signals.service';
import { TrainingTodayService } from '../../programs/today/training-today.service';
import { ProgressPhotoSummaryService } from '../../progress-photos/progress-photo-summary.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { UserSettingsService } from '../../settings/user-settings/user-settings.service';
import { coachDisabledError } from '../coach-errors';
import { CoachSettingsService } from '../coach-settings.service';
import { guardCoachText, extractNumbers, type CoachGuardReason } from '../guard/coach-content-guard';
import type { Intensity } from '../personas';
import { renderPersonaStyle, resolveRegister, type RenderedPersonaStyle } from '../personas/resolve-register';
import { COACH_PAUSE_MAX_DAYS, COACH_PAUSE_MIN_DAYS } from './coach-chat-errors';
import {
  COACH_ADJUST_LABEL,
  COACH_ADJUST_PATH,
  COACH_CHAT_BLOCKED_SAFETY_TAGS,
  COACH_CHAT_HISTORY_LIMIT,
  COACH_CHAT_REPLY_MAX_CHARS,
  COACH_CHAT_SAFETY_LOOKBACK_MS,
  buildCoachChatInput,
  buildCoachChatInstructions,
  excludeBlockedSafetyTurns,
  type CoachChatSupportiveReason,
} from './coach-chat-prompt';
import { blockedReplyFor, screenCoachChat, type CoachChatSafety, type CoachChatSafetyScreen } from './coach-chat-safety';
import { CoachChatMetrics, type CoachChatTurnOutcome } from './coach-chat.metrics';
import {
  createCoachChatTools,
  type CoachChatMemoryEvent,
  type CoachChatToolDeps,
  type CoachChatTurnActions,
} from './tools';

// =============================================================================
// CoachChatService: one chat turn (E7.7, #247; docs/specs/ai-coach.md §2.9)
// =============================================================================
//
// `startTurn` runs the PRECONDITIONS eagerly and throws (an ordinary JSON
// error, nothing persisted, no provider call) when one fails:
//
//   system `coach.enabled` off               403 COACH_DISABLED
//   `coach.chat` has no runnable model       409 AI_FEATURE_UNAVAILABLE
//
// (AI off is `AiEnabledGuard`'s 403 before this runs; a 2,001-character text
// is the Zod 400.) It then answers an async iterable of `CoachChatEvent`s:
//
//   SAFETY (blocked or distress): no model call, no feature resolution. The
//   user's message and the fixed supportive reply are persisted; frames:
//   `safety`, `delta`..., `done`. The persona is dropped (`personaId: null`).
//
//   MODEL: `AiService.forUser(userId).runTools` with the `coach.chat` model,
//   the persona instructions (supportive register on a `conservative`
//   outcome), the last 20 timeline messages and the tools. Nothing is
//   written until the FIRST model round-trip succeeds, so a refusal of the
//   first call (`ai.limits` 429, a key problem) leaves no row at all and the
//   controller still answers it as JSON. Then: the user's message is
//   persisted, each tool call is a `tool` frame, and the final text passes
//   the content guard (chat context) BEFORE the user sees any of it: a
//   failing reply is replaced by `COACH_CHAT_FALLBACK_REPLY`. The reply is
//   persisted, then streamed as `delta` frames, then `done`.
//
// WHY DELTAS AFTER THE GUARD. `runTools` is not a streaming call, and a reply
// shown token by token could not be withdrawn once the guard rejected it.
// The `delta` frames are the guarded text, chunked; `tool` frames arrive live
// while the model works.
//
// DISCONNECT. The controller's signal aborts the provider call; the partial
// reply is DISCARDED (no coach row; the user's message, once persisted,
// stays). An error after streaming began, or after the user's message was
// stored, is an `error` frame carrying `userMessageId` (null when nothing was
// stored); the reply is not persisted.
//
// RETRY (`retryOf`). A client whose turn ended in an `error` frame retries
// with `retryOf: <userMessageId>` and the same `text`: the stored user row is
// reused (no second row) when it is the caller's latest user chat message, no
// coach chat reply follows it and its body equals `text`; otherwise 400
// `COACH_RETRY_INVALID` before anything else happens.
//
// SAFETY HISTORY. A blocked turn tags BOTH its rows `data.safety` (`distress`
// or `symptom`); those rows are never sent to the model again
// (`excludeBlockedSafetyTurns`), and for `COACH_CHAT_SAFETY_LOOKBACK_MS`
// after one every model turn runs in the supportive register.
//
// MEMORY (#325; docs/specs/ai-memory.md). While memory is on for the user,
// the instructions carry the user's memory block and the turn gets the
// `remember` / `forget` / `update_memory` tools; each change they make is a
// `memory` frame (`{ op, memoryId, content }`) right after its `tool` frame,
// so the client can show a chip with Undo. After a model turn's reply is
// stored, `ai.memory.extract` is queued (5 minutes out, deduplicated per
// user) to learn durable facts in the background.
//
// ⚠ NEVER LOG TEXT. No log line, span attribute or counter carries the
// user's message, the model's reply or a tool argument (the `reason` of
// `pause_coach` included).
// =============================================================================

/** One SSE frame of `POST /api/coach/chat/stream`. `type` is the SSE event name. */
export type CoachChatEvent =
  | { type: 'safety'; level: 'blocked' | 'conservative'; screen: CoachChatSafetyScreen }
  | { type: 'tool'; name: string; status: AiToolCallStatus }
  | { type: 'memory'; op: CoachChatMemoryEvent['op']; memoryId: string; content: string }
  | { type: 'delta'; text: string }
  | {
      type: 'done';
      messageId: string;
      userMessageId: string;
      links: CoachChatLink[];
      pausedUntil: string | null;
      fallback: boolean;
    }
  | {
      type: 'error';
      code: string;
      message: string;
      /** The stored user message of this turn (pass it as `retryOf` to retry), or null when none was stored. */
      userMessageId: string | null;
    };

export interface CoachChatLink {
  label: string;
  href: string;
}

/** What the coach says when the guard rejects a reply. No digits, no profanity, no persona. */
export const COACH_CHAT_FALLBACK_REPLY =
  "Sorry, I couldn't put that answer together properly. Could you ask me again, maybe a little differently?";

/** Provider round-trips one turn may take (the default tool loop allows 8). */
export const COACH_CHAT_MAX_STEPS = 6;
export const COACH_CHAT_TOOL_TIMEOUT_MS = 15_000;
export const COACH_CHAT_MAX_OUTPUT_TOKENS = 800;

const FEATURE_ID = 'coach.chat';

/** `provider` on a reply no model wrote (a safety reply). */
export const COACH_STATIC_PROVIDER = 'static';

interface TurnContext {
  userId: string;
  text: string;
  startedAt: Date;
  signal?: AbortSignal;
  span: Span;
  /** A retry: the already stored user row, reused instead of a new one. */
  retry: { id: string; createdAt: Date } | null;
}

/** 400 for a `retryOf` that cannot be retried. */
export const COACH_RETRY_INVALID = 'COACH_RETRY_INVALID';

/** A history row as read for the prompt (`data` only for the safety filter). */
interface HistoryRow {
  role: string;
  kind: string;
  title: string;
  body: string;
  data: unknown;
}

@Injectable()
export class CoachChatService {
  private readonly logger = new Logger(CoachChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly features: AiFeatureModelResolver,
    private readonly userSettings: UserSettingsService,
    private readonly systemSettings: SystemSettingsService,
    private readonly healthProfile: HealthProfileService,
    private readonly checkIns: CheckInsService,
    private readonly signals: TrainingSignalsService,
    private readonly today: TrainingTodayService,
    private readonly photos: ProgressPhotoSummaryService,
    private readonly metrics: CoachChatMetrics,
    @Optional() private readonly appMetrics: AppMetricsService = fallbackAppMetrics(),
    // `save_commitment`'s writer (E7.12). Optional: without it the tool answers `unavailable`.
    @Optional() private readonly coachSettings?: CoachSettingsService,
    // `get_goals`' source (F9). Optional: without it the tool answers `unavailable`.
    @Optional() private readonly goals?: GoalProgressService,
    // User memory (#325). Optional: without them the chat runs without memory.
    @Optional() private readonly memoryContext?: MemoryContextService,
    @Optional() private readonly memories?: MemoryService,
    @Optional() private readonly memoryExtraction?: MemoryExtractionScheduler,
  ) {}

  /**
   * Starts one turn. Throws for every precondition; otherwise answers the
   * turn's events. The first event of a model turn is produced only after the
   * first model round-trip, so awaiting it surfaces a refusal of that call
   * before the response is committed to a stream.
   */
  async startTurn(
    userId: string,
    text: string,
    opts: { signal?: AbortSignal; retryOf?: string } = {},
  ): Promise<AsyncIterable<CoachChatEvent>> {
    const span = trace.getTracer(resolveServiceName()).startSpan('coach.chat.turn');
    const ctx: TurnContext = { userId, text, startedAt: new Date(), signal: opts.signal, span, retry: null };

    try {
      const [settings, policy, profile] = await Promise.all([
        this.userSettings.getSettings(userId),
        this.systemSettings.getCoachPolicy(),
        this.healthProfile.get(userId),
      ]);
      if (!policy.enabled) throw coachDisabledError();

      if (opts.retryOf) {
        ctx.retry = await this.retryTarget(userId, opts.retryOf, text);
        span.setAttribute('coach.chat.retry', true);
      }

      const safety = screenCoachChat(text);
      span.setAttribute('coach.safety', safety.level);
      if (safety.screen) this.metrics.safetyHit(safety.screen);

      if (safety.level === 'blocked') return this.safetyTurn(ctx, safety);

      const user = resolveCoachUserSettings(settings.coach);
      const register = resolveRegister(user, policy, { dateOfBirth: profile.dateOfBirth }, ctx.startedAt);
      // A blocked turn in the lookback keeps the register supportive, whatever this message says.
      const recentBlocked = safety.level !== 'conservative' && (await this.hasRecentBlockedTurn(userId, ctx.startedAt));
      if (recentBlocked) span.setAttribute('coach.chat.recent_safety', true);
      const supportive = safety.level === 'conservative' || recentBlocked;
      const supportiveReason: CoachChatSupportiveReason = recentBlocked ? 'recent_safety' : 'pain';
      // A supportive register is never profane: render as if locked (Sarge L3 -> L2).
      const style = renderPersonaStyle(
        user.personaId,
        clampIntensity(user.intensity),
        supportive ? { profane: false, reason: register.reason ?? 'toggle_off' } : register,
      );
      span.setAttributes({ 'coach.persona': style.persona.id, 'coach.intensity': style.intensity });

      const resolution = await this.features.resolve(userId, FEATURE_ID);
      if (!RUNNABLE_FEATURE_STATES.includes(resolution.state) || !resolution.model) {
        throw new ConflictException({
          message: `No AI model is available for the coach chat (${resolution.state}).`,
          details: { reason: 'AI_FEATURE_UNAVAILABLE', featureId: FEATURE_ID, state: resolution.state, fix: resolution.fix },
        });
      }
      span.setAttribute('ai.model', resolution.model.modelId);

      const [rows, today, memory] = await Promise.all([
        // Twice the window, so dropping blocked safety turns still leaves a full one.
        this.prisma.coachMessage.findMany({
          where: { userId, ...(ctx.retry ? { id: { not: ctx.retry.id } } : {}) },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: COACH_CHAT_HISTORY_LIMIT * 2,
          select: { role: true, kind: true, title: true, body: true, data: true },
        }) as Promise<HistoryRow[]>,
        this.checkIns.today(userId, ctx.startedAt),
        this.memoryContext ? this.memoryContext.forChat(userId) : Promise.resolve(null),
      ]);
      rows.reverse();
      const history = excludeBlockedSafetyTurns(rows)
        .slice(-COACH_CHAT_HISTORY_LIMIT)
        .map(({ role, kind, title, body }) => ({ role, kind, title, body }));

      return this.modelTurn(ctx, {
        safety,
        style,
        supportive,
        model: { provider: resolution.model.provider, modelId: resolution.model.modelId },
        instructions: buildCoachChatInstructions({
          style,
          supportive,
          supportiveReason,
          today,
          memoryEnabled: Boolean(memory?.enabled && this.memories),
          memoryBlock: memory?.block ?? '',
        }),
        memory,
        // `why` is user text: a delimited user-role part, never the system prompt; not under the supportive register.
        why: supportive ? null : (user.why ?? null),
        history,
      });
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Safety: a fixed reply, no model
  // ---------------------------------------------------------------------------

  private async *safetyTurn(ctx: TurnContext, safety: CoachChatSafety): AsyncGenerator<CoachChatEvent> {
    try {
      const body = blockedReplyFor(safety);
      // Both rows carry `data.safety`, so neither is ever sent to a model (`excludeBlockedSafetyTurns`).
      const userMessage = await this.persistUserMessage(ctx, safety.screen);
      let reply: { id: string };
      try {
        reply = await this.prisma.coachMessage.create({
          data: {
            userId: ctx.userId,
            role: 'coach',
            kind: 'chat',
            personaId: null,
            intensity: null,
            title: '',
            body,
            provider: COACH_STATIC_PROVIDER,
            data: { safety: safety.screen },
            createdAt: later(userMessage.createdAt),
          },
          select: { id: true },
        });
      } catch {
        // The user's row is stored: an `error` frame names it so a retry does not store it twice.
        this.metrics.error('internal');
        ctx.span.setStatus({ code: SpanStatusCode.ERROR });
        this.logger.warn(`Coach chat safety reply failed for user ${ctx.userId}`);
        yield internalErrorFrame(userMessage.id);
        return;
      }
      this.finish(ctx, 'safety', 0);

      yield { type: 'safety', level: 'blocked', screen: safety.screen as CoachChatSafetyScreen };
      for (const chunk of chunkText(body)) yield { type: 'delta', text: chunk };
      yield { type: 'done', messageId: reply.id, userMessageId: userMessage.id, links: [], pausedUntil: null, fallback: false };
    } finally {
      ctx.span.end();
    }
  }

  // ---------------------------------------------------------------------------
  // Model: runTools, guard, persist, stream
  // ---------------------------------------------------------------------------

  private async *modelTurn(
    ctx: TurnContext,
    turn: {
      safety: CoachChatSafety;
      style: RenderedPersonaStyle;
      supportive: boolean;
      model: { provider: string; modelId: string };
      instructions: string;
      why: string | null;
      history: Array<{ role: string; kind: string; title: string; body: string }>;
      memory?: MemoryChatContext | null;
    },
  ): AsyncGenerator<CoachChatEvent> {
    const actions: CoachChatTurnActions = { pausedUntil: null, memoryEvents: [] };
    const tools = createCoachChatTools(this.toolDeps(turn.memory ?? null), actions);
    const drainMemory = (): CoachChatEvent[] =>
      (actions.memoryEvents ?? []).splice(0).map((e) => ({ type: 'memory', op: e.op, memoryId: e.memoryId, content: e.content }));
    const steps = new StepChannel();
    let yielded = false;
    // A retry starts with its stored row; `stored` is true once THIS call wrote one.
    let userMessage: { id: string; createdAt: Date } | null = ctx.retry;
    let stored = false;
    const persistOnce = async (): Promise<{ id: string; createdAt: Date }> => {
      const row = await this.persistUserMessage(ctx);
      stored = true;
      return row;
    };
    let toolCount = 0;

    void this.ai
      .forUser(ctx.userId)
      .runTools(
        {
          provider: turn.model.provider,
          model: turn.model.modelId,
          instructions: turn.instructions,
          input: buildCoachChatInput(turn.history, ctx.text, { why: turn.why }),
          tools,
          maxSteps: COACH_CHAT_MAX_STEPS,
          toolTimeoutMs: COACH_CHAT_TOOL_TIMEOUT_MS,
          maxOutputTokens: COACH_CHAT_MAX_OUTPUT_TOKENS,
          onStep: (step) => steps.push(step),
        },
        { signal: ctx.signal },
      )
      .then(
        (result) => steps.end(result),
        (err: unknown) => steps.fail(err),
      );

    try {
      for await (const step of steps) {
        userMessage ??= await persistOnce();
        // The `safety` frame waits for the first round-trip, so a refused first call still answers JSON.
        if (turn.safety.level === 'conservative' && !yielded) {
          yielded = true;
          yield { type: 'safety', level: 'conservative', screen: 'pain' };
        }
        for (const call of step.calls) {
          toolCount += 1;
          this.metrics.toolCall(call.name, call.status);
          yielded = true;
          yield { type: 'tool', name: call.name, status: call.status };
        }
        for (const frame of drainMemory()) yield frame;
      }

      const result = steps.result as AiToolLoopResult;
      userMessage ??= await persistOnce();

      const raw = result.stopReason === 'completed' ? result.final.outputText.trim() : '';
      const verdict = this.check(raw, turn, ctx, result);
      const body = verdict.ok ? raw : COACH_CHAT_FALLBACK_REPLY;
      const links = body.includes(`](${COACH_ADJUST_PATH})`) ? [{ label: COACH_ADJUST_LABEL, href: COACH_ADJUST_PATH }] : [];
      const pausedUntil = actions.pausedUntil ? actions.pausedUntil.toISOString() : null;

      const reply = await this.prisma.coachMessage.create({
        data: {
          userId: ctx.userId,
          role: 'coach',
          kind: 'chat',
          personaId: turn.style.persona.id,
          intensity: turn.style.intensity,
          title: '',
          body,
          provider: result.final.provider,
          model: result.final.model,
          data: {
            ...(links.length > 0 ? { links } : {}),
            ...(pausedUntil ? { pausedUntil } : {}),
            ...(turn.safety.level === 'conservative' ? { safety: 'pain' } : {}),
            ...(verdict.ok ? {} : { fallback: true, guard: verdict.reasons }),
          },
          createdAt: later(userMessage.createdAt),
        },
        select: { id: true },
      });

      this.finish(ctx, verdict.ok ? 'model' : 'fallback', toolCount);
      // Background memory extraction for this conversation (never throws).
      if (this.memoryExtraction) await this.memoryExtraction.afterChatTurn(ctx.userId);

      yielded = true;
      for (const frame of drainMemory()) yield frame;
      for (const chunk of chunkText(body)) yield { type: 'delta', text: chunk };
      yield {
        type: 'done',
        messageId: reply.id,
        userMessageId: userMessage.id,
        links,
        pausedUntil,
        fallback: !verdict.ok,
      };
    } catch (err) {
      if (ctx.signal?.aborted) {
        // The client went away: the partial reply is discarded.
        this.metrics.error('cancelled');
        ctx.span.setAttribute('coach.chat.cancelled', true);
        return;
      }

      const code = err instanceof AiError ? err.code : 'internal';
      this.metrics.error(code);
      ctx.span.setStatus({ code: SpanStatusCode.ERROR });
      this.logger.warn(`Coach chat turn failed for user ${ctx.userId}: ${code}`);

      // Nothing sent and nothing stored by this call: an ordinary JSON error.
      if (!yielded && !stored) throw err;

      // Once the user's row exists the client must learn its id (`retryOf`), so it is a frame.
      const userMessageId = userMessage?.id ?? null;
      yield err instanceof AiError ? { ...toErrorEvent(err), userMessageId } : internalErrorFrame(userMessageId);
    } finally {
      ctx.span.setAttribute('coach.chat.tool_count', toolCount);
      ctx.span.end();
    }
  }

  /** The content guard over the final reply, in the chat context. */
  private check(
    text: string,
    turn: { style: RenderedPersonaStyle; supportive: boolean; history: Array<{ body: string }>; memory?: MemoryChatContext | null },
    ctx: TurnContext,
    result: AiToolLoopResult,
  ): { ok: boolean; reasons: CoachGuardReason[] } {
    if (text.length === 0 || text.length > COACH_CHAT_REPLY_MAX_CHARS) {
      this.appMetrics.coachGuardRejection('length');
      return { ok: false, reasons: ['length'] };
    }

    const allowedNumbers = new Set<string>([String(COACH_PAUSE_MIN_DAYS), String(COACH_PAUSE_MAX_DAYS)]);
    const sources = [
      ctx.text,
      ...turn.history.map((row) => row.body),
      // The user's own memory notes (#325): a figure the user told the coach is not invented.
      turn.memory?.block ?? '',
      ...result.steps.flatMap((step) => step.calls.map((call) => call.output)),
    ];
    for (const source of sources) for (const n of extractNumbers(source)) allowedNumbers.add(n);

    const guardCtx = {
      personaId: turn.style.persona.id,
      intensity: turn.style.intensity,
      register: { profane: turn.style.register.profane && !turn.supportive },
      lockScreenSafe: false,
      allowedNumbers,
      supportive: turn.supportive,
      surface: 'app' as const,
    };
    // The chat reply has its own length bound (above): the nudge `body` limit does not apply.
    const violations = guardCoachText('body', text, guardCtx).filter((v) => v.reason !== 'length');
    if (violations.length === 0) return { ok: true, reasons: [] };

    const reasons = [...new Set(violations.map((v) => v.reason))];
    for (const reason of reasons) this.appMetrics.coachGuardRejection(reason);
    return { ok: false, reasons };
  }

  private toolDeps(memory: MemoryChatContext | null): CoachChatToolDeps {
    return {
      prisma: this.prisma,
      signals: this.signals,
      today: this.today,
      checkIns: this.checkIns,
      photos: this.photos,
      now: () => new Date(),
      ...(this.coachSettings ? { commitments: this.coachSettings } : {}),
      ...(this.goals ? { goals: this.goals } : {}),
      ...(memory?.enabled && this.memories ? { memory: { service: this.memories, refs: memory.refs } } : {}),
    };
  }

  /**
   * The user's turn as a timeline row. A chat message also resets the
   * ignored-nudge streak (spec §2.2). `safetyScreen` (a blocked turn) tags
   * the row `data.safety`, so it is never sent to a model. A retry reuses its
   * stored row (tagged too when the turn is blocked).
   */
  private async persistUserMessage(
    ctx: TurnContext,
    safetyScreen: CoachChatSafetyScreen | null = null,
  ): Promise<{ id: string; createdAt: Date }> {
    if (ctx.retry) {
      if (safetyScreen) {
        await this.prisma.coachMessage.updateMany({
          where: { id: ctx.retry.id, userId: ctx.userId },
          data: { data: { safety: safetyScreen } },
        });
      }
      return ctx.retry;
    }
    const row = await this.prisma.coachMessage.create({
      data: {
        userId: ctx.userId,
        role: 'user',
        kind: 'chat',
        title: '',
        body: ctx.text,
        ...(safetyScreen ? { data: { safety: safetyScreen } } : {}),
        createdAt: ctx.startedAt,
      },
      select: { id: true, createdAt: true },
    });
    await this.prisma.coachState.updateMany({
      where: { userId: ctx.userId, consecutiveIgnored: { gt: 0 } },
      data: { consecutiveIgnored: 0 },
    });
    return row;
  }

  /**
   * The stored user row a `retryOf` names, or 400 `COACH_RETRY_INVALID`: it
   * must be the caller's LATEST user chat message, no coach chat reply may
   * follow it, and its body must equal `text`.
   */
  private async retryTarget(userId: string, retryOf: string, text: string): Promise<{ id: string; createdAt: Date }> {
    const latest = await this.prisma.coachMessage.findFirst({
      where: { userId, role: 'user', kind: 'chat' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, body: true, createdAt: true },
    });
    const invalid = (why: string) =>
      new BadRequestException({
        message: `This message cannot be retried (${why}).`,
        details: { code: COACH_RETRY_INVALID, reason: COACH_RETRY_INVALID },
      });
    if (!latest || latest.id !== retryOf) throw invalid('not your latest message');
    if (latest.body !== text) throw invalid('the text differs from the stored message');
    const answered = await this.prisma.coachMessage.findFirst({
      where: { userId, role: 'coach', kind: 'chat', createdAt: { gt: latest.createdAt } },
      select: { id: true },
    });
    if (answered) throw invalid('it already has a reply');
    return { id: latest.id, createdAt: latest.createdAt };
  }

  /** Whether a blocked safety turn (distress or symptom) of this user lies within the lookback. */
  private async hasRecentBlockedTurn(userId: string, now: Date): Promise<boolean> {
    const row = await this.prisma.coachMessage.findFirst({
      where: {
        userId,
        kind: 'chat',
        createdAt: { gte: new Date(now.getTime() - COACH_CHAT_SAFETY_LOOKBACK_MS) },
        OR: COACH_CHAT_BLOCKED_SAFETY_TAGS.map((tag) => ({ data: { path: ['safety'], equals: tag } })),
      },
      select: { id: true },
    });
    return Boolean(row);
  }

  private finish(ctx: TurnContext, outcome: CoachChatTurnOutcome, toolCount: number): void {
    this.metrics.turn(outcome);
    ctx.span.setAttributes({ 'coach.chat.outcome': outcome, 'coach.chat.tool_count': toolCount });
    this.logger.debug(`Coach chat turn user=${ctx.userId} outcome=${outcome} tools=${toolCount}`);
  }
}

// =============================================================================
// Helpers
// =============================================================================

function internalErrorFrame(userMessageId: string | null): CoachChatEvent {
  return {
    type: 'error',
    code: 'INTERNAL_ERROR',
    message: 'The coach could not answer just now. Please try again.',
    userMessageId,
  };
}

function clampIntensity(value: number): Intensity {
  return Math.min(3, Math.max(1, Math.round(value))) as Intensity;
}

/** One millisecond after `at`, so a reply always sorts after the message it answers. */
function later(at: Date): Date {
  return new Date(Math.max(Date.now(), at.getTime() + 1));
}

/** Splits text into word-boundary chunks for `delta` frames. Concatenated, they are the text exactly. */
export function chunkText(text: string, size = 48): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const piece of text.match(/\S+\s*|\s+/g) ?? []) {
    if (current.length > 0 && current.length + piece.length > size) {
      chunks.push(current);
      current = '';
    }
    current += piece;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Bridges `runTools`' `onStep` callback to an async iterator: each step is
 * yielded as it happens; iteration ends when the loop resolves (`result`) and
 * throws when it rejects.
 */
export class StepChannel implements AsyncIterable<AiToolStep> {
  result: AiToolLoopResult | undefined;
  private readonly queue: AiToolStep[] = [];
  private finished = false;
  private error: { err: unknown } | null = null;
  private wake: (() => void) | null = null;

  push(step: AiToolStep): void {
    this.queue.push(step);
    this.notify();
  }

  end(result: AiToolLoopResult): void {
    this.result = result;
    this.finished = true;
    this.notify();
  }

  fail(err: unknown): void {
    this.error = { err };
    this.finished = true;
    this.notify();
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AiToolStep> {
    for (;;) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.error) throw this.error.err;
      if (this.finished) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}
