import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type PlannerContextSource, supportedBy } from '../../../src/training-agents/context/build-planner-context';
import type { TrainingIntake } from '../../../src/training-agents/contracts/training-intake.contract';
import { fixtureId, contextSourceFixture, FIXTURE_NOW } from '../../../src/training-agents/testing/context-fixtures';
import { seedExercise, seedGym, SEED_LIBRARY } from '../support/seed-library';
import { type EvalPersona, personaSchema } from './persona.schema';

// =============================================================================
// Personas: load, validate against the seed, and turn into a context source
// =============================================================================

export const PERSONAS_DIR = join(__dirname, '../../fixtures/training/personas');
const DAY_MS = 24 * 60 * 60 * 1000;

/** Every persona file, validated. A slug the seed does not hold fails here, not mid-run. */
export function loadPersonas(): EvalPersona[] {
  const personas = readdirSync(PERSONAS_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
      const parsed = personaSchema.safeParse(JSON.parse(readFileSync(join(PERSONAS_DIR, file), 'utf8')));
      if (!parsed.success) throw new Error(`Persona ${file} is invalid: ${parsed.error.message}`);
      if (`${parsed.data.id}.json` !== file) throw new Error(`Persona file ${file} must be named after its id "${parsed.data.id}"`);
      return parsed.data;
    });

  for (const persona of personas) {
    const slugs = [
      ...(persona.allowedExercises ?? []),
      ...(persona.history?.exercises.map((e) => e.slug) ?? []),
      ...(persona.history?.painFlags ?? []),
      ...(((persona.intake.avoidExerciseKeys as string[] | undefined) ?? [])),
    ];
    for (const slug of slugs) seedExercise(slug);
    if (persona.gym) seedGym(persona.gym.equipment);
  }
  if (new Set(personas.map((p) => p.id)).size !== personas.length) throw new Error('Duplicate persona id');
  return personas;
}

export function intakeOf(persona: EvalPersona): TrainingIntake {
  return contextSourceOf(persona).intake;
}

/** The exercises a plan for this persona may use, by slug. */
export function allowedSlugs(persona: EvalPersona): Set<string> {
  if (persona.allowedExercises) return new Set(persona.allowedExercises);
  const gym = personaGymIds(persona);
  const avoid = new Set([...((persona.intake.avoidExerciseKeys as string[] | undefined) ?? []), ...(persona.history?.painFlags ?? [])]);
  return new Set(SEED_LIBRARY.filter((e) => !avoid.has(e.key) && supportedBy(e, gym)).map((e) => e.key));
}

function personaGymIds(persona: EvalPersona) {
  if (!persona.gym) return null;
  const gym = seedGym(persona.gym.equipment);
  return { equipmentTypeIds: gym.equipment.map((e) => e.equipmentTypeId), capabilityIds: gym.capabilities.map((c) => c.id) };
}

/** What the loader would read for this persona: profile, weights, gym, history and check-ins. */
export function contextSourceOf(persona: EvalPersona): PlannerContextSource {
  const gym = persona.gym ? seedGym(persona.gym.equipment) : null;
  const now = FIXTURE_NOW;

  const workouts: PlannerContextSource['workouts'] = [];
  if (persona.history) {
    const { weeks, sessionsPerWeek, exercises, painFlags } = persona.history;
    for (let week = 0; week < weeks; week += 1) {
      for (let session = 0; session < sessionsPerWeek; session += 1) {
        const startedAt = new Date(now.getTime() - (week * 7 + session * 2 + 1) * DAY_MS);
        const newest = week === 0 && session === 0;
        workouts.push({
          date: startedAt.toISOString().slice(0, 10),
          startedAt,
          completed: true,
          exercises: [
            ...exercises.map((e) => ({
              exerciseId: seedExercise(e.slug).id,
              sets: Array.from({ length: 3 }, () => ({ weightKg: e.weightKg, reps: e.reps, completed: true, isWarmup: false, painFlag: false })),
            })),
            ...(newest
              ? painFlags.map((slug) => ({
                  exerciseId: seedExercise(slug).id,
                  sets: [{ weightKg: 10, reps: 8, completed: true, isWarmup: false, painFlag: true }],
                }))
              : []),
          ],
        });
      }
    }
  }

  return contextSourceFixture({
    intake: { gymId: gym ? fixtureId(901, 'b') : null, ...persona.intake },
    profile: persona.profile
      ? {
          dateOfBirth: `${now.getUTCFullYear() - persona.profile.ageYears}-01-01`,
          sexAtBirth: persona.profile.sexAtBirth,
          heightMm: Math.round(persona.profile.heightCm * 10),
          unitSystem: 'metric',
          bio: null,
        }
      : null,
    weights: persona.profile ? [{ measuredAt: new Date(now.getTime() - 2 * DAY_MS), valueKg: persona.profile.weightKg }] : [],
    gym,
    library: SEED_LIBRARY,
    workouts,
    checkIns: persona.readiness ? [{ date: now.toISOString().slice(0, 10), ...persona.readiness }] : [],
  });
}
