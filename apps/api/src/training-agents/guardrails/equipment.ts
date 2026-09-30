import type { PlanTree } from '../../programs/contracts/plan-tree.contract';
import { supportedBy } from '../context/build-planner-context';
import { findSubstitutes, substituteInPlace } from './substitution';
import { Findings, pathOf, weeksOf, workoutLabel } from './tree';
import type { GuardrailContext, Violation } from './types';

// =============================================================================
// G2 Equipment
// =============================================================================
//
// Every exercise's requirement groups must be satisfied by the gym: a group
// is satisfied when the gym has ANY listed equipment type or any equipment
// providing ANY listed capability, and an exercise needs EVERY group
// (`isAvailable`, the E4.1 semantics). No gym: only exercises that need
// nothing.
//
// Repair: substitute along the ladder (`substitution.ts`); else drop with a
// warning. A priority exercise nothing can replace blocks the plan. A
// workout emptied by drops is removed (warning).
// =============================================================================

export function checkEquipment(tree: PlanTree, ctx: GuardrailContext): Violation[] {
  const f = new Findings('G2');
  const where = ctx.gym ? 'your gym' : 'bodyweight only (no gym)';

  for (const { week } of weeksOf(tree)) {
    for (const workout of [...week.workouts]) {
      for (const exercise of [...workout.exercises]) {
        const lib = ctx.library.get(exercise.exerciseId);
        if (!lib || supportedBy(lib, ctx.gym)) continue;

        const path = pathOf(ctx, week, workout, exercise);
        const inWorkout = new Set(workout.exercises.map((e) => e.exerciseId));
        const [substitute] = findSubstitutes(lib, ctx, inWorkout);

        if (substitute) {
          substituteInPlace(exercise, substitute);
          f.add('repair', 'equipment_substituted', path, `Replaced "${lib.key}" with "${substitute.key}": ${where} cannot support it.`);
        } else if (exercise.isPriority) {
          f.add('block', 'priority_unfillable', path, `"${lib.key}" is a main lift ${where} cannot support, and no substitute fits.`);
        } else {
          workout.exercises = workout.exercises.filter((e) => e !== exercise);
          f.add('warn', 'equipment_dropped', path, `Removed "${lib.key}": ${where} cannot support it and no substitute fits.`);
        }
      }

      if (workout.exercises.length === 0) {
        week.workouts = week.workouts.filter((w) => w !== workout);
        f.add('warn', 'empty_workout_dropped', pathOf(ctx, week, workout), `Removed ${workoutLabel(workout)}: no exercise in it fits the equipment.`);
      }
      workout.exercises.forEach((e, i) => {
        e.position = i;
      });
    }
  }

  return f.list;
}
