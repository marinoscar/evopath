import type { PlanExercise } from '../../programs/contracts/plan-tree.contract';
import { supportedBy } from '../../training-agents/context/build-planner-context';
import type { LibraryExercise } from '../../training-agents/context/planner-context.contract';
import { estimateMinutes } from '../../training-agents/guardrails/duration';
import { GUARDRAIL_LIMITS, effectiveLimits } from '../../training-agents/guardrails/limits';
import { findSubstitutes } from '../../training-agents/guardrails/substitution';
import type { GuardrailContext } from '../../training-agents/guardrails/types';
import { ADAPTATION_REASONS, ADAPTATION_RULES as R, ADAPTED_WORKOUT_LIMITS as L } from '../adaptation.constants';
import type { AdaptationFacts, BaseExercise } from '../context/adaptation-context.contract';
import {
  type AdaptationDropReason,
  type AdaptationExerciseSource,
  type AdaptationProposalModel,
  type AdaptedWorkout,
  type GuardrailFinding,
  adaptedWorkoutSchema,
} from '../contracts/adapted-workout.contract';
import type { SorenessLevel } from '../dto/adaptation-request.dto';

// =============================================================================
// The adaptation rules and the deterministic repair (pure)
// =============================================================================
//
// `applyAdaptationRules(draft, facts, request)` turns the planner's answer
// into a proposal that satisfies every rule, or fails with a stable code.
// Pure and deterministic: no I/O, no clock; the same input gives the same
// output. The model's text never decides anything: its numbers are clamped,
// its keys are checked against the context, its time estimate is ignored.
//
// ORDER (each step records what it changed in `repairs` or `rejected`):
//
//   1. shape      unknown or duplicate keys removed; source and replaced
//                 exercise corrected; priority taken from the plan (the model
//                 cannot promote an exercise); text clipped.
//   2. pain       an exercise on the avoid list or pain-flagged in the last 28
//                 days (E5.5's pain rule: exclude, never "push through") is
//                 substituted within its pattern, else removed.
//   3. equipment  an exercise today's equipment cannot support (the gym, the
//                 "only" subset, or bodyweight) is substituted, else removed.
//   4. bounds     sets, reps, rest and RPE inside E5.5's per-exercise range and
//                 the contract's (sets 1..8, RPE 5..10 in 0.5 steps).
//   5. soreness   mild: prime-mover sets <= 75 % of the base (floor 2), RPE <= 8.
//                 moderate: a kept prime mover gets <= 2 sets, RPE <= 6, a note.
//   6. energy     low energy (request or check-in energy <= 2): RPE <= 7,
//                 non-priority sets <= base - 1 (floor 2).
//   7. never      with a base: no exercise above its counterpart's sets or RPE,
//      escalate   total sets <= the base's total. Ad hoc: E5.5's level bounds.
//                 Conservative mode adds E5.5's caps (RPE 7, 4 sets, 22 per session).
//   8. time       estimated minutes (E5.5's duration model) <= minutes, else:
//                 T1 drop non-priority exercises from the end (never the last
//                 one), T2 one set off non-priority exercises (floor 2), T3 one
//                 set off priority exercises (floor 2). Still over:
//                 ADAPTATION_CANNOT_FIT.
//
// Hard failures: nothing left after 1..3 (ADAPTATION_INVALID), or time
// (ADAPTATION_CANNOT_FIT). Every limit is in `adaptation.constants.ts`.
// =============================================================================

export interface AdaptationRuleRequest {
  minutes: number | null;
  soreness: { muscles: string[]; level: SorenessLevel } | null;
}

export interface AdaptationRuleReport {
  repairs: GuardrailFinding[];
  rejected: GuardrailFinding[];
  estimatedMinutes: number;
  fitsRequest: boolean;
}

export type AdaptationRuleOutcome =
  | { ok: true; proposal: AdaptedWorkout; report: AdaptationRuleReport }
  | {
      ok: false;
      code: typeof ADAPTATION_REASONS.INVALID | typeof ADAPTATION_REASONS.CANNOT_FIT;
      message: string;
      report: AdaptationRuleReport;
    };

interface Working {
  lib: LibraryExercise;
  source: AdaptationExerciseSource;
  /** The planned exercise this one keeps or replaces; `null` for an added one or ad hoc. */
  counterpart: BaseExercise | null;
  isPriority: boolean;
  sets: number;
  repMin: number;
  repMax: number;
  targetRpe: number | null;
  restSeconds: number;
  note: string | null;
}

class Findings {
  readonly repairs: GuardrailFinding[] = [];
  readonly rejected: GuardrailFinding[] = [];
  repair(code: string, exerciseKey: string | null, message: string) {
    this.repairs.push({ code, exerciseKey, message });
  }
  reject(code: string, exerciseKey: string | null, message: string) {
    this.rejected.push({ code, exerciseKey, message });
  }
}

const clipText = (text: string | null | undefined, max: number): string =>
  [...(text ?? '').replace(/\s+/g, ' ').trim()].slice(0, max).join('').trim();

const roundHalf = (value: number) => Math.round(value * 2) / 2;
const floorSets = (value: number) => Math.max(R.setFloor, value);

/** Estimated minutes of an adapted exercise list: E5.5's duration model. */
export function estimateAdaptedMinutes(
  exercises: ReadonlyArray<Pick<Working, 'sets' | 'repMax' | 'restSeconds' | 'isPriority'>>,
): number {
  return estimateMinutes({
    exercises: exercises.map((e) => ({ targetSets: e.sets, repMax: e.repMax, restSeconds: e.restSeconds, isPriority: e.isPriority })) as PlanExercise[],
  });
}

/** The message of `ADAPTATION_CANNOT_FIT`. */
export function cannotFitMessage(minutes: number): string {
  return `Can't fit these lifts in ${minutes} minutes; try ${minutes + R.cannotFitSuggestionStep}`;
}

/** A guardrail context for E5.5's substitution ladder, over the adaptation's facts. */
function substitutionContext(facts: AdaptationFacts): GuardrailContext {
  return {
    goal: facts.goal,
    experience: facts.experience,
    daysPerWeek: 3,
    preferredWeekdays: null,
    minutesPerSession: 60,
    conservative: facts.conservative,
    avoidExerciseKeys: new Set(facts.avoidKeys),
    painFlagKeys: new Set(facts.painFlagKeys),
    limitationAreas: facts.limitationAreas,
    library: new Map(facts.library.map((e) => [e.id, e])),
    libraryByKey: new Map(facts.library.map((e) => [e.key, e])),
    gym: facts.inventory,
    history: new Map(),
    brief: null,
    now: new Date(facts.builtAt),
  };
}

function isSoreTarget(lib: LibraryExercise, sore: AdaptationRuleRequest['soreness']): boolean {
  return !!sore && lib.primaryMuscles.some((m) => sore.muscles.includes(m));
}

export function applyAdaptationRules(
  draft: AdaptationProposalModel,
  facts: AdaptationFacts,
  request: AdaptationRuleRequest,
): AdaptationRuleOutcome {
  const f = new Findings();
  const byKey = new Map(facts.library.map((e) => [e.key, e]));
  const baseByKey = new Map((facts.base?.exercises ?? []).map((e) => [e.key, e]));
  const hasBase = facts.base !== null;
  const serverDrops = new Map<string, AdaptationDropReason>();

  // ---- 1. shape ------------------------------------------------------------
  const seen = new Set<string>();
  const replaced = new Set<string>();
  let list: Working[] = [];

  for (const e of draft.exercises) {
    const lib = byKey.get(e.exerciseKey);
    if (!lib) {
      f.reject('unknown_exercise_removed', null, 'Removed an exercise that is not in your library or not offered for today.');
      continue;
    }
    if (seen.has(lib.key)) {
      f.reject('duplicate_removed', lib.key, `Removed a second "${lib.name}".`);
      continue;
    }
    seen.add(lib.key);

    let source: AdaptationExerciseSource = e.source;
    let counterpart: BaseExercise | null = null;

    if (baseByKey.has(lib.key)) {
      counterpart = baseByKey.get(lib.key)!;
      if (source !== 'kept') f.repair('source_corrected', lib.key, `"${lib.name}" is in today's plan: marked as kept.`);
      source = 'kept';
    } else {
      const target = e.replacesExerciseKey ? baseByKey.get(e.replacesExerciseKey) : undefined;
      const replaceable =
        target && !replaced.has(target.key) && !draft.exercises.some((other) => other.exerciseKey === target.key);
      if (replaceable) {
        counterpart = target;
        replaced.add(target.key);
        if (source !== 'swapped') f.repair('source_corrected', lib.key, `"${lib.name}" replaces "${target.name}": marked as swapped.`);
        source = 'swapped';
      } else {
        if (source !== 'added') f.repair('source_corrected', lib.key, `"${lib.name}" replaces nothing in today's plan: marked as added.`);
        source = 'added';
      }
    }

    const isPriority = hasBase ? (counterpart?.isPriority ?? false) : e.isPriority;
    if (hasBase && e.isPriority && !isPriority) {
      f.repair('priority_corrected', lib.key, `"${lib.name}" is not a priority lift in your plan.`);
    }

    list.push({
      lib,
      source,
      counterpart,
      isPriority,
      sets: e.sets,
      repMin: e.repMin,
      repMax: e.repMax,
      targetRpe: e.targetRpe,
      restSeconds: e.restSeconds,
      note: e.note ? clipText(e.note, L.noteChars) || null : null,
    });
  }

  if (list.length > L.exercises.max) {
    for (const extra of list.slice(L.exercises.max)) {
      f.reject('too_many_exercises', extra.lib.key, `Removed "${extra.lib.name}": at most ${L.exercises.max} exercises.`);
    }
    list = list.slice(0, L.exercises.max);
  }

  // ---- 2. pain and 3. equipment: substitute within the pattern, else remove --
  const sub = substitutionContext(facts);
  const excluded = (lib: LibraryExercise) => sub.avoidExerciseKeys.has(lib.key) || sub.painFlagKeys.has(lib.key);

  const replaceOrRemove = (w: Working, why: 'pain' | 'equipment'): Working | null => {
    const inList = new Set(list.map((x) => x.lib.id));
    const [substitute] = findSubstitutes(w.lib, sub, inList);
    const reason = why === 'pain' ? 'it is on your avoid list or you flagged pain on it recently' : "today's equipment cannot support it";
    if (substitute) {
      f.repair(`${why}_substituted`, w.lib.key, `Replaced "${w.lib.name}" with "${substitute.name}": ${reason}.`);
      return { ...w, lib: substitute, source: w.counterpart ? 'swapped' : 'added' };
    }
    f.reject(`${why}_removed`, w.lib.key, `Removed "${w.lib.name}": ${reason}.`);
    if (w.counterpart) serverDrops.set(w.counterpart.key, why === 'pain' ? 'other' : 'equipment');
    return null;
  };

  list = list.map((w) => (excluded(w.lib) ? replaceOrRemove(w, 'pain') : w)).filter((w): w is Working => w !== null);
  list = list.map((w) => (supportedBy(w.lib, facts.inventory) ? w : replaceOrRemove(w, 'equipment'))).filter((w): w is Working => w !== null);

  // A substitution may have produced a duplicate.
  const unique = new Set<string>();
  list = list.filter((w) => {
    if (unique.has(w.lib.key)) {
      f.reject('duplicate_removed', w.lib.key, `Removed a second "${w.lib.name}".`);
      return false;
    }
    unique.add(w.lib.key);
    return true;
  });

  if (list.length === 0) {
    return fail(ADAPTATION_REASONS.INVALID, 'No exercise in the proposal fits today.', f, list, request);
  }

  // ---- 4. per-exercise bounds -------------------------------------------------
  const level = effectiveLimits(facts.experience, facts.conservative);
  for (const w of list) {
    const setsMax = hasBase ? L.sets.max : Math.min(L.sets.max, level.setsPerExercise);
    const sets = Math.min(setsMax, Math.max(L.sets.min, Math.round(w.sets)));
    if (sets !== w.sets) f.repair('sets_clamped', w.lib.key, `${w.sets} sets of "${w.lib.name}" set to ${sets}.`);
    w.sets = sets;

    const repMin = Math.min(L.reps.max, Math.max(L.reps.min, Math.round(w.repMin)));
    const repMax = Math.min(L.reps.max, Math.max(repMin, Math.round(w.repMax)));
    if (repMin !== w.repMin || repMax !== w.repMax) {
      f.repair('reps_clamped', w.lib.key, `Reps ${w.repMin}-${w.repMax} of "${w.lib.name}" set to ${repMin}-${repMax}.`);
    }
    w.repMin = repMin;
    w.repMax = repMax;

    const rest = Math.min(R.restSeconds.max, Math.max(R.restSeconds.min, Math.round(w.restSeconds)));
    if (rest !== w.restSeconds) f.repair('rest_clamped', w.lib.key, `Rest ${w.restSeconds} s of "${w.lib.name}" set to ${rest} s.`);
    w.restSeconds = rest;
  }

  const capRpe = (w: Working, cap: number, code: string, why: string) => {
    if (w.targetRpe === null || w.targetRpe > cap) {
      if (w.targetRpe !== null) f.repair(code, w.lib.key, `RPE ${w.targetRpe} of "${w.lib.name}" lowered to ${cap} (${why}).`);
      w.targetRpe = cap;
    }
  };
  const capSets = (w: Working, cap: number, code: string, why: string) => {
    if (w.sets > cap) {
      f.repair(code, w.lib.key, `${w.sets} sets of "${w.lib.name}" lowered to ${cap} (${why}).`);
      w.sets = cap;
    }
  };

  // ---- 5. soreness ------------------------------------------------------------
  const sore = request.soreness;
  if (sore) {
    for (const w of list) {
      if (!isSoreTarget(w.lib, sore)) continue;
      const muscles = w.lib.primaryMuscles.filter((m) => sore.muscles.includes(m)).join(', ');
      if (sore.level === 'mild') {
        const ref = w.counterpart?.sets ?? w.sets;
        capSets(w, floorSets(Math.floor(ref * R.soreness.mild.setsFactor)), 'sore_mild_sets', `mild soreness: ${muscles}`);
        capRpe(w, R.soreness.mild.rpeCap, 'sore_mild_rpe', `mild soreness: ${muscles}`);
      } else {
        capSets(w, R.soreness.moderate.maxSets, 'sore_moderate_sets', `moderate soreness: ${muscles}`);
        capRpe(w, R.soreness.moderate.rpeCap, 'sore_moderate_rpe', `moderate soreness: ${muscles}`);
        const note = `Kept light: your ${muscles} ${muscles.includes(',') ? 'are' : 'is'} sore.`;
        w.note = clipText(w.note ? `${note} ${w.note}` : note, L.noteChars);
      }
    }
  }

  // ---- 6. low energy ----------------------------------------------------------
  if (facts.lowEnergy) {
    for (const w of list) {
      capRpe(w, R.lowEnergy.rpeCap, 'energy_rpe', 'low energy');
      if (!w.isPriority) {
        const ref = w.counterpart?.sets ?? w.sets;
        capSets(w, floorSets(ref - R.lowEnergy.setsBelowBase), 'energy_sets', 'low energy');
      }
    }
  }

  // ---- 7. never escalate --------------------------------------------------------
  if (hasBase) {
    const baseSets = facts.base!.exercises.map((e) => e.sets);
    const baseRpes = facts.base!.exercises.map((e) => e.targetRpe).filter((v): v is number => v !== null);
    const maxBaseSets = Math.max(...baseSets, R.setFloor);
    const maxBaseRpe = baseRpes.length ? Math.max(...baseRpes) : R.defaultRpeCap;

    for (const w of list) {
      capSets(w, w.counterpart?.sets ?? maxBaseSets, 'escalation_sets', 'never more than planned');
      capRpe(w, w.counterpart ? (w.counterpart.targetRpe ?? R.defaultRpeCap) : maxBaseRpe, 'escalation_rpe', 'never harder than planned');
    }
    reduceTotalSets(list, baseSets.reduce((a, b) => a + b, 0), f, serverDrops, 'escalation_total_sets', 'never more total sets than planned');
  } else {
    for (const w of list) capRpe(w, level.rpeCap, 'level_rpe', `${facts.experience} level`);
    reduceTotalSets(list, level.sessionSetsRepairAbove, f, serverDrops, 'level_total_sets', `${facts.experience} level session cap`);
  }

  if (facts.conservative) {
    const c = GUARDRAIL_LIMITS.conservative;
    for (const w of list) {
      capRpe(w, c.rpeCap, 'conservative_rpe', 'conservative mode');
      capSets(w, c.setsPerExercise, 'conservative_sets', 'conservative mode');
    }
    reduceTotalSets(list, c.sessionSets, f, serverDrops, 'conservative_total_sets', 'conservative mode');
  }

  // RPE inside the contract: 0.5 steps, 5..10.
  for (const w of list) {
    if (w.targetRpe === null) continue;
    const rpe = Math.min(L.rpe.max, Math.max(L.rpe.min, roundHalf(w.targetRpe)));
    if (rpe !== w.targetRpe) f.repair('rpe_clamped', w.lib.key, `RPE ${w.targetRpe} of "${w.lib.name}" set to ${rpe}.`);
    w.targetRpe = rpe;
  }

  // ---- 8. time ------------------------------------------------------------------
  if (request.minutes !== null) {
    const minutes = request.minutes;
    const fits = () => estimateAdaptedMinutes(list) <= minutes;
    const before = estimateAdaptedMinutes(list);

    // T1: drop non-priority exercises from the end, never the last exercise.
    for (let i = list.length - 1; i >= 0 && !fits() && list.length > 1; i -= 1) {
      const w = list[i];
      if (w.isPriority) continue;
      list.splice(i, 1);
      f.repair('time_exercise_dropped', w.lib.key, `Dropped "${w.lib.name}" to fit ${minutes} minutes (was about ${before}).`);
      if (w.counterpart) serverDrops.set(w.counterpart.key, 'time');
    }
    // T2 and T3: one set at a time, from the end, down to the floor.
    for (const priority of [false, true]) {
      let changed = true;
      while (!fits() && changed) {
        changed = false;
        for (const w of [...list].reverse()) {
          if (fits()) break;
          if (w.isPriority !== priority || w.sets <= R.setFloor) continue;
          w.sets -= 1;
          changed = true;
          f.repair(priority ? 'time_priority_set_removed' : 'time_set_removed', w.lib.key, `One set of "${w.lib.name}" removed to fit ${minutes} minutes (${w.sets} left).`);
        }
      }
    }
    if (!fits()) {
      return fail(ADAPTATION_REASONS.CANNOT_FIT, cannotFitMessage(minutes), f, list, request);
    }
  }

  // ---- the proposal -----------------------------------------------------------------
  const estimatedMinutes = estimateAdaptedMinutes(list);
  const presentBase = new Set(list.filter((w) => w.counterpart).map((w) => w.counterpart!.key));
  const modelReasons = new Map(draft.dropped.map((d) => [d.exerciseKey, d.reason]));
  const dropped = (facts.base?.exercises ?? [])
    .filter((b) => !presentBase.has(b.key))
    .map((b) => ({
      exerciseId: b.exerciseId,
      exerciseKey: b.key,
      name: b.name,
      reason: serverDrops.get(b.key) ?? modelReasons.get(b.key) ?? ('other' as AdaptationDropReason),
    }));

  const rationale = draft.rationale.map((r) => clipText(r, L.rationale.chars)).filter((r) => r.length > 0).slice(0, L.rationale.max);
  const title = clipText(draft.title, L.titleChars) || clipText(facts.base?.name, L.titleChars) || 'Adapted workout';

  const proposal: AdaptedWorkout = adaptedWorkoutSchema.parse({
    title,
    summary: clipText(draft.summary, L.summaryChars),
    estimatedMinutes,
    exercises: list.map((w, position) => ({
      exerciseId: w.lib.id,
      exerciseKey: w.lib.key,
      name: w.lib.name,
      position,
      source: w.source,
      replacesExerciseId: w.source === 'swapped' ? (w.counterpart?.exerciseId ?? null) : null,
      replacesExerciseKey: w.source === 'swapped' ? (w.counterpart?.key ?? null) : null,
      isPriority: w.isPriority,
      sets: w.sets,
      repMin: w.repMin,
      repMax: w.repMax,
      targetRpe: w.targetRpe,
      restSeconds: w.restSeconds,
      note: w.note,
      primaryMuscles: [...w.lib.primaryMuscles],
      trackingMode: w.lib.trackingMode,
    })),
    dropped,
    rationale: rationale.length ? rationale : ['Adjusted to what you told us about today.'],
    uncertainty: draft.uncertainty
      .map((u) => clipText(u, L.uncertainty.chars))
      .filter((u) => u.length > 0)
      .slice(0, L.uncertainty.max),
  });

  return {
    ok: true,
    proposal,
    report: {
      repairs: f.repairs,
      rejected: f.rejected,
      estimatedMinutes,
      fitsRequest: request.minutes === null || estimatedMinutes <= request.minutes,
    },
  };
}

/**
 * Brings the session down to `max` working sets: one set off each
 * non-priority exercise from the end (floor 2), repeated; then non-priority
 * exercises dropped from the end (never the last one); then one set off each
 * priority exercise (floor 2).
 */
function reduceTotalSets(
  list: Working[],
  max: number,
  f: Findings,
  serverDrops: Map<string, AdaptationDropReason>,
  code: string,
  why: string,
): void {
  const total = () => list.reduce((sum, w) => sum + w.sets, 0);
  if (total() <= max) return;
  const before = total();

  const trim = (priority: boolean) => {
    let changed = true;
    while (total() > max && changed) {
      changed = false;
      for (const w of [...list].reverse()) {
        if (total() <= max) break;
        if (w.isPriority !== priority || w.sets <= R.setFloor) continue;
        w.sets -= 1;
        changed = true;
      }
    }
  };

  trim(false);
  for (let i = list.length - 1; i >= 0 && total() > max && list.length > 1; i -= 1) {
    const w = list[i];
    if (w.isPriority) continue;
    list.splice(i, 1);
    f.repair(`${code}_dropped`, w.lib.key, `Dropped "${w.lib.name}" (${why}).`);
    if (w.counterpart) serverDrops.set(w.counterpart.key, 'other');
  }
  trim(true);

  f.repair(code, null, `${before} total sets lowered to ${total()} (${why}).`);
}

function fail(
  code: typeof ADAPTATION_REASONS.INVALID | typeof ADAPTATION_REASONS.CANNOT_FIT,
  message: string,
  f: Findings,
  list: Working[],
  request: AdaptationRuleRequest,
): AdaptationRuleOutcome {
  const estimatedMinutes = list.length ? estimateAdaptedMinutes(list) : 0;
  return {
    ok: false,
    code,
    message,
    report: {
      repairs: f.repairs,
      rejected: f.rejected,
      estimatedMinutes,
      fitsRequest: request.minutes === null || estimatedMinutes <= request.minutes,
    },
  };
}

// =============================================================================
// The apply-time re-check: does a stored proposal still pass against current data?
// =============================================================================

export interface StalenessFacts {
  /** The FULL library the user may use now, by id. */
  library: ReadonlyMap<string, LibraryExercise>;
  inventory: AdaptationFacts['inventory'];
  painFlagKeys: readonly string[];
  avoidKeys: readonly string[];
}

/** The violations of `proposal` against current data (empty: still valid). Never repairs. */
export function staleFindings(proposal: AdaptedWorkout, facts: StalenessFacts): GuardrailFinding[] {
  const findings: GuardrailFinding[] = [];
  const pain = new Set(facts.painFlagKeys);
  const avoid = new Set(facts.avoidKeys);

  for (const e of proposal.exercises) {
    const lib = facts.library.get(e.exerciseId);
    if (!lib) {
      findings.push({ code: 'exercise_unavailable', exerciseKey: e.exerciseKey, message: `"${e.name}" is no longer in your library.` });
      continue;
    }
    if (!supportedBy(lib, facts.inventory)) {
      findings.push({ code: 'equipment_changed', exerciseKey: e.exerciseKey, message: `Your equipment no longer supports "${e.name}".` });
    }
    if (pain.has(lib.key) || avoid.has(lib.key)) {
      findings.push({ code: 'pain_flagged', exerciseKey: e.exerciseKey, message: `"${e.name}" is now on your avoid list or pain-flagged.` });
    }
  }

  return findings;
}
