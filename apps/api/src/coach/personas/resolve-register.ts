// =============================================================================
// resolveRegister — the ONE answer to "is profanity allowed" (E7.2, #242)
// =============================================================================
//
// docs/specs/ai-coach.md §2.4. Profanity requires ALL FOUR conditions, checked
// in this order; the first that fails is the `reason`:
//
//   1 system_disabled       system `coach.allowProfanePersonas` is false
//   2 underage              the health profile's date of birth says < 18
//                           (wins over any attestation)
//     age_unverified        no date of birth and no `coach.adultConfirmedAt`
//   3 toggle_off            the user's `coach.profanity` is false
//   4 persona_or_intensity  not `drill_sergeant` at intensity 3
//
// Pure and re-evaluated on every call: never cache the result. The prompt
// builder, the content guard, the preview route and the settings route all
// call it; nothing else may decide the question. Failing closed means Sarge
// L3 renders as Sarge L2 (`renderIntensity`).
// =============================================================================

import { getCoachPersona } from './index';
import type { Intensity, Persona, PersonaRubricLevel, CoachPersonaVoice } from './persona.types';

export const COACH_REGISTER_REASONS = [
  'system_disabled',
  'age_unverified',
  'underage',
  'toggle_off',
  'persona_or_intensity',
] as const;

export type CoachRegisterReason = (typeof COACH_REGISTER_REASONS)[number];

export interface CoachRegister {
  profane: boolean;
  /** The failed unlock condition; `null` exactly when `profane`. */
  reason: CoachRegisterReason | null;
}

/** The only persona and level that may ever be profane (condition 4). */
export const PROFANE_PERSONA_ID = 'drill_sergeant';
export const PROFANE_INTENSITY: Intensity = 3;

export const ADULT_AGE_YEARS = 18;

/** What `resolveRegister` reads from the user's resolved `coach` namespace. */
export interface RegisterUserInput {
  personaId: string;
  intensity: number;
  profanity: boolean;
  adultConfirmedAt: string | null;
}

/** What it reads from the system `coach` setting. */
export interface RegisterSystemInput {
  allowProfanePersonas: boolean;
}

/** What it reads from the health profile: `YYYY-MM-DD` or null. */
export interface RegisterProfileInput {
  dateOfBirth: string | null;
}

/**
 * Whole years between a `YYYY-MM-DD` date of birth and `now` (UTC calendar
 * date), or `null` when the value is not a valid date.
 */
export function ageInYears(dateOfBirth: string, now: Date): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;

  const ny = now.getUTCFullYear();
  const nm = now.getUTCMonth() + 1;
  const nd = now.getUTCDate();
  let age = ny - y;
  if (nm < m || (nm === m && nd < d)) age -= 1;
  return age;
}

/**
 * Condition 2 alone: `null` when the user counts as an adult, otherwise the
 * reason. A date of birth, when present, decides (under 18 fails regardless
 * of `adultConfirmedAt`); without one, the self-attestation decides.
 */
export function adultCheck(
  user: Pick<RegisterUserInput, 'adultConfirmedAt'>,
  profile: RegisterProfileInput | null | undefined,
  now: Date,
): 'underage' | 'age_unverified' | null {
  const dob = profile?.dateOfBirth ?? null;
  if (dob !== null) {
    const age = ageInYears(dob, now);
    // An unreadable DOB is not evidence of adulthood: fail closed.
    if (age === null) return 'age_unverified';
    return age >= ADULT_AGE_YEARS ? null : 'underage';
  }
  return user.adultConfirmedAt ? null : 'age_unverified';
}

/** Condition 4 alone. */
export function isProfaneCombination(personaId: string, intensity: number): boolean {
  return personaId === PROFANE_PERSONA_ID && intensity === PROFANE_INTENSITY;
}

export function resolveRegister(
  user: RegisterUserInput,
  system: RegisterSystemInput,
  profile: RegisterProfileInput | null | undefined,
  now: Date = new Date(),
): CoachRegister {
  if (system.allowProfanePersonas !== true) return { profane: false, reason: 'system_disabled' };

  const age = adultCheck(user, profile, now);
  if (age !== null) return { profane: false, reason: age };

  if (user.profanity !== true) return { profane: false, reason: 'toggle_off' };

  if (!isProfaneCombination(user.personaId, user.intensity)) {
    return { profane: false, reason: 'persona_or_intensity' };
  }

  return { profane: true, reason: null };
}

/**
 * The intensity a persona is RENDERED at: the requested level, unless that
 * level is profane and the register is not, in which case the nearest clean
 * level below it (Sarge L3 locked -> Sarge L2).
 */
export function renderIntensity(persona: Persona, intensity: Intensity, register: CoachRegister): Intensity {
  let level = intensity;
  while (!register.profane && persona.profaneIntensities.includes(level) && level > 1) {
    level = (level - 1) as Intensity;
  }
  return level;
}

/** What the prompt builder (E7.5), the chat (E7.7) and the preview (E7.6) take from a persona. */
export interface RenderedPersonaStyle {
  persona: Persona;
  /** The level actually rendered (see `renderIntensity`). */
  intensity: Intensity;
  rubric: PersonaRubricLevel;
  voice: CoachPersonaVoice;
  /** TTS instructions for the rendered level. */
  ttsInstructions: string;
  register: CoachRegister;
}

/**
 * The persona card at the user's intensity under the given register. A locked
 * register never yields a profane rubric, voice or instruction.
 */
export function renderPersonaStyle(personaId: string, intensity: Intensity, register: CoachRegister): RenderedPersonaStyle {
  const persona = getCoachPersona(personaId);
  const level = renderIntensity(persona, intensity, register);
  const extra = persona.voice.extraInstructions?.[level];

  return {
    persona,
    intensity: level,
    rubric: persona.rubric[level],
    voice: persona.voice.byIntensity[level],
    ttsInstructions: extra ? `${persona.voice.instructions} ${extra}` : persona.voice.instructions,
    register,
  };
}
