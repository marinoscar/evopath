// =============================================================================
// "Prefill from photo" (E4.5) test fixtures
// =============================================================================
//
// `workout-prefill/*.model-output.json` is what the fake provider answers as
// the model's structured output: `placard` for the machine placard photo
// `docs/examples/gym-scan/leg-curl-placard.jpg`, `notebook` for a handwritten
// notebook page (the fake ignores pixels, so any image stands in for it).
//
// `placard.expected-drafts.json` is exactly what the review screen must
// receive (the `DraftItemView`s without `id` and `sortOrder`); `<photoN>`
// stands for the storage object id of the N-th uploaded photo.
//
// The notebook's expected drafts depend on the user's Health Profile unit
// (a weight without a written unit is read in it), so they are BUILT from the
// table in the story rather than stored: `notebookExpectedDrafts('lb' | 'kg')`.
//
// `seedExerciseVocabulary()` builds the vocabulary from `prisma/seed-data.ts`,
// the same rows `npm run prisma:seed` writes, for tests without a database.
// =============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { EXERCISE_CATALOG } from '../../prisma/seed-data';
import type { ExerciseVocabulary } from '../../src/workouts/prefill/exercise-vocabulary';

export const WORKOUT_PREFILL_FIXTURE_DIR = join(__dirname, 'workout-prefill');

export type WorkoutPrefillExample = 'placard' | 'notebook' | 'workout-empty';

export function loadPrefillModelOutput(example: WorkoutPrefillExample): any {
  return JSON.parse(readFileSync(join(WORKOUT_PREFILL_FIXTURE_DIR, `${example}.model-output.json`), 'utf8'));
}

/** The placard's expected drafts with `<photoN>` replaced by `photoIds[N]`. */
export function loadPlacardExpectedDrafts(photoIds: readonly string[]): any[] {
  const raw = readFileSync(join(WORKOUT_PREFILL_FIXTURE_DIR, 'placard.expected-drafts.json'), 'utf8');
  return JSON.parse(raw.replace(/<photo(\d+)>/g, (_match, index: string) => photoIds[Number(index)]));
}

interface NotebookRow {
  exerciseSlug: string | null;
  name: string;
  rawText: string;
  /** [weight as written (null = none), reps, durationSeconds] */
  sets: Array<[number | null, number | null, number | null]>;
  confidence: 'high' | 'medium' | 'low';
  uncertain: boolean;
  note: string | null;
  /** The confidence when the unit had to be assumed (a `high` becomes `medium`). */
  confidenceWhenAssumed?: 'medium';
}

/** The story's table, before unit conversion. */
const NOTEBOOK_TABLE: NotebookRow[] = [
  {
    exerciseSlug: 'barbell_bench_press',
    name: 'Barbell bench press',
    rawText: 'Bench 135 x 10, 10, 8',
    sets: [
      [135, 10, null],
      [135, 10, null],
      [135, 8, null],
    ],
    confidence: 'medium',
    uncertain: true,
    note: 'Bench is read as barbell bench press; the weight unit is not written.',
  },
  {
    exerciseSlug: 'incline_dumbbell_press',
    name: 'Incline dumbbell press',
    rawText: 'Incline DB press 50 x 12 x 3',
    sets: [
      [50, 12, null],
      [50, 12, null],
      [50, 12, null],
    ],
    confidence: 'medium',
    uncertain: true,
    note: 'Read as 50 x 12 for 3 sets; the notation order is ambiguous and the unit is not written.',
  },
  {
    exerciseSlug: 'triceps_pushdown',
    name: 'Triceps pushdown',
    rawText: 'Tricep pushdown 40 x 15, 15',
    sets: [
      [40, 15, null],
      [40, 15, null],
    ],
    confidence: 'high',
    confidenceWhenAssumed: 'medium',
    uncertain: false,
    note: null,
  },
  {
    exerciseSlug: 'plank',
    name: 'Plank',
    rawText: 'Plank 60s',
    sets: [[null, null, 60]],
    confidence: 'high',
    uncertain: false,
    note: null,
  },
  {
    exerciseSlug: null,
    name: 'Unreadable cable exercise',
    rawText: 'Cbl r? 25x12',
    sets: [[25, 12, null]],
    confidence: 'low',
    uncertain: true,
    note: 'Handwriting is unclear; it might be a cable row.',
  },
];

/** The kilograms the story's table lists, per written weight and unit. */
const KG: Record<'lb' | 'kg', Record<number, number>> = {
  lb: { 135: 61.235, 50: 22.68, 40: 18.144, 25: 11.34 },
  kg: { 135: 135, 50: 50, 40: 40, 25: 25 },
};

/**
 * The notebook's expected drafts for a user whose profile unit is `unit`
 * (`lb` = Imperial). Every weighed item gets the unit note, is uncertain, and
 * a `high` confidence drops to `medium`; Plank has no weight and no note.
 */
export function notebookExpectedDrafts(unit: 'lb' | 'kg', photoIds: readonly string[]): any[] {
  return NOTEBOOK_TABLE.map((row) => {
    const weighed = row.sets.some(([weight]) => weight !== null);
    const notes = [row.note, weighed ? `Unit not written; assumed ${unit}.` : null].filter(Boolean);

    return {
      kind: 'exercise',
      origin: 'ai',
      status: 'pending',
      confidence: weighed ? (row.confidenceWhenAssumed ?? row.confidence) : row.confidence,
      uncertain: row.uncertain || weighed,
      uncertaintyNote: notes.length > 0 ? notes.join(' ') : null,
      sourcePhotoIds: [photoIds[0]],
      userVerified: false,
      originalAiValue: null,
      value: {
        exerciseSlug: row.exerciseSlug,
        name: row.name,
        rawText: row.rawText,
        sets: row.sets.map(([weight, reps, durationSeconds]) => ({
          reps,
          weightKg: weight === null ? null : KG[unit][weight],
          durationSeconds,
          distanceMeters: null,
        })),
      },
    };
  });
}

export function seedExerciseVocabulary(): ExerciseVocabulary {
  return {
    exercises: [...EXERCISE_CATALOG]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((exercise) => ({ slug: exercise.slug, name: exercise.name, aliases: [] })),
  };
}
