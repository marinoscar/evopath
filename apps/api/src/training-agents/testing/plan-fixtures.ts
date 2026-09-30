import type { PlanExercise, PlanTree, PlanWorkout } from '../../programs/contracts/plan-tree.contract';
import { guardrailContextOf, type GuardrailContext } from '../guardrails/types';
import type { VerifiedEvidenceBrief } from '../agents/researcher/evidence-brief.contract';
import { LIB, runContextFixture } from './context-fixtures';
import { STUB_VERIFIED_BRIEF } from './stub-agent-nodes';

// =============================================================================
// Compact builders for plan trees and guardrail contexts in specs.
//
//   const tree = planTree([{ workouts: [{ weekday: 1, exercises: [ex('goblet_squat', { sets: 3 })] }] }]);
// =============================================================================

export interface ExerciseSpec extends Partial<Omit<PlanExercise, 'exerciseId'>> {
  key: string;
  sets?: number;
}

/** A prescribed exercise by library key (unknown keys become `unknown:<key>`, like the compiler's). */
export function ex(key: string, over: Omit<ExerciseSpec, 'key'> = {}): ExerciseSpec {
  return { key, ...over };
}

export interface WorkoutSpec {
  weekday: number | null;
  name?: string;
  exercises: ExerciseSpec[];
}

export interface WeekSpec {
  deload?: boolean;
  workouts: WorkoutSpec[];
}

function exerciseOf(spec: ExerciseSpec, position: number): PlanExercise {
  const { key, sets, ...rest } = spec;
  return {
    exerciseId: LIB[key]?.id ?? `unknown:${key}`,
    position,
    isPriority: false,
    targetSets: sets ?? 3,
    repMin: 8,
    repMax: 12,
    targetLoadKg: null,
    targetRpe: 7,
    restSeconds: 90,
    loadGuidance: 'choose_start',
    rationale: null,
    evidenceRefs: [],
    notes: null,
    equipmentTypeId: null,
    ...rest,
  };
}

function workoutOf(spec: WorkoutSpec, position: number): PlanWorkout {
  return {
    position,
    weekday: spec.weekday,
    name: spec.name ?? `Day ${position + 1}`,
    estimatedMinutes: null,
    rationale: null,
    exercises: spec.exercises.map(exerciseOf),
  };
}

/** One block holding `weeks`, numbered from 1. */
export function planTree(weeks: WeekSpec[]): PlanTree {
  return {
    blocks: [
      {
        position: 0,
        name: 'Block 1',
        focus: null,
        rationale: null,
        weeks: weeks.map((week, i) => ({ weekNumber: i + 1, isDeload: week.deload ?? false, workouts: week.workouts.map(workoutOf) })),
      },
    ],
  };
}

/** `n` copies of the same week. */
export function repeatWeeks(n: number, week: WeekSpec): WeekSpec[] {
  return Array.from({ length: n }, () => JSON.parse(JSON.stringify(week)) as WeekSpec);
}

/** A guardrail context over the fixture library (full gym, intermediate, 3 days, 60 minutes by default). */
export function guardrailContextFixture(
  over: Parameters<typeof runContextFixture>[0] = {},
  brief: VerifiedEvidenceBrief | null = STUB_VERIFIED_BRIEF,
): GuardrailContext {
  return guardrailContextOf(runContextFixture(over), brief);
}

/** The exercise keys of a tree, per week, per workout. */
export function keysOf(tree: PlanTree, ctx: GuardrailContext): string[][][] {
  return tree.blocks.flatMap((b) => b.weeks.map((w) => w.workouts.map((o) => o.exercises.map((e) => ctx.library.get(e.exerciseId)?.key ?? e.exerciseId))));
}
