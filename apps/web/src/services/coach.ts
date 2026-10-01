/**
 * The AI Coach's settings, as the web app sees them (E7.3, #243;
 * docs/specs/ai-coach.md §2.3, §2.4, §3.1, §3.2, §3.6, §3.7).
 *
 *   GET  /api/coach/personas          ai:use   the persona gallery (static sample lines)
 *   GET  /api/coach/settings          ai:use   my settings, the effective register, the policy
 *   PUT  /api/coach/settings          ai:use   merge-patch; `null` resets; `confirmAdult: true`
 *   GET  /api/admin/coach/settings    ai_config:read    the deployment's coach policy
 *   PUT  /api/admin/coach/settings    ai_config:write   any subset of the policy
 *
 * THE API DECIDES. Whether profanity is allowed (`effective.register`), the
 * nudge cap actually applied and whether Sarge's level-3 lines are served
 * uncensored are all answered server-side; the page only renders them. The
 * browser never stamps `adultConfirmedAt`: the 18+ dialog sends
 * `confirmAdult: true` and the server records the time.
 *
 * Coach refusals carry their code in `details.code` (the envelope's `code` is
 * status-derived); `COACH_PROFANITY_LOCKED` names the failed unlock condition
 * in `details.reason`.
 */
import { api, ApiError } from './api';
import type { CoachPhotoCadence } from '../types';

// -----------------------------------------------------------------------------
// Constants mirrored from the API
// -----------------------------------------------------------------------------

/** Mirrors `COACH_MOMENTS` (`apps/api/src/coach/personas/persona.types.ts`), in display order. */
export const COACH_MOMENTS = [
  'missed_twice',
  'streak_at_risk',
  'comeback',
  'pr',
  'weekly_target_hit',
  'missed_session',
  'fresh_start',
  'photo_prompt',
  'win_back',
  'back_off',
  'kickoff',
  'weekly_review',
] as const;

export type CoachMoment = (typeof COACH_MOMENTS)[number];

export const COACH_MOMENT_LABELS: Record<CoachMoment, string> = {
  missed_twice: 'Missed two sessions',
  streak_at_risk: 'Streak at risk',
  comeback: 'Comeback',
  pr: 'Personal record',
  weekly_target_hit: 'Weekly target hit',
  missed_session: 'Missed a session',
  fresh_start: 'Fresh start',
  photo_prompt: 'Progress photo',
  win_back: 'Win-back',
  back_off: 'Backing off',
  kickoff: 'Program kickoff',
  weekly_review: 'Weekly review',
};

/** Mirrors `COACH_REGISTER_REASONS` (`resolve-register.ts`). */
export type CoachRegisterReason =
  | 'system_disabled'
  | 'age_unverified'
  | 'underage'
  | 'toggle_off'
  | 'persona_or_intensity';

/** The one persona with a profane level (spec §2.4, condition 4). */
export const PROFANE_PERSONA_ID = 'drill_sergeant';
export const PROFANE_INTENSITY = 3;

export const COACH_PHOTO_CADENCES: readonly CoachPhotoCadence[] = ['off', 'weekly', 'biweekly', 'monthly'];

export const COACH_INTENSITY_MIN = 1;
export const COACH_INTENSITY_MAX = 3;
export const COACH_AUDIO_SPEED_MIN = 0.75;
export const COACH_AUDIO_SPEED_MAX = 1.5;
export const COACH_WHY_MAX_LENGTH = 200;
/** The schema's own ceiling on `maxNudgesPerDay` and on the admin's `maxNudgesPerDayCeiling`. */
export const COACH_MAX_NUDGES_PER_DAY_MAX = 4;
/** `HH:mm`, 24-hour: mirrors `COACH_TIME_OF_DAY_PATTERN`. */
export const COACH_TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Coach codes, carried in `details.code`. Mirrors `COACH_ERRORS`. */
export const COACH_ERRORS = {
  DISABLED: 'COACH_DISABLED',
  PROFANITY_LOCKED: 'COACH_PROFANITY_LOCKED',
  AUDIO_DISABLED: 'COACH_AUDIO_DISABLED',
  PERSONA_UNKNOWN: 'COACH_PERSONA_UNKNOWN',
  PREVIEW_RATE_LIMITED: 'COACH_PREVIEW_RATE_LIMITED',
} as const;

// -----------------------------------------------------------------------------
// GET /api/coach/personas
// -----------------------------------------------------------------------------

export interface CoachPersonaIntensity {
  level: number;
  label: string;
  /** Default voice at this level. */
  voice: string;
  /** Adult language (Sarge L3 only). */
  profane: boolean;
}

export interface CoachPersonaCard {
  id: string;
  name: string;
  tagline: string;
  vibe: string;
  /** Icon key (`whistle`, `military_tech`, ...). */
  avatar: string;
  /** The style card's summary. */
  style: string;
  intensities: CoachPersonaIntensity[];
  /** Every moment at every intensity (`'1' | '2' | '3'` keys). */
  sampleLines: Record<CoachMoment, Record<string, string>>;
  /** The profane level's lines were withheld (the clean level stands in). */
  censored: boolean;
}

export function getCoachPersonas(): Promise<CoachPersonaCard[]> {
  return api.get<CoachPersonaCard[]>('/coach/personas');
}

// -----------------------------------------------------------------------------
// GET / PUT /api/coach/settings
// -----------------------------------------------------------------------------

export interface CoachSettingsValue {
  enabled: boolean;
  personaId: string;
  intensity: number;
  profanity: boolean;
  adultConfirmedAt: string | null;
  audio: { enabled: boolean; voice: string | null; speed: number };
  quietHours: { start: string; end: string };
  maxNudgesPerDay: number;
  lockScreenSafe: boolean;
  photoCadence: CoachPhotoCadence;
  why: string | null;
  preferredTime: string | null;
}

export interface CoachRegister {
  profane: boolean;
  /** The failed unlock condition; `null` exactly when `profane`. */
  reason: CoachRegisterReason | null;
}

export interface CoachPolicy {
  enabled: boolean;
  allowProfanePersonas: boolean;
  allowAudio: boolean;
  maxNudgesPerDayCeiling: number;
}

export interface CoachSettingsView {
  settings: CoachSettingsValue;
  effective: {
    /** `maxNudgesPerDay` clamped to the ceiling. */
    maxNudgesPerDay: number;
    register: CoachRegister;
    /** A locked Sarge L3 renders as L2. */
    intensity: number;
    voice: string;
  };
  policy: CoachPolicy;
}

/**
 * The PUT body: any subset; `null` resets a field to its default. Never
 * `adultConfirmedAt` (send `confirmAdult: true`).
 */
export interface CoachSettingsPut {
  enabled?: boolean | null;
  personaId?: string | null;
  intensity?: number | null;
  profanity?: boolean | null;
  audio?: { enabled?: boolean | null; voice?: string | null; speed?: number | null } | null;
  quietHours?: { start?: string | null; end?: string | null } | null;
  maxNudgesPerDay?: number | null;
  lockScreenSafe?: boolean | null;
  photoCadence?: CoachPhotoCadence | null;
  why?: string | null;
  preferredTime?: string | null;
  confirmAdult?: true;
}

export function getCoachSettings(): Promise<CoachSettingsView> {
  return api.get<CoachSettingsView>('/coach/settings');
}

export function updateCoachSettings(body: CoachSettingsPut): Promise<CoachSettingsView> {
  return api.put<CoachSettingsView>('/coach/settings', body);
}

// -----------------------------------------------------------------------------
// GET / PUT /api/admin/coach/settings
// -----------------------------------------------------------------------------

export interface SystemCoachSettings {
  enabled: boolean;
  allowProfanePersonas: boolean;
  allowAudio: boolean;
  maxNudgesPerDayCeiling: number;
  audioRetentionDays: number;
  autoSilenceAfterIgnored: number;
  inactiveStopDays: number;
}

/** Inclusive bounds of each numeric policy field; mirrors `systemCoachSchema`. */
export const SYSTEM_COACH_NUMBER_BOUNDS = {
  maxNudgesPerDayCeiling: { min: 1, max: COACH_MAX_NUDGES_PER_DAY_MAX },
  audioRetentionDays: { min: 1, max: 3650 },
  autoSilenceAfterIgnored: { min: 1, max: 20 },
  inactiveStopDays: { min: 1, max: 90 },
} as const;

export function getSystemCoachSettings(): Promise<SystemCoachSettings> {
  return api.get<SystemCoachSettings>('/admin/coach/settings');
}

export function updateSystemCoachSettings(patch: Partial<SystemCoachSettings>): Promise<SystemCoachSettings> {
  return api.put<SystemCoachSettings>('/admin/coach/settings', patch);
}

// -----------------------------------------------------------------------------
// POST /api/coach/voice-preview (E7.6; planned)
// -----------------------------------------------------------------------------

/**
 * Whether the voice preview route exists yet. E7.6 adds
 * `POST /api/coach/voice-preview` (rate-limited, static sample lines); until it
 * ships the page renders "Hear it" disabled with a tooltip. Feature-detecting
 * the route by calling it is deliberately not done: a successful probe is a
 * paid TTS call. E7.6 flips this constant.
 */
export const COACH_VOICE_PREVIEW_AVAILABLE = false;

export interface CoachVoicePreviewRequest {
  personaId: string;
  intensity?: number;
  voice?: string;
  speed?: number;
  moment?: CoachMoment;
}

/** The planned answer: the stored audio, played through `AiSpeechPlayer`. */
export interface CoachVoicePreview {
  storageObjectId: string;
  voice: string;
  format?: string;
  mimeType?: string;
  size?: number;
  characters?: number;
}

export function previewCoachVoice(body: CoachVoicePreviewRequest): Promise<CoachVoicePreview> {
  return api.post<CoachVoicePreview>('/coach/voice-preview', body);
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export interface CoachErrorInfo {
  status: number | null;
  /** `details.code` (a coach code) when present. */
  code: string | null;
  /** `details.reason`: the failed unlock condition for `COACH_PROFANITY_LOCKED`. */
  reason: string | null;
  message: string;
}

export function coachErrorOf(error: unknown, fallback = 'Something went wrong. Try again.'): CoachErrorInfo {
  if (error instanceof ApiError) {
    const details = (error.details ?? {}) as { code?: unknown; reason?: unknown };
    return {
      status: error.status,
      code: typeof details.code === 'string' ? details.code : null,
      reason: typeof details.reason === 'string' ? details.reason : null,
      message: error.message || fallback,
    };
  }
  return { status: null, code: null, reason: null, message: fallback };
}

/** Plain-language text for each failed unlock condition (spec §2.4). */
export const PROFANITY_REASON_TEXT: Record<CoachRegisterReason, string> = {
  system_disabled: 'Adult language is switched off for this deployment by your administrator.',
  underage:
    'Adult language is only for people aged 18 or over, and the date of birth in your health profile says you are under 18.',
  age_unverified: 'Confirm you are 18 or older to unlock adult language.',
  toggle_off: 'Adult language is off. Turn it on to hear Sarge uncensored.',
  persona_or_intensity: 'Adult language applies only to Sarge at Unhinged (level 3).',
};

export function profanityReasonText(reason: string | null | undefined): string {
  if (reason && reason in PROFANITY_REASON_TEXT) return PROFANITY_REASON_TEXT[reason as CoachRegisterReason];
  return 'Adult language cannot be turned on right now.';
}

/** A user-facing message for a failed `PUT /api/coach/settings`. */
export function coachSaveErrorMessage(info: CoachErrorInfo): string {
  switch (info.code) {
    case COACH_ERRORS.PROFANITY_LOCKED:
      return profanityReasonText(info.reason);
    case COACH_ERRORS.DISABLED:
      return 'The coach is switched off for this deployment, so it cannot be turned on.';
    case COACH_ERRORS.AUDIO_DISABLED:
      return 'Spoken coach messages are switched off for this deployment.';
    case COACH_ERRORS.PERSONA_UNKNOWN:
      return 'That persona is no longer available. Reload the page and choose another.';
    default:
      if (info.status === null || info.status >= 500) {
        return 'Could not reach the server, so nothing was saved. Your changes are still here; try again.';
      }
      return info.message;
  }
}
