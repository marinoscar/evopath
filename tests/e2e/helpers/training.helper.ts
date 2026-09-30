import { expect } from '@playwright/test';
import type { AuthedApi } from './api.helper';
import { createGymWithEquipment, type CreatedGym } from './gym.helper';
import { exerciseIdBySlug } from './workout.helper';

/**
 * Training setup through the real API and WITHOUT any AI, for the adaptation
 * specs (E6.4): a gym with dumbbells, an adjustable bench and a cable machine,
 * an active plan whose session today is a six-exercise "Upper A", and a
 * check-in for today. The plan is built the manual way (`POST /api/programs`,
 * `PUT /api/programs/:id/structure`, `POST /api/programs/:id/activate`), the
 * same path a user editing a plan takes.
 */

/** ISO weekday (1 Monday .. 7 Sunday) of a `YYYY-MM-DD` day. */
export function isoWeekdayOf(day: string): number {
  const [year, month, date] = day.split('-').map(Number);
  const jsDay = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
  return ((jsDay + 6) % 7) + 1;
}

/** Today in the user's profile time zone (UTC when unset): the day the server calls today. */
export async function serverToday(api: AuthedApi): Promise<string> {
  return (await api.get<{ date: string }>('/api/check-ins/today')).date;
}

/** The planned session (a library slug per exercise). Chest first: "sore chest" has something to trim. */
export const UPPER_A_SLUGS = [
  { slug: 'dumbbell_bench_press', priority: true, sets: 4, repMin: 6, repMax: 10, rpe: 8, rest: 120 },
  { slug: 'incline_dumbbell_press', priority: false, sets: 3, repMin: 8, repMax: 12, rpe: 8, rest: 90 },
  { slug: 'dumbbell_row', priority: true, sets: 4, repMin: 8, repMax: 12, rpe: 8, rest: 90 },
  { slug: 'dumbbell_shoulder_press', priority: false, sets: 3, repMin: 8, repMax: 12, rpe: 8, rest: 90 },
  { slug: 'dumbbell_lateral_raise', priority: false, sets: 3, repMin: 12, repMax: 15, rpe: 8, rest: 60 },
  // Needs the cable machine: "Only dumbbells" drops it for equipment.
  { slug: 'cable_curl', priority: false, sets: 3, repMin: 10, repMax: 15, rpe: 8, rest: 60 },
] as const;

export const PLANNED_WORKOUT_NAME = 'Upper A';
export const PLANNED_TOTAL_SETS = UPPER_A_SLUGS.reduce((sum, e) => sum + e.sets, 0);

export interface SeededTraining {
  gym: CreatedGym;
  programId: string;
  /** The day the server calls today. */
  today: string;
}

interface CreatedProgram {
  id: string;
  currentVersion: number;
}

/** A gym with dumbbells, an adjustable bench and a cable machine (no barbell, no treadmill). */
export function createTrainingGym(api: AuthedApi, name = 'Garage Gym'): Promise<CreatedGym> {
  return createGymWithEquipment(api, name, ['adjustable_dumbbells', 'adjustable_bench', 'cable_machine']);
}

/**
 * The gym, then an active four-week plan with `Upper A` on today's weekday in
 * every week (a planned workout only occurs on its own weekday), started today.
 */
export async function seedActivePlan(api: AuthedApi, gym: CreatedGym): Promise<SeededTraining> {
  const today = await serverToday(api);
  const weekday = isoWeekdayOf(today);
  const exerciseIds = new Map<string, string>();
  for (const { slug } of UPPER_A_SLUGS) exerciseIds.set(slug, await exerciseIdBySlug(api, slug));

  const program = await api.post<CreatedProgram>('/api/programs', { name: 'Dumbbell base', goal: 'general' });
  await api.patch(`/api/programs/${program.id}`, { gymId: gym.id });

  const workout = (position: number) => ({
    position,
    weekday,
    name: PLANNED_WORKOUT_NAME,
    estimatedMinutes: 60,
    exercises: UPPER_A_SLUGS.map((e, index) => ({
      exerciseId: exerciseIds.get(e.slug)!,
      position: index,
      isPriority: e.priority,
      targetSets: e.sets,
      repMin: e.repMin,
      repMax: e.repMax,
      targetRpe: e.rpe,
      restSeconds: e.rest,
      loadGuidance: 'choose_start',
    })),
  });
  const tree = {
    blocks: [
      {
        position: 0,
        name: 'Base',
        weeks: [1, 2, 3, 4].map((weekNumber) => ({ weekNumber, isDeload: false, workouts: [workout(0)] })),
      },
    ],
  };
  const created = await api.get<{ currentVersion: number }>(`/api/programs/${program.id}`);
  await api.request('PUT', `/api/programs/${program.id}/structure`, tree, { 'If-Match': String(created.currentVersion) });
  await api.post(`/api/programs/${program.id}/activate`, { startDate: today });
  return { gym, programId: program.id, today };
}

/** Gym plus plan: everything an adaptation of today's planned workout needs, with no AI. */
export async function seedTraining(api: AuthedApi, gymName = 'Garage Gym'): Promise<SeededTraining> {
  const gym = await createTrainingGym(api, gymName);
  return seedActivePlan(api, gym);
}

/** Today's check-in (`PUT /api/check-ins/:date`). The note is deliberately free text: it must never reach a model. */
export async function seedCheckIn(
  api: AuthedApi,
  today: string,
  scores: { energy?: number; sleepQuality?: number; soreness?: number; stress?: number; note?: string } = {},
): Promise<void> {
  await api.put(`/api/check-ins/${today}`, { energy: 3, sleepQuality: 3, soreness: 2, stress: 2, ...scores });
}

interface ProgramView {
  currentVersion: number;
}

export async function programVersion(api: AuthedApi, programId: string): Promise<number> {
  return (await api.get<ProgramView>(`/api/programs/${programId}`)).currentVersion;
}

export interface ChangeLogEntryView {
  id: string;
  kind: string;
  actor: string;
  status: string;
  fromVersion: number | null;
  toVersion: number | null;
}

/** The plan's applied change-log entries of kind `adapted`, newest first. */
export async function adaptedEntries(api: AuthedApi, programId: string): Promise<ChangeLogEntryView[]> {
  const page = await api.get<{ items: ChangeLogEntryView[] }>(`/api/programs/${programId}/change-log`);
  return page.items.filter((entry) => entry.kind === 'adapted');
}

export interface AdaptationRequestBody {
  minutes?: number;
  soreness?: { muscles: string[]; level: 'mild' | 'moderate' };
  lowEnergy?: boolean;
  equipment?: { mode: 'gym' } | { mode: 'only'; equipmentTypeIds: string[] } | { mode: 'bodyweight' };
  gymId?: string;
  freeText?: string;
  useReadiness?: boolean;
  baseWorkout?: 'planned' | 'none';
}

export interface AdaptationViewBody {
  id: string;
  status: string;
  runId: string | null;
  jobId: string | null;
  stage: string | null;
  errorCode: string | null;
  appliedAs: string | null;
  appliedWorkoutId: string | null;
  proposal: { exercises: Array<{ exerciseKey: string; name: string; sets: number }>; estimatedMinutes: number } | null;
  guardrailReport: {
    repairs: Array<{ code: string }>;
    rejected: Array<{ code: string }>;
    estimatedMinutes: number;
    fitsRequest: boolean;
    warnings: string[];
  } | null;
  criticReport: { verdict: string | null; rounds: number; skipped?: string } | null;
}

/** `POST /api/ai/training/adaptations` (the same call the sheet makes); returns the new adaptation id. */
export async function startAdaptationViaApi(api: AuthedApi, request: AdaptationRequestBody): Promise<string> {
  const started = await api.post<{ adaptationId: string }>('/api/ai/training/adaptations', { useReadiness: true, baseWorkout: 'planned', ...request });
  return started.adaptationId;
}

/** Wait for an adaptation to leave `queued` and `running`, and return it. */
export async function settledAdaptation(api: AuthedApi, adaptationId: string, timeout = 120_000): Promise<AdaptationViewBody> {
  let view: AdaptationViewBody | undefined;
  await expect
    .poll(
      async () => {
        view = await api.get<AdaptationViewBody>(`/api/ai/training/adaptations/${adaptationId}`);
        return view.status;
      },
      { message: 'the adaptation never settled', timeout, intervals: [1_000, 2_000] },
    )
    .not.toMatch(/^(queued|running)$/);
  return view!;
}
