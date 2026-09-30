import { supportedBy } from '../context/build-planner-context';
import type { ImplementClass, LibraryExercise } from '../context/planner-context.contract';
import type { PlanExercise } from '../../programs/contracts/plan-tree.contract';
import type { GuardrailContext } from './types';

// =============================================================================
// The substitution ladder (G2 and G6 repairs; the critic's find_substitutes)
// =============================================================================
//
// A substitute shares the original's movement pattern and includes its first
// primary muscle, is supported by the gym (no gym: needs nothing), and is not
// already in the workout, on the avoid list or pain-flagged. Ranking, fully
// deterministic:
//
//   1. fallback tier of its implement for the original's implement (the same
//      implement is tier 0, then the table below; a class not in the row last),
//   2. same `isCompound` as the original first,
//   3. the user has recent history on it first,
//   4. name, then key, ascending.
//
//   original     tier 1            tier 2   tier 3   tier 4
//   barbell      dumbbell          machine  cable    bodyweight or band
//   dumbbell     barbell           machine  cable    bodyweight or band
//   machine      dumbbell          cable    barbell  bodyweight or band
//   cable        machine           dumbbell band     bodyweight
//   bodyweight   machine (assisted) cable   band     dumbbell
//   band         cable             dumbbell machine  bodyweight   (not in the spec table; our choice)
//
// The substitute carries over sets, reps, RPE, rest and priority; its load is
// cleared (`targetLoadKg` null, `loadGuidance` `choose_start`).
// =============================================================================

export const SUBSTITUTION_LADDER: Readonly<Record<ImplementClass, ReadonlyArray<readonly ImplementClass[]>>> = {
  barbell: [['dumbbell'], ['machine'], ['cable'], ['bodyweight', 'band']],
  dumbbell: [['barbell'], ['machine'], ['cable'], ['bodyweight', 'band']],
  machine: [['dumbbell'], ['cable'], ['barbell'], ['bodyweight', 'band']],
  cable: [['machine'], ['dumbbell'], ['band'], ['bodyweight']],
  bodyweight: [['machine'], ['cable'], ['band'], ['dumbbell']],
  band: [['cable'], ['dumbbell'], ['machine'], ['bodyweight']],
};

/** The fallback tier of `candidate` for `original` (0 same implement; 99 not on the ladder). */
export function fallbackTier(original: ImplementClass, candidate: ImplementClass): number {
  if (original === candidate) return 0;
  const index = SUBSTITUTION_LADDER[original].findIndex((tier) => tier.includes(candidate));
  return index === -1 ? 99 : index + 1;
}

/** Ranked substitutes for `original` (best first). `excludeIds` are ids already in the workout. */
export function findSubstitutes(
  original: LibraryExercise,
  ctx: GuardrailContext,
  excludeIds: ReadonlySet<string> = new Set(),
): LibraryExercise[] {
  const muscle = original.primaryMuscles[0];

  return [...ctx.library.values()]
    .filter(
      (candidate) =>
        candidate.id !== original.id &&
        !excludeIds.has(candidate.id) &&
        candidate.movementPattern === original.movementPattern &&
        (muscle === undefined || candidate.primaryMuscles.includes(muscle)) &&
        !ctx.avoidExerciseKeys.has(candidate.key) &&
        !ctx.painFlagKeys.has(candidate.key) &&
        supportedBy(candidate, ctx.gym),
    )
    .map((candidate) => ({
      candidate,
      tier: fallbackTier(original.implement, candidate.implement),
      compound: candidate.isCompound === original.isCompound ? 0 : 1,
      history: ctx.history.has(candidate.id) ? 0 : 1,
    }))
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        a.compound - b.compound ||
        a.history - b.history ||
        (a.candidate.name < b.candidate.name ? -1 : a.candidate.name > b.candidate.name ? 1 : 0) ||
        (a.candidate.key < b.candidate.key ? -1 : a.candidate.key > b.candidate.key ? 1 : 0),
    )
    .map((entry) => entry.candidate);
}

/** Swaps `exercise` to `substitute` in place, keeping its prescription and clearing its load. */
export function substituteInPlace(exercise: PlanExercise, substitute: LibraryExercise): void {
  exercise.exerciseId = substitute.id;
  exercise.targetLoadKg = null;
  exercise.loadGuidance = 'choose_start';
  exercise.equipmentTypeId = null;
}
