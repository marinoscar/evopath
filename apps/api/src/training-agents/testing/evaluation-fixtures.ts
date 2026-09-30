import { randomUUID } from 'node:crypto';

import type { PlanTree } from '../../programs/contracts/plan-tree.contract';
import { emptySignals } from '../../programs/signals/aggregate-signals';
import type { PlanSignals } from '../../programs/signals/plan-signals.contract';
import type { EvaluationSources } from '../evaluation/build-evaluator-context';
import { evidenceOf } from '../finalize/plan-evidence';
import { STUB_VERIFIED_BRIEF } from './stub-agent-nodes';
import { intakeFixture } from './intake-fixtures';

// =============================================================================
// Evaluation sources for specs: a 4-week, one-block plan started on Monday
// 2026-09-07 with two workouts a week (Monday: squat + bench, Thursday: row +
// press), every row with an id. `asOf` 2026-09-24 (a Thursday) is in week 3.
//
// CANARIES: every free-text field the sources carry that must never be sent
// (workout, block and exercise names, notes and rationales, the intake's
// preferences, signal exercise names) holds a `CANARY_*` string. A spec
// asserts none of them, and no uuid, reaches `context.sent`.
// =============================================================================

export const EVAL_START = '2026-09-07';
export const EVAL_AS_OF = '2026-09-24';

export const CANARY = {
  blockName: 'CANARY_BLOCK_NAME',
  workoutName: 'CANARY_WORKOUT_NAME',
  workoutRationale: 'CANARY_WORKOUT_RATIONALE',
  exerciseNote: 'CANARY_EXERCISE_NOTE',
  exerciseRationale: 'CANARY_EXERCISE_RATIONALE',
  preferences: 'CANARY_PREFERENCES',
  exerciseName: 'CANARY_EXERCISE_NAME',
  focus: 'CANARY_BLOCK_FOCUS',
} as const;

export const EVAL_EXERCISES = {
  squat: { id: randomUUID(), key: 'back_squat' },
  bench: { id: randomUUID(), key: 'bench_press' },
  row: { id: randomUUID(), key: 'barbell_row' },
  press: { id: randomUUID(), key: 'overhead_press' },
} as const;

type ExerciseName = keyof typeof EVAL_EXERCISES;

function exercise(name: ExerciseName, position: number) {
  return {
    id: randomUUID(),
    exerciseId: EVAL_EXERCISES[name].id,
    position,
    isPriority: position === 0,
    targetSets: 3,
    repMin: 6,
    repMax: 10,
    targetLoadKg: 60,
    targetRpe: 8,
    restSeconds: 120,
    loadGuidance: 'fixed' as const,
    rationale: CANARY.exerciseRationale,
    evidenceRefs: ['E1'],
    notes: CANARY.exerciseNote,
    equipmentTypeId: null,
  };
}

function workout(weekday: number, position: number, names: ExerciseName[]) {
  return {
    id: randomUUID(),
    position,
    weekday,
    name: CANARY.workoutName,
    estimatedMinutes: 60,
    rationale: CANARY.workoutRationale,
    exercises: names.map((name, i) => exercise(name, i)),
  };
}

/** The plan: 4 weeks, week 4 a deload. Positions are deliberately listed out of order in week 2. */
export function evaluationTree(): PlanTree {
  const week = (weekNumber: number) => ({
    id: randomUUID(),
    weekNumber,
    isDeload: weekNumber === 4,
    workouts:
      weekNumber === 2
        ? [workout(4, 1, ['row', 'press']), workout(1, 0, ['squat', 'bench'])]
        : [workout(1, 0, ['squat', 'bench']), workout(4, 1, ['row', 'press'])],
  });
  return {
    blocks: [
      {
        id: randomUUID(),
        position: 0,
        name: CANARY.blockName,
        focus: CANARY.focus,
        rationale: null,
        weeks: [week(1), week(2), week(3), week(4)],
      },
    ],
  } as PlanTree;
}

/** Signals as of `EVAL_AS_OF`, with `change` applied. */
export function evaluationSignals(change: (signals: PlanSignals) => void = () => undefined): PlanSignals {
  const signals = emptySignals({ from: '2026-08-10', to: EVAL_AS_OF }, EVAL_AS_OF);
  change(signals);
  return signals;
}

export function painRow(name: ExerciseName, over: Partial<PlanSignals['pain'][number]> = {}): PlanSignals['pain'][number] {
  return {
    exerciseId: EVAL_EXERCISES[name].id,
    slug: EVAL_EXERCISES[name].key,
    name: CANARY.exerciseName,
    lastFlaggedOn: '2026-09-21',
    flaggedSessions28d: 1,
    consecutiveFlaggedSessions: 1,
    ...over,
  };
}

export function evaluationSources(over: Partial<EvaluationSources> = {}): EvaluationSources {
  const tree = over.tree ?? evaluationTree();
  return {
    program: {
      id: randomUUID(),
      goal: 'hypertrophy',
      autonomy: 'autonomous',
      autonomyPausedReason: null,
      startDate: EVAL_START,
      currentVersion: 3,
      intake: intakeFixture({
        preferences: CANARY.preferences,
        limitations: [{ area: 'knee', description: 'Old knee sprain' }],
        avoidExerciseKeys: ['jump_squat'],
      }),
    },
    tree,
    exercises: Object.values(EVAL_EXERCISES).map((row) => ({ ...row })),
    linkedProgramWorkoutIds: [],
    signals: evaluationSignals(),
    changeLog: [
      { createdAt: new Date('2026-09-20T10:00:00Z'), kind: 'adapted', actor: 'ai', status: 'reverted', summary: 'Added a set of squats', operations: [{ op: 'set_prescription' }] },
      { createdAt: new Date('2026-09-15T10:00:00Z'), kind: 'adapted', actor: 'ai', status: 'rejected', summary: 'Swapped rows', operations: [{}, {}] },
      { createdAt: new Date('2026-09-10T10:00:00Z'), kind: 'adapted', actor: 'ai', status: 'expired', summary: 'Moved a day', operations: [] },
      { createdAt: new Date('2026-09-06T10:00:00Z'), kind: 'created', actor: 'ai', status: 'applied', summary: 'Created by the planner', operations: [] },
    ],
    evidence: [[], evidenceOf(STUB_VERIFIED_BRIEF)],
    ...over,
  };
}
