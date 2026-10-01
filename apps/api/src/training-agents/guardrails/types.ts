import type { PlanTree } from '../../programs/contracts/plan-tree.contract';
import type { VerifiedEvidenceBrief } from '../agents/researcher/evidence-brief.contract';
import type { ExerciseHistoryFacts, GymInventoryIds, LibraryExercise, TrainingRunContext } from '../context/planner-context.contract';
import type { TrainingCardio, TrainingExperience, TrainingGoalType } from '../contracts/training-intake.contract';

// =============================================================================
// Guardrail vocabulary: rules, violations, the report and the context
// =============================================================================

export const GUARDRAIL_RULES = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9'] as const;
export type GuardrailRule = (typeof GUARDRAIL_RULES)[number];

export type ViolationSeverity = 'block' | 'repair' | 'warn';

/**
 * One finding. `block`: the plan may not ship (nothing repaired it).
 * `repair`: the server changed the plan (the message says what and why).
 * `warn`: shipped as is, flagged for the critic and the user.
 * Messages and paths are server-authored; they quote exercise keys and
 * numbers, never model text.
 */
export interface Violation {
  rule: GuardrailRule;
  severity: ViolationSeverity;
  /** Stable machine code (`unknown_exercise`, `session_sets_clamped`, ...). */
  code: string;
  /** Where: `week 3 > Mon (Upper A) > barbell_bench_press`. */
  path: string;
  message: string;
}

export type GuardrailStatus = 'clean' | 'repaired' | 'blocked';

export interface GuardrailReport {
  /** `clean`: no violation. `repaired`: only repairs or warnings. `blocked`: an unrepaired block. */
  status: GuardrailStatus;
  violations: Violation[];
  counts: { block: number; repair: number; warn: number };
}

/** What the guardrails check a tree against. Built from the run context by `guardrailContextOf`. */
export interface GuardrailContext {
  goal: TrainingGoalType;
  experience: TrainingExperience;
  daysPerWeek: number;
  /** ISO weekdays, sorted; `null` = any day. */
  preferredWeekdays: number[] | null;
  minutesPerSession: number;
  conservative: boolean;
  avoidExerciseKeys: ReadonlySet<string>;
  painFlagKeys: ReadonlySet<string>;
  limitationAreas: string[];
  library: ReadonlyMap<string, LibraryExercise>;
  libraryByKey: ReadonlyMap<string, LibraryExercise>;
  /** `null`: no gym, bodyweight exercises only. */
  gym: GymInventoryIds | null;
  /** Recent history by exercise id. */
  history: ReadonlyMap<string, ExerciseHistoryFacts>;
  /** The verified brief (`null` when the run has none: every evidence ref is removed). */
  brief: VerifiedEvidenceBrief | null;
  /** The reference instant for gaps (the context's build time, so reruns agree). */
  now: Date;
  /** The intake's cardio request (#265); absent or `null` when it has none. */
  cardio?: TrainingCardio | null;
}

export function guardrailContextOf(context: TrainingRunContext, brief: VerifiedEvidenceBrief | null): GuardrailContext {
  const painFlagKeys = new Set(context.history.filter((h) => h.painFlagged).map((h) => h.key));
  for (const key of context.planner.history?.painFlagExerciseKeys ?? []) painFlagKeys.add(key);

  return {
    goal: context.intake.goal.type,
    experience: context.intake.experience,
    daysPerWeek: context.intake.daysPerWeek,
    preferredWeekdays: context.intake.preferredWeekdays ? [...context.intake.preferredWeekdays].sort((a, b) => a - b) : null,
    minutesPerSession: context.intake.minutesPerSession,
    conservative: context.mode.conservative,
    avoidExerciseKeys: new Set(context.intake.avoidExerciseKeys),
    painFlagKeys,
    limitationAreas: [...new Set(context.intake.limitations.map((l) => l.area))].sort(),
    library: new Map(context.library.map((e) => [e.id, e])),
    libraryByKey: new Map(context.library.map((e) => [e.key, e])),
    gym: context.gym,
    history: new Map(context.history.map((h) => [h.exerciseId, h])),
    brief,
    now: new Date(context.builtAt),
    cardio: context.intake.cardio ?? null,
  };
}

/** What `applyGuardrails` returns. */
export interface GuardrailOutcome {
  tree: PlanTree;
  report: GuardrailReport;
}
