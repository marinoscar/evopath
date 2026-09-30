import type { CompactSignals } from '../../programs/signals/compact-signals';
import type { RunState } from '../graph/run-state';

// =============================================================================
// EvaluateRunContext: what an evaluate run works from (`RunState.context`)
// =============================================================================
//
// `load_signals` builds it; `safety_gate` completes it (`safety`, and the
// "already decided" safety changes and the `recover` flag in `sent`). It is
// checkpointed with the run, so it holds no pain note, no note of any kind,
// no name and no key. Two halves, like the create run's context:
//
// - SENT (`sent`): exactly what the evaluator receives, inside its
//   delimiters. Exercises by stable key, plan rows by SHORT REF
//   (`W3-2-4` = week 3, workout 2, exercise 4; `W3-2` = the workout), never a
//   uuid; the profile digest of the plan's intake; recent change log entries
//   with the person's feedback; evidence claims by id. `summarizeEvaluatorContext`
//   renders the "what will be sent" panel from this same object.
// - SERVER ONLY (`server`): the ref -> row id map the envelope and apply
//   resolve operations with, the plan version the run is based on, the full
//   pain list, the plan's autonomy and pause state. Never sent.
// =============================================================================

export const EVALUATE_CONTEXT_VERSION = 1;

export interface WeekRange {
  from: number;
  to: number;
}

/** One exercise of the remaining plan, as the evaluator sees it. */
export interface EvaluatorPlanExercise {
  ref: string;
  key: string;
  isPriority: boolean;
  sets: number;
  repMin: number;
  repMax: number;
  targetRpe: number | null;
  restSeconds: number;
  targetLoadKg: number | null;
  loadGuidance: string;
}

export interface EvaluatorPlanWorkout {
  ref: string;
  weekday: number | null;
  /** The occurrence date (`YYYY-MM-DD`), null for an unscheduled workout. */
  date: string | null;
  /** Today's, past and started workouts never change (envelope E1). */
  locked: boolean;
  exercises: EvaluatorPlanExercise[];
}

export interface EvaluatorPlanWeek {
  weekNumber: number;
  /** 1-based block index (block names are not sent). */
  block: number;
  isDeload: boolean;
  lastWeekOfBlock: boolean;
  workouts: EvaluatorPlanWorkout[];
}

/** The plan from the current week on. */
export interface EvaluatorPlan {
  currentWeek: number | null;
  totalWeeks: number;
  weeks: EvaluatorPlanWeek[];
}

/** A recent change log entry. Reverted, rejected and expired entries are the person's feedback. */
export interface EvaluatorHistoryEntry {
  /** `YYYY-MM-DD` (UTC day of the entry). */
  date: string;
  kind: string;
  actor: string;
  status: string;
  /** Server or agent authored (at most 300 characters); never user free text. */
  summary: string;
  feedback: 'undone' | 'declined' | 'expired' | null;
  operations: number;
}

export interface EvaluatorEvidenceClaim {
  id: string;
  topic: string;
  claim: string;
  confidence: string;
}

/** A safety change the server already decided; shown to the evaluator as done. */
export interface ForcedSafetyOperation {
  op: 'remove_exercise';
  target: { exerciseRef: string; weeks: WeekRange };
  /** Fixed copy (`guardrails/safety-stop.ts`). */
  reason: string;
  forced: true;
}

/** The profile digest of `Program.intake` (the person's own words for this plan only). */
export interface EvaluatorProfile {
  goal: { type: string; description: string };
  experience: string | null;
  daysPerWeek: number | null;
  preferredWeekdays: number[] | null;
  minutesPerSession: number | null;
  limitations: Array<{ area: string; description: string }>;
  avoidExerciseKeys: string[];
  conservative: boolean;
  /** Filled by `safety_gate`. */
  alreadyDecided: ForcedSafetyOperation[];
}

/** Compact signals with every uuid and name removed: exercises by key, planned sessions by workout ref. */
export interface EvaluatorSignals {
  range: CompactSignals['range'];
  asOf: string;
  planVersion: number | null;
  weeksInRange: number;
  truncated: boolean;
  planChangedOn: string | null;
  adherence: CompactSignals['adherence'];
  frequency: CompactSignals['frequency'];
  sessions: Array<{
    workoutRef: string | null;
    plannedFor: string;
    status: string;
    setsPlanned: number;
    setsDone: number;
    avgRpe: number | null;
  }>;
  volume: CompactSignals['volume'];
  performance: Array<Omit<CompactSignals['performance'][number], 'exerciseId' | 'name' | 'slug'> & { key: string }>;
  effort: CompactSignals['effort'];
  pain: Array<{ key: string; lastFlaggedOn: string; flaggedSessions28d: number; consecutiveFlaggedSessions: number }>;
  readiness: CompactSignals['readiness'];
  body: CompactSignals['body'];
  dropped: { weeks: number; sessions: number; muscles: string[]; exercises: number; pain: number };
}

/** Exactly what the evaluator receives. */
export interface EvaluatorInput {
  run: {
    trigger: string | null;
    /** The last week of a block: consider the transition. */
    deep: boolean;
    /** Several low-readiness days in a row (set by `safety_gate`). */
    recover: boolean;
    /** Automatic adjustments are paused: assess only (set from the plan, and by `safety_gate`). */
    paused: boolean;
  };
  signals: EvaluatorSignals;
  plan: EvaluatorPlan;
  history: EvaluatorHistoryEntry[];
  evidence: EvaluatorEvidenceClaim[];
  profile: EvaluatorProfile;
}

/** What a short ref resolves to. Server only. */
export interface EvaluatorRef {
  kind: 'workout' | 'exercise';
  weekNumber: number;
  programWorkoutId: string;
  /** Exercise refs only. */
  programExerciseId?: string;
  exerciseId?: string;
  exerciseKey?: string;
  date: string | null;
  locked: boolean;
}

export interface ServerPainFact {
  exerciseId: string;
  key: string;
  lastFlaggedOn: string;
  flaggedSessions28d: number;
  consecutiveFlaggedSessions: number;
}

export interface EvaluateServerFacts {
  programId: string;
  /** The version the run's operations are based on (`applyChange`'s `expectedVersion`). */
  planVersion: number;
  autonomy: 'autonomous' | 'ask_first';
  /** The pause reason when automatic adjustments are paused, else null. */
  autonomyPausedReason: string | null;
  startDate: string | null;
  asOf: string;
  /** Short ref -> row ids. */
  refs: Record<string, EvaluatorRef>;
  /** Exercise key -> id, for every exercise in the plan. */
  exerciseIdsByKey: Record<string, string>;
  /** The full pain list (the compact signals may drop some). */
  pain: ServerPainFact[];
  readinessLowStreak: number;
}

export interface SafetyGateResult {
  /** `screenFreeText` over the last 14 days' pain notes: codes only, never the notes. */
  text: { level: 'ok' | 'conservative' | 'blocked'; reasons: string[] };
  painPattern: { triggered: boolean; exerciseKeys: string[]; exercisesFlagged14d: number };
  forced: ForcedSafetyOperation[];
  recover: boolean;
  /** Automatic adjustments are paused after the gate (read-only evaluation). */
  paused: boolean;
  /** The `reviewed` system entry this gate wrote, if any. */
  changeLogId: string | null;
}

export interface EvaluateRunContext {
  version: typeof EVALUATE_CONTEXT_VERSION;
  kind: 'evaluate';
  sent: EvaluatorInput;
  server: EvaluateServerFacts;
  /** Set by `safety_gate`. */
  safety: SafetyGateResult | null;
  builtAt: string;
}

/** `state.context` narrowed to an evaluate run's context, or null when it is not one. */
export function evaluateContextOf(state: { context?: RunState['context'] }): EvaluateRunContext | null {
  const context = (state.context ?? null) as Partial<EvaluateRunContext> | null;
  return context && context.kind === 'evaluate' && context.version === EVALUATE_CONTEXT_VERSION && context.sent && context.server
    ? (context as EvaluateRunContext)
    : null;
}
