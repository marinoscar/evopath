// =============================================================================
// Unit: workout pure rules and DTO bounds (E4.2)
// =============================================================================
//
// The mapper's pure functions (totals, rest derivation, dense renumbering,
// reordering, empty-set test, default name, duration) and the Zod bounds the
// routes enforce: weight decimals, RPE steps, RIR / reps / duration / distance
// / rest ranges, notes and name lengths, and the exercise and set limits'
// constants. The DB CHECK mirrors these bounds; see `workouts.db.spec.ts`.
// =============================================================================

import { Prisma } from '@prisma/client';

import {
  addWorkoutExerciseSchema,
  createSetSchema,
  finishWorkoutSchema,
  listWorkoutsQuerySchema,
  startWorkoutSchema,
  updateSetSchema,
  updateWorkoutExerciseSchema,
  updateWorkoutSchema,
} from '../../src/workouts/dto/workout.dto';
import {
  computeTotals,
  defaultWorkoutName,
  denseRenumber,
  deriveRestSeconds,
  durationBetween,
  isEmptySet,
  moveItem,
} from '../../src/workouts/workout-mapper';
import {
  MAX_EXERCISES_PER_WORKOUT,
  MAX_SETS_PER_EXERCISE,
  REST_DERIVATION_WINDOW_SECONDS,
  SET_BOUNDS,
} from '../../src/workouts/workouts.constants';

const set = (over: Partial<Parameters<typeof computeTotals>[0][number]> = {}) => ({
  weightKg: 100 as Prisma.Decimal | number | null,
  reps: 5 as number | null,
  completed: true,
  isWarmup: false,
  ...over,
});

describe('computeTotals', () => {
  it('counts completed working sets and sums weight x reps', () => {
    expect(computeTotals([set(), set({ weightKg: 50, reps: 10 })])).toEqual({ setCount: 2, volumeKg: 1000 });
  });

  it('excludes warm-up and uncompleted sets from count and volume', () => {
    const totals = computeTotals([set(), set({ isWarmup: true }), set({ completed: false }), set({ completed: false, isWarmup: true })]);
    expect(totals).toEqual({ setCount: 1, volumeKg: 500 });
  });

  it('counts a completed set without weight or reps but adds no volume', () => {
    expect(computeTotals([set({ weightKg: null }), set({ reps: null })])).toEqual({ setCount: 2, volumeKg: 0 });
  });

  it('accepts Prisma decimals and avoids float drift', () => {
    const totals = computeTotals([set({ weightKg: new Prisma.Decimal('31.750'), reps: 10 }), set({ weightKg: new Prisma.Decimal('31.75'), reps: 10 })]);
    expect(totals.volumeKg).toBe(635);
    expect(computeTotals([set({ weightKg: new Prisma.Decimal('0.1'), reps: 3 })]).volumeKg).toBe(0.3);
  });

  it('is zero for no sets', () => {
    expect(computeTotals([])).toEqual({ setCount: 0, volumeKg: 0 });
  });
});

describe('deriveRestSeconds', () => {
  const now = new Date('2026-09-29T10:00:00.000Z');
  const ago = (s: number) => new Date(now.getTime() - s * 1000);

  it('is null without a previous completion', () => {
    expect(deriveRestSeconds(null, now)).toBeNull();
  });

  it('returns whole seconds since the previous completion', () => {
    expect(deriveRestSeconds(ago(90), now)).toBe(90);
    expect(deriveRestSeconds(new Date(now.getTime() - 90_900), now)).toBe(90);
    expect(deriveRestSeconds(ago(0), now)).toBe(0);
  });

  it('derives up to but not including 15 minutes', () => {
    expect(deriveRestSeconds(ago(REST_DERIVATION_WINDOW_SECONDS - 1), now)).toBe(REST_DERIVATION_WINDOW_SECONDS - 1);
    expect(deriveRestSeconds(ago(REST_DERIVATION_WINDOW_SECONDS), now)).toBeNull();
    expect(deriveRestSeconds(ago(3600), now)).toBeNull();
  });

  it('is null when the previous completion lies in the future', () => {
    expect(deriveRestSeconds(ago(-5), now)).toBeNull();
  });
});

describe('denseRenumber', () => {
  const items = (...numbers: number[]) => numbers.map((n, i) => ({ id: `i${i}`, n }));

  it('returns only the rows whose number changes, after a middle delete', () => {
    expect(denseRenumber(items(1, 3, 4), (x) => x.n, 1)).toEqual([
      { id: 'i1', to: 2 },
      { id: 'i2', to: 3 },
    ]);
  });

  it('is empty when already dense', () => {
    expect(denseRenumber(items(1, 2, 3), (x) => x.n, 1)).toEqual([]);
    expect(denseRenumber(items(0, 1, 2), (x) => x.n, 0)).toEqual([]);
  });

  it('numbers from the given start (0 for positions)', () => {
    expect(denseRenumber(items(5, 9), (x) => x.n, 0)).toEqual([
      { id: 'i0', to: 0 },
      { id: 'i1', to: 1 },
    ]);
  });
});

describe('moveItem', () => {
  const letters = ['a', 'b', 'c', 'd'];

  it('moves forward and backward', () => {
    expect(moveItem(letters, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(letters, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('clamps the target and ignores an out-of-range source', () => {
    expect(moveItem(letters, 0, 99)).toEqual(['b', 'c', 'd', 'a']);
    expect(moveItem(letters, 1, -4)).toEqual(['b', 'a', 'c', 'd']);
    expect(moveItem(letters, 9, 0)).toEqual(letters);
  });

  it('does not mutate its input', () => {
    moveItem(letters, 0, 3);
    expect(letters).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('isEmptySet', () => {
  const empty = { weightKg: null, reps: null, durationSeconds: null, distanceMeters: null };

  it('is true only when weight, reps, time and distance are all null', () => {
    expect(isEmptySet(empty)).toBe(true);
    expect(isEmptySet({ ...empty, weightKg: 0 })).toBe(false);
    expect(isEmptySet({ ...empty, reps: 0 })).toBe(false);
    expect(isEmptySet({ ...empty, durationSeconds: 30 })).toBe(false);
    expect(isEmptySet({ ...empty, distanceMeters: 100 })).toBe(false);
  });
});

describe('defaultWorkoutName / durationBetween', () => {
  it('names the workout after the weekday of the date', () => {
    expect(defaultWorkoutName('2026-09-29')).toBe('Tuesday workout');
    expect(defaultWorkoutName('2026-09-27')).toBe('Sunday workout');
    expect(defaultWorkoutName('2026-09-28')).toBe('Monday workout');
  });

  it('measures whole seconds and never goes negative', () => {
    const a = new Date('2026-09-29T10:00:00.000Z');
    expect(durationBetween(a, new Date('2026-09-29T10:45:30.900Z'))).toBe(2730);
    expect(durationBetween(a, new Date('2026-09-29T09:59:00.000Z'))).toBe(0);
  });
});

describe('set DTO bounds', () => {
  const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, body: unknown) => schema.safeParse(body).success;

  it.each([createSetSchema, updateSetSchema])('accepts edge values and null', (schema) => {
    expect(ok(schema, { weightKg: 0, reps: 0, rpe: 1, rir: 0, durationSeconds: 0, distanceMeters: 0, restSeconds: 0 })).toBe(true);
    expect(ok(schema, { weightKg: 1000, reps: 1000, rpe: 10, rir: 10, durationSeconds: 86400, distanceMeters: 1_000_000, restSeconds: 7200 })).toBe(true);
    expect(ok(schema, { weightKg: null, reps: null, rpe: null, rir: null })).toBe(true);
  });

  it.each([createSetSchema, updateSetSchema])('weightKg: rejects 1000.001, negatives and a 4th decimal, accepts 3', (schema) => {
    expect(ok(schema, { weightKg: 1000.001 })).toBe(false);
    expect(ok(schema, { weightKg: -0.001 })).toBe(false);
    expect(ok(schema, { weightKg: 61.2355 })).toBe(false);
    expect(ok(schema, { weightKg: 61.235 })).toBe(true);
    expect(ok(schema, { weightKg: 31.75 })).toBe(true);
  });

  it.each([createSetSchema, updateSetSchema])('rpe: 0.5 steps within 1..10', (schema) => {
    for (const good of [1, 6.5, 7, 9.5, 10]) expect(ok(schema, { rpe: good })).toBe(true);
    for (const bad of [7.3, 0.5, 10.5, 0, 11, 7.25]) expect(ok(schema, { rpe: bad })).toBe(false);
  });

  it.each([createSetSchema, updateSetSchema])('integer fields: rir 0..10, reps 0..1000, and no fractions', (schema) => {
    expect(ok(schema, { rir: 11 })).toBe(false);
    expect(ok(schema, { rir: -1 })).toBe(false);
    expect(ok(schema, { rir: 1.5 })).toBe(false);
    expect(ok(schema, { reps: 1001 })).toBe(false);
    expect(ok(schema, { reps: 8.5 })).toBe(false);
    expect(ok(schema, { durationSeconds: 86401 })).toBe(false);
    expect(ok(schema, { restSeconds: 7201 })).toBe(false);
    expect(ok(schema, { restSeconds: -1 })).toBe(false);
  });

  it.each([createSetSchema, updateSetSchema])('distanceMeters: 0..1,000,000 with 2 decimals', (schema) => {
    expect(ok(schema, { distanceMeters: 1_000_000.01 })).toBe(false);
    expect(ok(schema, { distanceMeters: 12.345 })).toBe(false);
    expect(ok(schema, { distanceMeters: 12.34 })).toBe(true);
  });

  it.each([createSetSchema, updateSetSchema])('notes <= 1000, painNote <= 500, unknown keys rejected', (schema) => {
    expect(ok(schema, { notes: 'x'.repeat(1000) })).toBe(true);
    expect(ok(schema, { notes: 'x'.repeat(1001) })).toBe(false);
    expect(ok(schema, { painNote: 'x'.repeat(500) })).toBe(true);
    expect(ok(schema, { painNote: 'x'.repeat(501) })).toBe(false);
    expect(ok(schema, { setNumber: 3 })).toBe(false);
    expect(ok(schema, { weightLb: 135 })).toBe(false);
  });

  it('createSetSchema accepts an empty body; updateSetSchema needs a field', () => {
    expect(ok(createSetSchema, {})).toBe(true);
    expect(ok(updateSetSchema, {})).toBe(false);
  });

  it('bounds mirror the constants the DB CHECK uses', () => {
    expect(SET_BOUNDS.weightKg.max).toBe(1000);
    expect(SET_BOUNDS.rpe.step).toBe(0.5);
    expect(SET_BOUNDS.restSeconds.max).toBe(7200);
    expect(MAX_EXERCISES_PER_WORKOUT).toBe(30);
    expect(MAX_SETS_PER_EXERCISE).toBe(40);
  });
});

describe('workout DTO bounds', () => {
  const uuid = '11111111-1111-4111-8111-111111111111';

  it('start: name 1..80, real dates, uuid gym, strict', () => {
    expect(startWorkoutSchema.safeParse({}).success).toBe(true);
    expect(startWorkoutSchema.safeParse({ name: 'x'.repeat(80) }).success).toBe(true);
    expect(startWorkoutSchema.safeParse({ name: 'x'.repeat(81) }).success).toBe(false);
    expect(startWorkoutSchema.safeParse({ name: '' }).success).toBe(false);
    expect(startWorkoutSchema.safeParse({ date: '2026-02-30' }).success).toBe(false);
    expect(startWorkoutSchema.safeParse({ date: '29/09/2026' }).success).toBe(false);
    expect(startWorkoutSchema.safeParse({ date: '2026-09-29', gymId: uuid, startedAt: '2026-09-29T10:00:00Z' }).success).toBe(true);
    expect(startWorkoutSchema.safeParse({ gymId: 'nope' }).success).toBe(false);
    expect(startWorkoutSchema.safeParse({ userId: uuid }).success).toBe(false);
  });

  it('update: needs a field, gymId nullable, duration <= 7 days', () => {
    expect(updateWorkoutSchema.safeParse({}).success).toBe(false);
    expect(updateWorkoutSchema.safeParse({ gymId: null }).success).toBe(true);
    expect(updateWorkoutSchema.safeParse({ durationSeconds: 7 * 86400 }).success).toBe(true);
    expect(updateWorkoutSchema.safeParse({ durationSeconds: 7 * 86400 + 1 }).success).toBe(false);
    expect(updateWorkoutSchema.safeParse({ durationSeconds: -1 }).success).toBe(false);
    expect(updateWorkoutSchema.safeParse({ notes: 'x'.repeat(1001) }).success).toBe(false);
  });

  it('finish: optional notes and endedAt, strict', () => {
    expect(finishWorkoutSchema.safeParse({}).success).toBe(true);
    expect(finishWorkoutSchema.safeParse({ endedAt: 'yesterday' }).success).toBe(false);
    expect(finishWorkoutSchema.safeParse({ status: 'x' }).success).toBe(false);
  });

  it('list: pageSize <= 50 (default 20), page >= 1, from <= to, status enum', () => {
    expect(listWorkoutsQuerySchema.parse({})).toMatchObject({ page: 1, pageSize: 20 });
    expect(listWorkoutsQuerySchema.safeParse({ pageSize: '51' }).success).toBe(false);
    expect(listWorkoutsQuerySchema.safeParse({ pageSize: '50' }).success).toBe(true);
    expect(listWorkoutsQuerySchema.safeParse({ page: '0' }).success).toBe(false);
    expect(listWorkoutsQuerySchema.safeParse({ from: '2026-09-30', to: '2026-09-01' }).success).toBe(false);
    expect(listWorkoutsQuerySchema.safeParse({ status: 'paused' }).success).toBe(false);
    expect(listWorkoutsQuerySchema.safeParse({ status: 'completed', exerciseId: uuid }).success).toBe(true);
  });

  it('exercises: position 0..29, uuid exerciseId, patch needs a field', () => {
    expect(addWorkoutExerciseSchema.safeParse({ exerciseId: uuid, position: 29 }).success).toBe(true);
    expect(addWorkoutExerciseSchema.safeParse({ exerciseId: uuid, position: 30 }).success).toBe(false);
    expect(addWorkoutExerciseSchema.safeParse({ exerciseId: uuid, position: -1 }).success).toBe(false);
    expect(addWorkoutExerciseSchema.safeParse({ exerciseId: 'x' }).success).toBe(false);
    expect(updateWorkoutExerciseSchema.safeParse({}).success).toBe(false);
    expect(updateWorkoutExerciseSchema.safeParse({ position: 0 }).success).toBe(true);
    expect(updateWorkoutExerciseSchema.safeParse({ equipmentTypeId: null }).success).toBe(true);
  });
});
