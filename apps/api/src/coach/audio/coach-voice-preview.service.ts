// =============================================================================
// CoachVoicePreviewService — POST /api/coach/voice-preview (E7.6, #246)
// =============================================================================
//
// Speaks a persona's STATIC sample line in a voice, so a user can hear a
// persona before turning spoken nudges on. Never user data: the line comes
// from the registry, its placeholders are filled with fixed demo values, and
// the register is the caller's own (a locked Sarge L3 speaks the clean L2
// line, `censored: true`).
//
// Checks, in order, before any provider call:
//   1. system `coach.allowAudio`           off -> 403 COACH_AUDIO_DISABLED
//   2. `personaId` in the registry         else -> 400 COACH_PERSONA_UNKNOWN
//   3. `coach.voice` resolves a model      else -> 409 AI_FEATURE_UNAVAILABLE
//   4. the per-user rate limit             else -> 429 COACH_PREVIEW_RATE_LIMITED
// Then `speak()` queues `ai.audio.speech` and the route answers 202 with the
// run id; the client polls `GET /api/ai/runs/:id` and plays
// `output.storageObjectId` with the AI-generated disclosure. A preview run
// is not tied to any coach message (the settle listener ignores it).
// =============================================================================

import { ConflictException, Injectable, Logger } from '@nestjs/common';

import { RUNNABLE_FEATURE_STATES } from '../../ai/assignments/dto/ai-feature-resolution.dto';
import { AiFeatureModelResolver } from '../../ai/assignments/ai-feature-model-resolver.service';
import { AiService } from '../../ai/runtime/ai.service';
import { fromDbDate } from '../../check-ins/local-date';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { coachAudioDisabledError, coachPersonaUnknownError, coachPreviewRateLimitedError } from '../coach-errors';
import { coachUserSettingsOf } from '../planning/coach-planner.service';
import { isCoachPersonaId, type Intensity } from '../personas';
import { renderPersonaStyle, resolveRegister } from '../personas/resolve-register';
import { fillPlaceholders } from '../nudges/static-fallback';
import type { NudgeFill } from '../nudges/nudge-context';
import { COACH_VOICE_FEATURE_ID } from './coach-audio.service';
import { CoachPreviewRateLimiter } from './coach-preview-rate-limiter';
import {
  COACH_PREVIEW_DEFAULT_MOMENT,
  type CoachVoicePreviewRequest,
  type CoachVoicePreviewStarted,
} from './dto/coach-voice-preview.dto';

/** Fixed demo values for a sample line's placeholders: never the caller's data. */
export const COACH_PREVIEW_FILL: NudgeFill = { n: 3, streak: 4, lift: 'Squat 100 kg', time: '18:00' };

@Injectable()
export class CoachVoicePreviewService {
  private readonly logger = new Logger(CoachVoicePreviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
    private readonly features: AiFeatureModelResolver,
    private readonly ai: AiService,
    private readonly limiter: CoachPreviewRateLimiter,
  ) {}

  async preview(userId: string, dto: CoachVoicePreviewRequest, now: Date = new Date()): Promise<CoachVoicePreviewStarted> {
    const policy = await this.systemSettings.getCoachPolicy();
    if (!policy.allowAudio) throw coachAudioDisabledError();

    if (!isCoachPersonaId(dto.personaId)) throw coachPersonaUnknownError();

    const resolution = await this.features.resolve(userId, COACH_VOICE_FEATURE_ID);
    if (!RUNNABLE_FEATURE_STATES.includes(resolution.state) || !resolution.model) {
      throw new ConflictException({
        message: `No AI model is available for the coach voice (${resolution.state}).`,
        details: {
          reason: 'AI_FEATURE_UNAVAILABLE',
          featureId: COACH_VOICE_FEATURE_ID,
          state: resolution.state,
          fix: resolution.fix,
        },
      });
    }

    const row = await this.prisma.userSettings.findUnique({
      where: { userId },
      select: { value: true, user: { select: { healthProfile: { select: { dateOfBirth: true } } } } },
    });
    const settings = coachUserSettingsOf(row?.value ?? null);
    const dob = row?.user?.healthProfile?.dateOfBirth ?? null;
    const intensity = clampIntensity(dto.intensity ?? settings.intensity);

    // The caller's register, re-evaluated now, for the persona and level they
    // are previewing (the toggle is theirs; persona and level are the preview's).
    const register = resolveRegister(
      { ...settings, personaId: dto.personaId, intensity },
      policy,
      { dateOfBirth: dob ? fromDbDate(dob) : null },
      now,
    );
    const style = renderPersonaStyle(dto.personaId, intensity, register);
    const moment = dto.moment ?? COACH_PREVIEW_DEFAULT_MOMENT;
    const line = fillPlaceholders(style.persona.sampleLines[moment][style.intensity], COACH_PREVIEW_FILL);
    const voice = dto.voice ?? style.voice;
    const censored = style.intensity !== intensity;

    const decision = this.limiter.take(userId, now.getTime());
    if (!decision.allowed) {
      this.logger.log(`Coach voice preview refused for user ${userId}: rate limited`);
      throw coachPreviewRateLimitedError(decision.retryAfterMs);
    }

    const handle = await this.ai.forUser(userId).speak({
      provider: resolution.model.provider,
      model: resolution.model.modelId,
      input: line,
      voice,
      speed: dto.speed ?? settings.audio.speed,
      instructions: style.ttsInstructions,
    });

    this.logger.log(
      `Coach voice preview for user ${userId}: run ${handle.runId} (${style.persona.id} L${style.intensity}, ${moment})`,
    );
    return {
      runId: handle.runId,
      jobId: handle.jobId,
      personaId: style.persona.id,
      intensity: style.intensity,
      moment,
      voice,
      censored,
    };
  }
}

function clampIntensity(value: number): Intensity {
  return Math.min(3, Math.max(1, Math.round(value))) as Intensity;
}
