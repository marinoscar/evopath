/**
 * The exercise library API (`/api/exercises`), as the web app sees it. E4.1.
 *
 * The library (seeded, read-only) and the caller's own custom exercises come
 * back from one list. Reads need `exercises:read`; creating, editing,
 * deleting and approving a custom exercise need `exercises:write`, and the API
 * refuses a library exercise (`403 LIBRARY_EXERCISE_READ_ONLY`) or another
 * user's (`404`) whatever the browser offers.
 *
 * With `gymId` the API marks each item `available` and names what is
 * `missing` (the first unsatisfied requirement group); the browser only shows
 * that answer, it never computes availability itself.
 *
 * The vocabularies and bounds below mirror the API's Zod schemas so a form can
 * explain a problem before the round trip; the API decides.
 */

import { api, ApiError } from './api';

// -----------------------------------------------------------------------------
// Vocabulary and bounds (mirrors apps/api/src/common/constants/training.constants.ts)
// -----------------------------------------------------------------------------

export const MUSCLES = [
  'chest',
  'upper_back',
  'lats',
  'traps',
  'shoulders',
  'rear_delts',
  'biceps',
  'triceps',
  'forearms',
  'abs',
  'obliques',
  'lower_back',
  'glutes',
  'quads',
  'hamstrings',
  'calves',
  'hip_flexors',
  'adductors',
  'abductors',
  'full_body',
] as const;
export type Muscle = (typeof MUSCLES)[number];

export const MOVEMENT_PATTERNS = [
  'squat',
  'hinge',
  'horizontal_push',
  'vertical_push',
  'horizontal_pull',
  'vertical_pull',
  'lunge',
  'carry',
  'core',
  'isolation',
  'cardio',
] as const;
export type MovementPattern = (typeof MOVEMENT_PATTERNS)[number];

export const TRACKING_MODES = ['weight_reps', 'bodyweight_reps', 'time', 'distance_time'] as const;
export type TrackingMode = (typeof TRACKING_MODES)[number];

export const TRACKING_MODE_LABEL: Record<TrackingMode, string> = {
  weight_reps: 'Weight and reps',
  bodyweight_reps: 'Bodyweight reps',
  time: 'Time',
  distance_time: 'Distance and time',
};

export const EXERCISE_NAME_MAX = 80;
export const EXERCISE_NOTES_MAX = 1000;
export const PRIMARY_MUSCLES_MIN = 1;
export const PRIMARY_MUSCLES_MAX = 4;
export const SECONDARY_MUSCLES_MAX = 6;
export const REQUIREMENT_GROUPS_MAX = 4;
export const REQUIREMENT_OPTIONS_MAX = 6;
export const EXERCISES_LIMIT_MAX = 200;
/** Longest `q` the list accepts. */
export const EXERCISE_QUERY_MAX = 80;

/** `upper_back` -> `Upper back`; works for any vocabulary string. */
export function humanize(value: string): string {
  const text = value.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const muscleLabel = humanize;
export const patternLabel = humanize;

export function trackingLabel(mode: string): string {
  return (TRACKING_MODE_LABEL as Record<string, string>)[mode] ?? humanize(mode);
}

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type ExerciseOrigin = 'seed' | 'user' | 'ai';
export type ExerciseStatus = 'active' | 'pending_review';

/** One option of a requirement group: a concrete equipment type or a capability. */
export interface ExerciseRequirementOption {
  kind: 'equipment' | 'capability';
  /** The equipment type id or the capability id. */
  id: string;
  slug: string;
  name: string;
}

/**
 * A requirement group: satisfied when the gym has ANY of its options. An
 * exercise needs EVERY group; no groups means it needs nothing.
 */
export interface ExerciseRequirementGroup {
  groupIndex: number;
  options: ExerciseRequirementOption[];
}

/**
 * One exercise, as `GET /exercises`, `GET /exercises/:id` and the mutations
 * return it (the API's `ExerciseView`). Requirement groups are always
 * expanded.
 */
export interface Exercise {
  id: string;
  /** Permanent; `custom-<8 chars>` for a custom exercise. */
  slug: string;
  name: string;
  /** True for the caller's own exercise; false for a library one. */
  isCustom: boolean;
  origin: ExerciseOrigin;
  /** `pending_review`: an AI proposal awaiting the caller's approval. */
  status: ExerciseStatus;
  /** The AI run that proposed it; null otherwise. */
  proposedByRunId: string | null;
  primaryMuscles: string[];
  secondaryMuscles: string[];
  movementPattern: string;
  trackingMode: TrackingMode;
  isUnilateral: boolean;
  isBodyweight: boolean;
  aliases: string[];
  notes: string | null;
  /** Every group must be satisfied; empty means it needs no equipment. */
  requirements: ExerciseRequirementGroup[];
  /** Only with `gymId`: whether that gym satisfies every requirement group. */
  available?: boolean;
  /** Only with `gymId`: names of the first unsatisfied group's options (empty when available). */
  missing?: string[];
  createdAt: string;
  updatedAt: string;
}

/** Kept as a name for the single-exercise read; the list items carry the same fields. */
export type ExerciseDetail = Exercise;

/**
 * One requirement group of a create/update body: any listed equipment type OR
 * capability satisfies it; 1 to {@link REQUIREMENT_OPTIONS_MAX} ids in total.
 */
export interface ExerciseRequirementInput {
  equipmentTypeIds?: string[];
  capabilityIds?: string[];
}

/** `POST /exercises` body. */
export interface ExerciseInput {
  name: string;
  primaryMuscles: string[];
  secondaryMuscles?: string[];
  movementPattern: string;
  /** Defaults to `weight_reps` on the API. */
  trackingMode?: TrackingMode;
  isUnilateral?: boolean;
  isBodyweight?: boolean;
  /** Blank or null stores no notes. */
  notes?: string | null;
  /** Up to {@link REQUIREMENT_GROUPS_MAX} groups (AND); empty or omitted needs nothing. */
  requirements?: ExerciseRequirementInput[];
}

/** `PATCH` body: at least one field; `requirements` replaces every group when given. */
export type ExerciseUpdate = Partial<ExerciseInput>;

export interface ExerciseQuery {
  q?: string;
  muscle?: string | null;
  pattern?: string | null;
  tracking?: string | null;
  /** `true`: only the caller's custom exercises; `false`: only the library; omitted: both. */
  custom?: boolean;
  /** `true` also lists the caller's AI-proposed exercises awaiting approval. */
  includePending?: boolean;
  gymId?: string | null;
  /** Needs `gymId`; the API answers 400 without it. */
  availableOnly?: boolean;
  limit?: number;
}

// -----------------------------------------------------------------------------
// Calls
// -----------------------------------------------------------------------------

const exercisePath = (id: string) => `/exercises/${encodeURIComponent(id)}`;

/** Build the `GET /exercises` query string (empty values are left out). */
export function exerciseQueryString(query: ExerciseQuery = {}): string {
  const params = new URLSearchParams();
  const q = query.q?.trim();
  if (q) params.set('q', q);
  if (query.muscle) params.set('muscle', query.muscle);
  if (query.pattern) params.set('pattern', query.pattern);
  if (query.tracking) params.set('tracking', query.tracking);
  if (query.custom !== undefined) params.set('custom', String(query.custom));
  if (query.includePending) params.set('includePending', 'true');
  if (query.gymId) params.set('gymId', query.gymId);
  if (query.gymId && query.availableOnly) params.set('availableOnly', 'true');
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/** `GET /exercises` (`exercises:read`): the library plus the caller's custom exercises. */
export function listExercises(query: ExerciseQuery = {}): Promise<Exercise[]> {
  return api.get<Exercise[]>(`/exercises${exerciseQueryString(query)}`);
}

/** `GET /exercises/:id` (`exercises:read`), requirement groups expanded. */
export function getExercise(id: string): Promise<ExerciseDetail> {
  return api.get<ExerciseDetail>(exercisePath(id));
}

/** `POST /exercises` (`exercises:write`): a custom exercise owned by the caller. */
export function createExercise(input: ExerciseInput): Promise<ExerciseDetail> {
  return api.post<ExerciseDetail>('/exercises', input);
}

/** `PATCH /exercises/:id` (`exercises:write`): own custom exercises only. */
export function updateExercise(id: string, input: ExerciseUpdate): Promise<ExerciseDetail> {
  return api.patch<ExerciseDetail>(exercisePath(id), input);
}

/** `DELETE /exercises/:id` (`exercises:write`); `409 EXERCISE_IN_USE` while a workout uses it. */
export async function deleteExercise(id: string): Promise<void> {
  await api.delete<void>(exercisePath(id));
}

/** `POST /exercises/:id/approve` (`exercises:write`): accept an AI-proposed draft. */
export function approveExercise(id: string): Promise<ExerciseDetail> {
  return api.post<ExerciseDetail>(`${exercisePath(id)}/approve`);
}

// -----------------------------------------------------------------------------
// History: "Last time" and records (E4.4)
// -----------------------------------------------------------------------------
//
// Kilograms and metres, as everywhere in the workouts API; the browser only
// converts for display. The API computes every record (the formulas live in
// `apps/api/src/workouts/workout-records.ts`); nothing here recomputes one.

/** Mirrors `EXERCISE_HISTORY_LIMIT_*` in `apps/api/src/workouts/workouts.constants.ts`. */
export const EXERCISE_HISTORY_LIMIT_DEFAULT = 3;
export const EXERCISE_HISTORY_LIMIT_MAX = 10;

/** One completed set of the "last time" workout. */
export interface LastTimeSet {
  setNumber: number;
  weightKg: number | null;
  reps: number | null;
  durationSeconds: number | null;
  distanceMeters: number | null;
  rpe: number | null;
  isWarmup: boolean;
}

/** The most recent earlier completed workout with this exercise. */
export interface ExerciseLastTime {
  workoutId: string;
  /** `YYYY-MM-DD`, a calendar day. */
  date: string;
  gym: { id: string; name: string } | null;
  /** In position then `setNumber` order; warm-ups flagged. */
  sets: LastTimeSet[];
}

export interface ExerciseRecentWorkout {
  workoutId: string;
  date: string;
  topSet: { weightKg: number; reps: number } | null;
  e1rmKg: number | null;
}

export interface ExerciseRecords {
  maxWeightKg: { value: number; reps: number; date: string } | null;
  maxReps: { value: number; weightKg: number; date: string } | null;
  bestE1rmKg: { value: number; weightKg: number; reps: number; date: string } | null;
}

/** `GET /exercises/:id/history`. */
export interface ExerciseHistory {
  exerciseId: string;
  /** Null the first time the exercise is logged. */
  lastTime: ExerciseLastTime | null;
  /** Newest first. */
  recent: ExerciseRecentWorkout[];
  records: ExerciseRecords;
}

export interface ExerciseHistoryParams {
  /** History in the context of this workout: it is excluded, and only earlier completed workouts count. */
  workoutId?: string;
  /** `YYYY-MM-DD`; ignored by the API with `workoutId`. */
  beforeDate?: string;
  /** Prefer this gym for `lastTime`. */
  gymId?: string;
  /** 1..10 recent workouts; default 3. */
  limit?: number;
}

export function exerciseHistoryQueryString(params: ExerciseHistoryParams = {}): string {
  const search = new URLSearchParams();
  if (params.beforeDate) search.set('beforeDate', params.beforeDate);
  if (params.workoutId) search.set('workoutId', params.workoutId);
  if (params.gymId) search.set('gymId', params.gymId);
  if (params.limit !== undefined) search.set('limit', String(params.limit));
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

/** `GET /exercises/:id/history` (`workouts:read`): owner-scoped; `404` for an unknown or foreign exercise. */
export function getExerciseHistory(
  id: string,
  params: ExerciseHistoryParams = {},
  options: { signal?: AbortSignal } = {},
): Promise<ExerciseHistory> {
  return api.get<ExerciseHistory>(`${exercisePath(id)}/history${exerciseHistoryQueryString(params)}`, {
    signal: options.signal,
  });
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export function exerciseErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError || err instanceof Error) return err.message || fallback;
  return fallback;
}

export function isExerciseForbidden(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403;
}

export const EXERCISES_UNAVAILABLE = 'The exercise library is not available for your account.';
