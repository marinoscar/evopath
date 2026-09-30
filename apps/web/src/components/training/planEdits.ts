/**
 * Client-side edits of a plan tree for the editor. Pure: each returns a new
 * tree. The server validates the whole tree on save (`PUT /structure`); these
 * only keep the draft coherent (contiguous positions, week numbers) and
 * explain obvious mistakes before the round trip.
 *
 * New rows get a temporary `tmp-` id so React can keep focus on a moved row;
 * `toSaveTree` strips them (the API assigns real ids to rows without one).
 */
import {
  PLAN_LIMITS,
  type PlanBlock,
  type PlanExercise,
  type PlanTree,
  type PlanTreeView,
  type PlanWeek,
  type PlanWorkout,
} from '../../services/programs';

let counter = 0;
export const tmpId = () => `tmp-${Date.now().toString(36)}-${(counter++).toString(36)}`;
export const isTmpId = (id: string | undefined) => !!id && id.startsWith('tmp-');

/** The view tree (with `exercise` and `exerciseUnavailable`) as an editable plan tree. */
export function toEditTree(view: PlanTreeView): PlanTree {
  return {
    blocks: view.blocks.map((block) => ({
      id: block.id,
      position: block.position,
      name: block.name,
      focus: block.focus,
      rationale: block.rationale,
      weeks: block.weeks.map((week) => ({
        id: week.id,
        weekNumber: week.weekNumber,
        isDeload: week.isDeload,
        workouts: week.workouts.map((workout) => ({
          id: workout.id,
          position: workout.position,
          weekday: workout.weekday,
          name: workout.name,
          estimatedMinutes: workout.estimatedMinutes,
          rationale: workout.rationale,
          exercises: [...workout.exercises]
            .sort((a, b) => a.position - b.position)
            .map((e) => ({
              id: e.id,
              exerciseId: e.exerciseId,
              position: e.position,
              isPriority: e.isPriority,
              targetSets: e.targetSets,
              repMin: e.repMin,
              repMax: e.repMax,
              targetLoadKg: e.targetLoadKg,
              targetRpe: e.targetRpe,
              restSeconds: e.restSeconds,
              loadGuidance: e.loadGuidance,
              rationale: e.rationale,
              evidenceRefs: e.evidenceRefs,
              notes: e.notes,
              equipmentTypeId: e.equipmentTypeId,
            })),
        })),
      })),
    })),
  };
}

/** What `PUT /structure` is sent: temporary ids removed, positions renumbered. */
export function toSaveTree(tree: PlanTree): PlanTree {
  const strip = <T extends { id?: string }>(row: T): T => {
    if (!isTmpId(row.id)) return row;
    const { id: _id, ...rest } = row;
    return rest as T;
  };
  return {
    blocks: tree.blocks.map((block, b) =>
      strip({
        ...block,
        position: b,
        weeks: block.weeks.map((week) =>
          strip({
            ...week,
            workouts: week.workouts.map((workout, w) =>
              strip({
                ...workout,
                position: w,
                exercises: workout.exercises.map((exercise, e) => strip({ ...exercise, position: e })),
              }),
            ),
          }),
        ),
      }),
    ),
  };
}

/** Every week in order, with its block index. */
export function allWeeks(tree: PlanTree): Array<{ blockIndex: number; week: PlanWeek }> {
  return tree.blocks
    .flatMap((block, blockIndex) => block.weeks.map((week) => ({ blockIndex, week })))
    .sort((a, b) => a.week.weekNumber - b.week.weekNumber);
}

function mapWeek(tree: PlanTree, weekNumber: number, fn: (week: PlanWeek) => PlanWeek): PlanTree {
  return {
    blocks: tree.blocks.map((block) => ({
      ...block,
      weeks: block.weeks.map((week) => (week.weekNumber === weekNumber ? fn(week) : week)),
    })),
  };
}

function mapWorkout(tree: PlanTree, weekNumber: number, workoutId: string, fn: (w: PlanWorkout) => PlanWorkout): PlanTree {
  return mapWeek(tree, weekNumber, (week) => ({
    ...week,
    workouts: week.workouts.map((workout) => (workout.id === workoutId ? fn(workout) : workout)),
  }));
}

export function renumberExercises(exercises: PlanExercise[]): PlanExercise[] {
  return exercises.map((exercise, position) => ({ ...exercise, position }));
}

export function updateExercise(
  tree: PlanTree,
  weekNumber: number,
  workoutId: string,
  exerciseId: string,
  patch: Partial<PlanExercise>,
): PlanTree {
  return mapWorkout(tree, weekNumber, workoutId, (workout) => ({
    ...workout,
    exercises: workout.exercises.map((e) => (e.id === exerciseId ? { ...e, ...patch } : e)),
  }));
}

export function moveExercise(tree: PlanTree, weekNumber: number, workoutId: string, exerciseId: string, delta: -1 | 1): PlanTree {
  return mapWorkout(tree, weekNumber, workoutId, (workout) => {
    const list = [...workout.exercises];
    const from = list.findIndex((e) => e.id === exerciseId);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= list.length) return workout;
    [list[from], list[to]] = [list[to], list[from]];
    return { ...workout, exercises: renumberExercises(list) };
  });
}

export function removeExercise(tree: PlanTree, weekNumber: number, workoutId: string, exerciseId: string): PlanTree {
  return mapWorkout(tree, weekNumber, workoutId, (workout) => ({
    ...workout,
    exercises: renumberExercises(workout.exercises.filter((e) => e.id !== exerciseId)),
  }));
}

export function newExercise(exerciseId: string, position: number): PlanExercise {
  return {
    id: tmpId(),
    exerciseId,
    position,
    isPriority: false,
    targetSets: 3,
    repMin: 8,
    repMax: 12,
    targetLoadKg: null,
    targetRpe: null,
    restSeconds: 90,
    loadGuidance: 'choose_start',
    rationale: null,
    evidenceRefs: [],
    notes: null,
    equipmentTypeId: null,
  };
}

export function addExercises(tree: PlanTree, weekNumber: number, workoutId: string, exerciseIds: string[]): PlanTree {
  return mapWorkout(tree, weekNumber, workoutId, (workout) => ({
    ...workout,
    exercises: renumberExercises([
      ...workout.exercises,
      ...exerciseIds.map((id, i) => newExercise(id, workout.exercises.length + i)),
    ]).slice(0, PLAN_LIMITS.exercisesPerWorkoutMax),
  }));
}

/** The first weekday not used in the week, or null. */
export function freeWeekday(week: PlanWeek): number | null {
  const used = new Set(week.workouts.map((w) => w.weekday).filter((d): d is number => typeof d === 'number'));
  for (let d = 1; d <= 7; d++) if (!used.has(d)) return d;
  return null;
}

export function addWorkout(tree: PlanTree, weekNumber: number): PlanTree {
  return mapWeek(tree, weekNumber, (week) =>
    week.workouts.length >= PLAN_LIMITS.workoutsPerWeekMax
      ? week
      : {
          ...week,
          workouts: [
            ...week.workouts,
            {
              id: tmpId(),
              position: week.workouts.length,
              weekday: freeWeekday(week),
              name: `Workout ${week.workouts.length + 1}`,
              estimatedMinutes: null,
              rationale: null,
              exercises: [],
            },
          ],
        },
  );
}

export function removeWorkout(tree: PlanTree, weekNumber: number, workoutId: string): PlanTree {
  return mapWeek(tree, weekNumber, (week) => ({
    ...week,
    workouts: week.workouts.filter((w) => w.id !== workoutId).map((w, position) => ({ ...w, position })),
  }));
}

export function updateWorkout(tree: PlanTree, weekNumber: number, workoutId: string, patch: Partial<PlanWorkout>): PlanTree {
  return mapWorkout(tree, weekNumber, workoutId, (workout) => ({ ...workout, ...patch }));
}

/** Append a week to the last block. */
export function addWeek(tree: PlanTree): PlanTree {
  const next = Math.max(0, ...allWeeks(tree).map((w) => w.week.weekNumber)) + 1;
  if (next > PLAN_LIMITS.weeksMax || tree.blocks.length === 0) return tree;
  const last = tree.blocks.length - 1;
  return {
    blocks: tree.blocks.map((block, i) =>
      i === last ? { ...block, weeks: [...block.weeks, { id: tmpId(), weekNumber: next, isDeload: false, workouts: [] }] } : block,
    ),
  };
}

/** Append a block with one empty week. */
export function addBlock(tree: PlanTree): PlanTree {
  const next = Math.max(0, ...allWeeks(tree).map((w) => w.week.weekNumber)) + 1;
  if (next > PLAN_LIMITS.weeksMax) return tree;
  const block: PlanBlock = {
    id: tmpId(),
    position: tree.blocks.length,
    name: `Block ${tree.blocks.length + 1}`,
    focus: null,
    rationale: null,
    weeks: [{ id: tmpId(), weekNumber: next, isDeload: false, workouts: [] }],
  };
  return { blocks: [...tree.blocks, block] };
}

/** Remove the last week (keeps week numbers contiguous); a block left empty is removed too. */
export function removeLastWeek(tree: PlanTree): PlanTree {
  const weeks = allWeeks(tree);
  if (weeks.length <= 1) return tree;
  const last = weeks[weeks.length - 1].week.weekNumber;
  return {
    blocks: tree.blocks
      .map((block) => ({ ...block, weeks: block.weeks.filter((w) => w.weekNumber !== last) }))
      .filter((block) => block.weeks.length > 0),
  };
}

/** Replace week `to`'s workouts with copies of week `from`'s (new rows). */
export function copyWeek(tree: PlanTree, from: number, to: number): PlanTree {
  const source = allWeeks(tree).find((w) => w.week.weekNumber === from)?.week;
  if (!source || from === to) return tree;
  return mapWeek(tree, to, (week) => ({
    ...week,
    workouts: source.workouts.map((workout) => ({
      ...workout,
      id: tmpId(),
      exercises: workout.exercises.map((exercise) => ({ ...exercise, id: tmpId() })),
    })),
  }));
}

/**
 * Make week `n` a deload: flag it and cut the volume and effort (about 40%
 * fewer sets, one RPE lower). The server's rules still decide on save.
 */
export function makeDeload(tree: PlanTree, weekNumber: number): PlanTree {
  return mapWeek(tree, weekNumber, (week) => ({
    ...week,
    isDeload: true,
    workouts: week.workouts.map((workout) => ({
      ...workout,
      exercises: workout.exercises.map((exercise) => ({
        ...exercise,
        targetSets: Math.max(1, Math.round(exercise.targetSets * 0.6)),
        targetRpe:
          exercise.targetRpe === null || exercise.targetRpe === undefined ? exercise.targetRpe : Math.max(1, exercise.targetRpe - 1),
      })),
    })),
  }));
}

export function setDeload(tree: PlanTree, weekNumber: number, isDeload: boolean): PlanTree {
  return mapWeek(tree, weekNumber, (week) => ({ ...week, isDeload }));
}

/** Row-level problems, keyed `exerciseRowId.field` or `workoutId.field`. */
export function planErrors(tree: PlanTree): Record<string, string> {
  const errors: Record<string, string> = {};
  const L = PLAN_LIMITS;
  const int = (v: unknown) => typeof v === 'number' && Number.isInteger(v);
  for (const { week } of allWeeks(tree)) {
    const days = new Map<number, string>();
    for (const workout of week.workouts) {
      const wid = workout.id ?? '';
      if (!workout.name.trim()) errors[`${wid}.name`] = 'Name the workout.';
      if (workout.weekday) {
        if (days.has(workout.weekday)) errors[`${wid}.weekday`] = `Week ${week.weekNumber} already has a workout that day.`;
        days.set(workout.weekday, wid);
      }
      for (const e of workout.exercises) {
        const id = e.id ?? '';
        if (!int(e.targetSets) || e.targetSets < L.targetSets.min || e.targetSets > L.targetSets.max) {
          errors[`${id}.targetSets`] = `Sets: ${L.targetSets.min} to ${L.targetSets.max}.`;
        }
        if (!int(e.repMin) || e.repMin < L.reps.min || e.repMin > L.reps.max) errors[`${id}.repMin`] = `Reps: ${L.reps.min} to ${L.reps.max}.`;
        if (!int(e.repMax) || e.repMax < L.reps.min || e.repMax > L.reps.max) errors[`${id}.repMax`] = `Reps: ${L.reps.min} to ${L.reps.max}.`;
        else if (int(e.repMin) && e.repMax < e.repMin) errors[`${id}.repMax`] = 'Max reps must be at least min reps.';
        if (e.targetRpe !== null && e.targetRpe !== undefined) {
          if (e.targetRpe < L.targetRpe.min || e.targetRpe > L.targetRpe.max || !Number.isInteger(e.targetRpe / L.targetRpe.step)) {
            errors[`${id}.targetRpe`] = 'RPE: 1 to 10 in steps of 0.5.';
          }
        }
        if (!int(e.restSeconds) || e.restSeconds < L.restSeconds.min || e.restSeconds > L.restSeconds.max) {
          errors[`${id}.restSeconds`] = `Rest: ${L.restSeconds.min} to ${L.restSeconds.max} seconds.`;
        }
        if (e.targetLoadKg !== null && e.targetLoadKg !== undefined && (e.targetLoadKg < 0 || e.targetLoadKg > L.targetLoadKg.max)) {
          errors[`${id}.targetLoadKg`] = 'Load is out of range.';
        }
      }
    }
  }
  return errors;
}
