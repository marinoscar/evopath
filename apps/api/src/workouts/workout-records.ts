import type { ExerciseTrackingMode } from '../common/constants/training.constants';

// =============================================================================
// Workout records (E4.4) — the single home of the PR and 1RM formulas
// =============================================================================
//
// Pure functions, no Nest or Prisma imports. `WorkoutHistoryService` feeds
// them from SQL aggregates; the tests feed them raw sets and check that both
// paths agree.
//
// WORKING SET. `completed AND NOT isWarmup AND reps >= 1` with a weight: a
// `weight_reps` set without `weightKg` does not count; a `bodyweight_reps` set
// without added weight counts as 0 kg (it can earn a rep PR only). `time` and
// `distance_time` exercises have no working sets and never earn a PR.
// Pain-flagged sets count.
//
// PRs of a working set S against its PRIOR working sets (strictly greater
// wins; ties are not PRs):
//   - first_time: there is no prior working set at all (and then nothing else).
//   - weight:     S.weightKg > max prior weightKg.
//   - reps:       S.reps > max prior reps among prior sets at S.weightKg - 0.01
//                 or heavier; needs at least one such prior set.
//   - e1rm:       e1rmKg(S) > max prior e1rmKg (both rounded to 0.1 kg); needs
//                 S and at least one prior set to have an e1RM.
// =============================================================================

/** The PR types a set can earn, in reporting order. */
export const PR_TYPES = ['first_time', 'weight', 'reps', 'e1rm'] as const;
export type PrType = (typeof PR_TYPES)[number];

/** One PR a set earns. For `first_time`, `value` is the set's weight (kg) and `previous` is null. */
export interface SetPr {
  type: PrType;
  value: number;
  previous: number | null;
}

/** The set fields the record rules read. */
export interface RecordSetInput {
  weightKg: number | null;
  reps: number | null;
  completed: boolean;
  isWarmup: boolean;
}

/** A working set: kilograms (0 for an unweighted bodyweight set) and reps >= 1. */
export interface WorkingSet {
  weightKg: number;
  reps: number;
}

/** The best reps logged at one exact weight, as SQL `GROUP BY weight` returns them. */
export interface WeightBucket {
  weightKg: number;
  /** Most reps in one set at this weight. */
  maxReps: number;
  /** Most reps in one set at this weight among sets of 1..12 reps (the e1RM range), or null. */
  maxRepsForE1rm: number | null;
}

/** Reps range the Epley estimate is used for. */
export const E1RM_MAX_REPS = 12;
/** A prior set counts toward a rep PR at this many kilograms below S's weight or heavier. */
export const REP_PR_WEIGHT_TOLERANCE_KG = 0.01;

/** True when an exercise of this tracking mode can earn PRs at all. */
export function tracksPrs(trackingMode: ExerciseTrackingMode | string): boolean {
  return trackingMode === 'weight_reps' || trackingMode === 'bodyweight_reps';
}

/** Rounds to 0.1 (e1RM display and comparison precision). */
export function round1(value: number): number {
  return Math.round(value * 10 + 1e-9) / 10;
}

/** Rounds to 0.001 kg (the stored weight precision), removing float noise. */
export function round3(value: number): number {
  return Math.round(value * 1000 + 1e-9) / 1000;
}

/**
 * The set as a working set, or null when it does not count. See the header
 * for the rule.
 */
export function toWorkingSet(set: RecordSetInput, trackingMode: ExerciseTrackingMode | string): WorkingSet | null {
  if (!tracksPrs(trackingMode)) return null;
  if (!set.completed || set.isWarmup) return null;
  if (set.reps === null || set.reps < 1) return null;

  let weightKg = set.weightKg;
  if (weightKg === null) {
    if (trackingMode !== 'bodyweight_reps') return null;
    weightKg = 0;
  }

  return { weightKg: round3(weightKg), reps: set.reps };
}

/** The working sets among `sets`, in their order. */
export function workingSets(sets: readonly RecordSetInput[], trackingMode: ExerciseTrackingMode | string): WorkingSet[] {
  const result: WorkingSet[] = [];
  for (const set of sets) {
    const working = toWorkingSet(set, trackingMode);
    if (working) result.push(working);
  }
  return result;
}

/**
 * Estimated one-rep max (Epley), rounded to 0.1 kg: `weightKg * (1 + reps / 30)`,
 * `weightKg` itself for a single; null outside 1..12 reps or without weight.
 */
export function e1rmKg(weightKg: number | null, reps: number | null): number | null {
  if (weightKg === null || reps === null) return null;
  if (!(weightKg > 0) || reps < 1 || reps > E1RM_MAX_REPS) return null;
  return round1(reps === 1 ? weightKg : weightKg * (1 + reps / 30));
}

/** Groups working sets by exact weight, the shape the SQL aggregate returns. */
export function toWeightBuckets(sets: readonly WorkingSet[]): WeightBucket[] {
  const byWeight = new Map<number, WeightBucket>();
  for (const set of sets) {
    addToBuckets(byWeight, set);
  }
  return [...byWeight.values()];
}

function addToBuckets(byWeight: Map<number, WeightBucket>, set: WorkingSet): void {
  const inRange = set.reps <= E1RM_MAX_REPS ? set.reps : null;
  const bucket = byWeight.get(set.weightKg);
  if (!bucket) {
    byWeight.set(set.weightKg, { weightKg: set.weightKg, maxReps: set.reps, maxRepsForE1rm: inRange });
    return;
  }
  bucket.maxReps = Math.max(bucket.maxReps, set.reps);
  if (inRange !== null) {
    bucket.maxRepsForE1rm = bucket.maxRepsForE1rm === null ? inRange : Math.max(bucket.maxRepsForE1rm, inRange);
  }
}

/** The PRs `set` earns against prior history summarized as weight buckets. */
export function classifyAgainstBuckets(set: WorkingSet, prior: readonly WeightBucket[]): SetPr[] {
  if (prior.length === 0) {
    return [{ type: 'first_time', value: set.weightKg, previous: null }];
  }

  const prs: SetPr[] = [];

  const maxWeight = Math.max(...prior.map((bucket) => bucket.weightKg));
  if (set.weightKg > maxWeight) {
    prs.push({ type: 'weight', value: set.weightKg, previous: maxWeight });
  }

  const atOrAbove = prior.filter((bucket) => bucket.weightKg >= set.weightKg - REP_PR_WEIGHT_TOLERANCE_KG);
  if (atOrAbove.length > 0) {
    const maxReps = Math.max(...atOrAbove.map((bucket) => bucket.maxReps));
    if (set.reps > maxReps) {
      prs.push({ type: 'reps', value: set.reps, previous: maxReps });
    }
  }

  const estimate = e1rmKg(set.weightKg, set.reps);
  if (estimate !== null) {
    const priorEstimates = prior
      .map((bucket) => e1rmKg(bucket.weightKg, bucket.maxRepsForE1rm))
      .filter((value): value is number => value !== null);
    if (priorEstimates.length > 0) {
      const best = Math.max(...priorEstimates);
      if (estimate > best) {
        prs.push({ type: 'e1rm', value: estimate, previous: best });
      }
    }
  }

  return prs;
}

/** The PRs `set` earns against `priorSets` (working sets only; see `workingSets`). */
export function classifySet(set: WorkingSet, priorSets: readonly WorkingSet[]): SetPr[] {
  return classifyAgainstBuckets(set, toWeightBuckets(priorSets));
}

/** A set of one workout in "prior" order (position, then setNumber). */
export interface SequencedSet<K> {
  key: K;
  set: RecordSetInput;
}

/**
 * The PRs of every set of one exercise within one workout, in order: each set
 * is compared with `prior` (the other workouts) plus the working sets before
 * it in `sets`. Sets that are not working sets map to an empty array.
 */
export function classifySequence<K>(
  sets: ReadonlyArray<SequencedSet<K>>,
  trackingMode: ExerciseTrackingMode | string,
  prior: readonly WeightBucket[],
): Map<K, SetPr[]> {
  const byWeight = new Map<number, WeightBucket>();
  for (const bucket of prior) {
    byWeight.set(bucket.weightKg, { ...bucket });
  }

  const result = new Map<K, SetPr[]>();
  for (const { key, set } of sets) {
    const working = toWorkingSet(set, trackingMode);
    if (!working) {
      result.set(key, []);
      continue;
    }
    result.set(key, classifyAgainstBuckets(working, [...byWeight.values()]));
    addToBuckets(byWeight, working);
  }
  return result;
}

/** A PR earned by one set of one workout exercise, for `bestPerType`. */
export interface EarnedPr {
  exerciseId: string;
  exerciseName: string;
  workoutExerciseId: string;
  setId: string;
  setNumber: number;
  /** The entry's position in the workout, for "earliest" tie-breaking. */
  position: number;
  pr: SetPr;
}

export interface BestPr {
  exerciseId: string;
  exerciseName: string;
  workoutExerciseId: string;
  setId: string;
  setNumber: number;
  type: PrType;
  value: number;
  previous: number | null;
}

/**
 * The best set per PR type per exercise: the highest `value` (the earliest set
 * on a tie). Ordered by first appearance of the exercise, then `PR_TYPES`.
 */
export function bestPerType(earned: readonly EarnedPr[]): BestPr[] {
  const ordered = [...earned].sort((a, b) => a.position - b.position || a.setNumber - b.setNumber);
  const best = new Map<string, EarnedPr>();
  const exerciseOrder: string[] = [];

  for (const item of ordered) {
    if (!exerciseOrder.includes(item.exerciseId)) exerciseOrder.push(item.exerciseId);
    const key = `${item.exerciseId}:${item.pr.type}`;
    const current = best.get(key);
    if (!current || item.pr.value > current.pr.value) {
      best.set(key, item);
    }
  }

  const result: BestPr[] = [];
  for (const exerciseId of exerciseOrder) {
    for (const type of PR_TYPES) {
      const item = best.get(`${exerciseId}:${type}`);
      if (!item) continue;
      result.push({
        exerciseId: item.exerciseId,
        exerciseName: item.exerciseName,
        workoutExerciseId: item.workoutExerciseId,
        setId: item.setId,
        setNumber: item.setNumber,
        type,
        value: item.pr.value,
        previous: item.pr.previous,
      });
    }
  }
  return result;
}

// -----------------------------------------------------------------------------
// All-time records (the reference the history SQL mirrors)
// -----------------------------------------------------------------------------

export interface DatedWorkingSet extends WorkingSet {
  /** `YYYY-MM-DD` of the workout. */
  date: string;
  /** The workout's start, to order two workouts on one day. */
  startedAt: Date;
}

export interface ExerciseRecords {
  maxWeightKg: { value: number; reps: number; date: string } | null;
  maxReps: { value: number; weightKg: number; date: string } | null;
  bestE1rmKg: { value: number; weightKg: number; reps: number; date: string } | null;
}

/**
 * All-time records over dated working sets. Ties go to the heavier (or
 * higher-rep) set, then to the earliest workout: the date a record was first
 * reached.
 */
export function recordsOf(sets: readonly DatedWorkingSet[]): ExerciseRecords {
  const earlier = (a: DatedWorkingSet, b: DatedWorkingSet) =>
    a.date < b.date || (a.date === b.date && a.startedAt.getTime() < b.startedAt.getTime());

  let maxWeight: DatedWorkingSet | null = null;
  let maxReps: DatedWorkingSet | null = null;
  let bestE1rm: { set: DatedWorkingSet; value: number } | null = null;

  for (const set of sets) {
    if (
      !maxWeight ||
      set.weightKg > maxWeight.weightKg ||
      (set.weightKg === maxWeight.weightKg && (set.reps > maxWeight.reps || (set.reps === maxWeight.reps && earlier(set, maxWeight))))
    ) {
      maxWeight = set;
    }
    if (
      !maxReps ||
      set.reps > maxReps.reps ||
      (set.reps === maxReps.reps && (set.weightKg > maxReps.weightKg || (set.weightKg === maxReps.weightKg && earlier(set, maxReps))))
    ) {
      maxReps = set;
    }
    const value = e1rmKg(set.weightKg, set.reps);
    if (value !== null && (!bestE1rm || value > bestE1rm.value || (value === bestE1rm.value && earlier(set, bestE1rm.set)))) {
      bestE1rm = { set, value };
    }
  }

  return {
    maxWeightKg: maxWeight ? { value: maxWeight.weightKg, reps: maxWeight.reps, date: maxWeight.date } : null,
    maxReps: maxReps ? { value: maxReps.reps, weightKg: maxReps.weightKg, date: maxReps.date } : null,
    bestE1rmKg: bestE1rm
      ? { value: bestE1rm.value, weightKg: bestE1rm.set.weightKg, reps: bestE1rm.set.reps, date: bestE1rm.set.date }
      : null,
  };
}
