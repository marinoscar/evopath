import type { Prisma } from '@prisma/client';

import { fromDbDate } from '../../../check-ins/local-date';
import type { PlannedSnapshotEntry } from '../../../programs/today/planned-session';
import {
  bestPerType,
  classifySequence,
  E1RM_MAX_REPS,
  round3,
  toWorkingSet,
  tracksPrs,
  type EarnedPr,
  type SetPr,
  type WeightBucket,
} from '../../../workouts/workout-records';
import type { CoachChatToolDeps } from './coach-chat-tool.types';
import { dropNulls, localTimeOf, num, round, userText, weekdayOf } from './user-context';

// =============================================================================
// One logged workout in full, for the coach chat (#338)
// =============================================================================
//
// `get_workout_history` and `get_workout` read workouts with ONE select
// (`WORKOUT_DETAIL_SELECT`): the workout, its gym's name, its plan link, and
// every exercise and set in order, notes and pain notes included (the chat's
// privacy rule, `user-context.ts`). Never a photo, a readiness snapshot or a
// gym's location. PRs come from the same rules `WorkoutHistoryService` uses
// (`workout-records.ts`): one grouped SQL read for the whole batch, then the
// workouts are folded in chronological order (`prsForWorkouts`).
// =============================================================================

export const WORKOUT_DETAIL_SELECT = {
  id: true,
  name: true,
  date: true,
  status: true,
  startedAt: true,
  endedAt: true,
  durationSeconds: true,
  notes: true,
  gym: { select: { name: true } },
  programWorkout: { select: { name: true, week: { select: { weekNumber: true } } } },
  programSession: {
    select: {
      plannedFor: true,
      plannedSnapshot: true,
      programWorkout: { select: { name: true, week: { select: { weekNumber: true } } } },
    },
  },
  exercises: {
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      exerciseId: true,
      position: true,
      notes: true,
      exercise: { select: { name: true, trackingMode: true } },
      sets: {
        orderBy: { setNumber: 'asc' },
        select: {
          id: true,
          setNumber: true,
          weightKg: true,
          reps: true,
          durationSeconds: true,
          distanceMeters: true,
          rpe: true,
          rir: true,
          restSeconds: true,
          isWarmup: true,
          completed: true,
          painFlag: true,
          painNote: true,
          notes: true,
        },
      },
    },
  },
} satisfies Prisma.WorkoutSelect;

export type WorkoutDetailRow = Prisma.WorkoutGetPayload<{ select: typeof WORKOUT_DETAIL_SELECT }>;

export interface CoachSetView {
  set: number;
  warmup?: true;
  weightKg?: number;
  reps?: number;
  rpe?: number;
  rir?: number;
  durationSeconds?: number;
  distanceMeters?: number;
  restSeconds?: number;
  completed: boolean;
  painFlag?: true;
  painNote?: string;
  notes?: string;
}

export interface CoachPrView {
  exercise: string;
  setNumber: number;
  type: SetPr['type'];
  /** kg for first_time/weight/e1rm, reps for reps. */
  value: number;
  previous: number | null;
}

export interface CoachWorkoutView {
  workoutId: string;
  date: string;
  weekday: string;
  startTime: string;
  endTime: string | null;
  durationMinutes: number | null;
  status: string;
  name: string;
  gym: string | null;
  notes: string | null;
  plan: { session: string | null; weekNumber: number | null; plannedFor: string | null } | null;
  exercises: Array<{ name: string; notes: string | null; sets: CoachSetView[] }>;
  totals: { workingSets: number; volumeKg: number };
  prs: CoachPrView[];
}

function setView(set: WorkoutDetailRow['exercises'][number]['sets'][number]): CoachSetView {
  return {
    set: set.setNumber,
    ...(set.isWarmup ? { warmup: true as const } : {}),
    ...dropNulls({
      weightKg: num(set.weightKg),
      reps: set.reps,
      rpe: num(set.rpe),
      rir: set.rir,
      durationSeconds: set.durationSeconds,
      distanceMeters: num(set.distanceMeters),
      restSeconds: set.restSeconds,
    }),
    completed: set.completed,
    ...(set.painFlag ? { painFlag: true as const } : {}),
    ...dropNulls({ painNote: userText(set.painNote), notes: userText(set.notes) }),
  } as CoachSetView;
}

/** Completed working sets and their volume (kg x reps; an unweighted set adds 0). */
function totalsOf(row: WorkoutDetailRow): { workingSets: number; volumeKg: number } {
  let workingSets = 0;
  let volume = 0;
  for (const entry of row.exercises) {
    for (const set of entry.sets) {
      if (!set.completed || set.isWarmup) continue;
      workingSets += 1;
      const weight = num(set.weightKg);
      if (weight !== null && set.reps !== null) volume += weight * set.reps;
    }
  }
  return { workingSets, volumeKg: round(volume, 1) };
}

function durationMinutesOf(row: WorkoutDetailRow): number | null {
  if (row.durationSeconds !== null) return Math.round(row.durationSeconds / 60);
  if (row.endedAt) return Math.round((row.endedAt.getTime() - row.startedAt.getTime()) / 60_000);
  return null;
}

/** One workout as the coach reads it. `prs` maps set id -> the PRs that set earned. */
export function workoutView(row: WorkoutDetailRow, timeZone: string | null, prs: ReadonlyMap<string, SetPr[]>): CoachWorkoutView {
  const date = fromDbDate(row.date);
  const linked = row.programSession?.programWorkout ?? row.programWorkout;
  const plan =
    row.programSession || row.programWorkout
      ? {
          session: linked?.name ?? null,
          weekNumber: linked?.week.weekNumber ?? null,
          plannedFor: row.programSession ? fromDbDate(row.programSession.plannedFor) : null,
        }
      : null;

  const earned: EarnedPr[] = [];
  for (const entry of row.exercises) {
    for (const set of entry.sets) {
      for (const pr of prs.get(set.id) ?? []) {
        earned.push({
          exerciseId: entry.exerciseId,
          exerciseName: entry.exercise.name,
          workoutExerciseId: entry.id,
          setId: set.id,
          setNumber: set.setNumber,
          position: entry.position,
          pr,
        });
      }
    }
  }

  return {
    workoutId: row.id,
    date,
    weekday: weekdayOf(date),
    startTime: localTimeOf(row.startedAt, timeZone),
    endTime: row.endedAt ? localTimeOf(row.endedAt, timeZone) : null,
    durationMinutes: durationMinutesOf(row),
    status: row.status,
    name: row.name,
    gym: userText(row.gym?.name ?? null, 80),
    notes: userText(row.notes),
    plan,
    exercises: row.exercises.map((entry) => ({
      name: entry.exercise.name,
      notes: userText(entry.notes),
      sets: entry.sets.map(setView),
    })),
    totals: totalsOf(row),
    prs: bestPerType(earned).map((pr) => ({
      exercise: pr.exerciseName,
      setNumber: pr.setNumber,
      type: pr.type,
      value: pr.value,
      previous: pr.previous,
    })),
  };
}

/** The plan's prescription a workout was started from, by exercise name (null when not from a plan). */
export function plannedSnapshotView(
  snapshot: unknown,
  names: ReadonlyMap<string, string>,
): Array<Record<string, unknown>> | null {
  if (!Array.isArray(snapshot)) return null;
  return (snapshot as PlannedSnapshotEntry[]).map((entry) =>
    dropNulls({
      exercise: names.get(entry.exerciseId) ?? entry.slug,
      priority: entry.isPriority || null,
      sets: entry.sets,
      repMin: entry.repMin,
      repMax: entry.repMax,
      targetDurationSeconds: entry.targetDurationSeconds ?? null,
      targetDistanceMeters: entry.targetDistanceMeters ?? null,
      targetRpe: entry.targetRpe,
      targetLoadKg: entry.targetLoadKg,
      loadGuidance: entry.loadGuidance,
    }),
  );
}

// -----------------------------------------------------------------------------
// PRs for a batch of workouts
// -----------------------------------------------------------------------------

function chronological(a: WorkoutDetailRow, b: WorkoutDetailRow): number {
  return a.date.getTime() - b.date.getTime() || a.startedAt.getTime() - b.startedAt.getTime() || (a.id < b.id ? -1 : 1);
}

function addToBuckets(byWeight: Map<number, WeightBucket>, weightKg: number, reps: number): void {
  const inRange = reps <= E1RM_MAX_REPS ? reps : null;
  const bucket = byWeight.get(weightKg);
  if (!bucket) {
    byWeight.set(weightKg, { weightKg, maxReps: reps, maxRepsForE1rm: inRange });
    return;
  }
  bucket.maxReps = Math.max(bucket.maxReps, reps);
  if (inRange !== null) bucket.maxRepsForE1rm = bucket.maxRepsForE1rm === null ? inRange : Math.max(bucket.maxRepsForE1rm, inRange);
}

/**
 * The PRs of every set of the COMPLETED workouts in `rows`, by set id: the
 * same answer `WorkoutHistoryService.prsForWorkout` gives per workout, in one
 * grouped read. History before the earliest completed workout of the batch
 * comes from SQL (`priorBuckets`); the batch itself is folded oldest first.
 * `rows` must be every completed workout of the caller from the earliest one
 * on (a newest-first page is). Empty without a history source.
 */
export async function prsForWorkouts(
  deps: CoachChatToolDeps,
  userId: string,
  rows: readonly WorkoutDetailRow[],
): Promise<Map<string, SetPr[]>> {
  const result = new Map<string, SetPr[]>();
  const completed = rows.filter((row) => row.status === 'completed').sort(chronological);
  if (!deps.history || completed.length === 0) return result;

  const exerciseIds = new Set<string>();
  for (const row of completed)
    for (const entry of row.exercises)
      if (tracksPrs(entry.exercise.trackingMode) && entry.sets.some((set) => set.completed && !set.isWarmup)) exerciseIds.add(entry.exerciseId);
  if (exerciseIds.size === 0) return result;

  const earliest = completed[0];
  const prior = await deps.history.priorBuckets(userId, [...exerciseIds], {
    kind: 'beforeWorkout',
    workoutId: earliest.id,
    date: earliest.date,
    startedAt: earliest.startedAt,
  });
  const state = new Map<string, Map<number, WeightBucket>>();
  for (const id of exerciseIds) {
    state.set(id, new Map((prior.get(id) ?? []).map((bucket) => [bucket.weightKg, { ...bucket }])));
  }

  for (const row of completed) {
    const byExercise = new Map<string, WorkoutDetailRow['exercises'][number][]>();
    for (const entry of row.exercises) {
      if (!exerciseIds.has(entry.exerciseId)) continue;
      byExercise.set(entry.exerciseId, [...(byExercise.get(entry.exerciseId) ?? []), entry]);
    }
    for (const [exerciseId, entries] of byExercise) {
      const ordered = [...entries].sort((a, b) => a.position - b.position);
      const mode = ordered[0].exercise.trackingMode;
      const sequence = ordered.flatMap((entry) =>
        entry.sets.map((set) => ({
          key: set.id,
          set: { weightKg: num(set.weightKg), reps: set.reps, completed: set.completed, isWarmup: set.isWarmup },
        })),
      );
      const buckets = state.get(exerciseId)!;
      for (const [setId, prs] of classifySequence(sequence, mode, [...buckets.values()])) {
        if (prs.length > 0) result.set(setId, prs);
      }
      for (const { set } of sequence) {
        const working = toWorkingSet(set, mode);
        if (working) addToBuckets(buckets, round3(working.weightKg), working.reps);
      }
    }
  }
  return result;
}
