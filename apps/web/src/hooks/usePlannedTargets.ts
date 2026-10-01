/**
 * The duration and distance targets the plan set for a logged workout's
 * exercises (#263), so the logger can pre-fill them and show progress.
 *
 * A workout started from the plan carries `programWorkoutId`; the planned
 * rows live in the active plan's tree (`GET /api/programs?status=active`,
 * then `GET /api/programs/:id`). Nothing is requested unless the workout is
 * linked to the plan AND has a time or distance exercise, and the caller
 * holds `programs:read`. Reads only: what counts as done is the API's call
 * (training signals); this is presentation.
 *
 * A plan edited after the workout started shows the plan's current target.
 */
import { useEffect, useMemo, useState } from 'react';
import { getProgram, listPrograms, type PlanExerciseView } from '../services/programs';
import type { Workout } from '../services/workouts';
import { useIsMounted } from './useIsMounted';

export interface PlannedTarget {
  /** Seconds per set; null when the plan sets none. */
  durationSeconds: number | null;
  /** Metres per set; null when the plan sets none. */
  distanceMeters: number | null;
  /** Planned sets (intervals); null or 1 for one continuous effort. */
  sets: number | null;
}

/** Exercise id -> its plan target; only exercises with a duration or distance target. */
export type PlannedTargets = Record<string, PlannedTarget>;

const CARDIO_MODES = new Set(['time', 'distance_time']);
const NONE: PlannedTargets = {};

/** The cardio targets of one planned workout in a plan tree, by exercise id. */
export function targetsFromTree(
  tree: { blocks: Array<{ weeks: Array<{ workouts: Array<{ id: string; exercises: PlanExerciseView[] }> }> }> },
  programWorkoutId: string,
): PlannedTargets | null {
  for (const block of tree.blocks)
    for (const week of block.weeks)
      for (const workout of week.workouts) {
        if (workout.id !== programWorkoutId) continue;
        const targets: PlannedTargets = {};
        for (const e of workout.exercises) {
          const durationSeconds = e.targetDurationSeconds ?? null;
          const distanceMeters = e.targetDistanceMeters ?? null;
          if (durationSeconds === null && distanceMeters === null) continue;
          if (targets[e.exerciseId]) continue; // the first row wins when an exercise repeats
          targets[e.exerciseId] = { durationSeconds, distanceMeters, sets: e.targetSets ?? null };
        }
        return targets;
      }
  return null;
}

export function usePlannedTargets(
  workout: Pick<Workout, 'id' | 'programWorkoutId' | 'exercises'> | null,
  { enabled = true }: { enabled?: boolean } = {},
): PlannedTargets {
  const [targets, setTargets] = useState<PlannedTargets>(NONE);
  const isMounted = useIsMounted();
  const programWorkoutId = workout?.programWorkoutId ?? null;
  const hasCardio = useMemo(
    () => (workout?.exercises ?? []).some((e) => CARDIO_MODES.has(e.exercise.trackingMode)),
    [workout?.exercises],
  );
  const active = enabled && programWorkoutId !== null && hasCardio;

  useEffect(() => {
    if (!active || !programWorkoutId) {
      setTargets(NONE);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const programs = await listPrograms({ status: 'active' });
        for (const item of programs) {
          const program = await getProgram(item.id);
          const found = targetsFromTree(program.tree, programWorkoutId);
          if (found) {
            if (!cancelled && isMounted()) setTargets(found);
            return;
          }
        }
        if (!cancelled && isMounted()) setTargets(NONE);
      } catch {
        // Quiet: the logger works without targets.
        if (!cancelled && isMounted()) setTargets(NONE);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, programWorkoutId, isMounted]);

  return targets;
}
