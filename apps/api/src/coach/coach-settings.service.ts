import { Injectable, Logger, Optional } from '@nestjs/common';

import { AppMetricsService, fallbackAppMetrics } from '../common/otel/app-metrics.service';
import type { SystemCoachValue } from '../common/schemas/settings.schema';
import {
  resolveCoachUserSettings,
  type CoachSettingsPatchValue,
  type CoachSettingsValue,
  type ResolvedCoachUserSettings,
} from '../common/schemas/user-settings-namespaces.schema';
import { HealthProfileService } from '../health-profile/health-profile.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { UserSettingsService } from '../settings/user-settings/user-settings.service';
import {
  coachAudioDisabledError,
  coachDisabledError,
  coachPersonaUnknownError,
  coachProfanityLockedError,
} from './coach-errors';
import type { CoachPersonaCardData } from './dto/coach-personas.dto';
import type { CoachSettingsViewData, PutCoachSettingsValue } from './dto/coach-settings.dto';
import {
  COACH_INTENSITIES,
  COACH_MOMENTS,
  COACH_PERSONAS,
  isCoachPersonaId,
  type Intensity,
  type IntensityLines,
} from './personas';
import { renderIntensity, renderPersonaStyle, resolveRegister, type CoachRegister } from './personas/resolve-register';

// =============================================================================
// CoachSettingsService — /api/coach/personas and /api/coach/settings (E7.2)
// =============================================================================
//
// The unlock rules live HERE and in `resolveRegister`, never in the client:
//
//   - `personaId` must name a registry persona        -> 400 COACH_PERSONA_UNKNOWN
//   - `enabled: true` while the system switch is off   -> 403 COACH_DISABLED
//   - `audio.enabled: true` while `allowAudio` is off  -> 403 COACH_AUDIO_DISABLED
//   - `profanity: true` while condition 1, 2 or 4 fails -> 403 COACH_PROFANITY_LOCKED
//     (`details.reason` names it); nothing is stored
//   - `confirmAdult: true` stamps `adultConfirmedAt = now` server-side
//
// A refused write stores nothing. Reads re-evaluate the register every time,
// so a stored `profanity: true` that a later system change invalidates reads
// `profane: false` without the stored value being touched (spec §2.4).
//
// ⚠ NEVER LOG VALUES. The date of birth and `why` never reach a log line;
// a profanity change is logged as the user id and a boolean.
// =============================================================================

type CoachContext = {
  stored: CoachSettingsValue | undefined;
  resolved: ResolvedCoachUserSettings;
  policy: SystemCoachValue;
  dateOfBirth: string | null;
};

@Injectable()
export class CoachSettingsService {
  private readonly logger = new Logger(CoachSettingsService.name);

  constructor(
    private readonly userSettings: UserSettingsService,
    private readonly systemSettings: SystemSettingsService,
    private readonly healthProfile: HealthProfileService,
    @Optional() private readonly metrics: AppMetricsService = fallbackAppMetrics(),
  ) {}

  /** The caller's register now: every unlock condition re-read. */
  async registerFor(userId: string, now: Date = new Date()): Promise<CoachRegister> {
    const ctx = await this.load(userId);
    return this.register(ctx, now);
  }

  async personas(userId: string): Promise<CoachPersonaCardData[]> {
    const register = await this.registerFor(userId);

    return COACH_PERSONAS.map((persona) => {
      const censored = persona.profaneIntensities.length > 0 && !register.profane;
      const sampleLines = Object.fromEntries(
        COACH_MOMENTS.map((moment) => {
          const lines = {} as Record<Intensity, string>;
          for (const level of COACH_INTENSITIES) {
            lines[level] = persona.sampleLines[moment][renderIntensity(persona, level, register)];
          }
          return [moment, lines as IntensityLines];
        }),
      ) as CoachPersonaCardData['sampleLines'];

      return {
        id: persona.id,
        name: persona.name,
        tagline: persona.tagline,
        vibe: persona.vibe,
        avatar: persona.avatar,
        style: persona.styleCard.summary,
        intensities: COACH_INTENSITIES.map((level) => ({
          level,
          label: persona.rubric[level].label,
          voice: persona.voice.byIntensity[level],
          profane: persona.profaneIntensities.includes(level),
        })),
        sampleLines,
        censored,
      };
    });
  }

  async view(userId: string): Promise<CoachSettingsViewData> {
    return this.toView(await this.load(userId), new Date());
  }

  async update(userId: string, dto: PutCoachSettingsValue): Promise<CoachSettingsViewData> {
    const now = new Date();
    const { confirmAdult, ...fields } = dto;

    if (fields.personaId !== undefined && fields.personaId !== null && !isCoachPersonaId(fields.personaId)) {
      throw coachPersonaUnknownError();
    }

    const before = await this.load(userId);
    const patch: CoachSettingsPatchValue = {
      ...fields,
      ...(confirmAdult === true ? { adultConfirmedAt: now.toISOString() } : {}),
    };
    const next: CoachContext = { ...before, resolved: resolveCoachUserSettings(applyCoachPatch(before.stored, patch)) };

    if (patch.enabled === true && !before.policy.enabled) throw coachDisabledError();
    if (patch.audio?.enabled === true && !before.policy.allowAudio) throw coachAudioDisabledError();
    if (patch.profanity === true) {
      const register = this.register(next, now);
      if (!register.profane) throw coachProfanityLockedError(register.reason ?? 'toggle_off');
    }

    const saved = await this.userSettings.patchSettings(userId, { coach: patch } as never);
    const after: CoachContext = {
      ...before,
      stored: saved.coach,
      resolved: resolveCoachUserSettings(saved.coach),
    };

    if (before.resolved.profanity !== after.resolved.profanity) {
      this.logger.log(`coach profanity changed userId=${userId} profanity=${after.resolved.profanity}`);
    }
    if (confirmAdult === true) {
      this.logger.log(`coach adult confirmation stamped userId=${userId}`);
    }
    this.metrics.coachSettingsUpdate(after.resolved.personaId);

    return this.toView(after, now);
  }

  private async load(userId: string): Promise<CoachContext> {
    const [settings, policy, profile] = await Promise.all([
      this.userSettings.getSettings(userId),
      this.systemSettings.getCoachPolicy(),
      this.healthProfile.get(userId),
    ]);

    return {
      stored: settings.coach,
      resolved: resolveCoachUserSettings(settings.coach),
      policy,
      dateOfBirth: profile.dateOfBirth,
    };
  }

  private register(ctx: CoachContext, now: Date): CoachRegister {
    return resolveRegister(ctx.resolved, ctx.policy, { dateOfBirth: ctx.dateOfBirth }, now);
  }

  private toView(ctx: CoachContext, now: Date): CoachSettingsViewData {
    const register = this.register(ctx, now);
    const s = ctx.resolved;
    const style = renderPersonaStyle(s.personaId, clampIntensity(s.intensity), register);

    return {
      settings: {
        ...s,
        audio: { ...s.audio },
        quietHours: { ...s.quietHours },
      },
      effective: {
        maxNudgesPerDay: Math.min(s.maxNudgesPerDay, ctx.policy.maxNudgesPerDayCeiling),
        register,
        intensity: style.intensity,
        voice: s.audio.voice ?? style.voice,
      },
      policy: {
        enabled: ctx.policy.enabled,
        allowProfanePersonas: ctx.policy.allowProfanePersonas,
        allowAudio: ctx.policy.allowAudio,
        maxNudgesPerDayCeiling: ctx.policy.maxNudgesPerDayCeiling,
      },
    };
  }
}

function clampIntensity(value: number): Intensity {
  return (Math.min(3, Math.max(1, Math.round(value))) as Intensity);
}

/**
 * The stored namespace a PATCH would produce, for EVALUATING the unlock rules
 * before anything is written. Same semantics as
 * `UserSettingsService.mergeCoach` (which performs the real write): omitted
 * keeps, a value replaces, `null` deletes, and `audio`/`quietHours` merge one
 * level deeper.
 */
export function applyCoachPatch(
  stored: CoachSettingsValue | undefined,
  patch: CoachSettingsPatchValue,
): CoachSettingsValue {
  const out: Record<string, unknown> = { ...(stored ?? {}) };

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if ((key === 'audio' || key === 'quietHours') && value !== null) {
      const nested: Record<string, unknown> = { ...((out[key] as Record<string, unknown> | undefined) ?? {}) };
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v === undefined) continue;
        if (v === null) delete nested[k];
        else nested[k] = v;
      }
      if (Object.keys(nested).length > 0) out[key] = nested;
      else delete out[key];
      continue;
    }
    if (value === null) delete out[key];
    else out[key] = value;
  }

  return out as CoachSettingsValue;
}
