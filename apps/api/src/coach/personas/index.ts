// =============================================================================
// The AI Coach persona registry (E7.2, #242; docs/specs/ai-coach.md §2.3)
// =============================================================================
//
// `COACH_PERSONAS` is the one place persona text lives. Add a persona by
// adding its `*.persona.ts` file and registering it below (spec §4.1); the
// completeness check here and `persona-registry.spec.ts` refuse a persona with
// a missing moment or intensity.
// =============================================================================

import { ANALYST_PERSONA } from './analyst.persona';
import { BUTLER_PERSONA } from './butler.persona';
import { COACH_PERSONA } from './coach.persona';
import { DRILL_SERGEANT_PERSONA } from './drill-sergeant.persona';
import { HYPE_PERSONA } from './hype.persona';
import { NANA_PERSONA } from './nana.persona';
import {
  COACH_INTENSITIES,
  COACH_MOMENTS,
  COACH_PERSONA_IDS,
  COACH_PERSONA_VOICES,
  type CoachPersonaId,
  type Persona,
} from './persona.types';
import { STOIC_PERSONA } from './stoic.persona';

export * from './persona.types';

/** Every persona, in gallery order (`COACH_PERSONA_IDS`). */
export const COACH_PERSONAS: readonly Persona[] = Object.freeze([
  COACH_PERSONA,
  DRILL_SERGEANT_PERSONA,
  STOIC_PERSONA,
  ANALYST_PERSONA,
  BUTLER_PERSONA,
  HYPE_PERSONA,
  NANA_PERSONA,
]);

/** The persona every user starts with (`COACH_USER_DEFAULTS.personaId`). */
export const DEFAULT_COACH_PERSONA_ID: CoachPersonaId = 'coach';

const BY_ID: ReadonlyMap<string, Persona> = new Map(COACH_PERSONAS.map((p) => [p.id, p]));

/** True when `id` names a registry persona. */
export function isCoachPersonaId(id: unknown): id is CoachPersonaId {
  return typeof id === 'string' && BY_ID.has(id);
}

/** The persona for `id`, or `undefined`. */
export function findCoachPersona(id: string): Persona | undefined {
  return BY_ID.get(id);
}

/**
 * The persona for `id`, falling back to the default persona for an id the
 * registry no longer knows (a stored id from a removed persona must not break
 * a read).
 */
export function getCoachPersona(id: string): Persona {
  return BY_ID.get(id) ?? (BY_ID.get(DEFAULT_COACH_PERSONA_ID) as Persona);
}

/**
 * Structural problems with the registry: ids out of step with
 * `COACH_PERSONA_IDS`, a missing or empty sample line, an unknown voice, a
 * profane level on a persona other than Sarge. Empty when the registry is
 * complete. `CoachModule` calls `assertCoachRegistryComplete` at init so a
 * broken registry fails the boot, not a request.
 */
export function coachRegistryProblems(personas: readonly Persona[] = COACH_PERSONAS): string[] {
  const problems: string[] = [];
  const ids = personas.map((p) => p.id);

  if (ids.join(',') !== COACH_PERSONA_IDS.join(',')) {
    problems.push(`persona ids ${JSON.stringify(ids)} do not match COACH_PERSONA_IDS`);
  }

  for (const persona of personas) {
    if (!persona.name.trim() || !persona.tagline.trim() || !persona.avatar.trim()) {
      problems.push(`${persona.id}: name, tagline and avatar are required`);
    }
    for (const intensity of COACH_INTENSITIES) {
      const voice = persona.voice.byIntensity[intensity];
      if (!(COACH_PERSONA_VOICES as readonly string[]).includes(voice)) {
        problems.push(`${persona.id}: unknown voice ${String(voice)} at intensity ${intensity}`);
      }
      if (!persona.rubric[intensity]?.label.trim() || !persona.rubric[intensity]?.guidance.trim()) {
        problems.push(`${persona.id}: rubric missing at intensity ${intensity}`);
      }
      for (const moment of COACH_MOMENTS) {
        const line = persona.sampleLines[moment]?.[intensity];
        if (typeof line !== 'string' || line.trim().length === 0) {
          problems.push(`${persona.id}: no sample line for ${moment} at intensity ${intensity}`);
        }
      }
    }
    if (!persona.voice.instructions.trim()) {
      problems.push(`${persona.id}: TTS instructions are required`);
    }
    // Condition 4 of the profanity unlock (spec §2.4): only Sarge at L3.
    const profane = [...persona.profaneIntensities];
    const allowed = persona.id === 'drill_sergeant' ? [3] : [];
    if (profane.join(',') !== allowed.join(',')) {
      problems.push(`${persona.id}: profane intensities ${JSON.stringify(profane)}, expected ${JSON.stringify(allowed)}`);
    }
  }

  return problems;
}

export function assertCoachRegistryComplete(personas: readonly Persona[] = COACH_PERSONAS): void {
  const problems = coachRegistryProblems(personas);
  if (problems.length > 0) {
    throw new Error(`Coach persona registry is incomplete:\n- ${problems.join('\n- ')}`);
  }
}
