/**
 * The workouts API (`/api/workouts`), as the web app sees it. E4.2.
 *
 * Every route is owner-scoped on the server (`workouts:read` /
 * `workouts:write`); another user's workout, workout exercise or set answers
 * `404`. `services/api.ts` stays the transport (bearer token, refresh, the
 * `{ data }` envelope); this module holds the calls next to the types they
 * produce.
 *
 * UNITS: the API speaks kilograms (`weightKg`, `volumeKg`) and metres
 * (`distanceMeters`) only, in and out. The browser converts for display with
 * `utils/units.ts`, from the Health Profile `unitSystem`; it never sends a
 * pound value.
 *
 * The bounds below mirror the API's Zod schemas
 * (`apps/api/src/workouts/workouts.constants.ts`) so a form can explain a
 * problem before the round trip; the API decides.
 */

import { api, ApiError } from './api';
import type { ExerciseStatus, TrackingMode } from './exercises';

// -----------------------------------------------------------------------------
// Vocabulary and bounds (mirrors apps/api/src/workouts/workouts.constants.ts)
// -----------------------------------------------------------------------------

export const WORKOUT_STATUSES = ['in_progress', 'completed'] as const;
export type WorkoutStatus = (typeof WORKOUT_STATUSES)[number];

export const WORKOUT_NAME_MAX = 80;
export const WORKOUT_NOTES_MAX = 1000;
export const SET_NOTES_MAX = 1000;
export const SET_PAIN_NOTE_MAX = 500;
export const MAX_EXERCISES_PER_WORKOUT = 30;
export const MAX_SETS_PER_EXERCISE = 40;
export const WORKOUT_LIST_PAGE_SIZE_DEFAULT = 20;
export const WORKOUT_LIST_PAGE_SIZE_MAX = 50;

/** Set field bounds, in the API's units (kilograms, metres, seconds). */
export const SET_BOUNDS = {
  weightKg: { min: 0, max: 1000, decimals: 3 },
  reps: { min: 0, max: 1000 },
  durationSeconds: { min: 0, max: 86_400 },
  distanceMeters: { min: 0, max: 1_000_000, decimals: 2 },
  rpe: { min: 1, max: 10, step: 0.5 },
  rir: { min: 0, max: 10 },
  restSeconds: { min: 0, max: 7200 },
} as const;

/** `details.reason` values the workouts API answers with. */
export const WORKOUT_REFUSALS = {
  WORKOUT_DATE_OUT_OF_RANGE: 'WORKOUT_DATE_OUT_OF_RANGE',
  TIME_IN_FUTURE: 'TIME_IN_FUTURE',
  ENDED_BEFORE_STARTED: 'ENDED_BEFORE_STARTED',
  WORKOUT_NOT_COMPLETED: 'WORKOUT_NOT_COMPLETED',
  WORKOUT_EXERCISE_LIMIT: 'WORKOUT_EXERCISE_LIMIT',
  WORKOUT_SET_LIMIT: 'WORKOUT_SET_LIMIT',
  EXERCISE_PENDING_REVIEW: 'EXERCISE_PENDING_REVIEW',
} as const;
export type WorkoutRefusal = (typeof WORKOUT_REFUSALS)[keyof typeof WORKOUT_REFUSALS];

// -----------------------------------------------------------------------------
// Types (the API's views)
// -----------------------------------------------------------------------------

/** One set (the API's `SetLogView`). Weight in kilograms, distance in metres. */
export interface SetLogView {
  id: string;
  workoutExerciseId: string;
  /** 1-based, dense within the exercise. */
  setNumber: number;
  weightKg: number | null;
  reps: number | null;
  durationSeconds: number | null;
  distanceMeters: number | null;
  /** 1..10 in steps of 0.5. */
  rpe: number | null;
  /** 0..10. */
  rir: number | null;
  restSeconds: number | null;
  isWarmup: boolean;
  completed: boolean;
  completedAt: string | null;
  painFlag: boolean;
  painNote: string | null;
  notes: string | null;
}

/** The exercise a workout entry refers to. */
export interface WorkoutExerciseRef {
  id: string;
  slug: string;
  name: string;
  trackingMode: TrackingMode;
  isBodyweight: boolean;
  isUnilateral: boolean;
  primaryMuscles: string[];
  isCustom: boolean;
  status: ExerciseStatus;
}

export interface EquipmentTypeRef {
  id: string;
  slug: string;
  name: string;
}

/** One exercise entry of a workout (the API's `WorkoutExerciseView`). */
export interface WorkoutExerciseView {
  /** The entry id (`weId` in routes), not the exercise id. */
  id: string;
  workoutId: string;
  exerciseId: string;
  /** 0-based, dense within the workout. */
  position: number;
  equipmentTypeId: string | null;
  equipmentType: EquipmentTypeRef | null;
  notes: string | null;
  exercise: WorkoutExerciseRef;
  /** In `setNumber` order. */
  sets: SetLogView[];
  createdAt: string;
}

/** A copy of the day's readiness check-in taken at start; informational. */
export interface ReadinessSnapshot {
  date: string;
  energy: number | null;
  sleepQuality: number | null;
  soreness: number | null;
  stress: number | null;
  note: string | null;
  updatedAt: string;
}

export interface GymRef {
  id: string;
  name: string;
}

/** Totals over completed working (non-warm-up) sets. */
export interface WorkoutTotals {
  durationSeconds: number | null;
  exerciseCount: number;
  setCount: number;
  /** Sum of weightKg x reps, kilograms. */
  volumeKg: number;
}

/** A full workout (the API's `WorkoutView`). */
export interface Workout {
  id: string;
  name: string;
  /** The user's local calendar day, `YYYY-MM-DD`. */
  date: string;
  status: WorkoutStatus;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  gymId: string | null;
  gym: GymRef | null;
  notes: string | null;
  /** Reserved for programs; always null for now. */
  programWorkoutId: string | null;
  readinessSnapshot: ReadinessSnapshot | null;
  /** In `position` order. */
  exercises: WorkoutExerciseView[];
  summary: WorkoutTotals;
  createdAt: string;
  updatedAt: string;
}

/** `POST /workouts`: `existing` is true (HTTP 200) when a workout was already in progress. */
export interface StartWorkoutResult extends Workout {
  existing: boolean;
}

/** One row of `GET /workouts`. */
export interface WorkoutListItem {
  id: string;
  name: string;
  date: string;
  status: WorkoutStatus;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  gym: GymRef | null;
  exerciseCount: number;
  /** Completed working (non-warm-up) sets. */
  setCount: number;
  /** Kilograms. */
  volumeKg: number;
  /** In `position` order; exercise ids, not entry ids. */
  exercises: Array<{ id: string; name: string }>;
}

/** `GET /workouts` answers with the flat pagination shape (docs/API.md). */
export interface WorkoutPage {
  items: WorkoutListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// -----------------------------------------------------------------------------
// Inputs
// -----------------------------------------------------------------------------

/** `POST /workouts` body; every field optional. */
export interface StartWorkoutInput {
  name?: string;
  /** `YYYY-MM-DD`, the user's local day; the API defaults it from the Health Profile time zone. */
  date?: string;
  /** Default: the caller's default gym. */
  gymId?: string;
  /** ISO instant; default now. */
  startedAt?: string;
}

export interface ListWorkoutsParams {
  page?: number;
  pageSize?: number;
  status?: WorkoutStatus;
  gymId?: string;
  /** `YYYY-MM-DD`, inclusive. */
  from?: string;
  /** `YYYY-MM-DD`, inclusive. */
  to?: string;
  exerciseId?: string;
}

/** `PATCH /workouts/:id`: at least one field. */
export interface UpdateWorkoutInput {
  name?: string;
  notes?: string | null;
  /** Null clears the gym. */
  gymId?: string | null;
  date?: string;
  startedAt?: string;
  /** Completed workouts only. */
  endedAt?: string;
  /** Completed workouts only. */
  durationSeconds?: number;
}

export interface FinishWorkoutInput {
  notes?: string | null;
  endedAt?: string;
}

export interface AddWorkoutExerciseInput {
  exerciseId: string;
  /** 0-based; inserts and shifts. Default: appended. */
  position?: number;
  equipmentTypeId?: string | null;
  notes?: string | null;
}

/** `PATCH /workouts/:id/exercises/:weId`: at least one field. */
export interface UpdateWorkoutExerciseInput {
  position?: number;
  notes?: string | null;
  equipmentTypeId?: string | null;
}

/**
 * A set body, kilograms and metres. On create, an omitted `weightKg`, `reps`,
 * `durationSeconds` or `distanceMeters` is copied from the exercise's previous
 * set; send `null` to leave it empty.
 */
export interface SetInput {
  weightKg?: number | null;
  reps?: number | null;
  durationSeconds?: number | null;
  distanceMeters?: number | null;
  rpe?: number | null;
  rir?: number | null;
  restSeconds?: number | null;
  isWarmup?: boolean;
  completed?: boolean;
  painFlag?: boolean;
  painNote?: string | null;
  notes?: string | null;
}

// -----------------------------------------------------------------------------
// Calls
// -----------------------------------------------------------------------------

const seg = encodeURIComponent;
const workoutPath = (id: string) => `/workouts/${seg(id)}`;
const entryPath = (id: string, weId: string) => `${workoutPath(id)}/exercises/${seg(weId)}`;
const setPath = (id: string, setId: string) => `${workoutPath(id)}/sets/${seg(setId)}`;

/** Build the `GET /workouts` query string (empty values are left out). */
export function workoutsQueryString(params: ListWorkoutsParams = {}): string {
  const search = new URLSearchParams();
  if (params.page !== undefined) search.set('page', String(params.page));
  if (params.pageSize !== undefined) search.set('pageSize', String(params.pageSize));
  if (params.status) search.set('status', params.status);
  if (params.gymId) search.set('gymId', params.gymId);
  if (params.from) search.set('from', params.from);
  if (params.to) search.set('to', params.to);
  if (params.exerciseId) search.set('exerciseId', params.exerciseId);
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

/**
 * `POST /workouts` (`workouts:write`). When a workout is already in progress
 * nothing is created and that one comes back with `existing: true`.
 */
export function startWorkout(input: StartWorkoutInput = {}): Promise<StartWorkoutResult> {
  return api.post<StartWorkoutResult>('/workouts', input);
}

/** `GET /workouts` (`workouts:read`): newest `date` first. */
export function listWorkouts(
  params: ListWorkoutsParams = {},
  options: { signal?: AbortSignal } = {},
): Promise<WorkoutPage> {
  return api.get<WorkoutPage>(`/workouts${workoutsQueryString(params)}`, { signal: options.signal });
}

/** `GET /workouts/:id` (`workouts:read`): exercises and sets in order. */
export function getWorkout(id: string, options: { signal?: AbortSignal } = {}): Promise<Workout> {
  return api.get<Workout>(workoutPath(id), { signal: options.signal });
}

/** `PATCH /workouts/:id` (`workouts:write`). */
export function updateWorkout(id: string, input: UpdateWorkoutInput): Promise<Workout> {
  return api.patch<Workout>(workoutPath(id), input);
}

/** `POST /workouts/:id/finish` (`workouts:write`); idempotent. `summary` carries the totals. */
export function finishWorkout(id: string, input: FinishWorkoutInput = {}): Promise<Workout> {
  return api.post<Workout>(`${workoutPath(id)}/finish`, input);
}

/** `DELETE /workouts/:id` (`workouts:write`): the workout with its exercises and sets. */
export async function deleteWorkout(id: string): Promise<void> {
  await api.delete<void>(workoutPath(id));
}

/** `POST /workouts/:id/exercises` (`workouts:write`). */
export function addWorkoutExercise(id: string, input: AddWorkoutExerciseInput): Promise<WorkoutExerciseView> {
  return api.post<WorkoutExerciseView>(`${workoutPath(id)}/exercises`, input);
}

/** `PATCH /workouts/:id/exercises/:weId` (`workouts:write`); reload the workout to see a new order. */
export function updateWorkoutExercise(
  id: string,
  weId: string,
  input: UpdateWorkoutExerciseInput,
): Promise<WorkoutExerciseView> {
  return api.patch<WorkoutExerciseView>(entryPath(id, weId), input);
}

/** `DELETE /workouts/:id/exercises/:weId` (`workouts:write`); positions are renumbered. */
export async function removeWorkoutExercise(id: string, weId: string): Promise<void> {
  await api.delete<void>(entryPath(id, weId));
}

/** `POST /workouts/:id/exercises/:weId/sets` (`workouts:write`); an empty body copies the previous set. */
export function addSet(id: string, weId: string, input: SetInput = {}): Promise<SetLogView> {
  return api.post<SetLogView>(`${entryPath(id, weId)}/sets`, input);
}

/** `PATCH /workouts/:id/sets/:setId` (`workouts:write`). */
export function updateSet(id: string, setId: string, input: SetInput): Promise<SetLogView> {
  return api.patch<SetLogView>(setPath(id, setId), input);
}

/** `DELETE /workouts/:id/sets/:setId` (`workouts:write`); set numbers are renumbered. */
export async function deleteSet(id: string, setId: string): Promise<void> {
  await api.delete<void>(setPath(id, setId));
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/** The API's `details.reason`, when the error carries one. */
export function workoutRefusalReason(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const details = err.details;
  if (details && typeof details === 'object' && 'reason' in details) {
    const reason = (details as { reason: unknown }).reason;
    return typeof reason === 'string' ? reason : null;
  }
  return null;
}

export function workoutErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError || err instanceof Error) return err.message || fallback;
  return fallback;
}

export function isWorkoutNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

export const WORKOUTS_UNAVAILABLE = 'Workout logging is not available for your account.';
