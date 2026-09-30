import type { LibraryExercise, GymInventoryIds } from '../../training-agents/context/planner-context.contract';
import type { SentDataSummary } from '../../training-agents/context/summarize-context';
import type { TrainingExperience, TrainingGoalType } from '../../training-agents/contracts/training-intake.contract';
import type { SafetyLevel } from '../../training-agents/guardrails/safety-screen';
import type { EquipmentMode, SorenessLevel } from '../dto/adaptation-request.dto';

// =============================================================================
// The adaptation context: what is sent, and what only the server reads
// =============================================================================
//
// `AdaptationContextBuilder.build(userId, request)` returns ONE object. Its
// `sent` half is exactly what the planner and critic receive (inside
// `<context-json>`), and `summary` is rendered from that same object, so the
// "what will be sent" preview cannot differ from what is sent. `facts` is
// SERVER ONLY (ids, requirement groups, the base prescription with loads):
// the guardrails and `apply` read it; it is never sent.
//
// Minimisation (the spec's table): exercises by key and name, never an id;
// no name, email, profile, time zone, coordinates, gym name, notes, photos,
// storage ids, labs, medications, body weight, other gyms, other users,
// full history or the check-in note.
// =============================================================================

export const ADAPTATION_CONTEXT_VERSION = 1;

export interface SentExercise {
  key: string;
  name: string;
  primaryMuscles: string[];
  isPriority: boolean;
  sets: number;
  repMin: number;
  repMax: number;
  targetRpe: number | null;
  restSeconds: number;
  /** Whether the equipment chosen for today supports it. */
  availableHere: boolean;
}

export interface SentCandidate {
  key: string;
  name: string;
  primaryMuscles: string[];
  movementPattern: string;
  isCompound: boolean;
  trackingMode: string;
}

/** Exactly what the planner and the critic receive. Optional sections are omitted, never null. */
export interface AdaptationSentContext {
  version: typeof ADAPTATION_CONTEXT_VERSION;
  request: {
    minutes: number | null;
    soreness: { muscles: string[]; level: SorenessLevel } | null;
    lowEnergy: boolean;
    equipment: { mode: EquipmentMode; names: string[] };
    freeText: string | null;
    baseWorkout: 'planned' | 'none';
  };
  /** The plan header, when a plan is active. */
  plan?: {
    goal: string;
    weekNumber: number | null;
    totalWeeks: number | null;
    isDeload: boolean;
    priorityExerciseKeys: string[];
  };
  /** Today's planned workout, when it is the base. */
  today?: { estimatedMinutes: number | null; exercises: SentExercise[] };
  gym: {
    type: string | null;
    bodyweightOnly: boolean;
    equipment: Array<{ name: string; quantity: number; capabilities: string[] }>;
  };
  candidates: SentCandidate[];
  /** Per planned exercise: the last session's top set and date. */
  lastSessions?: Array<{ key: string; date: string; topSet: { weightKg: number; reps: number } | null }>;
  /** Today's four check-in scores, when `useReadiness` and a check-in exists. Never the note. */
  readiness?: { energy: number | null; sleepQuality: number | null; soreness: number | null; stress: number | null };
  constraints: {
    experience: TrainingExperience;
    lowEnergy: boolean;
    conservative: boolean;
    avoidExerciseKeys: string[];
    limitationAreas: string[];
  };
}

export type AdaptationSentKey = Exclude<keyof AdaptationSentContext, 'version'>;

/** Every section key the sent context can carry, in render order. */
export const ADAPTATION_SENT_KEYS: readonly AdaptationSentKey[] = [
  'request',
  'plan',
  'today',
  'gym',
  'candidates',
  'lastSessions',
  'readiness',
  'constraints',
];

/** One planned exercise, server side (with its load prescription). */
export interface BaseExercise {
  exerciseId: string;
  key: string;
  name: string;
  primaryMuscles: string[];
  trackingMode: string;
  isPriority: boolean;
  sets: number;
  repMin: number;
  repMax: number;
  targetRpe: number | null;
  restSeconds: number;
  targetLoadKg: number | null;
  loadGuidance: string;
  lastTime: { performedOn: string; topSet: { weightKg: number; reps: number } | null } | null;
}

/** Today's planned workout, when it is the base. */
export interface AdaptationBase {
  programId: string;
  planVersion: number;
  /** `program_versions.id` of `planVersion`, when found. */
  planVersionId: string | null;
  programWorkoutId: string;
  /** The planned workout's name (server only; the title of a one-off falls back to it). */
  name: string;
  date: string;
  /** The plan's gym. */
  gymId: string | null;
  exercises: BaseExercise[];
}

/** `workout_adaptations.base_ref`. */
export interface AdaptationBaseRef {
  planId: string;
  planVersionId: string | null;
  planVersion: number;
  planWorkoutId: string;
  date: string;
}

/** SERVER ONLY: what the guardrails and `apply` check against. Checkpointed, never sent. */
export interface AdaptationFacts {
  /** The user's local day (Health Profile time zone). */
  today: string;
  base: AdaptationBase | null;
  gymId: string | null;
  /** Every equipment type of the chosen gym (the staleness check compares against it). */
  gymEquipmentTypeIds: string[];
  /** What today's equipment choice supports; `null`: bodyweight only. */
  inventory: GymInventoryIds | null;
  /** The planned exercises plus the candidates: the only exercises a proposal may use. */
  library: LibraryExercise[];
  painFlagKeys: string[];
  avoidKeys: string[];
  limitationAreas: string[];
  experience: TrainingExperience;
  goal: TrainingGoalType;
  lowEnergy: boolean;
  conservative: boolean;
  builtAt: string;
}

export interface AdaptationSafety {
  level: SafetyLevel;
  /** Rule codes, never the user's words. */
  reasons: string[];
}

export interface AdaptationContext {
  version: typeof ADAPTATION_CONTEXT_VERSION;
  sent: AdaptationSentContext;
  facts: AdaptationFacts;
  safety: AdaptationSafety;
  /** The "what will be sent" sections, rendered from `sent`. */
  summary: SentDataSummary;
  baseRef: AdaptationBaseRef | null;
}

/** `workout_adaptations.context_snapshot`: the sent object and its summary. Key-free. */
export interface AdaptationContextSnapshot {
  version: typeof ADAPTATION_CONTEXT_VERSION;
  sent: AdaptationSentContext;
  summary: SentDataSummary;
}

export function snapshotOf(context: AdaptationContext): AdaptationContextSnapshot {
  return { version: context.version, sent: context.sent, summary: context.summary };
}

/** Why a context could not be built (the service maps these to 400/404; the graph to a failed run). */
export class AdaptationContextError extends Error {
  constructor(
    readonly code: 'ADAPTATION_GYM_NOT_FOUND' | 'ADAPTATION_EQUIPMENT_NOT_IN_GYM',
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AdaptationContextError';
  }
}
