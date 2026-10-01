/**
 * What changed between two versions of a plan, for the History page.
 *
 * PURE. Compares two snapshot trees (`ProgramVersion.snapshot.tree`, row ids
 * preserved by the API) and lists added, removed and changed exercises and
 * prescriptions, moved workouts and deload changes, plus a one-line summary.
 * Rows are matched by id when both sides have one, else by position within
 * their parent (a manual edit without ids).
 *
 * The API decides what a version IS; this only describes the difference.
 */
import type { PlanBlock, PlanExercise, PlanTree, PlanWeek, PlanWorkout } from '../services/programs';
import { formatPrescription } from './prescription';
import type { DistanceUnit } from './workoutFormat';

export type PlanChangeKind =
  | 'exercise_added'
  | 'exercise_removed'
  | 'exercise_changed'
  | 'workout_added'
  | 'workout_removed'
  | 'workout_moved'
  | 'workout_renamed'
  | 'week_added'
  | 'week_removed'
  | 'deload_changed'
  | 'block_added'
  | 'block_removed'
  | 'block_renamed';

export interface PlanChange {
  kind: PlanChangeKind;
  weekNumber: number | null;
  /** A readable sentence. */
  text: string;
}

export interface PlanDiff {
  changes: PlanChange[];
  summary: string;
}

/** Resolves an exercise id to a name for the sentences; falls back to "an exercise". */
export type ExerciseNamer = (exerciseId: string) => string | null;

const WEEKDAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function weekdayName(day: number | null | undefined): string {
  return day ? (WEEKDAY_NAMES[day] ?? 'unscheduled') : 'unscheduled';
}

/** `3 x 8-10 @ RPE 8`; a cardio row reads `5 km · 30 min` (#263). */
export function prescription(
  exercise: Pick<PlanExercise, 'targetSets' | 'repMin' | 'repMax' | 'targetRpe' | 'targetDurationSeconds' | 'targetDistanceMeters'>,
  distanceUnit: DistanceUnit = 'km',
): string {
  return formatPrescription({ ...exercise, sets: exercise.targetSets }, { ascii: true, distanceUnit });
}

interface Located<T> {
  row: T;
  weekNumber: number;
  key: string;
}

function weeksOf(tree: PlanTree | null | undefined): Array<{ block: PlanBlock; week: PlanWeek }> {
  const out: Array<{ block: PlanBlock; week: PlanWeek }> = [];
  for (const block of tree?.blocks ?? []) for (const week of block.weeks ?? []) out.push({ block, week });
  return out;
}

function workoutKey(week: PlanWeek, workout: PlanWorkout): string {
  return workout.id ? `id:${workout.id}` : `w${week.weekNumber}:p${workout.position}`;
}

function workoutsOf(tree: PlanTree | null | undefined): Map<string, Located<PlanWorkout>> {
  const map = new Map<string, Located<PlanWorkout>>();
  for (const { week } of weeksOf(tree)) {
    for (const workout of week.workouts ?? []) {
      const key = workoutKey(week, workout);
      map.set(key, { row: workout, weekNumber: week.weekNumber, key });
    }
  }
  return map;
}

function exercisesOf(workoutKeyValue: string, workout: PlanWorkout): Map<string, PlanExercise> {
  const map = new Map<string, PlanExercise>();
  for (const exercise of workout.exercises ?? []) {
    map.set(exercise.id ? `id:${exercise.id}` : `${workoutKeyValue}:p${exercise.position}`, exercise);
  }
  return map;
}

function loadText(kg: number | null | undefined): string {
  return kg === null || kg === undefined ? 'open load' : `${kg} kg`;
}

function describeExerciseChange(before: PlanExercise, after: PlanExercise): string[] {
  const parts: string[] = [];
  if (prescription(before) !== prescription(after)) parts.push(`${prescription(before)} to ${prescription(after)}`);
  if ((before.targetLoadKg ?? null) !== (after.targetLoadKg ?? null)) {
    parts.push(`load ${loadText(before.targetLoadKg)} to ${loadText(after.targetLoadKg)}`);
  }
  if (before.restSeconds !== after.restSeconds) parts.push(`rest ${before.restSeconds}s to ${after.restSeconds}s`);
  if (Boolean(before.isPriority) !== Boolean(after.isPriority)) parts.push(after.isPriority ? 'now a priority' : 'no longer a priority');
  if (before.position !== after.position) parts.push('moved within the workout');
  if (before.exerciseId !== after.exerciseId) parts.push('exercise swapped');
  return parts;
}

export function diffSnapshots(
  before: PlanTree | null | undefined,
  after: PlanTree | null | undefined,
  nameOf: ExerciseNamer = () => null,
): PlanDiff {
  const changes: PlanChange[] = [];
  const name = (id: string) => nameOf(id) ?? 'an exercise';

  // Blocks, by id or position.
  const blockKey = (block: PlanBlock) => (block.id ? `id:${block.id}` : `p${block.position}`);
  const beforeBlocks = new Map((before?.blocks ?? []).map((b) => [blockKey(b), b]));
  const afterBlocks = new Map((after?.blocks ?? []).map((b) => [blockKey(b), b]));
  for (const [key, block] of afterBlocks) {
    const prev = beforeBlocks.get(key);
    if (!prev) changes.push({ kind: 'block_added', weekNumber: null, text: `Added block "${block.name}"` });
    else if (prev.name !== block.name) {
      changes.push({ kind: 'block_renamed', weekNumber: null, text: `Renamed block "${prev.name}" to "${block.name}"` });
    }
  }
  for (const [key, block] of beforeBlocks) {
    if (!afterBlocks.has(key)) changes.push({ kind: 'block_removed', weekNumber: null, text: `Removed block "${block.name}"` });
  }

  // Weeks, by week number (program-wide).
  const beforeWeeks = new Map(weeksOf(before).map(({ week }) => [week.weekNumber, week]));
  const afterWeeks = new Map(weeksOf(after).map(({ week }) => [week.weekNumber, week]));
  for (const [n, week] of afterWeeks) {
    const prev = beforeWeeks.get(n);
    if (!prev) changes.push({ kind: 'week_added', weekNumber: n, text: `Added week ${n}` });
    else if (Boolean(prev.isDeload) !== Boolean(week.isDeload)) {
      changes.push({
        kind: 'deload_changed',
        weekNumber: n,
        text: week.isDeload ? `Week ${n} is now a deload week` : `Week ${n} is no longer a deload week`,
      });
    }
  }
  for (const n of beforeWeeks.keys()) {
    if (!afterWeeks.has(n)) changes.push({ kind: 'week_removed', weekNumber: n, text: `Removed week ${n}` });
  }

  // Workouts and their exercises.
  const beforeWorkouts = workoutsOf(before);
  const afterWorkouts = workoutsOf(after);
  for (const [key, { row, weekNumber }] of afterWorkouts) {
    const prev = beforeWorkouts.get(key);
    if (!prev) {
      changes.push({ kind: 'workout_added', weekNumber, text: `Week ${weekNumber}: added workout "${row.name}"` });
      continue;
    }
    if (prev.row.name !== row.name) {
      changes.push({
        kind: 'workout_renamed',
        weekNumber,
        text: `Week ${weekNumber}: renamed "${prev.row.name}" to "${row.name}"`,
      });
    }
    if ((prev.row.weekday ?? null) !== (row.weekday ?? null) || prev.weekNumber !== weekNumber) {
      changes.push({
        kind: 'workout_moved',
        weekNumber,
        text: `Moved "${row.name}" from week ${prev.weekNumber} ${weekdayName(prev.row.weekday)} to week ${weekNumber} ${weekdayName(row.weekday)}`,
      });
    }

    const beforeExercises = exercisesOf(key, prev.row);
    const afterExercises = exercisesOf(key, row);
    for (const [exKey, exercise] of afterExercises) {
      const old = beforeExercises.get(exKey);
      if (!old) {
        changes.push({
          kind: 'exercise_added',
          weekNumber,
          text: `Week ${weekNumber}, ${row.name}: added ${name(exercise.exerciseId)} (${prescription(exercise)})`,
        });
        continue;
      }
      const parts = describeExerciseChange(old, exercise);
      if (parts.length > 0) {
        changes.push({
          kind: 'exercise_changed',
          weekNumber,
          text: `Week ${weekNumber}, ${row.name}: ${name(exercise.exerciseId)} ${parts.join(', ')}`,
        });
      }
    }
    for (const [exKey, exercise] of beforeExercises) {
      if (!afterExercises.has(exKey)) {
        changes.push({
          kind: 'exercise_removed',
          weekNumber,
          text: `Week ${weekNumber}, ${row.name}: removed ${name(exercise.exerciseId)}`,
        });
      }
    }
  }
  for (const [key, { row, weekNumber }] of beforeWorkouts) {
    if (!afterWorkouts.has(key)) {
      changes.push({ kind: 'workout_removed', weekNumber, text: `Week ${weekNumber}: removed workout "${row.name}"` });
    }
  }

  return { changes, summary: summarize(changes) };
}

function summarize(changes: PlanChange[]): string {
  if (changes.length === 0) return 'No changes to the plan content.';
  const count = (kinds: PlanChangeKind[]) => changes.filter((c) => kinds.includes(c.kind)).length;
  const parts: string[] = [];
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const added = count(['exercise_added']);
  const removed = count(['exercise_removed']);
  const changed = count(['exercise_changed']);
  const workouts = count(['workout_added', 'workout_removed', 'workout_moved', 'workout_renamed']);
  const weeks = count(['week_added', 'week_removed', 'deload_changed', 'block_added', 'block_removed', 'block_renamed']);
  if (added) parts.push(`${plural(added, 'exercise')} added`);
  if (removed) parts.push(`${plural(removed, 'exercise')} removed`);
  if (changed) parts.push(`${plural(changed, 'prescription')} changed`);
  if (workouts) parts.push(`${plural(workouts, 'workout change')}`);
  if (weeks) parts.push(`${plural(weeks, 'week or block change')}`);
  return `${parts.join(', ')}.`.replace(/^./, (c) => c.toUpperCase());
}

/** The tree inside a stored snapshot, or null when it does not look like one. */
export function snapshotTree(snapshot: unknown): PlanTree | null {
  const tree = (snapshot as { tree?: unknown } | null)?.tree as PlanTree | undefined;
  return tree && Array.isArray(tree.blocks) ? tree : null;
}
