// =============================================================================
// Signals fixture: a 26-week user with a wide exercise library (E5.9)
// =============================================================================
//
// Deterministic. 20 exercises over 16 muscles, a 26-week 3-day plan (six
// exercises of four sets a day, rotating), every session done with a slowly
// rising load, check-ins and weekly weigh-ins. The compaction budget test and
// the evaluator persona fixtures build on it.
// =============================================================================

import type {
  SignalsExercise,
  SignalsInput,
  SignalsPlannedWorkout,
  SignalsWorkout,
} from '../../../../src/programs/signals/aggregate-signals';
import { addDays } from '../../../../src/check-ins/local-date';

const MUSCLES = [
  'abductors',
  'back',
  'biceps',
  'calves',
  'chest',
  'core',
  'forearms',
  'glutes',
  'hamstrings',
  'lats',
  'lower_back',
  'quads',
  'rear_delts',
  'shoulders',
  'traps',
  'triceps',
];

const hex = (n: number, width: number) => n.toString(16).padStart(width, '0');

export const LONG_PROGRAM_ID = '50000000-0000-4000-8000-000000000001';
export const LONG_START = '2026-03-30';
export const LONG_AS_OF = '2026-09-28';
export const LONG_RANGE = { from: '2026-03-30', to: '2026-09-27' };

export const LONG_EXERCISES: SignalsExercise[] = Array.from({ length: 20 }, (_, index) => ({
  id: `60000000-0000-4000-8000-${hex(index + 1, 12)}`,
  slug: `exercise-${String(index + 1).padStart(2, '0')}`,
  name: `Exercise ${String(index + 1).padStart(2, '0')}`,
  primaryMuscles: [MUSCLES[index % MUSCLES.length], MUSCLES[(index * 7 + 3) % MUSCLES.length]],
  trackingMode: 'weight_reps',
}));

function programWorkoutId(week: number, day: number): string {
  return `70000000-0000-4000-8000-${hex(week * 10 + day, 12)}`;
}

function dayExercises(week: number, day: number): string[] {
  return Array.from({ length: 6 }, (_, slot) => LONG_EXERCISES[(week + day * 6 + slot) % LONG_EXERCISES.length].id);
}

export function longHistoryInput(overrides: Partial<SignalsInput> = {}): SignalsInput {
  const planned: SignalsPlannedWorkout[] = [];
  const workouts: SignalsWorkout[] = [];
  const weekdays = [1, 3, 5];
  let serial = 0;

  for (let week = 1; week <= 26; week += 1) {
    weekdays.forEach((weekday, day) => {
      const exerciseIds = dayExercises(week, day);
      planned.push({
        programWorkoutId: programWorkoutId(week, day),
        name: `Week ${week} day ${day + 1}`,
        weekNumber: week,
        weekday,
        position: day,
        archived: false,
        exercises: exerciseIds.map((exerciseId) => ({ exerciseId, targetSets: 4 })),
      });
      const date = addDays(LONG_START, (week - 1) * 7 + (weekday - 1));
      serial += 1;
      workouts.push({
        id: `80000000-0000-4000-8000-${hex(serial, 12)}`,
        date,
        startedAt: `${date}T18:00:00.000Z`,
        status: 'completed',
        linked: true,
        programWorkoutId: programWorkoutId(week, day),
        plannedSets: 24,
        exercises: exerciseIds.map((exerciseId, slot) => ({
          exerciseId,
          sets: Array.from({ length: 4 }, (_, index) => ({
            weightKg: 40 + slot * 10 + week * 1.25,
            reps: 8 + (index % 3),
            durationSeconds: null,
            distanceMeters: null,
            rpe: 7 + ((week + index) % 3) * 0.5,
            isWarmup: false,
            completed: true,
          })),
        })),
      });
    });
  }

  return {
    range: LONG_RANGE,
    asOf: LONG_AS_OF,
    program: { id: LONG_PROGRAM_ID, startDate: LONG_START, planVersion: 7 },
    planned,
    workouts,
    exercises: LONG_EXERCISES,
    priorBuckets: {},
    pain: workouts
      .filter((row) => row.date >= addDays(LONG_AS_OF, -27))
      .flatMap((row) =>
        row.exercises.map((entry) => ({
          exerciseId: entry.exerciseId,
          workoutId: row.id,
          date: row.date,
          startedAt: row.startedAt,
          flagged: entry.exerciseId === LONG_EXERCISES[19].id,
        })),
      ),
    checkIns: Array.from({ length: 7 }, (_, index) => ({
      date: addDays(LONG_AS_OF, -index),
      energy: 3,
      sleepQuality: 3,
      soreness: 2,
      stress: 3,
    })),
    weights: Array.from({ length: 8 }, (_, index) => ({ date: addDays(LONG_AS_OF, -7 * index), value: 82 - index * 0.3 })),
    bodyFat: [{ date: addDays(LONG_AS_OF, -3), value: 19 }],
    ...overrides,
  };
}
