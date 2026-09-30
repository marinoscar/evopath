// =============================================================================
// Signals fixture: a 3-day plan over 4 weeks (E5.9)
// =============================================================================
//
// Pure input for `aggregateSignals` (no database). Monday/Wednesday/Friday
// from Monday 2026-08-31, four weeks. Two sessions are skipped (week 2
// Wednesday, week 3 Friday), one is partial (week 4 Monday: 2 of 6 planned
// sets), and there is one ad-hoc workout (Saturday 2026-09-12). `asOf` is
// Monday 2026-09-28, so every plan week is over.
//
// Evaluator persona fixtures reuse `threeDayPlanInput()` and tweak it.
// =============================================================================

import type {
  SignalsExercise,
  SignalsInput,
  SignalsPlannedWorkout,
  SignalsSet,
  SignalsWorkout,
} from '../../../../src/programs/signals/aggregate-signals';

export const IDS = {
  program: '10000000-0000-4000-8000-000000000001',
  squat: '20000000-0000-4000-8000-000000000001',
  bench: '20000000-0000-4000-8000-000000000002',
  deadlift: '20000000-0000-4000-8000-000000000003',
  row: '20000000-0000-4000-8000-000000000004',
  pullup: '20000000-0000-4000-8000-000000000005',
  plank: '20000000-0000-4000-8000-000000000006',
} as const;

export const EXERCISES: SignalsExercise[] = [
  { id: IDS.squat, slug: 'back-squat', name: 'Back squat', primaryMuscles: ['quads', 'glutes'], trackingMode: 'weight_reps' },
  { id: IDS.bench, slug: 'bench-press', name: 'Bench press', primaryMuscles: ['chest'], trackingMode: 'weight_reps' },
  { id: IDS.deadlift, slug: 'deadlift', name: 'Deadlift', primaryMuscles: ['hamstrings', 'glutes'], trackingMode: 'weight_reps' },
  { id: IDS.row, slug: 'barbell-row', name: 'Barbell row', primaryMuscles: ['back'], trackingMode: 'weight_reps' },
  { id: IDS.pullup, slug: 'pull-up', name: 'Pull-up', primaryMuscles: ['back'], trackingMode: 'bodyweight_reps' },
  { id: IDS.plank, slug: 'plank', name: 'Plank', primaryMuscles: ['core'], trackingMode: 'time' },
];

export const START = '2026-08-31';
export const AS_OF = '2026-09-28';
export const RANGE = { from: '2026-08-31', to: '2026-09-27' };

/** `pw-<week>-<weekday>` as a uuid. */
export function programWorkoutId(week: number, weekday: number): string {
  return `30000000-0000-4000-8000-0000000${String(week).padStart(2, '0')}0${weekday}0`;
}

const DAY_A = [
  { exerciseId: IDS.squat, targetSets: 3 },
  { exerciseId: IDS.bench, targetSets: 3 },
];
const DAY_B = [
  { exerciseId: IDS.deadlift, targetSets: 3 },
  { exerciseId: IDS.row, targetSets: 3 },
];
const DAY_C = [
  { exerciseId: IDS.squat, targetSets: 3 },
  { exerciseId: IDS.pullup, targetSets: 3 },
];

export function plannedWorkouts(weeks = 4): SignalsPlannedWorkout[] {
  const result: SignalsPlannedWorkout[] = [];
  for (let week = 1; week <= weeks; week += 1) {
    [
      { weekday: 1, name: 'Day A', exercises: DAY_A },
      { weekday: 3, name: 'Day B', exercises: DAY_B },
      { weekday: 5, name: 'Day C', exercises: DAY_C },
    ].forEach((day, position) =>
      result.push({
        programWorkoutId: programWorkoutId(week, day.weekday),
        name: day.name,
        weekNumber: week,
        weekday: day.weekday,
        position,
        archived: false,
        exercises: day.exercises,
      }),
    );
  }
  return result;
}

export function set(weightKg: number | null, reps: number | null, extra: Partial<SignalsSet> = {}): SignalsSet {
  return { weightKg, reps, durationSeconds: null, distanceMeters: null, rpe: null, isWarmup: false, completed: true, ...extra };
}

export function sets(count: number, weightKg: number | null, reps: number, rpe: number | null = null): SignalsSet[] {
  return Array.from({ length: count }, () => set(weightKg, reps, { rpe }));
}

let serial = 0;
export function workoutId(): string {
  serial += 1;
  return `40000000-0000-4000-8000-${String(serial).padStart(12, '0')}`;
}

export function workout(date: string, exercises: SignalsWorkout['exercises'], extra: Partial<SignalsWorkout> = {}): SignalsWorkout {
  return {
    id: workoutId(),
    date,
    startedAt: `${date}T17:00:00.000Z`,
    status: 'completed',
    linked: false,
    programWorkoutId: null,
    plannedSets: null,
    exercises,
    ...extra,
  };
}

/** A completed workout started from the planned workout of `week`/`weekday`. */
export function planned(date: string, week: number, weekday: number, exercises: SignalsWorkout['exercises'], extra: Partial<SignalsWorkout> = {}) {
  return workout(date, exercises, { linked: true, programWorkoutId: programWorkoutId(week, weekday), plannedSets: 6, ...extra });
}

/** The logged workouts of the scenario, oldest first. */
export function loggedWorkouts(): SignalsWorkout[] {
  return [
    // Week 1: all three.
    planned('2026-08-31', 1, 1, [
      { exerciseId: IDS.squat, sets: [set(60, 5, { isWarmup: true }), ...sets(3, 100, 5, 7)] },
      { exerciseId: IDS.bench, sets: sets(3, 70, 8, 7) },
    ]),
    planned('2026-09-02', 1, 3, [
      { exerciseId: IDS.deadlift, sets: sets(3, 140, 5, 8) },
      { exerciseId: IDS.row, sets: sets(3, 60, 10, 7) },
    ]),
    planned('2026-09-04', 1, 5, [
      { exerciseId: IDS.squat, sets: sets(3, 102.5, 5, 7) },
      { exerciseId: IDS.pullup, sets: sets(3, null, 8, 8) },
    ]),
    // Week 2: Wednesday skipped; ad-hoc plank on Saturday.
    planned('2026-09-07', 2, 1, [
      { exerciseId: IDS.squat, sets: sets(3, 105, 5, 8) },
      { exerciseId: IDS.bench, sets: sets(3, 72.5, 8, 8) },
    ]),
    planned('2026-09-11', 2, 5, [
      { exerciseId: IDS.squat, sets: sets(3, 107.5, 5, 8) },
      { exerciseId: IDS.pullup, sets: [set(null, 9, { rpe: 8, }), set(null, 8, { rpe: 9 }), set(null, 7, { rpe: 9.5 })] },
    ]),
    workout('2026-09-12', [
      {
        exerciseId: IDS.plank,
        sets: [
          set(null, null, { durationSeconds: 30, isWarmup: true }),
          set(null, null, { durationSeconds: 60 }),
          set(null, null, { durationSeconds: 60 }),
          set(null, null, { durationSeconds: 60 }),
        ],
      },
    ]),
    // Week 3: Friday skipped.
    planned('2026-09-14', 3, 1, [
      { exerciseId: IDS.squat, sets: sets(3, 110, 5, 8.5) },
      { exerciseId: IDS.bench, sets: sets(3, 75, 8, 8.5) },
    ]),
    planned('2026-09-16', 3, 3, [
      { exerciseId: IDS.deadlift, sets: sets(3, 145, 5, 9) },
      { exerciseId: IDS.row, sets: sets(3, 62.5, 10, 8) },
    ]),
    // Week 4: Monday partial (2 of 6 planned sets).
    planned('2026-09-21', 4, 1, [
      { exerciseId: IDS.squat, sets: [...sets(2, 112.5, 5, 9), set(112.5, 5, { completed: false })] },
      { exerciseId: IDS.bench, sets: [set(75, 8, { completed: false })] },
    ]),
    planned('2026-09-23', 4, 3, [
      { exerciseId: IDS.deadlift, sets: sets(3, 147.5, 5, 9) },
      { exerciseId: IDS.row, sets: sets(3, 62.5, 10, 8.5) },
    ]),
    planned('2026-09-25', 4, 5, [
      { exerciseId: IDS.squat, sets: sets(3, 112.5, 5, 9) },
      { exerciseId: IDS.pullup, sets: sets(3, null, 9, 9) },
    ]),
  ];
}

/** The whole scenario as `aggregateSignals` input. */
export function threeDayPlanInput(overrides: Partial<SignalsInput> = {}): SignalsInput {
  return {
    range: RANGE,
    asOf: AS_OF,
    program: { id: IDS.program, startDate: START, planVersion: 3 },
    planned: plannedWorkouts(),
    planChangedOn: null,
    truncated: false,
    workouts: loggedWorkouts(),
    exercises: EXERCISES,
    priorBuckets: {},
    pain: [],
    checkIns: [],
    weights: [],
    bodyFat: [],
    ...overrides,
  };
}
