import type { PlanChangeOperation, PlanChangeWeekRange } from '../../programs/contracts/plan-change.contract';
import { WEEKDAY_NAMES } from '../guardrails/tree';

// =============================================================================
// describeOperation: one plain-language line per plan-change operation
// =============================================================================
//
// SERVER-AUTHORED. The history, the proposal card and the adaptation critic
// show these lines; they are built from the operation's numbers and exercise
// keys (or the library names the caller passes), never from the model's
// `reason` text.
// =============================================================================

export interface DescribeOptions {
  /** The exercise key a short ref names (`W3-2-4` -> `back_squat`). */
  keyOfRef?: (ref: string) => string | undefined;
  /** A readable name for an exercise key (the library name); default the key with spaces. */
  nameOfKey?: (key: string) => string | undefined;
}

const DESCRIPTION_MAX = 200;

function humanKey(key: string): string {
  return key.replace(/_/g, ' ');
}

function weeksLabel(weeks: PlanChangeWeekRange): string {
  return weeks.from === weeks.to ? `Week ${weeks.from}` : `Weeks ${weeks.from}-${weeks.to}`;
}

/** `W3-2` or `W3-2-4` -> the workout's position in its week (`2`). */
function workoutSlotOf(ref: string): string {
  return ref.split('-')[1] ?? '?';
}

function kg(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1).replace(/\.0$/, '')} kg`;
}

export function describeOperation(op: PlanChangeOperation, options: DescribeOptions = {}): string {
  const name = (key: string | undefined) => (key ? (options.nameOfKey?.(key) ?? humanKey(key)) : 'an exercise');
  const exerciseAt = (ref: string) => name(options.keyOfRef?.(ref));
  let text: string;

  switch (op.op) {
    case 'set_prescription': {
      const parts: string[] = [];
      if (op.sets !== null) parts.push(`${op.sets} ${op.sets === 1 ? 'set' : 'sets'}`);
      if (op.repMin !== null || op.repMax !== null) {
        const min = op.repMin ?? op.repMax;
        const max = op.repMax ?? op.repMin;
        parts.push(min === max ? `${min} reps` : `${min}-${max} reps`);
      }
      if (op.targetLoadKg !== null) parts.push(kg(op.targetLoadKg));
      if (op.targetRpe !== null) parts.push(`RPE ${op.targetRpe}`);
      if (op.restSeconds !== null) parts.push(`${op.restSeconds} s rest`);
      if (op.loadGuidance === 'choose_start') parts.push('you choose the starting weight');
      if (op.loadGuidance === 'from_history') parts.push('weight from your recent sessions');
      text = `${weeksLabel(op.target.weeks)}, ${exerciseAt(op.target.exerciseRef)}: ${parts.length ? parts.join(', ') : 'no change'}`;
      break;
    }
    case 'swap_exercise':
      text = `${weeksLabel(op.target.weeks)}: replace ${exerciseAt(op.target.exerciseRef)} with ${name(op.withExerciseKey)}`;
      break;
    case 'remove_exercise':
      text = `${weeksLabel(op.target.weeks)}: remove ${exerciseAt(op.target.exerciseRef)}`;
      break;
    case 'add_exercise':
      text =
        `${weeksLabel(op.weeks)}, workout ${workoutSlotOf(op.workoutRef)}: add ${name(op.exerciseKey)} ` +
        `(${op.sets} x ${op.repMin === op.repMax ? op.repMin : `${op.repMin}-${op.repMax}`})`;
      break;
    case 'set_weekday':
      text = `${weeksLabel(op.weeks)}: move workout ${workoutSlotOf(op.workoutRef)} to ${WEEKDAY_NAMES[op.weekday] ?? op.weekday}`;
      break;
    case 'drop_workout':
      text = `${weeksLabel(op.weeks)}: drop workout ${workoutSlotOf(op.workoutRef)}`;
      break;
    case 'mark_deload':
      text = `Week ${op.weekNumber} becomes a lighter deload week (fewer sets, lighter loads)`;
      break;
    case 'regenerate_remaining':
      text = `Rewrite the plan from week ${op.fromWeek}`;
      break;
  }

  return text.length > DESCRIPTION_MAX ? `${text.slice(0, DESCRIPTION_MAX - 1)}…` : text;
}
