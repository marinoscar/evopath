/**
 * The training programs API (`/api/programs`), as the web app sees it. E5.1.
 *
 * Every route is owner-scoped on the server (`programs:read` /
 * `programs:write`); another user's program answers `404`. Manual plans need
 * no AI. `services/api.ts` stays the transport (bearer token, refresh, the
 * `{ data }` envelope); this module holds the calls next to their types.
 *
 * CONCURRENCY: content writes (`replaceProgramStructure`, `revertProgram`)
 * send the loaded `currentVersion` as `If-Match`. A stale version answers
 * `409` with `details.reason: 'TRAINING_STALE_PLAN'` and
 * `details.currentVersion`; reload and re-apply.
 *
 * UNITS: the API speaks kilograms only (`targetLoadKg`). Display converts with
 * `formatTargetLoad` (`utils/units.ts`), from the Health Profile `unitSystem`.
 *
 * The bounds below mirror the API's plan contract
 * (`apps/api/src/programs/contracts/plan-tree.contract.ts`) so a form can
 * explain a problem before the round trip; the API decides.
 */

import { formatWeight, type WeightUnit } from '../utils/units';
import { api, ApiError } from './api';

// -----------------------------------------------------------------------------
// Vocabulary and bounds
// -----------------------------------------------------------------------------

export const PROGRAM_STATUSES = ['draft', 'active', 'paused', 'archived', 'completed'] as const;
export type ProgramStatus = (typeof PROGRAM_STATUSES)[number];

export const PROGRAM_GOALS = ['strength', 'hypertrophy', 'fat_loss', 'general', 'endurance', 'custom'] as const;
export type ProgramGoal = (typeof PROGRAM_GOALS)[number];

export const PROGRAM_AUTONOMY = ['autonomous', 'ask_first'] as const;
export type ProgramAutonomy = (typeof PROGRAM_AUTONOMY)[number];

export type ProgramSource = 'ai' | 'manual';

export const VERSION_ORIGINS = ['initial', 'ai_create', 'ai_adapt', 'manual_edit', 'revert', 'duplicate'] as const;
export type VersionOrigin = (typeof VERSION_ORIGINS)[number];

export type ChangeKind = 'created' | 'adapted' | 'edited' | 'reverted' | 'reviewed';
export type ChangeActor = 'ai' | 'user' | 'system';
export const CHANGE_STATUSES = ['applied', 'proposed', 'rejected', 'reverted', 'superseded', 'expired'] as const;
export type ChangeStatus = (typeof CHANGE_STATUSES)[number];

export type LoadGuidance = 'choose_start' | 'from_history' | 'fixed';

/** Why automatic adjustments are paused (E5.8): two safety stops, or the owner. */
export const AUTONOMY_PAUSE_REASONS = ['safety_text', 'pain_pattern', 'user_paused'] as const;
export type AutonomyPauseReason = (typeof AUTONOMY_PAUSE_REASONS)[number];

export const PLAN_LIMITS = {
  weeksMax: 52,
  workoutsPerWeekMax: 7,
  exercisesPerWorkoutMax: 20,
  nameMax: 100,
  nodeRationaleMax: 300,
  targetSets: { min: 1, max: 20 },
  reps: { min: 1, max: 100 },
  targetLoadKg: { min: 0, max: 1000, decimals: 3 },
  targetRpe: { min: 1, max: 10, step: 0.5 },
  restSeconds: { min: 0, max: 900 },
  /** Cardio prescriptions (#262): a duration and/or a distance instead of reps. */
  targetDurationSeconds: { min: 60, max: 36_000 },
  targetDistanceMeters: { min: 100, max: 100_000 },
} as const;

/**
 * Which prescription shape an exercise's `trackingMode` takes (#262):
 * `weight_reps` / `bodyweight_reps` -> sets and reps; `time` -> a duration;
 * `distance_time` -> a duration and/or a distance. The API rejects a
 * mismatch with `400 VALIDATION_ERROR`.
 */
export type PrescriptionShape = 'reps' | 'duration' | 'distance_duration';

export function prescriptionShapeFor(trackingMode: string | null | undefined): PrescriptionShape {
  if (trackingMode === 'time') return 'duration';
  if (trackingMode === 'distance_time') return 'distance_duration';
  return 'reps';
}

/** `details.reason` values the programs API answers with. */
export const PROGRAM_REFUSALS = {
  STALE_PLAN: 'TRAINING_STALE_PLAN',
  NOT_LATEST: 'NOT_LATEST',
  NOT_REVERTIBLE: 'NOT_REVERTIBLE',
  SNAPSHOT_UNSUPPORTED: 'SNAPSHOT_UNSUPPORTED',
  IF_MATCH_REQUIRED: 'IF_MATCH_REQUIRED',
  ILLEGAL_TRANSITION: 'ILLEGAL_TRANSITION',
  NOT_SCHEDULABLE: 'PLAN_NOT_SCHEDULABLE',
  ACTIVE_PROGRAM_CONFLICT: 'ACTIVE_PROGRAM_CONFLICT',
  START_DATE_OUT_OF_RANGE: 'START_DATE_OUT_OF_RANGE',
  PROGRAM_ARCHIVED: 'PROGRAM_ARCHIVED',
  HAS_HISTORY: 'PROGRAM_HAS_HISTORY',
  UNKNOWN_EXERCISES: 'UNKNOWN_EXERCISES',
  ROW_ID_CONFLICT: 'ROW_ID_CONFLICT',
  INVALID_PLAN: 'INVALID_PLAN',
} as const;
export type ProgramRefusal = (typeof PROGRAM_REFUSALS)[keyof typeof PROGRAM_REFUSALS];

// -----------------------------------------------------------------------------
// The plan tree (what PUT /structure takes; ids optional for new rows)
// -----------------------------------------------------------------------------

export interface PlanExercise {
  /** Omit for a new row. */
  id?: string;
  exerciseId: string;
  position: number;
  isPriority?: boolean;
  /** Reps shape: required. Cardio shape: null, or 1..20 intervals. */
  targetSets: number | null;
  /** Reps shape only; null for a duration or distance prescription. */
  repMin: number | null;
  repMax: number | null;
  /** Cardio shape (#262): seconds, 60..36000; null for reps. */
  targetDurationSeconds?: number | null;
  /** Cardio shape (#262): metres, 100..100000; null for reps. */
  targetDistanceMeters?: number | null;
  /** Kilograms; null lets the lifter choose or use history. */
  targetLoadKg?: number | null;
  /** 1..10 in steps of 0.5. */
  targetRpe?: number | null;
  restSeconds: number;
  loadGuidance?: LoadGuidance;
  rationale?: string | null;
  evidenceRefs?: string[];
  notes?: string | null;
  equipmentTypeId?: string | null;
}

export interface PlanWorkout {
  id?: string;
  position: number;
  /** ISO weekday 1 (Monday) .. 7 (Sunday); null when unscheduled. */
  weekday?: number | null;
  name: string;
  estimatedMinutes?: number | null;
  rationale?: string | null;
  exercises: PlanExercise[];
}

export interface PlanWeek {
  id?: string;
  /** 1-based, program-wide, contiguous. */
  weekNumber: number;
  isDeload?: boolean;
  workouts: PlanWorkout[];
}

export interface PlanBlock {
  id?: string;
  position: number;
  name: string;
  focus?: string | null;
  rationale?: string | null;
  weeks: PlanWeek[];
}

export interface PlanTree {
  blocks: PlanBlock[];
}

// -----------------------------------------------------------------------------
// Views
// -----------------------------------------------------------------------------

export interface ProgramHeader {
  id: string;
  name: string;
  goal: ProgramGoal;
  status: ProgramStatus;
  source: ProgramSource;
  autonomy: ProgramAutonomy;
  /** `YYYY-MM-DD`, set on activation. */
  startDate: string | null;
  gymId: string | null;
  /** Send back as `If-Match` on content writes. */
  currentVersion: number;
  /** When automatic adjustments were paused (a safety stop, or the owner); null while they run. */
  autonomyPausedAt: string | null;
  /** Why they are paused; null while they run. */
  autonomyPausedReason: AutonomyPauseReason | null;
  /** When the last evaluation run started; null when never. */
  lastEvaluatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProgramListItem extends ProgramHeader {
  /** AI changes the owner has not yet marked seen. */
  unseenChangeCount: number;
}

export interface PlanExerciseView extends Required<Omit<PlanExercise, 'id'>> {
  id: string;
  /** Null when the exercise is no longer available; see `exerciseUnavailable`. */
  exercise: { id: string; name: string; slug: string; trackingMode: string } | null;
  exerciseUnavailable: boolean;
}

export interface PlanWorkoutView extends Required<Omit<PlanWorkout, 'id' | 'exercises'>> {
  id: string;
  exercises: PlanExerciseView[];
}

export interface PlanWeekView extends Required<Omit<PlanWeek, 'id' | 'workouts'>> {
  id: string;
  workouts: PlanWorkoutView[];
}

export interface PlanBlockView extends Required<Omit<PlanBlock, 'id' | 'weeks'>> {
  id: string;
  weeks: PlanWeekView[];
}

export interface PlanTreeView {
  blocks: PlanBlockView[];
}

export interface Program extends ProgramHeader {
  notes: string | null;
  /** The plan's overall rationale. */
  rationale: string | null;
  intake: unknown;
  gym: { id: string; name: string } | null;
  version: {
    versionNumber: number;
    origin: VersionOrigin;
    rationale: string | null;
    evidence: Record<string, unknown>[];
    meta: Record<string, unknown>;
    createdAt: string;
  };
  tree: PlanTreeView;
  /** Present after a write: non-blocking notes about the saved plan. */
  warnings?: string[];
}

export interface ProgramVersionSummary {
  versionNumber: number;
  origin: VersionOrigin;
  createdAt: string;
  runId: string | null;
  changeLogId: string | null;
  summary: string | null;
}

export interface ProgramVersion extends ProgramVersionSummary {
  rationale: string | null;
  evidence: Record<string, unknown>[];
  meta: Record<string, unknown>;
  /** `{ schemaVersion, program, tree }`, row ids preserved. */
  snapshot: Record<string, unknown>;
}

/**
 * One operation as the change log stores it (E5.8): the typed plan-change
 * operation (`op` plus its fields), `forced` for a safety removal, and the
 * server-authored one-line `description` the history shows. Older entries
 * may carry other shapes; read `description` defensively.
 */
export interface StoredOperation extends Record<string, unknown> {
  op?: string;
  description?: string;
  forced?: boolean;
}

export interface ChangeLogEntry {
  id: string;
  kind: ChangeKind;
  actor: ChangeActor;
  status: ChangeStatus;
  fromVersion: number | null;
  toVersion: number | null;
  runId: string | null;
  summary: string;
  rationale: string | null;
  /** A `proposed` entry has a `runId` (decide through it) and `toVersion: null`. */
  operations: StoredOperation[];
  citations: Record<string, unknown>[];
  revertsLogId: string | null;
  seenAt: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface ChangeLogPage {
  items: ChangeLogEntry[];
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
}

// -----------------------------------------------------------------------------
// Inputs
// -----------------------------------------------------------------------------

export interface CreateProgramInput {
  name: string;
  goal: ProgramGoal;
  notes?: string | null;
}

export interface UpdateProgramInput {
  name?: string;
  goal?: ProgramGoal;
  notes?: string | null;
  autonomy?: ProgramAutonomy;
  gymId?: string | null;
}

export type RevertProgramInput = { toVersion: number } | { changeLogId: string };

// -----------------------------------------------------------------------------
// Today's planned workout (E5.7)
// -----------------------------------------------------------------------------

/** `details.reason` values `getTrainingToday` and `startProgramWorkout` answer with. */
export const TODAY_REFUSALS = {
  /** `date` more than 2 days from the server's today (400). */
  DATE_OUT_OF_RANGE: 'TODAY_OUT_OF_RANGE',
  /** The plan was paused, archived or completed before start (409, with `details.status`). */
  PROGRAM_NOT_ACTIVE: 'PROGRAM_NOT_ACTIVE',
  /** Another workout is in progress (409); `details.workoutId` is the one to resume. */
  WORKOUT_IN_PROGRESS: 'WORKOUT_IN_PROGRESS',
  /** The planned workout has no exercises (409). */
  PROGRAM_WORKOUT_EMPTY: 'PROGRAM_WORKOUT_EMPTY',
} as const;
export type TodayRefusal = (typeof TODAY_REFUSALS)[keyof typeof TODAY_REFUSALS];

export interface TodayProgramRef {
  id: string;
  name: string;
}

export interface TodayProgramWorkoutRef {
  id: string;
  name: string;
  /** ISO weekday 1 (Monday) .. 7 (Sunday). */
  weekday: number;
  estimatedMinutes: number | null;
}

export interface TodaySessionExercise {
  programExerciseId: string;
  exercise: {
    id: string;
    slug: string;
    name: string;
    trackingMode: string;
    isBodyweight: boolean;
    primaryMuscles: string[];
  };
  isPriority: boolean;
  /** Null for a duration or distance prescription without intervals (#262). */
  sets: number | null;
  repMin: number | null;
  repMax: number | null;
  /** Seconds; set for a duration prescription (#262). */
  targetDurationSeconds: number | null;
  /** Metres; set for a distance prescription (#262). */
  targetDistanceMeters: number | null;
  targetRpe: number | null;
  restSeconds: number;
  loadGuidance: LoadGuidance;
  /** Kilograms; the plan's load (meaningful for `fixed`). */
  targetLoadKg: number | null;
  /**
   * Kilograms; the load to show: `fixed` = `targetLoadKg` (else last top set),
   * `from_history` = last top set, `choose_start` = null ("Choose a starting load").
   */
  suggestedLoadKg: number | null;
  /** The one-line reason for this prescription. */
  rationale: string | null;
  lastTime: { performedOn: string; topSet: { weightKg: number; reps: number } | null } | null;
  /** Null when the plan has no gym. */
  availableAtGym: boolean | null;
}

export interface TodaySession {
  programId: string;
  programName: string;
  programWorkoutId: string;
  name: string;
  weekNumber: number;
  totalWeeks: number;
  isDeload: boolean;
  estimatedMinutes: number | null;
  planVersion: number;
  /** AI changes not yet marked seen: render the "Plan adjusted" chip when > 0. */
  unseenChangeCount: number;
  lastChange: { summary: string; actor: ChangeActor; at: string } | null;
  exercises: TodaySessionExercise[];
}

/** `GET /api/training/today`: discriminated by `kind`. `date` echoes the request. */
export type TrainingToday =
  | { kind: 'no_program'; date: string }
  | { kind: 'not_started'; date: string; program: TodayProgramRef; startsOn: string }
  | { kind: 'program_complete'; date: string; program: TodayProgramRef }
  | {
      kind: 'rest_day';
      date: string;
      program: TodayProgramRef;
      weekNumber: number;
      totalWeeks: number;
      /** The next occurrence within 14 days, or null. */
      next: { date: string; weekNumber: number; programWorkout: TodayProgramWorkoutRef } | null;
    }
  | {
      kind: 'workout';
      date: string;
      program: TodayProgramRef;
      programWorkout: TodayProgramWorkoutRef;
      weekNumber: number;
      totalWeeks: number;
      isDeload: boolean;
      /** A completed workout is linked to this planned workout. */
      done: boolean;
      completedWorkoutId: string | null;
      inProgressWorkoutId: string | null;
      session: TodaySession;
    };

export type TrainingTodayKind = TrainingToday['kind'];

export interface StartProgramWorkoutInput {
  /** The client's local day, `YYYY-MM-DD` (within 2 days of the server's today). */
  date: string;
  /** Default: the plan's gym. */
  gymId?: string;
}

export interface StartProgramWorkoutResult {
  /** The E4 workout to open in the logger. */
  workoutId: string;
  /** True when the in-progress workout for this planned workout was returned. */
  existing: boolean;
  /** The plan version the session was started from. */
  planVersion: number;
}

// -----------------------------------------------------------------------------
// Plan signals (E5.9): GET /api/training/signals
// -----------------------------------------------------------------------------
//
// Facts the server computes about a plan. Every number is finite or null.
// Weights are kilograms (convert for display); dates are local `YYYY-MM-DD`
// days; a week is an ISO week keyed by its Monday.

/** `details.reason` values `getTrainingSignals` answers 400 with. */
export const SIGNALS_REFUSALS = {
  /** `asOf` more than 2 days from the server's today. */
  AS_OF_OUT_OF_RANGE: 'SIGNALS_AS_OF_OUT_OF_RANGE',
  /** `from` after `to`, or a range over 26 weeks (after defaults). */
  RANGE_INVALID: 'SIGNALS_RANGE_INVALID',
} as const;
export type SignalsRefusal = (typeof SIGNALS_REFUSALS)[keyof typeof SIGNALS_REFUSALS];

/** The widest range the route accepts. */
export const SIGNALS_MAX_WEEKS = 26;

export type PlannedSessionStatus = 'done' | 'partial' | 'missed' | 'upcoming' | 'in_progress';
export type LiftTrend = 'up' | 'flat' | 'down' | 'insufficient';
export type RpeTrend = 'rising' | 'flat' | 'falling' | 'insufficient';

export interface AdherenceCounts {
  /** Due planned sessions: before `asOf`, or already started or done. */
  planned: number;
  /** Planned sessions with a completed linked workout (partial ones included). */
  completed: number;
  /** Completed planned sessions below 60 percent of their planned sets. */
  partialSessions: number;
  missed: number;
  /** Completed workouts linked to no plan. */
  extra: number;
  /** `completed / planned` in percent (one decimal); null when nothing was planned. */
  adherencePct: number | null;
}

export interface AdherenceWeek extends AdherenceCounts {
  weekStart: string;
  /** Straddles the range edge or is not over yet; left out of averages. */
  partial: boolean;
}

export interface PlannedSessionSignal {
  programWorkoutId: string;
  name: string;
  plannedFor: string;
  status: PlannedSessionStatus;
  workoutId: string | null;
  setsPlanned: number;
  setsDone: number;
  /** 0..100, one decimal; null without a workout or planned sets. */
  completionPct: number | null;
  avgRpe: number | null;
}

export interface MuscleVolume {
  muscle: string;
  weeks: Array<{ weekStart: string; plannedSets: number; hardSets: number }>;
  totalHardSets: number;
  /** Null when no hard set was weighted. */
  tonnageKg: number | null;
}

export interface LiftPerformance {
  exerciseId: string;
  slug: string;
  name: string;
  sessions: number;
  best: { weightKg: number | null; reps: number | null; e1rmKg: number | null };
  /** Newest first, at most three. */
  lastTopSets: Array<{ date: string; weightKg: number; reps: number; rpe: number | null }>;
  trend: LiftTrend;
  trendPct: number | null;
  prInRange: boolean;
}

export interface PainSignal {
  exerciseId: string;
  slug: string;
  name: string;
  lastFlaggedOn: string;
  flaggedSessions28d: number;
  consecutiveFlaggedSessions: number;
}

export interface PlanSignals {
  range: { from: string; to: string };
  asOf: string;
  /** Null when the caller has no program: adherence is then empty. */
  programId: string | null;
  planVersion: number | null;
  weeksInRange: number;
  /** A very large history moved `range.from` forward. */
  truncated: boolean;
  /** The latest day the plan changed inside the range ("earlier weeks use today's structure"). */
  planChangedOn: string | null;
  adherence: {
    weeks: AdherenceWeek[];
    totals: AdherenceCounts;
    missedStreak: number;
    completedStreak: number;
  };
  frequency: { avgPerWeek: number | null; perWeek: Array<{ weekStart: string; sessions: number }> };
  sessions: PlannedSessionSignal[];
  volume: MuscleVolume[];
  performance: LiftPerformance[];
  effort: { avgRpe: number | null; setsAtRpe9Plus: number; rpeTrend: RpeTrend };
  pain: PainSignal[];
  readiness: {
    days: number;
    avg: { energy: number | null; sleepQuality: number | null; soreness: number | null; stress: number | null } | null;
    lowDays: number;
    lowStreak: number;
  };
  body: {
    weightKg: { latest: number | null; changePerWeek: number | null; points: number };
    bodyFatPct: { latest: number | null; points: number } | null;
  };
}

export interface TrainingSignalsParams {
  /** Default: the active program. */
  programId?: string;
  /** Default: the Monday 7 weeks before `to`'s week. */
  from?: string;
  /** Default: `asOf`. */
  to?: string;
  /** The client's local day (within 2 days of the server's today). */
  asOf?: string;
}

// -----------------------------------------------------------------------------
// Calls
// -----------------------------------------------------------------------------

const programPath = (id: string) => `/programs/${encodeURIComponent(id)}`;
const ifMatch = (version: number) => ({ headers: { 'If-Match': String(version) } });

export function listPrograms(params: { status?: ProgramStatus } = {}, options: { signal?: AbortSignal } = {}) {
  const query = params.status ? `?status=${encodeURIComponent(params.status)}` : '';
  return api.get<ProgramListItem[]>(`/programs${query}`, { signal: options.signal });
}

export function createProgram(input: CreateProgramInput) {
  return api.post<Program>('/programs', input);
}

export function getProgram(id: string, options: { signal?: AbortSignal } = {}) {
  return api.get<Program>(programPath(id), { signal: options.signal });
}

/** Header fields only; does not create a version. */
export function updateProgram(id: string, input: UpdateProgramInput) {
  return api.patch<Program>(programPath(id), input);
}

/** Replace the whole tree. `currentVersion` is the version the edit is based on. */
export function replaceProgramStructure(id: string, currentVersion: number, tree: PlanTree) {
  return api.put<Program>(`${programPath(id)}/structure`, tree, ifMatch(currentVersion));
}

/** `startDate` is the client's calendar day, `YYYY-MM-DD`. */
export function activateProgram(id: string, startDate: string) {
  return api.post<Program>(`${programPath(id)}/activate`, { startDate });
}

export function pauseProgram(id: string) {
  return api.post<Program>(`${programPath(id)}/pause`);
}

export function archiveProgram(id: string) {
  return api.post<Program>(`${programPath(id)}/archive`);
}

export function duplicateProgram(id: string) {
  return api.post<Program>(`${programPath(id)}/duplicate`);
}

/** 409 `PROGRAM_HAS_HISTORY` when workouts were logged from it: archive instead. */
export async function deleteProgram(id: string): Promise<void> {
  await api.delete<void>(programPath(id));
}

export function listProgramVersions(id: string, options: { signal?: AbortSignal } = {}) {
  return api.get<ProgramVersionSummary[]>(`${programPath(id)}/versions`, { signal: options.signal });
}

export function getProgramVersion(id: string, versionNumber: number, options: { signal?: AbortSignal } = {}) {
  return api.get<ProgramVersion>(`${programPath(id)}/versions/${versionNumber}`, { signal: options.signal });
}

/**
 * `{ toVersion }` restores that version as a new one; `{ changeLogId }` undoes
 * the latest change (409 `NOT_LATEST` otherwise: offer "Restore version N").
 */
export function revertProgram(id: string, currentVersion: number, input: RevertProgramInput) {
  return api.post<Program>(`${programPath(id)}/revert`, input, ifMatch(currentVersion));
}

export function listProgramChangeLog(
  id: string,
  params: { status?: ChangeStatus; limit?: number; cursor?: string } = {},
  options: { signal?: AbortSignal } = {},
) {
  const search = new URLSearchParams();
  if (params.status) search.set('status', params.status);
  if (params.limit !== undefined) search.set('limit', String(params.limit));
  if (params.cursor) search.set('cursor', params.cursor);
  const query = search.toString();
  return api.get<ChangeLogPage>(`${programPath(id)}/change-log${query ? `?${query}` : ''}`, { signal: options.signal });
}

/**
 * Clears a paused plan's automatic adjustments (`programs:write`), after the
 * owner confirmed they read the safety message. Idempotent; no version bump.
 */
export function resumeProgramAutonomy(id: string) {
  return api.post<Program>(`${programPath(id)}/autonomy/resume`);
}

/** Marks `upToId` and every older entry as seen. */
export function markProgramChangesSeen(id: string, upToId: string) {
  return api.post<{ updated: number }>(`${programPath(id)}/change-log/seen`, { upToId });
}

/**
 * What the active plan asks for on `date`, the client's local day
 * (`YYYY-MM-DD`, in the Health Profile time zone when set). `programs:read`.
 */
export function getTrainingToday(date: string, options: { signal?: AbortSignal } = {}) {
  return api.get<TrainingToday>(`/training/today?date=${encodeURIComponent(date)}`, { signal: options.signal });
}

/**
 * Starts a planned workout into the logger (`programs:read` + `workouts:write`).
 * Idempotent while that session is in progress (`existing: true`). 409
 * `WORKOUT_IN_PROGRESS` carries `details.workoutId` (offer Resume); 409
 * `PROGRAM_NOT_ACTIVE` means refetch Today.
 */
export function startProgramWorkout(programWorkoutId: string, input: StartProgramWorkoutInput) {
  return api.post<StartProgramWorkoutResult>(`/program-workouts/${encodeURIComponent(programWorkoutId)}/start`, input);
}

/**
 * Plan signals for a range (`programs:read`, works with AI off). 400 with
 * `SIGNALS_AS_OF_OUT_OF_RANGE` / `SIGNALS_RANGE_INVALID` (or a validation
 * error) for bad dates; 404 for a program that is not the caller's.
 */
export function getTrainingSignals(params: TrainingSignalsParams = {}, options: { signal?: AbortSignal } = {}) {
  const query = new URLSearchParams();
  for (const key of ['programId', 'from', 'to', 'asOf'] as const) {
    const value = params[key];
    if (value) query.set(key, value);
  }
  const search = query.toString();
  return api.get<PlanSignals>(`/training/signals${search ? `?${search}` : ''}`, { signal: options.signal });
}

/** The signals refusal a 400 carries, or null. */
export function signalsRefusalOf(error: unknown): SignalsRefusal | null {
  if (!(error instanceof ApiError)) return null;
  const reason = (error.details as { reason?: unknown } | undefined)?.reason;
  return typeof reason === 'string' && (Object.values(SIGNALS_REFUSALS) as string[]).includes(reason)
    ? (reason as SignalsRefusal)
    : null;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** The refusal reason of an API error, when it is one of this API's. */
export function programRefusalOf(error: unknown): ProgramRefusal | null {
  if (!(error instanceof ApiError)) return null;
  const reason = (error.details as { reason?: unknown } | undefined)?.reason;
  return typeof reason === 'string' && (Object.values(PROGRAM_REFUSALS) as string[]).includes(reason)
    ? (reason as ProgramRefusal)
    : null;
}

/** A target load for display in the user's unit, or null when the plan leaves it open. */
export function formatTargetLoad(kg: number | null | undefined, unit: WeightUnit): string | null {
  return kg === null || kg === undefined ? null : formatWeight(kg, unit);
}

/** The refusal reason of a Today or start error, when it is one of those. */
export function todayRefusalOf(error: unknown): TodayRefusal | null {
  if (!(error instanceof ApiError)) return null;
  const reason = (error.details as { reason?: unknown } | undefined)?.reason;
  return typeof reason === 'string' && (Object.values(TODAY_REFUSALS) as string[]).includes(reason)
    ? (reason as TodayRefusal)
    : null;
}
