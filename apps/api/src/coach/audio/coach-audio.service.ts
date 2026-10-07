// =============================================================================
// CoachAudioService — a coach message's optional spoken version (E7.6, #246;
// on demand since #259)
// =============================================================================
//
// docs/specs/ai-coach.md §2.7. AUDIO IS ON REQUEST ONLY (#259): no job speaks
// a message by itself. A coach message is written `audioStatus = 'none'` and
// delivered as text at once; the user presses "Listen" (or the push's
// "Hear Coach" action, which autoplays) and `POST /api/coach/messages/:id/audio`
// (`CoachMessageAudioService`) moves it `none | failed -> pending` with a
// guarded update, marks `data.audioOnDemand` and calls `start`.
//
//   start   resolves nothing itself: the caller passes the `coach.voice`
//           model and the speech request. Calls `speak()` (which queues
//           `ai.audio.speech`), stores `audioRunId` and queues the WAIT CAP: a
//           `coach.audio.settle` job scheduled 2 minutes out. A `speak()` that
//           throws marks the audio failed at once.
//   settle  `coach.audio.settle` (the speech job settled, or the cap
//           elapsed): reads the run, classifies it (`tts-refusal.ts`) and
//           moves the message `pending -> ready | failed` with a guarded
//           update, so a duplicate settle changes nothing. An on-demand
//           message is NEVER (re)delivered by its settle: the user is already
//           looking at it, and a chat reply has no delivery at all. `deliver`
//           is true only for a message written `pending` by the pre-#259
//           automatic path (no `data.audioOnDemand`) that is still undelivered,
//           so a message in flight across the upgrade is not lost.
//
// Single attempt per request: a failure is never retried and a refusal is
// never rephrased (spec §2.14); the user may press Listen again.
//
// ⚠ PRIVACY: ids, model ids, enums and a character count in logs and spans;
// never the script, the instructions or the provider's error text.
// =============================================================================

import { Injectable, Logger, Optional } from '@nestjs/common';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { Prisma } from '@prisma/client';

import { AiFeatureModelResolver } from '../../ai/assignments/ai-feature-model-resolver.service';
import { RUNNABLE_FEATURE_STATES } from '../../ai/assignments/dto/ai-feature-resolution.dto';
import { AI_SPEECH_INPUT_MAX_CHARS } from '../../ai/core/types/media.types';
import { AiRunsService } from '../../ai/runtime/ai-runs.service';
import { AiService } from '../../ai/runtime/ai.service';
import {
  EvoPathMetricsService,
  fallbackEvoPathMetrics,
  type CoachAudioFailureReason,
} from '../../app-metrics/evopath-metrics.service';
import { resolveServiceName } from '../../common/otel/telemetry-identity';
import { JobsService } from '../../jobs/jobs.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  COACH_AUDIO_SETTLE_JOB_TYPE,
  COACH_MESSAGE_DELIVER_JOB_TYPE,
  COACH_MESSAGE_SUBJECT_TYPE,
} from '../coach-job-types';
import type { RenderedPersonaStyle } from '../personas/resolve-register';
import { stripMarkdown } from '../text/strip-markdown';
import { classifySpeechRun, type CoachAudioCause } from './tts-refusal';

export const COACH_VOICE_FEATURE_ID = 'coach.voice';

/** How long a speech run may take before its message is recorded `failed` (`timeout`) (spec §2.7). */
export const COACH_AUDIO_WAIT_CAP_MS = 2 * 60_000;

/**
 * A message still `pending` this long after its audio was requested
 * (`data.audioRequestedAt`, else `createdAt`) is swept by `coach.audio.purge`
 * (safety net).
 */
export const COACH_AUDIO_STALE_PENDING_MS = 10 * 60_000;

/** Upper bound of the combined persona + message TTS instructions. */
export const COACH_TTS_INSTRUCTIONS_MAX = 1_000;

export interface CoachVoiceModel {
  provider: string;
  modelId: string;
}

export interface CoachSpeechRequest {
  input: string;
  voice: string;
  speed: number;
  instructions: string | undefined;
}

export type CoachAudioStartOutcome =
  | { status: 'pending'; runId: string }
  | { status: 'failed'; reason: CoachAudioFailureReason };

export type CoachAudioSettleOutcome =
  | { status: 'ready' | 'failed'; userId: string; deliver: boolean }
  | { status: 'waiting' | 'not_pending'; userId: string; deliver: boolean }
  | { status: 'not_found'; deliver: false };

const RUN_SELECT = { status: true, output: true, errorCode: true, errorMessage: true } as const;

@Injectable()
export class CoachAudioService {
  private readonly logger = new Logger(CoachAudioService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly runs: AiRunsService,
    private readonly features: AiFeatureModelResolver,
    private readonly jobs: JobsService,
    @Optional() private readonly metrics: EvoPathMetricsService = fallbackEvoPathMetrics(),
  ) {}

  /** The `coach.voice` model for `userId`, or null when the feature cannot run (no model, no `audio_speech`). */
  async resolveVoiceModel(userId: string): Promise<CoachVoiceModel | null> {
    const resolution = await this.features.resolve(userId, COACH_VOICE_FEATURE_ID);
    if (!RUNNABLE_FEATURE_STATES.includes(resolution.state) || !resolution.model) return null;
    return { provider: resolution.model.provider, modelId: resolution.model.modelId };
  }

  /**
   * The speech request for a message: the guard-approved `audioScript` (else
   * the body), the user's voice (else the persona's default for the RENDERED
   * level), the user's speed, and the persona's TTS instructions followed by
   * the message's own `audioInstructions`. The script is plain text: its
   * markdown (links, emphasis, lists, tables) is stripped first (#343).
   */
  speechRequest(input: {
    style: RenderedPersonaStyle;
    userVoice: string | null;
    speed: number;
    audioScript: string | null | undefined;
    body: string;
    audioInstructions: string | null | undefined;
  }): CoachSpeechRequest {
    // Markdown is never read aloud (#343): `**19 sets**` is spoken as "19 sets".
    const script = stripMarkdown((input.audioScript && input.audioScript.trim()) || input.body);
    const parts = [input.style.ttsInstructions, input.audioInstructions?.trim()].filter(
      (part, index, all): part is string => Boolean(part) && all.indexOf(part) === index,
    );
    const instructions = parts.join(' ').slice(0, COACH_TTS_INSTRUCTIONS_MAX).trim();

    return {
      input: script.slice(0, AI_SPEECH_INPUT_MAX_CHARS),
      voice: input.userVoice ?? input.style.voice,
      speed: input.speed,
      instructions: instructions || undefined,
    };
  }

  /**
   * Starts the spoken version of a message already moved to `pending`. On
   * `failed` the audio is recorded failed (`provider_error`) at once.
   * `jobId` scopes the AI call to a job when one is running it; an on-demand
   * request has none.
   */
  async start(params: {
    userId: string;
    jobId?: string;
    messageId: string;
    model: CoachVoiceModel;
    request: CoachSpeechRequest;
    now: Date;
  }): Promise<CoachAudioStartOutcome> {
    const { userId, jobId, messageId, model, request, now } = params;
    const tracer = trace.getTracer(resolveServiceName());

    return tracer.startActiveSpan('coach.audio.generate', async (span): Promise<CoachAudioStartOutcome> => {
      span.setAttributes({
        'ai.model': model.modelId,
        'coach.audio.characters': request.input.length,
        'coach.message_id': messageId,
      });
      try {
        let runId: string;
        try {
          const handle = await this.ai.forUser(userId, jobId ? { jobId } : {}).speak({
            provider: model.provider,
            model: model.modelId,
            input: request.input,
            voice: request.voice,
            speed: request.speed,
            ...(request.instructions ? { instructions: request.instructions } : {}),
          });
          runId = handle.runId;
        } catch (error) {
          // A refusal to even queue (voice the model does not speak, a key
          // gone, a limit): text only, never retried.
          const code = errorCode(error);
          this.logger.warn(`Coach audio for message ${messageId} could not start (${code ?? 'error'})`);
          await this.markFailed(messageId, 'provider_error', code, now);
          span.setAttribute('coach.audio.outcome', 'failed:provider_error');
          return { status: 'failed', reason: 'provider_error' };
        }

        await this.prisma.coachMessage.updateMany({
          where: { id: messageId, audioStatus: 'pending' },
          data: { audioRunId: runId },
        });

        // The wait cap: a settle job two minutes out, independent of the
        // event-driven one (`skipDedup`), so whichever runs first decides
        // and the other finds nothing pending.
        // Pinned to this run: a cap left over from an earlier attempt on the
        // same message (Listen pressed again after a failure) changes nothing.
        await this.enqueueSettle(messageId, 'timeout', new Date(now.getTime() + COACH_AUDIO_WAIT_CAP_MS), undefined, runId);

        // The speech job may have settled before `audioRunId` was stored, in
        // which case the listener found no message. Settle now if so.
        const run = await this.prisma.aiRun.findUnique({ where: { id: runId }, select: { status: true } });
        if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status)) {
          await this.enqueueSettle(messageId, 'settled', undefined, undefined, runId);
        }

        span.setAttribute('coach.audio.outcome', 'pending');
        this.logger.log(`Coach audio for message ${messageId}: speech run ${runId} queued`);
        return { status: 'pending', runId };
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /**
   * Moves a `pending` message to `ready` or `failed` from its speech run.
   * `deliver` tells the caller to enqueue `coach.message.deliver`: true only
   * for an undelivered message of the pre-#259 automatic path (see the file
   * header), never for an on-demand request or a chat reply.
   */
  async settle(
    messageId: string,
    cause: CoachAudioCause,
    now: Date,
    jobSucceeded: boolean | null = null,
    runId: string | null = null,
  ): Promise<CoachAudioSettleOutcome> {
    const message = await this.prisma.coachMessage.findUnique({
      where: { id: messageId },
      select: { id: true, userId: true, kind: true, audioStatus: true, audioRunId: true, deliveredAt: true, data: true },
    });
    if (!message) return { status: 'not_found', deliver: false };

    // Only a legacy automatic message still waiting for its push is delivered
    // from here; an on-demand request (or a chat reply) never is.
    const deliver = message.deliveredAt === null && message.kind !== 'chat' && !isOnDemandAudio(message.data);
    if (runId && message.audioRunId && message.audioRunId !== runId) {
      // A settle (or wait cap) of an EARLIER speech run of this message: a
      // newer on-demand attempt owns the row now.
      return { status: 'not_pending', userId: message.userId, deliver: false };
    }
    if (message.audioStatus !== 'pending') {
      // A duplicate settle, or the other of the event/cap pair: nothing to
      // change. A legacy automatic message is re-enqueued for delivery only
      // if that has not happened (the enqueue collapses onto a queued one).
      return { status: 'not_pending', userId: message.userId, deliver };
    }

    const run = message.audioRunId
      ? await this.prisma.aiRun.findUnique({ where: { id: message.audioRunId }, select: RUN_SELECT })
      : null;
    const outcome = classifySpeechRun(run, { cause, jobSucceeded });

    if (outcome.kind === 'wait') {
      return { status: 'waiting', userId: message.userId, deliver: false };
    }

    if (outcome.kind === 'ready') {
      const changed = await this.prisma.coachMessage.updateMany({
        where: { id: messageId, audioStatus: 'pending' },
        data: {
          audioStatus: 'ready',
          audioStorageObjectId: outcome.storageObjectId,
          data: mergeData(message.data, { voice: outcome.voice, audioMimeType: outcome.mimeType }),
        },
      });
      if (changed.count > 0) {
        this.metrics.coachAudioReady();
        this.logger.log(`Coach audio for message ${messageId} is ready (object ${outcome.storageObjectId})`);
      }
      return { status: 'ready', userId: message.userId, deliver };
    }

    if (outcome.reason === 'timeout' && message.audioRunId && run && ['pending', 'running'].includes(run.status)) {
      // Late audio is discarded rather than paid for and orphaned.
      await this.runs.cancel(message.userId, message.audioRunId).catch((error: unknown) => {
        this.logger.warn(`Could not cancel speech run ${message.audioRunId}: ${error instanceof Error ? error.name : 'error'}`);
      });
    }

    await this.markFailed(messageId, outcome.reason, outcome.code, now, message.data);
    return { status: 'failed', userId: message.userId, deliver };
  }

  /**
   * Records the failure: `pending -> failed` with `data.audioFailure`
   * `{ reason, code, at }`. Guarded, so only the first caller counts it.
   */
  async markFailed(
    messageId: string,
    reason: CoachAudioFailureReason,
    code: string | null,
    now: Date,
    currentData?: Prisma.JsonValue | null,
  ): Promise<boolean> {
    const data =
      currentData !== undefined
        ? currentData
        : ((await this.prisma.coachMessage.findUnique({ where: { id: messageId }, select: { data: true } }))?.data ??
          null);

    const changed = await this.prisma.coachMessage.updateMany({
      where: { id: messageId, audioStatus: 'pending' },
      data: {
        audioStatus: 'failed',
        data: mergeData(data, { audioFailure: { reason, code, at: now.toISOString() } }),
      },
    });
    if (changed.count === 0) return false;

    this.metrics.coachAudioFailure(reason);
    this.logger.log(`Coach audio for message ${messageId} failed (${reason}); the text stands`);
    return true;
  }

  /**
   * Queue `coach.audio.settle`. The event-driven one dedups per message; the
   * wait cap never does. `runId` pins the job to one speech run (a settle of
   * an older run of the same message is then a no-op).
   */
  async enqueueSettle(
    messageId: string,
    cause: CoachAudioCause,
    scheduledFor?: Date,
    jobSucceeded?: boolean,
    runId?: string,
  ): Promise<void> {
    await this.jobs.enqueue({
      type: COACH_AUDIO_SETTLE_JOB_TYPE,
      reason: 'backfill',
      subjectType: COACH_MESSAGE_SUBJECT_TYPE,
      subjectId: messageId,
      payload: {
        messageId,
        cause,
        ...(jobSucceeded !== undefined ? { jobSucceeded } : {}),
        ...(runId ? { runId } : {}),
      },
      ...(scheduledFor ? { scheduledFor } : {}),
      ...(cause === 'timeout' ? { skipDedup: true } : {}),
    });
  }

  async enqueueDelivery(messageId: string): Promise<void> {
    await this.jobs.enqueue({
      type: COACH_MESSAGE_DELIVER_JOB_TYPE,
      reason: 'backfill',
      subjectType: COACH_MESSAGE_SUBJECT_TYPE,
      subjectId: messageId,
      payload: { messageId },
    });
  }
}

/** True when the message's audio was requested on demand (#259): its settle never delivers. */
export function isOnDemandAudio(data: Prisma.JsonValue | null | undefined): boolean {
  return Boolean(data && typeof data === 'object' && !Array.isArray(data) && (data as Prisma.JsonObject).audioOnDemand === true);
}

/** When a message's current audio was asked for: `data.audioRequestedAt` (on demand, #259), else its `createdAt`. */
export function audioRequestedAtOf(data: Prisma.JsonValue | null | undefined, createdAt: Date): Date {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const at = (data as Prisma.JsonObject).audioRequestedAt;
    if (typeof at === 'string') {
      const parsed = new Date(at);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
  }
  return createdAt;
}

/** `data` with `patch` merged in at the top level (a non-object `data` is replaced). */
export function mergeData(data: Prisma.JsonValue | null | undefined, patch: Record<string, unknown>): Prisma.InputJsonObject {
  const base = data && typeof data === 'object' && !Array.isArray(data) ? (data as Prisma.JsonObject) : {};
  return { ...base, ...patch } as Prisma.InputJsonObject;
}

function errorCode(error: unknown): string | null {
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return null;
}
