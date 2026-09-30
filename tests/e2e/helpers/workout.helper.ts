import { expect } from '@playwright/test';
import type { AuthedApi } from './api.helper';

/**
 * Workout setup and assertions through the real API (E4.7).
 *
 * The specs drive the logger through the UI, then read the workout back here:
 * a passing DOM is not proof that anything was stored. Weights are kilograms
 * in the API, always (`lbToKg` is the web client's conversion: kilograms
 * rounded to the API's 0.001).
 */

export const KG_PER_LB = 0.45359237;

/** Pounds to the kilograms the API stores for them: 70 lb -> 31.751. */
export function lbToKg(lb: number): number {
  return Math.round(lb * KG_PER_LB * 1000) / 1000;
}

/** How far a stored kilogram value may sit from its expected value. */
export const KG_TOLERANCE = 0.001;

export interface SetBody {
  id: string;
  setNumber: number;
  weightKg: number | null;
  reps: number | null;
  durationSeconds: number | null;
  distanceMeters: number | null;
  isWarmup: boolean;
  completed: boolean;
  painFlag: boolean;
  prs: Array<{ type: string }>;
}

export interface WorkoutExerciseBody {
  id: string;
  exerciseId: string;
  position: number;
  exercise: { id: string; slug: string; name: string; isCustom: boolean; trackingMode: string };
  sets: SetBody[];
}

export interface WorkoutBody {
  id: string;
  name: string;
  status: 'in_progress' | 'completed';
  date: string;
  startedAt: string;
  gymId: string | null;
  exercises: WorkoutExerciseBody[];
  photos: Array<{ id: string; storageObjectId: string }>;
  summary: { setCount: number; exerciseCount: number; volumeKg: number; prs: Array<{ type: string }> };
}

export interface StartedWorkout extends WorkoutBody {
  existing: boolean;
}

export interface SeedSet {
  weightKg?: number | null;
  reps?: number | null;
  durationSeconds?: number | null;
  distanceMeters?: number | null;
  isWarmup?: boolean;
  completed?: boolean;
}

/** `GET /api/workouts/:id`. */
export function getWorkout(api: AuthedApi, workoutId: string): Promise<WorkoutBody> {
  return api.get<WorkoutBody>(`/api/workouts/${workoutId}`);
}

/** The API refuses with this status; `AuthedApi` throws with the status in its message. */
export async function expectStatus(request: () => Promise<unknown>, status: number): Promise<void> {
  const failure = await request().then(
    () => null,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );
  expect(failure, `expected the request to fail with ${status}`).not.toBeNull();
  expect(failure!.message).toContain(` failed: ${status} `);
}

/** `POST /api/workouts`: starts one, or answers the one already in progress with `existing: true`. */
export function startWorkout(
  api: AuthedApi,
  body: { name?: string; gymId?: string; startedAt?: string } = {},
): Promise<StartedWorkout> {
  return api.post<StartedWorkout>('/api/workouts', body);
}

/** The library or custom exercise with this slug. */
export async function exerciseIdBySlug(api: AuthedApi, slug: string): Promise<string> {
  const q = encodeURIComponent(slug.replace(/_/g, ' '));
  const exercises = await api.get<Array<{ id: string; slug: string }>>(`/api/exercises?q=${q}&limit=50`);
  const exercise = exercises.find((candidate) => candidate.slug === slug);
  if (!exercise) throw new Error(`No exercise with slug ${slug}; migrate and seed the stack first.`);
  return exercise.id;
}

/** Add a library exercise to a workout with `sets` (one empty row when none are given). */
export async function addExerciseWithSets(
  api: AuthedApi,
  workoutId: string,
  slug: string,
  sets: readonly SeedSet[] = [{}],
): Promise<WorkoutExerciseBody> {
  const exerciseId = await exerciseIdBySlug(api, slug);
  const entry = await api.post<WorkoutExerciseBody>(`/api/workouts/${workoutId}/exercises`, { exerciseId });
  for (const set of sets) {
    await api.post(`/api/workouts/${workoutId}/exercises/${entry.id}/sets`, set);
  }
  return entry;
}

/** `POST /api/workouts/:id/finish`. */
export function finishWorkout(api: AuthedApi, workoutId: string): Promise<WorkoutBody> {
  return api.post<WorkoutBody>(`/api/workouts/${workoutId}/finish`, {});
}

/**
 * Start, fill and finish a workout, all through the API. `hoursAgo` backdates
 * `startedAt`, so a workout logged next is unambiguously later (PRs and
 * "Last time" order by date, then start time: two workouts started in the same
 * minute would tie).
 */
export async function seedCompletedWorkout(
  api: AuthedApi,
  options: { gymId?: string; hoursAgo?: number; name?: string; slug: string; sets: readonly SeedSet[] },
): Promise<WorkoutBody> {
  const startedAt = new Date(Date.now() - (options.hoursAgo ?? 2) * 3_600_000).toISOString();
  const workout = await startWorkout(api, {
    ...(options.name ? { name: options.name } : {}),
    ...(options.gymId ? { gymId: options.gymId } : {}),
    startedAt,
  });
  await addExerciseWithSets(
    api,
    workout.id,
    options.slug,
    options.sets.map((set) => ({ completed: true, ...set })),
  );
  return finishWorkout(api, workout.id);
}

/** The kilogram values of an exercise's sets, in set order. */
export function weightsOf(entry: WorkoutExerciseBody): Array<number | null> {
  return entry.sets.map((set) => set.weightKg);
}
