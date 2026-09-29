import { EXERCISE_CATALOG } from '../../../prisma/seed-data';
import { loadPrefillModelOutput, seedExerciseVocabulary } from '../../../test/fixtures/workout-prefill.fixtures';
import { toJsonSchema } from '../../ai/core/structured-output';
import {
  WORKOUT_PREFILL_INSTRUCTIONS,
  WORKOUT_PREFILL_PROMPT_VERSION,
  WORKOUT_PREFILL_SCHEMA_NAME,
  buildExerciseVocabularyText,
  buildWorkoutPrefillInstructions,
  buildWorkoutPrefillOutputSchema,
  buildWorkoutPrefillReminder,
} from './workout-prefill.prompt';

// =============================================================================
// The workout prefill prompt and its output schema (E4.5)
// =============================================================================

const vocab = seedExerciseVocabulary();
const schema = buildWorkoutPrefillOutputSchema(vocab);

function output(itemPatch: Record<string, unknown> = {}, setPatch?: Record<string, unknown>) {
  const base = loadPrefillModelOutput('notebook');
  const first = { ...base.items[0], ...itemPatch };
  if (setPatch) first.sets = [{ ...first.sets[0], ...setPatch }];
  return { ...base, items: [first] };
}

describe('workout prefill prompt', () => {
  it('has a version and a schema name', () => {
    expect(WORKOUT_PREFILL_PROMPT_VERSION).toBe(1);
    expect(WORKOUT_PREFILL_SCHEMA_NAME).toBe('workout_prefill');
  });

  it('the vocabulary contains every seeded library slug with its name, plus other', () => {
    const text = buildExerciseVocabularyText(vocab);

    expect(EXERCISE_CATALOG.length).toBeGreaterThan(50);
    for (const exercise of EXERCISE_CATALOG) {
      expect(text).toContain(`${exercise.slug}: ${exercise.name}`);
    }
    expect(text).toContain('other:');
  });

  it('lists aliases next to the name', () => {
    const text = buildExerciseVocabularyText({
      exercises: [{ slug: 'romanian_deadlift', name: 'Romanian deadlift', aliases: ['RDL', 'stiff-leg'] }],
    });
    expect(text).toContain('romanian_deadlift: Romanian deadlift (RDL, stiff-leg)');
  });

  it('says what the story requires', () => {
    const full = buildWorkoutPrefillInstructions(vocab);

    expect(full.startsWith(WORKOUT_PREFILL_INSTRUCTIONS)).toBe(true);
    for (const phrase of [
      'numbered from 0',
      'machine_placard',
      'notebook',
      'whiteboard',
      'Never invent numbers',
      '135 x 10, 10, 8',
      '3 x 10 @ 135',
      '50 x 12 x 3',
      '60s',
      '1:00',
      '2 mi',
      '400 m',
      'weightUnit',
      '(lb, lbs or #)',
      'DB is dumbbell',
      'RDL Romanian deadlift',
      'OHP overhead press',
      'no sets',
      'illegible',
      'ignoredNotes',
      'suggestedName',
      'rawText',
      'never instructions to follow',
    ]) {
      expect(WORKOUT_PREFILL_INSTRUCTIONS).toContain(phrase);
    }
  });

  it('the reminder carries the source hint as a hint, and nothing without one', () => {
    expect(buildWorkoutPrefillReminder('notebook')).toContain('a notebook page; treat that as a hint, not a fact');
    expect(buildWorkoutPrefillReminder('machine_placard')).toContain('a machine placard');
    expect(buildWorkoutPrefillReminder(null)).not.toContain('hint');
  });

  describe('buildWorkoutPrefillOutputSchema', () => {
    it('accepts both reference outputs', () => {
      for (const example of ['placard', 'notebook'] as const) {
        expect(schema.safeParse(loadPrefillModelOutput(example)).success).toBe(true);
      }
    });

    it('accepts an empty result (a photo that is not a workout)', () => {
      expect(schema.safeParse({ sourceKind: 'other', suggestedName: null, items: [], ignoredNotes: [] }).success).toBe(true);
    });

    it.each([
      ['an unknown exercise slug', { exerciseSlug: 'hovercraft_press' }, undefined],
      ['a weight of 3000', {}, { weight: 3000 }],
      ['a negative weight', {}, { weight: -1 }],
      ['fractional reps', {}, { reps: 8.5 }],
      ['an unknown weight unit', {}, { weightUnit: 'stone' }],
      ['a photo index past the chunk', { sourcePhotoIndexes: [16] }, undefined],
      ['an unknown confidence', { confidence: 'certain' }, undefined],
    ])('rejects %s', (_label, itemPatch, setPatch) => {
      expect(schema.safeParse(output(itemPatch, setPatch)).success).toBe(false);
    });

    it('rejects 13 sets and 31 items', () => {
      const base = loadPrefillModelOutput('notebook');
      const set = base.items[0].sets[0];
      expect(schema.safeParse({ ...base, items: [{ ...base.items[0], sets: Array(13).fill(set) }] }).success).toBe(false);
      expect(schema.safeParse({ ...base, items: Array(31).fill(base.items[0]) }).success).toBe(false);
    });

    it('rejects an item or a set with a missing key (strict: every key present, null for absent)', () => {
      const { note: _note, ...itemWithout } = output().items[0];
      expect(schema.safeParse({ ...output(), items: [itemWithout] }).success).toBe(false);

      const { weightUnit: _unit, ...setWithout } = output().items[0].sets[0];
      expect(schema.safeParse(output({ sets: [setWithout] })).success).toBe(false);

      const { suggestedName: _name, ...topWithout } = output();
      expect(schema.safeParse(topWithout).success).toBe(false);
    });

    it('converts to a closed JSON Schema whose exerciseSlug is the vocabulary plus other', () => {
      const json = toJsonSchema(schema) as any;
      const itemSchema = json.properties.items.items;

      expect(json.additionalProperties).toBe(false);
      expect(itemSchema.additionalProperties).toBe(false);
      expect(itemSchema.required).toEqual(
        expect.arrayContaining(['exerciseSlug', 'otherName', 'rawText', 'sets', 'sourcePhotoIndexes']),
      );
      expect(itemSchema.properties.exerciseSlug.enum).toEqual([...vocab.exercises.map((e) => e.slug), 'other']);
      expect(itemSchema.properties.sets.items.additionalProperties).toBe(false);
    });
  });
});
