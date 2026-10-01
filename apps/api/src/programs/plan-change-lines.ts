import type { PlanTree } from './contracts/plan-tree.contract';
import { describePrescriptionChange } from './contracts/prescription';

// =============================================================================
// Plain-language lines for the prescription changes between two trees
// =============================================================================
//
// SERVER-AUTHORED, pure. A manual edit or a revert stores these as its change
// log `operations` (`{ op: 'edit_prescription', description }`), which the
// history lists under "What changed". Only an exercise row that exists in
// both trees (same row id, same exercise) and whose prescription reads
// differently produces a line; the same change in several weeks is one line
// with its weeks (`Weeks 1-4, Outdoor walk: 20 → 30 min`).
// =============================================================================

export const PRESCRIPTION_CHANGE_LINES_MAX = 20;

export interface PrescriptionChangeOperation {
  op: 'edit_prescription';
  description: string;
}

function weeksLabel(weeks: number[]): string {
  const sorted = [...new Set(weeks)].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (const week of [...sorted.slice(1), Number.NaN]) {
    if (week === prev + 1) {
      prev = week;
      continue;
    }
    ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = week;
    prev = week;
  }
  return `${sorted.length === 1 ? 'Week' : 'Weeks'} ${ranges.join(', ')}`;
}

/**
 * One line per distinct prescription change, in program order of first
 * appearance; at most `PRESCRIPTION_CHANGE_LINES_MAX` (a last line counts the
 * rest). `nameOf` gives the exercise's readable name.
 */
export function prescriptionChangeLines(
  before: PlanTree,
  after: PlanTree,
  nameOf: (exerciseId: string) => string | undefined,
): string[] {
  const previous = new Map<string, PlanTree['blocks'][number]['weeks'][number]['workouts'][number]['exercises'][number]>();
  for (const block of before.blocks)
    for (const week of block.weeks)
      for (const workout of week.workouts) for (const exercise of workout.exercises) if (exercise.id) previous.set(exercise.id, exercise);

  const byText = new Map<string, number[]>();
  const weeks = after.blocks.flatMap((block) => block.weeks).sort((a, b) => a.weekNumber - b.weekNumber);
  for (const week of weeks) {
    for (const workout of week.workouts) {
      for (const exercise of workout.exercises) {
        const old = exercise.id ? previous.get(exercise.id) : undefined;
        if (!old || old.exerciseId !== exercise.exerciseId) continue;
        const change = describePrescriptionChange(old, exercise);
        if (!change) continue;
        const text = `${nameOf(exercise.exerciseId) ?? 'An exercise'}: ${change}`;
        const list = byText.get(text) ?? [];
        list.push(week.weekNumber);
        byText.set(text, list);
      }
    }
  }

  const lines = [...byText.entries()].map(([text, at]) => `${weeksLabel(at)}, ${text}`);
  if (lines.length <= PRESCRIPTION_CHANGE_LINES_MAX) return lines;
  const rest = lines.length - (PRESCRIPTION_CHANGE_LINES_MAX - 1);
  return [...lines.slice(0, PRESCRIPTION_CHANGE_LINES_MAX - 1), `…and ${rest} more prescription changes`];
}

export function prescriptionChangeOperations(
  before: PlanTree,
  after: PlanTree,
  nameOf: (exerciseId: string) => string | undefined,
): PrescriptionChangeOperation[] {
  return prescriptionChangeLines(before, after, nameOf).map((description) => ({ op: 'edit_prescription', description }));
}
