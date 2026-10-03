// =============================================================================
// CoachMessageAudioService — on-demand "Listen" for a coach message (#259)
// =============================================================================
//
// docs/specs/ai-coach.md §2.7. No job speaks a message by itself any more:
// the user presses Listen (or follows the push's "Hear Coach" action, which
// autoplays) and `POST /api/coach/messages/:id/audio` lands here.
//
// `request`, in order:
//   1. The caller's own coach message (`role = 'coach'`)  else 404 COACH_MESSAGE_NOT_FOUND
//   2. System `allowAudio` AND the user's `audio.enabled`  else 403 COACH_AUDIO_DISABLED
//   3. `ready` with its object -> 200 `{ ready, storageObjectId, voice }`;
//      `pending` -> 202 `{ pending, runId }`. No new `speak()` for either.
//   4. `coach.voice` resolves                              else 409 AI_FEATURE_UNAVAILABLE
//   5. The per-user Listen limit (own bucket)              else 429 COACH_AUDIO_RATE_LIMITED
//   6. GUARDED `none | failed (| ready without object) -> pending`, with
//      `data.audioOnDemand = true` and `data.audioRequestedAt`. Losing the
//      guard (a concurrent press) re-reads the row and answers its state:
//      exactly one press per attempt reaches `speak()`.
//   7. `CoachAudioService.start`: `speak()` with the user's voice (else the
//      persona's for the level the CURRENT register renders), speed, persona
//      TTS instructions plus `data.audioInstructions`; input
//      `data.audioScript`, else the body, as plain text (markdown stripped,
//      links reduced to their labels; #343). It stores `audioRunId` and
//      queues the 2-minute wait cap.
//      202 `{ pending, runId }`, or 200 `{ failed }` when `speak()` refused.
//
// The speech run settles through `coach.audio.settle` exactly as before, but
// an on-demand message is never (re)delivered by it: no second notification.
// The text spoken is the stored, guard-approved text; nothing is regenerated.
//
// `get` is the cheap poll: the same shape, no side effects, no limit.
//
// ⚠ PRIVACY: ids and enums in logs; never the script or the body.
// =============================================================================

import { Injectable, Logger, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { AiFeatureModelResolver } from '../../ai/assignments/ai-feature-model-resolver.service';
import { RUNNABLE_FEATURE_STATES } from '../../ai/assignments/dto/ai-feature-resolution.dto';
import { fromDbDate } from '../../check-ins/local-date';
import {
  AppMetricsService,
  fallbackAppMetrics,
  type CoachAudioRequestOutcome,
} from '../../common/otel/app-metrics.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import {
  coachAudioDisabledError,
  coachAudioRateLimitedError,
  coachMessageNotFoundError,
  coachVoiceUnavailableError,
} from '../coach-errors';
import { COACH_INTENSITIES, isCoachPersonaId, type Intensity } from '../personas';
import { coachUserSettingsOf } from '../planning/coach-planner.service';
import { renderPersonaStyle, resolveRegister } from '../personas/resolve-register';
import { COACH_VOICE_FEATURE_ID, CoachAudioService } from './coach-audio.service';
import { CoachListenRateLimiter } from './coach-listen-rate-limiter';
import type { CoachMessageAudio } from './dto/coach-message-audio.dto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MESSAGE_SELECT = {
  id: true,
  body: true,
  personaId: true,
  intensity: true,
  audioStatus: true,
  audioStorageObjectId: true,
  audioRunId: true,
  data: true,
} as const;

type OwnedMessage = Prisma.CoachMessageGetPayload<{ select: typeof MESSAGE_SELECT }>;

@Injectable()
export class CoachMessageAudioService {
  private readonly logger = new Logger(CoachMessageAudioService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
    private readonly features: AiFeatureModelResolver,
    private readonly audio: CoachAudioService,
    private readonly limiter: CoachListenRateLimiter,
    @Optional() private readonly metrics: AppMetricsService = fallbackAppMetrics(),
  ) {}

  /** The caller's message's audio state. Read only. */
  async get(userId: string, messageId: string): Promise<CoachMessageAudio> {
    return messageAudioView(await this.owned(userId, messageId));
  }

  /** Speaks the caller's message on request (see the file header for the order of checks). */
  async request(userId: string, messageId: string, now: Date = new Date()): Promise<CoachMessageAudio> {
    const message = await this.owned(userId, messageId);

    const [policy, row] = await Promise.all([
      this.systemSettings.getCoachPolicy(),
      this.prisma.userSettings.findUnique({
        where: { userId },
        select: { value: true, user: { select: { healthProfile: { select: { dateOfBirth: true } } } } },
      }),
    ]);
    const settings = coachUserSettingsOf(row?.value ?? null);
    if (!policy.allowAudio) {
      this.count('disabled');
      throw coachAudioDisabledError();
    }
    if (!settings.audio.enabled) {
      this.count('disabled');
      throw coachAudioDisabledError('Spoken coach messages are switched off in your coach settings.');
    }

    const current = messageAudioView(message);
    if (current.status === 'ready' || current.status === 'pending') {
      this.count(current.status);
      return current;
    }

    const resolution = await this.features.resolve(userId, COACH_VOICE_FEATURE_ID);
    if (!RUNNABLE_FEATURE_STATES.includes(resolution.state) || !resolution.model) {
      this.count('no_voice_model');
      throw coachVoiceUnavailableError(COACH_VOICE_FEATURE_ID, resolution.state, resolution.fix);
    }
    const model = { provider: resolution.model.provider, modelId: resolution.model.modelId };

    const decision = this.limiter.take(userId, now.getTime());
    if (!decision.allowed) {
      this.count('rate_limited');
      this.logger.log(`Coach message audio refused for user ${userId}: rate limited`);
      throw coachAudioRateLimitedError(decision.retryAfterMs);
    }

    // The guarded claim: only one concurrent press moves the row to `pending`.
    const data = recordOf(message.data);
    const { audioFailure: _previousFailure, ...kept } = data;
    const claimed = await this.prisma.coachMessage.updateMany({
      where: {
        id: message.id,
        userId,
        role: 'coach',
        OR: [{ audioStatus: { in: ['none', 'failed'] } }, { audioStatus: 'ready', audioStorageObjectId: null }],
      },
      data: {
        audioStatus: 'pending',
        audioRunId: null,
        audioStorageObjectId: null,
        data: { ...kept, audioOnDemand: true, audioRequestedAt: now.toISOString() } as Prisma.InputJsonObject,
      },
    });
    if (claimed.count === 0) {
      const fresh = messageAudioView(await this.owned(userId, messageId));
      this.count(fresh.status === 'ready' || fresh.status === 'pending' ? fresh.status : 'failed');
      this.logger.debug(`Coach message ${message.id}: a concurrent audio request won; answering ${fresh.status}`);
      return fresh;
    }

    const dob = row?.user?.healthProfile?.dateOfBirth ?? null;
    const personaId = message.personaId && isCoachPersonaId(message.personaId) ? message.personaId : settings.personaId;
    const intensity = clampIntensity(message.intensity ?? settings.intensity);
    // The register re-evaluated now: a level that is no longer unlocked is
    // spoken with the clean level's voice and instructions.
    const register = resolveRegister(
      { ...settings, personaId, intensity },
      policy,
      { dateOfBirth: dob ? fromDbDate(dob) : null },
      now,
    );
    const style = renderPersonaStyle(personaId, intensity, register);
    // `speechRequest` strips the markdown (links included) from whichever text it speaks (#343).
    const script = typeof data.audioScript === 'string' ? data.audioScript : null;
    const request = this.audio.speechRequest({
      style,
      userVoice: settings.audio.voice,
      speed: settings.audio.speed,
      audioScript: script,
      body: message.body,
      audioInstructions: typeof data.audioInstructions === 'string' ? data.audioInstructions : null,
    });

    let started: Awaited<ReturnType<CoachAudioService['start']>>;
    try {
      started = await this.audio.start({ userId, messageId: message.id, model, request, now });
    } catch (error) {
      // Never leave the claim stuck `pending` on an unexpected error.
      await this.audio.markFailed(message.id, 'provider_error', null, now).catch(() => false);
      throw error;
    }

    if (started.status === 'pending') {
      this.count('started');
      this.logger.log(`Coach message ${message.id}: on-demand speech run ${started.runId} queued`);
      return { status: 'pending', runId: started.runId };
    }
    this.count('failed');
    return { status: 'failed' };
  }

  private count(outcome: CoachAudioRequestOutcome): void {
    this.metrics.coachAudioRequest(outcome);
  }

  private async owned(userId: string, messageId: string): Promise<OwnedMessage> {
    if (!UUID.test(messageId)) throw coachMessageNotFoundError();
    const message = await this.prisma.coachMessage.findFirst({
      where: { id: messageId, userId, role: 'coach' },
      select: MESSAGE_SELECT,
    });
    if (!message) throw coachMessageNotFoundError();
    return message;
  }
}

/** A message row's audio as the routes answer it. `ready` without its object (deleted) reads `none`. */
export function messageAudioView(row: {
  audioStatus: string;
  audioStorageObjectId: string | null;
  audioRunId: string | null;
  data: Prisma.JsonValue | null;
}): CoachMessageAudio {
  switch (row.audioStatus) {
    case 'ready': {
      if (!row.audioStorageObjectId) return { status: 'none' };
      const voice = recordOf(row.data).voice;
      return {
        status: 'ready',
        storageObjectId: row.audioStorageObjectId,
        ...(typeof voice === 'string' ? { voice } : {}),
      };
    }
    case 'pending':
      return { status: 'pending', ...(row.audioRunId ? { runId: row.audioRunId } : {}) };
    case 'failed':
      return { status: 'failed' };
    default:
      return { status: 'none' };
  }
}

function recordOf(value: Prisma.JsonValue | null | undefined): Record<string, Prisma.JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? ({ ...value } as Record<string, Prisma.JsonValue>) : {};
}

function clampIntensity(value: number): Intensity {
  const level = Math.round(value);
  return (COACH_INTENSITIES as readonly number[]).includes(level) ? (level as Intensity) : 2;
}
