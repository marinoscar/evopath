import type {
  PlanChangeOperation,
  PlanChangeOperationName,
  PlanChangeWeekRange,
} from '../../programs/contracts/plan-change.contract';
import type { PlanExercise, PlanTree, PlanWorkout } from '../../programs/contracts/plan-tree.contract';
import { addDays } from '../../check-ins/local-date';
import { occurrenceDate } from '../../programs/today/resolve-today';
import type { AssessmentStatus } from '../agents/evaluator/evaluation-result.contract';
import { supportedBy } from '../context/build-planner-context';
import { type AcceptedOperation, type OperationTargets, applyOperations } from '../evaluation/apply-operations';
import { describeOperation } from '../evaluation/describe-operation';
import type { EvaluateRunContext, EvaluatorRef } from '../evaluation/evaluate-context';
import { fingerprintOf } from '../evaluation/fingerprints';
import { applyGuardrails } from './index';
import { sanitizeModelText } from './citations';
import { ENVELOPE_LIMITS } from './envelope-limits';
import { GUARDRAIL_LIMITS, effectiveLimits } from './limits';
import { firstExposureCap, nextLoadCap } from './progression';
import { allowedWeekdays, floorHalf, setsByMuscle, weeksOf } from './tree';
import type { GuardrailContext, GuardrailRule } from './types';

// =============================================================================
// The adaptation envelope: guardrail G10 (pure)
// =============================================================================
//
// `applyEnvelope(ops, input) -> { accepted, clamped, dropped, notes }` bounds
// the evaluator's typed operations. OUT-OF-BOUND OPERATIONS ARE CLAMPED OR
// DROPPED AND RECORDED; they are never turned into questions. Two layers:
//
// 1. PER OPERATION (`bindOperations`), in the model's order, after the forced
//    safety removals (which always pass and come first):
//
//    REF  unknown refs, unknown exercise keys and no-ops are dropped
//    E1   Frozen: only workouts strictly after `asOf` without a linked
//         session change; a week range is narrowed to its unlocked weeks
//    E2   Size: at most 8 operations and 6 distinct exercises
//    E3   Loads: an increase needs the G7 preconditions (last exposure met
//         the rep floor, no recent pain flag on the exercise, fewer than 3
//         low-readiness days in a row, not recovering, automation not
//         paused, assessment not `needs_recovery`), one step (G7 bounds) per
//         adaptation; decreases always pass
//    E6   Equipment and injury: a swapped or added exercise is supported by
//         the plan's gym and is neither on the avoid list nor pain-flagged
//    E7   Rate: one adaptation per 48 hours (recovery and pain responses
//         exempt), one `regenerate_remaining` per 14 days
//    E8   Deloads: nothing shortens or intensifies a deload week
//    E9   Feedback: a change the person undid or declined in the last 14
//         days (by fingerprint) is dropped
//    E10  Escalation: `regenerate_remaining` is not run automatically; it is
//         dropped and the message suggests asking the planner to revise
//
// 2. ON THE TREE (`boundOnTree`), operation by operation on the tree with the
//    ones accepted so far:
//
//    E4   Volume: weekly hard sets per muscle rise by at most 2 sets and 15
//         percent (at least 1) and fall by at most 30 percent (at least 1),
//         against the tree before this adaptation; deloads, pain responses
//         and a dropped workout (bounded by E5 instead) excepted
//    E5   Structure: at most 2 swaps per workout and 1 dropped workout slot;
//         weekdays inside the preferred ones and never shared in a week;
//         workouts per week never below `max(2, daysPerWeek - 1)`; every
//         changed workout keeps 2 exercises and its priority lift
//    G1-G9  the E5.5 guardrails: an operation after which they would repair
//         or block something they did not before is dropped with their
//         message (so what lands never needs a repair)
//
// While automation is paused every non-forced operation is dropped. The
// operation's `reason` is model text: it is sanitised and length-capped and
// only ever stored, never interpreted.
// =============================================================================

export type EnvelopeRule =
  | 'E1'
  | 'E2'
  | 'E3'
  | 'E4'
  | 'E5'
  | 'E6'
  | 'E7'
  | 'E8'
  | 'E9'
  | 'E10'
  | 'REF'
  | 'SAFETY'
  | 'BOUNDS'
  | 'CRITIC'
  | GuardrailRule;

/** One clamp or drop, server-authored. `index` is the model's order (`-1` for a forced operation). */
export interface EnvelopeFinding {
  index: number;
  /** The operation, or null for a finding about the evaluation as a whole (an invented claim id). */
  op: PlanChangeOperationName | null;
  rule: EnvelopeRule;
  code: string;
  message: string;
}

export interface EnvelopeResult {
  /** Forced safety operations first, then the model's accepted ones in its order. */
  accepted: AcceptedOperation[];
  clamped: EnvelopeFinding[];
  dropped: EnvelopeFinding[];
  /** Server-authored sentences to append to the person's message (E10). */
  notes: string[];
}

export interface EnvelopeInput {
  context: EvaluateRunContext;
  /** The live tree the run evaluated. */
  tree: PlanTree;
  guardrails: GuardrailContext;
  assessment: AssessmentStatus;
  now: Date;
}

export const ESCALATION_NOTE =
  'A bigger rewrite of your remaining plan may help; you can ask the planner to revise your plan.';

const L = ENVELOPE_LIMITS;

const EXERCISE_OPS: readonly PlanChangeOperationName[] = ['set_prescription', 'swap_exercise', 'remove_exercise'];
const WORKOUT_OPS: readonly PlanChangeOperationName[] = ['add_exercise', 'set_weekday', 'drop_workout'];

class Drop extends Error {
  constructor(
    readonly rule: EnvelopeRule,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function refParts(ref: string): number[] {
  return ref.slice(1).split('-').map(Number);
}

function humanKey(key: string): string {
  return key.replace(/_/g, ' ');
}

interface TreeIndex {
  exercises: Map<string, { weekNumber: number; workout: PlanWorkout; exercise: PlanExercise }>;
  workouts: Map<string, { weekNumber: number; workout: PlanWorkout }>;
  deloadWeeks: Set<number>;
  weekNumbers: number[];
}

function indexTree(tree: PlanTree): TreeIndex {
  const exercises: TreeIndex['exercises'] = new Map();
  const workouts: TreeIndex['workouts'] = new Map();
  const deloadWeeks = new Set<number>();
  const weekNumbers: number[] = [];
  for (const { week } of weeksOf(tree)) {
    weekNumbers.push(week.weekNumber);
    if (week.isDeload) deloadWeeks.add(week.weekNumber);
    for (const workout of week.workouts) {
      if (workout.id) workouts.set(workout.id, { weekNumber: week.weekNumber, workout });
      for (const exercise of workout.exercises) if (exercise.id) exercises.set(exercise.id, { weekNumber: week.weekNumber, workout, exercise });
    }
  }
  return { exercises, workouts, deloadWeeks, weekNumbers };
}

function emptyTargets(): OperationTargets {
  return { exerciseRowIds: [], workoutRowIds: [], weekNumbers: [], exerciseId: null };
}

function normalizeRange(range: PlanChangeWeekRange, weeks: readonly number[]): PlanChangeWeekRange {
  const min = weeks.length ? Math.min(...weeks) : 1;
  const max = weeks.length ? Math.max(...weeks) : 1;
  const from = Math.max(min, Math.min(range.from, range.to));
  const to = Math.min(max, Math.max(range.from, range.to));
  return { from, to };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Whether the exercise had a pain flag recently enough to block an increase (or makes a change a pain response). */
function painRecent(context: EvaluateRunContext, key: string | undefined): boolean {
  if (!key) return false;
  const since = addDays(context.server.asOf, -(L.increasePainLookbackDays - 1));
  return context.server.pain.some(
    (row) => row.key === key && (row.consecutiveFlaggedSessions >= 1 || row.lastFlaggedOn >= since),
  );
}

// ---- layer 1: per operation ---------------------------------------------------

interface BindState {
  input: EnvelopeInput;
  index: TreeIndex;
  refs: Record<string, EvaluatorRef>;
  keyOfRef: (ref: string) => string | undefined;
  forcedRows: Set<string>;
  touchedKeys: Set<string>;
  loadIncreased: Set<string>;
  suppressed: Set<string>;
  paused: boolean;
  recentAdaptation: boolean;
  clamped: EnvelopeFinding[];
}

function clampRecord(state: BindState, index: number, op: PlanChangeOperationName, rule: EnvelopeRule, code: string, message: string): void {
  state.clamped.push({ index, op, rule, code, message });
}

/** Exercise rows of the target's slot (same workout position, same exercise) across the range, unlocked only. */
function resolveExerciseTargets(
  state: BindState,
  index: number,
  op: PlanChangeOperation & { target: { exerciseRef: string; weeks: PlanChangeWeekRange } },
  skipWeek: (weekNumber: number) => boolean,
): { rows: EvaluatorRef[]; range: PlanChangeWeekRange } {
  const ref = state.refs[op.target.exerciseRef];
  if (!ref || ref.kind !== 'exercise' || !ref.exerciseId) {
    throw new Drop('REF', 'unknown_ref', `The change named a plan position (${op.target.exerciseRef.slice(0, 16)}) that does not exist.`);
  }
  const slot = refParts(op.target.exerciseRef)[1];
  const range = normalizeRange(op.target.weeks, state.index.weekNumbers);
  const rows: EvaluatorRef[] = [];
  let locked = 0;
  let deload = 0;
  let safety = 0;

  for (let week = range.from; week <= range.to; week += 1) {
    for (const [candidate, row] of Object.entries(state.refs)) {
      if (row.kind !== 'exercise' || row.exerciseId !== ref.exerciseId) continue;
      const [w, o] = refParts(candidate);
      if (w !== week || o !== slot) continue;
      if (row.locked) {
        locked += 1;
      } else if (row.programExerciseId && state.forcedRows.has(row.programExerciseId)) {
        safety += 1;
      } else if (skipWeek(week)) {
        deload += 1;
      } else {
        rows.push(row);
      }
    }
  }

  const name = humanKey(ref.exerciseKey ?? 'this exercise');
  if (rows.length === 0) {
    if (safety > 0) throw new Drop('SAFETY', 'superseded_by_safety', `${name} is already being removed after repeated pain.`);
    if (locked > 0) throw new Drop('E1', 'locked', `Past and started sessions never change (${name}).`);
    if (deload > 0) throw new Drop('E8', 'deload', `A deload week is never shortened or made harder (${name}).`);
    throw new Drop('REF', 'no_target', `No upcoming session holds ${name} in that position.`);
  }

  const weeks = rows.map((row) => row.weekNumber);
  const narrowed = { from: Math.min(...weeks), to: Math.max(...weeks) };
  if (locked > 0) clampRecord(state, index, op.op, 'E1', 'locked_weeks_skipped', `Past and started sessions of ${name} were left as they are.`);
  if (deload > 0) clampRecord(state, index, op.op, 'E8', 'deload_weeks_skipped', `The deload week was left lighter for ${name}.`);
  return { rows, range: narrowed };
}

/** Workout rows of the target's slot across the range, unlocked only. */
function resolveWorkoutTargets(
  state: BindState,
  index: number,
  op: PlanChangeOperation & { workoutRef: string; weeks: PlanChangeWeekRange },
  skipWeek: (weekNumber: number) => string | null,
): { rows: EvaluatorRef[]; range: PlanChangeWeekRange } {
  const ref = state.refs[op.workoutRef];
  if (!ref || ref.kind !== 'workout') {
    throw new Drop('REF', 'unknown_ref', `The change named a workout (${op.workoutRef.slice(0, 16)}) that does not exist.`);
  }
  const slot = refParts(op.workoutRef)[1];
  const range = normalizeRange(op.weeks, state.index.weekNumbers);
  const rows: EvaluatorRef[] = [];
  let locked = 0;
  const skipped = new Map<string, number>();

  for (let week = range.from; week <= range.to; week += 1) {
    const row = state.refs[`W${week}-${slot}`];
    if (!row || row.kind !== 'workout') continue;
    if (row.locked) {
      locked += 1;
      continue;
    }
    const why = skipWeek(week);
    if (why) {
      skipped.set(why, (skipped.get(why) ?? 0) + 1);
      continue;
    }
    rows.push(row);
  }

  if (rows.length === 0) {
    if (locked > 0) throw new Drop('E1', 'locked', `Past and started sessions never change (workout ${slot}).`);
    if (skipped.has('deload')) throw new Drop('E8', 'deload', `A deload week is never shortened or made harder (workout ${slot}).`);
    if (skipped.has('past_date')) throw new Drop('E1', 'past_date', `A workout cannot move to a day that has already passed (workout ${slot}).`);
    throw new Drop('REF', 'no_target', `No upcoming week holds workout ${slot}.`);
  }
  const weeks = rows.map((row) => row.weekNumber);
  if (locked > 0 || skipped.has('past_date')) {
    clampRecord(state, index, op.op, 'E1', 'locked_weeks_skipped', `Past and started sessions of workout ${slot} were left as they are.`);
  }
  if (skipped.has('deload')) clampRecord(state, index, op.op, 'E8', 'deload_weeks_skipped', `The deload week was left lighter (workout ${slot}).`);
  return { rows, range: { from: Math.min(...weeks), to: Math.max(...weeks) } };
}

/** Clamps a new exercise's prescription into the value bounds (and the level's caps). */
function boundPrescription<T extends { sets: number | null; repMin: number | null; repMax: number | null; targetRpe: number | null; restSeconds: number | null }>(
  state: BindState,
  index: number,
  opName: PlanChangeOperationName,
  values: T,
): T {
  const g = state.input.guardrails;
  const limits = effectiveLimits(g.experience, g.conservative);
  const b = L.bounds;
  const out = { ...values };
  let changed = false;
  const set = <K extends keyof T>(key: K, value: T[K]) => {
    if (out[key] !== value) {
      out[key] = value;
      changed = true;
    }
  };

  if (out.sets !== null) set('sets', clampNumber(Math.round(out.sets), b.sets.min, Math.min(b.sets.max, limits.setsPerExercise)) as T['sets']);
  if (out.repMin !== null) set('repMin', clampNumber(Math.round(out.repMin), b.reps.min, b.reps.max) as T['repMin']);
  if (out.repMax !== null) set('repMax', clampNumber(Math.round(out.repMax), b.reps.min, b.reps.max) as T['repMax']);
  if (out.repMin !== null && out.repMax !== null && out.repMin > out.repMax) set('repMax', out.repMin as T['repMax']);
  if (out.targetRpe !== null) {
    const stepped = Math.round(out.targetRpe / b.rpe.step) * b.rpe.step;
    set('targetRpe', clampNumber(stepped, b.rpe.min, Math.min(b.rpe.max, limits.rpeCap)) as T['targetRpe']);
  }
  if (out.restSeconds !== null) set('restSeconds', clampNumber(Math.round(out.restSeconds), b.restSeconds.min, b.restSeconds.max) as T['restSeconds']);

  if (changed) clampRecord(state, index, opName, 'BOUNDS', 'value_bounds', 'A number was brought inside the safe range for your level.');
  return out;
}

/** E3 and value bounds for `set_prescription`; returns null when nothing is left to change. */
function boundSetPrescription(
  state: BindState,
  index: number,
  op: Extract<PlanChangeOperation, { op: 'set_prescription' }>,
  rows: EvaluatorRef[],
  key: string,
): Extract<PlanChangeOperation, { op: 'set_prescription' }> | null {
  const { input } = state;
  const g = input.guardrails;
  const current = rows.flatMap((row) => {
    const entry = row.programExerciseId ? state.index.exercises.get(row.programExerciseId) : undefined;
    return entry ? [entry.exercise] : [];
  });
  let out = { ...op, ...boundPrescription(state, index, op.op, op) };
  if (out.targetLoadKg !== null) {
    const bounded = floorHalf(clampNumber(out.targetLoadKg, L.bounds.loadKg.min, L.bounds.loadKg.max));
    if (bounded !== out.targetLoadKg) clampRecord(state, index, op.op, 'BOUNDS', 'value_bounds', 'A load was brought inside the safe range.');
    out = { ...out, targetLoadKg: bounded };
  }
  const name = humanKey(key);

  const loadUp = out.targetLoadKg !== null && current.some((e) => e.targetLoadKg === null || out.targetLoadKg! > e.targetLoadKg);
  const rpeUp = out.targetRpe !== null && current.some((e) => e.targetRpe !== null && out.targetRpe! > e.targetRpe);
  const setsUp = out.sets !== null && current.some((e) => out.sets! > e.targetSets);

  const blocked: string | null = painRecent(input.context, key)
    ? 'pain'
    : input.context.server.readinessLowStreak >= L.increaseBlockedLowStreak
      ? 'low_readiness'
      : input.context.safety?.recover
        ? 'recovery'
        : input.assessment === 'needs_recovery'
          ? 'needs_recovery'
          : null;

  if (blocked && (loadUp || rpeUp || setsUp)) {
    const why = {
      pain: `pain was flagged on ${name} recently`,
      low_readiness: 'readiness has been low for several days',
      recovery: 'recovery comes first after several low-readiness days',
      needs_recovery: 'the review found you need recovery',
    }[blocked];
    clampRecord(state, index, op.op, 'E3', `increase_blocked_${blocked}`, `No increase for ${name}: ${why}.`);
    out = {
      ...out,
      ...(loadUp ? { targetLoadKg: null, loadGuidance: null } : {}),
      ...(rpeUp ? { targetRpe: null } : {}),
      ...(setsUp ? { sets: null } : {}),
    };
  } else if (loadUp) {
    const exerciseId = rows[0]?.exerciseId;
    const lib = exerciseId ? g.library.get(exerciseId) : undefined;
    const fact = exerciseId ? g.history.get(exerciseId) : undefined;
    const repFloor = Math.min(...current.map((e) => e.repMin));
    let cap: number | null = null;

    if (!lib) {
      cap = null;
    } else if (state.loadIncreased.has(key)) {
      cap = null;
      clampRecord(state, index, op.op, 'E3', 'one_step_per_adaptation', `${name} goes up at most one step per adjustment.`);
    } else if (!fact || fact.lastMinReps === null || fact.lastMinReps < repFloor) {
      cap = null;
      clampRecord(state, index, op.op, 'E3', 'rep_floor_not_met', `${name} holds its load: the last session did not reach the bottom of the rep range.`);
    } else {
      const caps = current.map((e) =>
        e.targetLoadKg !== null && e.targetLoadKg > 0
          ? nextLoadCap(lib, e.targetLoadKg, false)
          : firstExposureCap(lib, e, fact, g.now),
      );
      cap = caps.some((c) => c === null) ? null : Math.min(...(caps as number[]));
    }

    const floor = Math.min(...current.map((e) => e.targetLoadKg ?? Infinity));
    if (cap === null || cap <= floor) {
      if (cap === null && lib && !state.loadIncreased.has(key) && fact && fact.lastMinReps !== null && fact.lastMinReps >= repFloor) {
        clampRecord(state, index, op.op, 'E3', 'no_load_basis', `${name} holds its load: there is no recent load to build on.`);
      }
      out = { ...out, targetLoadKg: null, loadGuidance: null };
    } else {
      if (out.targetLoadKg! > cap) {
        clampRecord(state, index, op.op, 'E3', 'one_step', `${name} goes up by one small step at most.`);
        out = { ...out, targetLoadKg: cap };
      }
      state.loadIncreased.add(key);
    }
  }

  const nothing = [out.sets, out.repMin, out.repMax, out.targetRpe, out.restSeconds, out.targetLoadKg, out.loadGuidance].every((v) => v === null);
  return nothing ? null : out;
}

function bindOne(state: BindState, raw: PlanChangeOperation, index: number): AcceptedOperation {
  const { input } = state;
  const g = input.guardrails;
  let op: PlanChangeOperation = { ...raw, reason: sanitizeModelText(raw.reason, 200) } as PlanChangeOperation;
  if (op.op === 'regenerate_remaining') op = { ...op, instruction: sanitizeModelText(op.instruction, 300) };

  if (op.op === 'regenerate_remaining') {
    throw new Drop('E10', 'escalation_not_automatic', 'Rewriting the rest of the plan is not done automatically.');
  }
  if (state.paused) {
    throw new Drop('SAFETY', 'automation_paused', 'Automatic adjustments are paused; only safety changes are made.');
  }

  const targets = emptyTargets();
  let touched: string[] = [];
  let painResponse = false;
  let decreaseOnly = false;
  const deloadWeek = (week: number) => state.index.deloadWeeks.has(week);

  if (EXERCISE_OPS.includes(op.op)) {
    const exerciseOp = op as Extract<PlanChangeOperation, { op: 'set_prescription' | 'swap_exercise' | 'remove_exercise' }>;
    const current = (row: EvaluatorRef) => (row.programExerciseId ? state.index.exercises.get(row.programExerciseId)?.exercise : undefined);
    const intensifies = (week: number) => {
      if (!deloadWeek(week)) return false;
      if (exerciseOp.op === 'remove_exercise') return true;
      if (exerciseOp.op !== 'set_prescription') return false;
      return Object.entries(state.refs).some(([, row]) => {
        if (row.weekNumber !== week || row.kind !== 'exercise') return false;
        const e = current(row);
        return (
          !!e &&
          ((exerciseOp.sets !== null && exerciseOp.sets > e.targetSets) ||
            (exerciseOp.targetLoadKg !== null && (e.targetLoadKg === null || exerciseOp.targetLoadKg > e.targetLoadKg)) ||
            (exerciseOp.targetRpe !== null && e.targetRpe !== null && exerciseOp.targetRpe > e.targetRpe))
        );
      });
    };
    const { rows, range } = resolveExerciseTargets(state, index, exerciseOp, intensifies);
    const key = rows[0].exerciseKey ?? 'unknown';
    touched = [key];
    painResponse = painRecent(input.context, key);
    targets.exerciseRowIds = rows.map((row) => row.programExerciseId ?? '').filter(Boolean);
    const target = { exerciseRef: exerciseOp.target.exerciseRef, weeks: range };

    if (exerciseOp.op === 'set_prescription') {
      const bounded = boundSetPrescription(state, index, { ...exerciseOp, target }, rows, key);
      if (!bounded) throw new Drop('E3', 'nothing_left', `Nothing was left to change for ${humanKey(key)}.`);
      op = bounded;
      const now = rows.map(current).filter((e): e is PlanExercise => !!e);
      decreaseOnly =
        !(bounded.sets !== null && now.some((e) => bounded.sets! > e.targetSets)) &&
        !(bounded.targetLoadKg !== null && now.some((e) => e.targetLoadKg === null || bounded.targetLoadKg! > e.targetLoadKg)) &&
        !(bounded.targetRpe !== null && now.some((e) => e.targetRpe !== null && bounded.targetRpe! > e.targetRpe));
    } else if (exerciseOp.op === 'swap_exercise') {
      const lib = g.libraryByKey.get(exerciseOp.withExerciseKey);
      checkNewExercise(state, lib, exerciseOp.withExerciseKey);
      if (lib!.id === rows[0].exerciseId) throw new Drop('REF', 'no_op', 'The swap named the same exercise.');
      targets.exerciseId = lib!.id;
      touched.push(lib!.key);
      op = { ...exerciseOp, target };
    } else {
      op = { ...exerciseOp, target };
    }
  } else if (WORKOUT_OPS.includes(op.op)) {
    const workoutOp = op as Extract<PlanChangeOperation, { op: 'add_exercise' | 'set_weekday' | 'drop_workout' }>;
    const skip = (week: number): string | null => {
      if (workoutOp.op !== 'set_weekday' && deloadWeek(week)) return 'deload';
      if (workoutOp.op === 'set_weekday' && input.context.server.startDate) {
        const date = occurrenceDate(input.context.server.startDate, week, workoutOp.weekday);
        if (date <= input.context.server.asOf) return 'past_date';
      }
      return null;
    };
    if (workoutOp.op === 'add_exercise') {
      const lib = g.libraryByKey.get(workoutOp.exerciseKey);
      checkNewExercise(state, lib, workoutOp.exerciseKey);
      targets.exerciseId = lib!.id;
      touched = [lib!.key];
    }
    if (workoutOp.op === 'set_weekday' && !allowedWeekdays(g).includes(workoutOp.weekday)) {
      throw new Drop('E5', 'weekday_not_preferred', 'Workouts only move to your preferred training days.');
    }
    const { rows, range } = resolveWorkoutTargets(state, index, workoutOp, skip);
    targets.workoutRowIds = rows.map((row) => row.programWorkoutId).filter(Boolean);
    if (workoutOp.op === 'add_exercise') {
      const bounded = boundPrescription(state, index, workoutOp.op, workoutOp);
      const already = targets.workoutRowIds.some((id) =>
        state.index.workouts.get(id)?.workout.exercises.some((e) => e.exerciseId === targets.exerciseId),
      );
      if (already) throw new Drop('REF', 'duplicate_exercise', `${humanKey(workoutOp.exerciseKey)} is already in that workout.`);
      op = {
        ...workoutOp,
        weeks: range,
        sets: bounded.sets ?? 3,
        repMin: bounded.repMin ?? 8,
        repMax: bounded.repMax ?? 12,
        targetRpe: bounded.targetRpe,
        restSeconds: bounded.restSeconds ?? 90,
      };
    } else {
      op = { ...workoutOp, weeks: range };
      decreaseOnly = workoutOp.op === 'drop_workout';
    }
  } else if (op.op === 'mark_deload') {
    const week = op.weekNumber;
    if (!state.index.weekNumbers.includes(week)) throw new Drop('REF', 'no_target', `Week ${week} is not in the plan.`);
    if (state.index.deloadWeeks.has(week)) throw new Drop('E8', 'already_deload', `Week ${week} is already a deload week.`);
    const rows = Object.entries(state.refs).filter(([, row]) => row.kind === 'workout' && row.weekNumber === week);
    const open = rows.filter(([, row]) => !row.locked);
    if (open.length === 0) throw new Drop('E1', 'locked', `Week ${week} has already started or passed.`);
    if (open.length < rows.length) {
      clampRecord(state, index, op.op, 'E1', 'locked_weeks_skipped', `Sessions of week ${week} already done were left as they are.`);
    }
    targets.workoutRowIds = open.map(([, row]) => row.programWorkoutId).filter(Boolean);
    targets.weekNumbers = [week];
    decreaseOnly = true;
  }

  const fingerprint = fingerprintOf(op, state.keyOfRef);
  if (state.suppressed.has(fingerprint)) {
    throw new Drop('E9', 'suppressed', 'You undid or declined this change recently, so it is not suggested again for 14 days.');
  }

  if (state.recentAdaptation && input.assessment !== 'needs_recovery' && !painResponse && !(decreaseOnly && op.op === 'mark_deload')) {
    throw new Drop('E7', 'rate', 'Your plan was adjusted in the last 48 hours; the next adjustment waits.');
  }

  const next = new Set([...state.touchedKeys, ...touched]);
  if (next.size > L.maxDistinctExercises) {
    throw new Drop('E2', 'too_many_exercises', `One adjustment changes at most ${L.maxDistinctExercises} exercises.`);
  }
  for (const key of touched) state.touchedKeys.add(key);

  return {
    ...op,
    fingerprint,
    description: describeOperation(op, { keyOfRef: state.keyOfRef, nameOfKey: (key) => g.libraryByKey.get(key)?.name }),
    targets,
  } as AcceptedOperation;
}

function checkNewExercise(state: BindState, lib: ReturnType<GuardrailContext['libraryByKey']['get']>, key: string): void {
  const g = state.input.guardrails;
  if (!lib) throw new Drop('REF', 'unknown_exercise', `"${key.slice(0, 60)}" is not an exercise in your library.`);
  if (!supportedBy(lib, g.gym)) throw new Drop('E6', 'equipment', `${humanKey(lib.key)} needs equipment your gym does not have.`);
  if (g.avoidExerciseKeys.has(lib.key)) throw new Drop('E6', 'avoid_list', `${humanKey(lib.key)} is on your avoid list.`);
  if (g.painFlagKeys.has(lib.key) || painRecent(state.input.context, lib.key)) {
    throw new Drop('E6', 'pain_flagged', `${humanKey(lib.key)} was flagged as painful recently.`);
  }
}

/** Resolves the forced safety removals (always accepted, first). */
function bindForced(state: BindState): AcceptedOperation[] {
  const forced = state.input.context.safety?.forced ?? [];
  const g = state.input.guardrails;
  const out: AcceptedOperation[] = [];
  for (const op of forced) {
    const ref = state.refs[op.target.exerciseRef];
    if (!ref || ref.kind !== 'exercise' || !ref.programExerciseId || ref.locked) continue;
    if (state.forcedRows.has(ref.programExerciseId)) continue;
    state.forcedRows.add(ref.programExerciseId);
    out.push({
      ...op,
      forced: true,
      fingerprint: fingerprintOf(op, state.keyOfRef),
      description: describeOperation(op, { keyOfRef: state.keyOfRef, nameOfKey: (key) => g.libraryByKey.get(key)?.name }),
      targets: { ...emptyTargets(), exerciseRowIds: [ref.programExerciseId] },
    });
  }
  return out;
}

/** Layer 1: every operation bound on its own, in the model's order. */
export function bindOperations(
  ops: readonly PlanChangeOperation[],
  input: EnvelopeInput,
): EnvelopeResult & { indexes: Map<AcceptedOperation, number> } {
  const refs = input.context.server.refs;
  const last = input.context.server.lastAdaptationAt;
  const state: BindState = {
    input,
    index: indexTree(input.tree),
    refs,
    keyOfRef: (ref) => refs[ref]?.exerciseKey,
    forcedRows: new Set(),
    touchedKeys: new Set(),
    loadIncreased: new Set(),
    suppressed: new Set(input.context.server.suppressedFingerprints ?? []),
    paused: input.context.safety?.paused ?? input.context.server.autonomyPausedReason !== null,
    recentAdaptation: !!last && input.now.getTime() - new Date(last).getTime() < L.adaptationSpacingMs,
    clamped: [],
  };

  const accepted = bindForced(state);
  const dropped: EnvelopeFinding[] = [];
  const notes: string[] = [];
  const indexes = new Map<AcceptedOperation, number>(accepted.map((op) => [op, -1]));

  ops.forEach((raw, index) => {
    if (index >= L.maxOperations) {
      dropped.push({ index, op: raw.op, rule: 'E2', code: 'too_many_operations', message: `One adjustment makes at most ${L.maxOperations} changes.` });
      return;
    }
    try {
      const op = bindOne(state, raw, index);
      indexes.set(op, index);
      accepted.push(op);
    } catch (error) {
      if (!(error instanceof Drop)) throw error;
      dropped.push({ index, op: raw.op, rule: error.rule, code: error.code, message: error.message });
      if (error.rule === 'E10' && !notes.includes(ESCALATION_NOTE)) notes.push(ESCALATION_NOTE);
    }
  });

  return { accepted, clamped: state.clamped, dropped, notes, indexes };
}

// ---- layer 2: on the tree ------------------------------------------------------

/** Non-warn guardrail findings, keyed without the workout label (so a moved workout keeps its findings). */
function guardrailKeys(tree: PlanTree, g: GuardrailContext): Map<string, { rule: GuardrailRule; code: string; message: string }> {
  const out = new Map<string, { rule: GuardrailRule; code: string; message: string }>();
  for (const violation of applyGuardrails(tree, g).report.violations) {
    if (violation.severity === 'warn') continue;
    const parts = violation.path.split(' > ');
    const where = [parts[0], parts[2]].filter(Boolean).join(' > ');
    out.set(`${violation.rule}|${violation.code}|${where}`, { rule: violation.rule, code: violation.code, message: violation.message });
  }
  return out;
}

/** The weeks and workouts an operation touches, in `tree` (before it applies). */
function touchedOf(op: AcceptedOperation, index: TreeIndex): { weeks: Set<number>; workouts: Set<string> } {
  const weeks = new Set<number>(op.targets.weekNumbers);
  const workouts = new Set<string>(op.targets.workoutRowIds);
  for (const id of op.targets.exerciseRowIds) {
    const entry = index.exercises.get(id);
    if (entry) {
      weeks.add(entry.weekNumber);
      if (entry.workout.id) workouts.add(entry.workout.id);
    }
  }
  for (const id of op.targets.workoutRowIds) {
    const entry = index.workouts.get(id);
    if (entry) weeks.add(entry.weekNumber);
  }
  return { weeks, workouts };
}

export interface BoundOnTreeResult {
  accepted: AcceptedOperation[];
  dropped: EnvelopeFinding[];
  /** The tree with every accepted operation applied. */
  tree: PlanTree;
}

/**
 * Layer 2: the accepted operations applied one by one to `tree`, each kept
 * only when the tree-level rules (E4, E5, G1 to G9) still hold. Forced
 * operations are applied first and always kept. Also used before a stale
 * retry, on the newer tree.
 */
export function boundOnTree(
  operations: readonly AcceptedOperation[],
  tree: PlanTree,
  g: GuardrailContext,
  context: Pick<EvaluateRunContext, 'server'>,
  indexOf: (op: AcceptedOperation) => number = () => 0,
): BoundOnTreeResult {
  const forced = operations.filter((op) => op.forced);
  const model = operations.filter((op) => !op.forced);
  const dropped: EnvelopeFinding[] = [];
  const baseIndex = indexTree(tree);
  let candidate = applyOperations(tree, forced).tree;

  // E4 compares against the tree after the forced safety removals (a pain
  // response is exempt, so it must not count against the model's changes).
  const baseVolume = new Map<number, Map<string, number>>();
  for (const { week } of weeksOf(candidate)) {
    baseVolume.set(week.weekNumber, setsByMuscle(g, week.workouts, GUARDRAIL_LIMITS.uncountedMuscles));
  }

  const baseFindings = guardrailKeys(candidate, g);
  const accepted: AcceptedOperation[] = [...forced];
  const swaps = new Map<string, number>();
  let droppedWorkouts = 0;
  const minWorkouts = Math.max(L.minWorkoutsPerWeek, g.daysPerWeek - 1);

  for (const op of model) {
    const drop = (rule: EnvelopeRule, code: string, message: string) => dropped.push({ index: indexOf(op), op: op.op, rule, code, message });
    const before = indexTree(candidate);
    const { weeks, workouts } = touchedOf(op, before);
    const next = applyOperations(candidate, [op]);
    if (next.missing.length > 0) {
      drop('REF', 'missing_target', 'Part of the plan this change named no longer exists.');
      continue;
    }
    const after = indexTree(next.tree);

    // E5 structure
    if (op.op === 'swap_exercise') {
      const over = [...workouts].some((id) => (swaps.get(id) ?? 0) + 1 > L.swapsPerWorkout);
      if (over) {
        drop('E5', 'too_many_swaps', `A workout gets at most ${L.swapsPerWorkout} swaps per adjustment.`);
        continue;
      }
    }
    if (op.op === 'drop_workout') {
      if (droppedWorkouts + 1 > L.droppedWorkoutsPerAdaptation) {
        drop('E5', 'too_many_drops', 'One adjustment drops at most one workout.');
        continue;
      }
      const tooFew = [...weeks].some((week) => (weeksOf(next.tree).find((w) => w.week.weekNumber === week)?.week.workouts.length ?? 0) < minWorkouts);
      if (tooFew) {
        drop('E5', 'too_few_workouts', `Each week keeps at least ${minWorkouts} workouts.`);
        continue;
      }
    }
    if (op.op === 'set_weekday') {
      const clash = [...weeks].some((week) => {
        const days = weeksOf(next.tree).find((w) => w.week.weekNumber === week)?.week.workouts.map((w) => w.weekday).filter((d) => d != null) ?? [];
        return new Set(days).size !== days.length;
      });
      if (clash) {
        drop('E5', 'weekday_taken', 'Another workout is already on that day.');
        continue;
      }
    }
    const thinned = [...workouts].some((id) => {
      const was = before.workouts.get(id)?.workout;
      const now = after.workouts.get(id)?.workout;
      if (!was || !now) return false;
      const minExercises = Math.min(L.minExercisesPerWorkout, was.exercises.length);
      const hadPriority = was.exercises.some((e) => e.isPriority);
      return now.exercises.length < minExercises || (hadPriority && now.exercises.filter((e) => e.isPriority).length < L.minPriorityPerWorkout);
    });
    if (thinned) {
      drop('E5', 'workout_too_thin', 'Every workout keeps at least two exercises and its main lift.');
      continue;
    }

    // E4 volume (against the tree before this adaptation)
    const key = op.targets.exerciseRowIds.length ? baseIndex.exercises.get(op.targets.exerciseRowIds[0])?.exercise.exerciseId : undefined;
    const painResponse = !!key && context.server.pain.some((row) => row.exerciseId === key);
    // A dropped workout is bounded by E5 (one per adjustment, a weekly floor);
    // the volume it takes with it is not a separate breach.
    if (op.op !== 'mark_deload' && op.op !== 'drop_workout' && !painResponse) {
      let breach: string | null = null;
      for (const week of weeks) {
        if (baseIndex.deloadWeeks.has(week)) continue;
        const base = baseVolume.get(week) ?? new Map<string, number>();
        const now = setsByMuscle(g, weeksOf(next.tree).find((w) => w.week.weekNumber === week)?.week.workouts ?? [], GUARDRAIL_LIMITS.uncountedMuscles);
        for (const muscle of new Set([...base.keys(), ...now.keys()])) {
          const b = base.get(muscle) ?? 0;
          const delta = (now.get(muscle) ?? 0) - b;
          const rise = b === 0 ? L.volumeRiseSets : Math.min(L.volumeRiseSets, Math.max(1, Math.round(b * L.volumeRiseFraction)));
          const fall = Math.max(1, Math.floor(b * L.volumeFallFraction));
          if (delta > rise) breach = `Weekly sets for ${muscle.replace(/_/g, ' ')} rise by at most ${rise} per adjustment.`;
          else if (-delta > fall) breach = `Weekly sets for ${muscle.replace(/_/g, ' ')} fall by at most ${fall} per adjustment.`;
          if (breach) break;
        }
        if (breach) break;
      }
      if (breach) {
        drop('E4', 'volume', breach);
        continue;
      }
    }

    // G1-G9: nothing new for the guardrails to repair or block.
    const findings = guardrailKeys(next.tree, g);
    const fresh = [...findings.entries()].find(([k]) => !baseFindings.has(k));
    if (fresh) {
      drop(fresh[1].rule, fresh[1].code, fresh[1].message);
      continue;
    }

    if (op.op === 'swap_exercise') for (const id of workouts) swaps.set(id, (swaps.get(id) ?? 0) + 1);
    if (op.op === 'drop_workout') droppedWorkouts += 1;
    candidate = next.tree;
    accepted.push(op);
  }

  return { accepted, dropped, tree: candidate };
}

/** The envelope: layer 1 then layer 2 (see the header). Pure. */
export function applyEnvelope(ops: readonly PlanChangeOperation[], input: EnvelopeInput): EnvelopeResult {
  const bound = bindOperations(ops, input);
  const onTree = boundOnTree(bound.accepted, input.tree, input.guardrails, input.context, (op) => bound.indexes.get(op) ?? -1);

  return {
    accepted: onTree.accepted,
    clamped: bound.clamped,
    dropped: [...bound.dropped, ...onTree.dropped].sort((a, b) => a.index - b.index),
    notes: bound.notes,
  };
}
