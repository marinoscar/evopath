import type { ExerciseTrackingMode, MovementPattern } from '../../common/constants/training.constants';
import type { TrainingHealthSummary } from '../../health-summary/health-summary.reader';
import type { RequirementRow } from '../../exercises/exercise-availability.service';
import type { EquipmentClass, ResearcherContext } from '../agents/researcher/researcher-context';
import type { TrainingIntake } from '../contracts/training-intake.contract';
import type { ConservativeMode } from '../guardrails/safety-screen';

// =============================================================================
// The context a create or revise run works from
// =============================================================================
//
// `TrainingRunContext` is what `prepare_context` puts in `RunState.context`
// (checkpointed with the run). It has two halves:
//
// - SENT: `researcher` (the researcher's minimised input) and `planner` (the
//   planner's). Exercises appear by stable slug (`key`), never by uuid; no
//   name, email, date of birth, note, lab, medication, gym name or storage
//   key can be in them (`never-send.ts`, asserted by the canary test). The
//   one health exception is `planner.healthSummary` (H8, #192): the user's
//   stored AI health summary TEXT, present only while they opted in. The
//   one user-memory exception is `planner.userMemories` (#325): the user's
//   own memory notes (training categories only), as the delimited block
//   `MemoryContextService` renders, present only while memory is on. The
//   "what will be sent" summary renders these same objects.
// - SERVER ONLY: `library`, `gym`, `history` and `mode`: what the guardrails
//   need to check and repair a plan (ids, requirement groups, recent loads).
//   Never sent to a model.
// =============================================================================

/** The substitution ladder's implement classes (`guardrails/substitution.ts`). */
export const IMPLEMENT_CLASSES = ['barbell', 'dumbbell', 'machine', 'cable', 'band', 'bodyweight'] as const;
export type ImplementClass = (typeof IMPLEMENT_CLASSES)[number];

/** One exercise the user may be prescribed: the seeded library plus their own active custom exercises. */
export interface LibraryExercise {
  id: string;
  /** The exercise's slug: the only way a model names it. */
  key: string;
  name: string;
  primaryMuscles: string[];
  secondaryMuscles: string[];
  movementPattern: MovementPattern | string;
  trackingMode: ExerciseTrackingMode | string;
  isCompound: boolean;
  isUnilateral: boolean;
  isBodyweight: boolean;
  /** The main implement, derived from the first requirement group (`implementOf`). */
  implement: ImplementClass;
  /** Requirement rows (OR inside a `groupIndex`, AND across groups); empty = needs nothing. */
  requirements: RequirementRow[];
}

/** What the chosen gym has, as ids. `null` on the context means "no gym": bodyweight only. */
export interface GymInventoryIds {
  equipmentTypeIds: string[];
  capabilityIds: string[];
}

/** Server-side recent history of one exercise (last 6 weeks), for the load guardrails. */
export interface ExerciseHistoryFacts {
  exerciseId: string;
  key: string;
  /** Top working set weight of the most recent exposure, kg (0 for unweighted bodyweight). */
  lastLoadKg: number | null;
  /** The most recent exposure's date, `YYYY-MM-DD`. */
  lastDate: string;
  /** Fewest reps among the most recent exposure's working sets. */
  lastMinReps: number | null;
  /** Heaviest working set in the window, kg. */
  bestRecentLoadKg: number | null;
  /** A set of it was pain-flagged in the last 28 days. */
  painFlagged: boolean;
}

/** One candidate exercise as the planner sees it. */
export interface CandidateExercise {
  key: string;
  name: string;
  primaryMuscles: string[];
  secondaryMuscles: string[];
  movementPattern: string;
  trackingMode: string;
  isCompound: boolean;
  isUnilateral: boolean;
}

export interface HistoryExerciseRow {
  key: string;
  lastTopSet: { weightKg: number; reps: number } | null;
  /** 1 = the user's most recent session. */
  sessionsAgo: number;
  bestRecentWorkingLoadKg: number | null;
}

export interface CompactPlanExercise {
  key: string;
  isPriority: boolean;
  /** Null only for a cardio prescription without a set count. */
  sets: number | null;
  /** Null for a cardio prescription. */
  repMin: number | null;
  repMax: number | null;
  /** Present only on a cardio prescription: total seconds and/or meters. */
  targetDurationSeconds?: number | null;
  targetDistanceMeters?: number | null;
  targetRpe: number | null;
  restSeconds: number;
  targetLoadKg: number | null;
}

export interface CompactPlanWorkout {
  name: string;
  weekday: number | null;
  exercises: CompactPlanExercise[];
}

/** A plan compacted like a draft: distinct week contents once, then the sequence of weeks. */
export interface CompactPlan {
  weekTypes: Array<{ key: string; workouts: CompactPlanWorkout[] }>;
  weeks: Array<{ weekNumber: number; weekType: string; isDeload: boolean; block: string }>;
}

/**
 * Walking and jogging (#265): what the user asked for, the equipment-free
 * cardio exercises they may be prescribed, their recent cardio volume and the
 * server's placement and progression guidance. Present when the intake asks
 * for cardio or the goal is endurance, fat loss or general fitness.
 */
export interface PlannerCardioContext {
  /** The user asked for cardio sessions: the plan must include them. */
  requested: boolean;
  activity: 'walk' | 'run' | 'any' | null;
  /** Cardio sessions a week the user asked for, when given. */
  daysPerWeek: number | null;
  /** Minutes per cardio session the user asked for, when given. */
  minutesPerSession: number | null;
  /** The most weekly cardio minutes the server lets ship (`daysPerWeek x minutesPerSession x 1.25`), when both are given. */
  weeklyMinutesCap: number | null;
  /** Equipment-free cardio exercises (outdoor walk, hike, outdoor run) by key, tracked by duration and distance. */
  exerciseKeys: string[];
  /** Completed cardio minutes per week over the last 4 weeks, oldest first. */
  recentWeeklyMinutes: number[];
  /** Server-authored placement and progression rules for the cardio sessions. */
  guidance: string[];
}

/** Exactly what the planner receives (inside `<context>`). Optional sections are omitted, never null. */
export interface PlannerContext {
  request: { kind: 'create' | 'revise'; instruction: string | null };
  goal: { type: TrainingIntake['goal']['type']; description: string };
  experience: TrainingIntake['experience'];
  daysPerWeek: number;
  preferredWeekdays: number[] | null;
  minutesPerSession: number;
  durationWeeks: number;
  limitations: Array<{ area: string; description: string }>;
  avoidExerciseKeys: string[];
  preferences: string;
  conservative: boolean;
  profile?: {
    ageYears: number | null;
    sexAtBirth: 'female' | 'male' | null;
    heightCm: number | null;
    unitPreference: 'metric' | 'imperial';
  };
  bodyMetrics?: {
    weightKg: number | null;
    bodyFatPercent: number | null;
    weightTrend: { kgPerWeek: number; points: number } | null;
  };
  equipment: { hasGym: boolean; equipmentClass: EquipmentClass; capabilityKeys: string[] };
  candidateExercises: CandidateExercise[];
  cardio?: PlannerCardioContext;
  history?: {
    /** Completed sessions per week, oldest of the 6 weeks first. */
    sessionsPerWeek: number[];
    exercises: HistoryExerciseRow[];
    painFlagExerciseKeys: string[];
  };
  readiness?: {
    energy: number | null;
    sleepQuality: number | null;
    soreness: number | null;
    stress: number | null;
    days: number;
  };
  bio?: string;
  /**
   * The opt-in AI health summary (H8, #192): the stored narrative and
   * training considerations, verbatim. Present only while the user's consent
   * is on and a ready summary exists; never a raw value.
   */
  healthSummary?: TrainingHealthSummary;
  /**
   * The user's memory notes (#325): goal, preference, constraint/injury,
   * schedule, equipment and training-history facts the user can see and edit,
   * as one `<user_memories>` block with its untrusted-data preamble. Present
   * only while memory is on and a fact exists.
   */
  userMemories?: string;
  currentPlan?: CompactPlan;
}

export type PlannerContextKey = keyof PlannerContext;

/** Every top-level key a planner context can carry, in the order it is rendered. */
export const PLANNER_CONTEXT_KEYS: readonly PlannerContextKey[] = [
  'request',
  'goal',
  'experience',
  'daysPerWeek',
  'preferredWeekdays',
  'minutesPerSession',
  'durationWeeks',
  'limitations',
  'avoidExerciseKeys',
  'preferences',
  'conservative',
  'profile',
  'bodyMetrics',
  'equipment',
  'candidateExercises',
  'cardio',
  'history',
  'readiness',
  'healthSummary',
  'userMemories',
  'bio',
  'currentPlan',
];

/** The run's context: what is sent (researcher, planner) plus what only the server reads. */
export interface TrainingRunContext {
  version: 1;
  kind: 'create' | 'revise';
  /** Conservative mode and why (rule codes only). */
  mode: ConservativeMode;
  researcher: ResearcherContext;
  planner: PlannerContext;
  /** SERVER ONLY from here down. */
  intake: TrainingIntake;
  library: LibraryExercise[];
  gym: GymInventoryIds | null;
  history: ExerciseHistoryFacts[];
  /** `revise`: the program and version the run changes. */
  revise: { programId: string; basedOnVersion: number } | null;
  /** When the context was built (ISO). */
  builtAt: string;
}
