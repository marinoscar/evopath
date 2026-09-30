import type { PlanTree } from '../../programs/contracts/plan-tree.contract';
import { LOAD_LIMITS } from './limits';
import { firstExposureCap } from './progression';
import { Findings, ceilHalf, floorHalf, pathOf, slotsOf } from './tree';
import type { GuardrailContext, Violation } from './types';

// =============================================================================
// G9 Loads: a model never invents a load
// =============================================================================
//
// A model-supplied `targetLoadKg` stays only when the user has recent
// history on that exercise (a best working load above 0). With history, the
// first planned load must sit within 60..105 percent of the best recent
// working load (and under G7's history cap); later exposures follow G7.
// Repairs: null the load, clamp it, and make `loadGuidance` agree:
// `fixed` with a load; without one `from_history` when there is history,
// else `choose_start`.
// =============================================================================

export function checkLoads(tree: PlanTree, ctx: GuardrailContext): Violation[] {
  const f = new Findings('G9');
  const seen = new Set<string>();

  for (const { week, workout, exercise } of slotsOf(tree)) {
    const lib = ctx.library.get(exercise.exerciseId);
    if (!lib) continue;
    const path = pathOf(ctx, week, workout, exercise);
    const fact = ctx.history.get(exercise.exerciseId);
    const best = fact?.bestRecentLoadKg ?? null;
    const hasHistory = best !== null && best > 0;

    if (exercise.targetLoadKg !== null) {
      if (!hasHistory) {
        f.add('repair', 'load_without_history', path, `Load ${exercise.targetLoadKg} kg removed: there is no recent history to base a load on.`);
        exercise.targetLoadKg = null;
        exercise.loadGuidance = 'choose_start';
      } else if (!week.isDeload && !seen.has(exercise.exerciseId)) {
        const cap = firstExposureCap(lib, exercise, fact, ctx.now);
        const hi = Math.min(floorHalf(best * LOAD_LIMITS.firstExposure.max), cap ?? Number.POSITIVE_INFINITY);
        const lo = Math.min(ceilHalf(best * LOAD_LIMITS.firstExposure.min), hi);
        const clamped = Math.min(hi, Math.max(lo, exercise.targetLoadKg));
        if (clamped !== exercise.targetLoadKg) {
          f.add(
            'repair',
            'first_load_clamped',
            path,
            `Load ${exercise.targetLoadKg} kg set to ${clamped} kg: a first load stays within 60 to 105 percent of your best recent ${best} kg.`,
          );
          exercise.targetLoadKg = clamped;
        }
      }
    }

    if (exercise.targetLoadKg !== null) {
      seen.add(exercise.exerciseId);
      if (exercise.loadGuidance !== 'fixed') {
        f.add('repair', 'load_guidance', path, `Load guidance set to "fixed": the exercise has a load.`);
        exercise.loadGuidance = 'fixed';
      }
    } else if (exercise.loadGuidance === 'fixed' || (exercise.loadGuidance === 'from_history' && !hasHistory)) {
      const guidance = hasHistory ? 'from_history' : 'choose_start';
      f.add('repair', 'load_guidance', path, `Load guidance set to "${guidance}": there is no load to follow.`);
      exercise.loadGuidance = guidance;
    }
  }

  return f.list;
}
