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

/** One item of `GET /exercises`. */
export interface Exercise {
  id: string;
  slug: string;
  name: string;
  aliases: string[];
  primaryMuscles: string[];
  secondaryMuscles: string[];
  movementPattern: string;
  trackingMode: string;
  isUnilateral: boolean;
  isBodyweight: boolean;
  notes: string | null;
  /** True for the caller's own custom exercise; false for a library one. */
  custom: boolean;
  origin?: ExerciseOrigin;
  status?: ExerciseStatus;
  /** Present only when the list was asked with `gymId`. */
  available?: boolean;
  /** Human names of the first unsatisfied group's options (with `gymId`). */
  missing?: string[];
}

/** One option of a requirement group: a concrete equipment type or a capability. */
export interface ExerciseRequirementOption {
  kind: 'equipment_type' | 'capability';
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

/** `GET /exercises/:id`. */
export interface ExerciseDetail extends Exercise {
  requirements: ExerciseRequirementGroup[];
}

/** One requirement group of a create/update body (ids, OR within the group). */
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
  trackingMode: string;
  isUnilateral?: boolean;
  isBodyweight?: boolean;
  notes?: string | null;
  requirements?: ExerciseRequirementInput[];
}

export type ExerciseUpdate = Partial<ExerciseInput>;

export interface ExerciseQuery {
  q?: string;
  muscle?: string | null;
  pattern?: string | null;
  tracking?: string | null;
  /** `true` lists only the caller's custom exercises. */
  custom?: boolean;
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
  if (query.custom) params.set('custom', 'true');
  if (query.gymId) params.set('gymId', query.gymId);
  if (query.gymId && query.availableOnly) params.set('availableOnly', 'true');
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/** `GET /exercises` (`exercises:read`): the library plus the caller's custom exercises. */
export async function listExercises(query: ExerciseQuery = {}): Promise<Exercise[]> {
  const data = await api.get<Exercise[] | { items: Exercise[] }>(
    `/exercises${exerciseQueryString(query)}`
  );
  // Tolerate a paginated `{ items }` body as well as a bare array.
  return Array.isArray(data) ? data : (data?.items ?? []);
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
