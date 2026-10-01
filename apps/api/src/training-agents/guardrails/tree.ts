import { setsOf, type PlanBlock, type PlanExercise, type PlanTree, type PlanWeek, type PlanWorkout } from '../../programs/contracts/plan-tree.contract';
import type { LibraryExercise } from '../context/planner-context.contract';
import type { GuardrailContext, GuardrailRule, Violation, ViolationSeverity } from './types';

// =============================================================================
// Shared helpers for the guardrail rules: walking, labelling, counting.
// Every rule works on a normalised deep copy (`normalizeTree`): blocks by
// position, weeks by number, workouts by weekday then position, exercises by
// position (then exercise id, so input order never matters), positions
// renumbered 0..n-1.
// =============================================================================

export const WEEKDAY_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** A deep copy, sorted and renumbered. Pure. */
export function normalizeTree(tree: PlanTree): PlanTree {
  const copy: PlanTree = JSON.parse(JSON.stringify(tree));
  copy.blocks.sort((a, b) => a.position - b.position);
  copy.blocks.forEach((block, b) => {
    block.position = b;
    block.weeks.sort((a, c) => a.weekNumber - c.weekNumber);
    for (const week of block.weeks) sortWeek(week);
  });
  return copy;
}

/** Workouts by weekday (unscheduled last) then position; exercises by position then id; positions renumbered. */
export function sortWeek(week: PlanWeek): void {
  week.workouts.sort((a, b) => (a.weekday ?? 8) - (b.weekday ?? 8) || a.position - b.position);
  week.workouts.forEach((workout, w) => {
    workout.position = w;
    workout.exercises.sort((a, b) => a.position - b.position || (a.exerciseId < b.exerciseId ? -1 : a.exerciseId > b.exerciseId ? 1 : 0));
    workout.exercises.forEach((exercise, e) => {
      exercise.position = e;
    });
  });
}

/** Every week in program order, with its block. */
export function weeksOf(tree: PlanTree): Array<{ block: PlanBlock; week: PlanWeek }> {
  const out: Array<{ block: PlanBlock; week: PlanWeek }> = [];
  for (const block of tree.blocks) for (const week of block.weeks) out.push({ block, week });
  return out.sort((a, b) => a.week.weekNumber - b.week.weekNumber);
}

export interface ExerciseSlot {
  week: PlanWeek;
  workout: PlanWorkout;
  exercise: PlanExercise;
}

/** Every exercise in program order (week, workout order, position). */
export function slotsOf(tree: PlanTree): ExerciseSlot[] {
  const out: ExerciseSlot[] = [];
  for (const { week } of weeksOf(tree))
    for (const workout of week.workouts) for (const exercise of workout.exercises) out.push({ week, workout, exercise });
  return out;
}

export function keyOf(ctx: GuardrailContext, exerciseId: string): string {
  return ctx.library.get(exerciseId)?.key ?? exerciseId.replace(/^unknown:/, '');
}

/**
 * A workout by its day (`Mon workout`), or its position when unscheduled.
 * Never its name: names are model text, and paths and messages reach events.
 */
export function workoutLabel(workout: PlanWorkout): string {
  return workout.weekday ? `${WEEKDAY_NAMES[workout.weekday]} workout` : `unscheduled workout ${workout.position + 1}`;
}

function workoutPathLabel(workout: PlanWorkout): string {
  return workout.weekday ? WEEKDAY_NAMES[workout.weekday] : `unscheduled ${workout.position + 1}`;
}

export function pathOf(ctx: GuardrailContext, week: PlanWeek, workout?: PlanWorkout, exercise?: PlanExercise): string {
  const parts = [`week ${week.weekNumber}`];
  if (workout) parts.push(workoutPathLabel(workout));
  if (exercise) parts.push(keyOf(ctx, exercise.exerciseId));
  return parts.join(' > ');
}

/** Collects violations for one rule. */
export class Findings {
  readonly list: Violation[] = [];

  constructor(private readonly rule: GuardrailRule) {}

  add(severity: ViolationSeverity, code: string, path: string, message: string): void {
    this.list.push({ rule: this.rule, severity, code, path, message });
  }
}

export function sessionSets(workout: PlanWorkout): number {
  return workout.exercises.reduce((sum, e) => sum + setsOf(e), 0);
}

/** Counted primary muscles of an exercise (cardio and whole-body excluded). */
export function countedMuscles(lib: LibraryExercise | undefined, uncounted: readonly string[]): string[] {
  if (!lib || lib.movementPattern === 'cardio') return [];
  return lib.primaryMuscles.filter((m) => !uncounted.includes(m));
}

/** Sets per primary muscle in one workout or week. */
export function setsByMuscle(
  ctx: GuardrailContext,
  workouts: readonly PlanWorkout[],
  uncounted: readonly string[],
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const workout of workouts)
    for (const exercise of workout.exercises)
      for (const muscle of countedMuscles(ctx.library.get(exercise.exerciseId), uncounted))
        totals.set(muscle, (totals.get(muscle) ?? 0) + setsOf(exercise));
  return totals;
}

/** Rounds down to a 0.5 kg step (float noise tolerated). */
export function floorHalf(kg: number): number {
  return Math.floor(kg * 2 + 1e-9) / 2;
}

/** Rounds up to a 0.5 kg step. */
export function ceilHalf(kg: number): number {
  return Math.ceil(kg * 2 - 1e-9) / 2;
}

/** The allowed weekdays: the preferred ones, or every day. */
export function allowedWeekdays(ctx: GuardrailContext): number[] {
  return ctx.preferredWeekdays && ctx.preferredWeekdays.length > 0 ? ctx.preferredWeekdays : [1, 2, 3, 4, 5, 6, 7];
}
