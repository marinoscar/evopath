import { addDays } from '../../check-ins/local-date';
import type { EvaluatorRef, ForcedSafetyOperation, ServerPainFact } from '../evaluation/evaluate-context';
import { SAFETY_STOP_GUIDANCE } from './safety-keywords';

// =============================================================================
// Safety stops of the evaluate graph (pure; `nodes/safety-gate.node.ts`)
// =============================================================================
//
// Deterministic and server-side, BEFORE any provider call:
//
//   (a) urgent-symptom text in a pain note of the last 14 days
//       (`screenFreeText`, run by the node; the notes never leave the server)
//       -> the run ends `blocked_safety`, automation pauses (`safety_text`);
//   (b) PAIN PATTERN: one exercise flagged in 3 sessions in a row, or pain on
//       3 or more different exercises in 14 days -> automation pauses
//       (`pain_pattern`); the run continues read-only;
//   (c) one exercise flagged in 2 sessions in a row -> its unlocked future
//       occurrences are removed (FORCED: applied in both autonomy modes and
//       shown to the evaluator as already decided);
//   (d) `readiness.lowStreak >= 5` -> the context is marked `recover`.
//
// All copy is fixed here. None of it diagnoses, and none of it says to train
// through pain (a test asserts it over `SAFETY_COPY`).
// =============================================================================

export const SAFETY_STOP_RULES = {
  /** (a) and (b): the window, in local days ending `asOf`. */
  windowDays: 14,
  /** (b) one exercise flagged in this many sessions in a row. */
  patternConsecutiveSessions: 3,
  /** (b) ... or pain on this many different exercises in the window. */
  patternDistinctExercises: 3,
  /** (c) forced removal from this many sessions in a row. */
  forcedConsecutiveSessions: 2,
  /** (d) low-readiness days in a row. */
  recoverLowStreak: 5,
} as const;

export const SAFETY_TEXT_SUMMARY =
  'Automatic adjustments paused: a recent pain note may describe a symptom that needs medical attention.';
export const SAFETY_TEXT_RATIONALE = SAFETY_STOP_GUIDANCE;

export const PAIN_PATTERN_SUMMARY = 'Automatic adjustments paused: pain keeps coming back.';
export const PAIN_PATTERN_RATIONALE =
  'Pain was flagged repeatedly in recent sessions. Your plan will not add load or volume while adjustments are ' +
  'paused. Please see a qualified professional, such as a doctor or physiotherapist, before you resume automatic ' +
  'adjustments. Stop any exercise that hurts.';

export const FORCED_REMOVAL_REASON =
  'Pain was flagged on this exercise in two sessions in a row, so it is removed from your upcoming sessions.';

/** Every user-facing safety string, for the copy assertions. */
export const SAFETY_COPY: readonly string[] = [
  SAFETY_TEXT_SUMMARY,
  SAFETY_TEXT_RATIONALE,
  PAIN_PATTERN_SUMMARY,
  PAIN_PATTERN_RATIONALE,
  FORCED_REMOVAL_REASON,
];

export interface PainPatternResult {
  triggered: boolean;
  /** Keys of the exercises that tripped the rule (sorted). */
  exerciseKeys: string[];
  /** Different exercises with pain in the window. */
  exercisesFlagged14d: number;
}

/** (b) The pain pattern over the full pain list, as of `asOf` (`YYYY-MM-DD`). */
export function painPattern(pain: readonly ServerPainFact[], asOf: string): PainPatternResult {
  const since = addDays(asOf, -(SAFETY_STOP_RULES.windowDays - 1));
  const recent = pain.filter((row) => row.lastFlaggedOn >= since && row.lastFlaggedOn <= asOf);
  const repeated = pain.filter((row) => row.consecutiveFlaggedSessions >= SAFETY_STOP_RULES.patternConsecutiveSessions);
  const spread = recent.length >= SAFETY_STOP_RULES.patternDistinctExercises;
  const keys = new Set([...repeated.map((row) => row.key), ...(spread ? recent.map((row) => row.key) : [])]);

  return { triggered: repeated.length > 0 || spread, exerciseKeys: [...keys].sort(), exercisesFlagged14d: recent.length };
}

/** Sort key of a short ref: week, workout, exercise numerically. */
function refOrder(ref: string): number[] {
  return ref.slice(1).split('-').map(Number);
}

function compareRefs(a: string, b: string): number {
  const x = refOrder(a);
  const y = refOrder(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * (c) The forced removals: every unlocked future occurrence of an exercise
 * flagged in 2 or more sessions in a row, one operation per occurrence, in
 * plan order.
 */
export function forcedSafetyOperations(
  pain: readonly ServerPainFact[],
  refs: Readonly<Record<string, EvaluatorRef>>,
): ForcedSafetyOperation[] {
  const flagged = new Set(
    pain.filter((row) => row.consecutiveFlaggedSessions >= SAFETY_STOP_RULES.forcedConsecutiveSessions).map((row) => row.exerciseId),
  );
  if (flagged.size === 0) return [];

  return Object.entries(refs)
    .filter(([, ref]) => ref.kind === 'exercise' && !ref.locked && ref.exerciseId !== undefined && flagged.has(ref.exerciseId))
    .map(([ref]) => ref)
    .sort(compareRefs)
    .map((ref) => ({
      op: 'remove_exercise' as const,
      target: { exerciseRef: ref, weeks: { from: refs[ref].weekNumber, to: refs[ref].weekNumber } },
      reason: FORCED_REMOVAL_REASON,
      forced: true as const,
    }));
}

/** (d) Several low-readiness days in a row. */
export function needsRecovery(lowStreak: number): boolean {
  return lowStreak >= SAFETY_STOP_RULES.recoverLowStreak;
}
