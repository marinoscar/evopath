/**
 * Workout logging fixtures (E4.3): builders for the API views and a small
 * stateful MSW API that behaves like `apps/api/src/workouts` for the web
 * suites: one workout in progress at a time (`existing: true` otherwise),
 * owner-less but 404 for unknown ids, sets copied from the previous set on
 * create, totals over completed working sets, dense renumbering. Every
 * mutating request is recorded in `calls` with its body.
 */
import { http, HttpResponse } from 'msw';
import { server } from '../server';
import type { Exercise } from '../../../services/exercises';
import type {
  GymRef,
  ReadinessSnapshot,
  SetInput,
  SetLogView,
  Workout,
  WorkoutExerciseView,
  WorkoutListItem,
} from '../../../services/workouts';

const API = '*/api';
export const WORKOUT_NOW = '2026-09-29T12:00:00.000Z';
export const WORKOUT_TODAY = '2026-09-29';

let seq = 0;
const nextId = (prefix: string) => {
  seq += 1;
  return `00000000-0000-4000-8000-${prefix}${String(seq).padStart(11, '0')}`;
};

export function mockSet(overrides: Partial<SetLogView> = {}): SetLogView {
  return {
    id: nextId('c'),
    workoutExerciseId: 'we',
    setNumber: 1,
    weightKg: null,
    reps: null,
    durationSeconds: null,
    distanceMeters: null,
    rpe: null,
    rir: null,
    restSeconds: null,
    isWarmup: false,
    completed: false,
    completedAt: null,
    painFlag: false,
    painNote: null,
    notes: null,
    ...overrides,
  };
}

export function mockEntry(
  exercise: Pick<Exercise, 'id' | 'slug' | 'name' | 'trackingMode' | 'isBodyweight' | 'isUnilateral' | 'primaryMuscles' | 'isCustom' | 'status'>,
  overrides: Partial<WorkoutExerciseView> = {},
): WorkoutExerciseView {
  const id = overrides.id ?? nextId('d');
  return {
    id,
    workoutId: 'w',
    exerciseId: exercise.id,
    position: 0,
    equipmentTypeId: null,
    equipmentType: null,
    notes: null,
    exercise: {
      id: exercise.id,
      slug: exercise.slug,
      name: exercise.name,
      trackingMode: exercise.trackingMode,
      isBodyweight: exercise.isBodyweight,
      isUnilateral: exercise.isUnilateral,
      primaryMuscles: exercise.primaryMuscles,
      isCustom: exercise.isCustom,
      status: exercise.status,
    },
    sets: [],
    createdAt: WORKOUT_NOW,
    ...overrides,
  };
}

export function computeSummary(workout: Pick<Workout, 'exercises' | 'durationSeconds'>): Workout['summary'] {
  let setCount = 0;
  let volume = 0;
  for (const entry of workout.exercises) {
    for (const set of entry.sets) {
      if (!set.completed || set.isWarmup) continue;
      setCount += 1;
      if (set.weightKg !== null && set.reps !== null) volume += set.weightKg * set.reps;
    }
  }
  return {
    durationSeconds: workout.durationSeconds,
    exerciseCount: workout.exercises.length,
    setCount,
    volumeKg: Math.round(volume * 1000) / 1000,
  };
}

export function mockWorkout(overrides: Partial<Workout> = {}): Workout {
  const base: Workout = {
    id: nextId('e'),
    name: 'Workout',
    date: WORKOUT_TODAY,
    status: 'in_progress',
    startedAt: WORKOUT_NOW,
    endedAt: null,
    durationSeconds: null,
    gymId: null,
    gym: null,
    notes: null,
    programWorkoutId: null,
    readinessSnapshot: null,
    exercises: [],
    summary: { durationSeconds: null, exerciseCount: 0, setCount: 0, volumeKg: 0 },
    createdAt: WORKOUT_NOW,
    updatedAt: WORKOUT_NOW,
    ...overrides,
  };
  base.exercises = base.exercises.map((e, i) => ({
    ...e,
    workoutId: base.id,
    position: i,
    sets: e.sets.map((s, j) => ({ ...s, workoutExerciseId: e.id, setNumber: j + 1 })),
  }));
  base.gymId = base.gym?.id ?? base.gymId;
  return { ...base, summary: overrides.summary ?? computeSummary(base) };
}

export function toListItem(w: Workout): WorkoutListItem {
  const summary = computeSummary(w);
  return {
    id: w.id,
    name: w.name,
    date: w.date,
    status: w.status,
    startedAt: w.startedAt,
    endedAt: w.endedAt,
    durationSeconds: w.durationSeconds,
    gym: w.gym,
    exerciseCount: summary.exerciseCount,
    setCount: summary.setCount,
    volumeKg: summary.volumeKg,
    exercises: w.exercises.map((e) => ({ id: e.exercise.id, name: e.exercise.name })),
  };
}

export interface WorkoutsApiState {
  workouts: Workout[];
  calls: { method: string; path: string; body?: unknown }[];
}

export interface WorkoutsApiOptions {
  /** Exercises `POST /workouts/:id/exercises` can add. */
  exercises?: Exercise[];
  /** Gyms by id, for `gymId` in bodies. */
  gyms?: GymRef[];
  /** Applied when `POST /workouts` omits `gymId`. */
  defaultGymId?: string | null;
  readinessSnapshot?: ReadinessSnapshot | null;
}

const notFound = (what: string) =>
  HttpResponse.json({ statusCode: 404, message: `${what} not found`, error: 'Not Found' }, { status: 404 });

export function statefulWorkoutsApi(initial: Workout[] = [], options: WorkoutsApiOptions = {}): WorkoutsApiState {
  const state: WorkoutsApiState = { workouts: initial.map((w) => structuredClone(w)), calls: [] };
  const gyms = options.gyms ?? [];
  const exercises = options.exercises ?? [];

  const find = (id: unknown) => state.workouts.find((w) => w.id === id);
  const view = (w: Workout): Workout => {
    w.summary = computeSummary(w);
    return structuredClone(w);
  };
  const findSet = (w: Workout, setId: unknown) => {
    for (const entry of w.exercises) {
      const set = entry.sets.find((s) => s.id === setId);
      if (set) return { entry, set };
    }
    return null;
  };

  server.use(
    http.get(`${API}/workouts`, ({ request }) => {
      const url = new URL(request.url);
      const status = url.searchParams.get('status');
      const page = Number(url.searchParams.get('page') ?? 1);
      const pageSize = Number(url.searchParams.get('pageSize') ?? 20);
      const all = state.workouts
        .filter((w) => !status || w.status === status)
        .sort((a, b) => (a.date === b.date ? b.startedAt.localeCompare(a.startedAt) : b.date.localeCompare(a.date)));
      const items = all.slice((page - 1) * pageSize, page * pageSize).map(toListItem);
      return HttpResponse.json({
        data: { items, total: all.length, page, pageSize, totalPages: Math.ceil(all.length / pageSize) },
      });
    }),
    http.post(`${API}/workouts`, async ({ request }) => {
      const body = (await request.clone().json()) as { name?: string; gymId?: string };
      state.calls.push({ method: 'POST', path: '/workouts', body });
      const running = state.workouts.find((w) => w.status === 'in_progress');
      if (running) return HttpResponse.json({ data: { ...view(running), existing: true } });
      const gymId = body.gymId ?? options.defaultGymId ?? null;
      const gym = gyms.find((g) => g.id === gymId) ?? null;
      const created = mockWorkout({
        name: body.name ?? 'Workout',
        gymId: gym?.id ?? null,
        gym,
        readinessSnapshot: options.readinessSnapshot ?? null,
      });
      state.workouts.push(created);
      return HttpResponse.json({ data: { ...view(created), existing: false } }, { status: 201 });
    }),
    http.get(`${API}/workouts/:id`, ({ params }) => {
      const w = find(params.id);
      return w ? HttpResponse.json({ data: view(w) }) : notFound('Workout');
    }),
    http.patch(`${API}/workouts/:id`, async ({ params, request }) => {
      const body = (await request.clone().json()) as Record<string, unknown>;
      state.calls.push({ method: 'PATCH', path: `/workouts/${params.id}`, body });
      const w = find(params.id);
      if (!w) return notFound('Workout');
      if (typeof body.name === 'string') w.name = body.name;
      if (body.notes !== undefined) w.notes = body.notes as string | null;
      if (typeof body.date === 'string') w.date = body.date;
      if (body.gymId !== undefined) {
        const gym = gyms.find((g) => g.id === body.gymId) ?? null;
        w.gymId = gym?.id ?? null;
        w.gym = gym;
      }
      return HttpResponse.json({ data: view(w) });
    }),
    http.post(`${API}/workouts/:id/finish`, ({ params }) => {
      state.calls.push({ method: 'POST', path: `/workouts/${params.id}/finish` });
      const w = find(params.id);
      if (!w) return notFound('Workout');
      if (w.status !== 'completed') {
        w.status = 'completed';
        w.endedAt = '2026-09-29T13:05:00.000Z';
        w.durationSeconds = 3900;
      }
      return HttpResponse.json({ data: view(w) });
    }),
    http.delete(`${API}/workouts/:id`, ({ params }) => {
      state.calls.push({ method: 'DELETE', path: `/workouts/${params.id}` });
      const before = state.workouts.length;
      state.workouts = state.workouts.filter((w) => w.id !== params.id);
      return before === state.workouts.length ? notFound('Workout') : new HttpResponse(null, { status: 204 });
    }),
    http.post(`${API}/workouts/:id/exercises`, async ({ params, request }) => {
      const body = (await request.clone().json()) as { exerciseId: string };
      state.calls.push({ method: 'POST', path: `/workouts/${params.id}/exercises`, body });
      const w = find(params.id);
      const exercise = exercises.find((e) => e.id === body.exerciseId);
      if (!w || !exercise) return notFound(w ? 'Exercise' : 'Workout');
      const entry = mockEntry(exercise, { workoutId: w.id, position: w.exercises.length });
      w.exercises.push(entry);
      return HttpResponse.json({ data: structuredClone(entry) }, { status: 201 });
    }),
    http.patch(`${API}/workouts/:id/exercises/:weId`, async ({ params, request }) => {
      const body = (await request.clone().json()) as { position?: number; notes?: string | null };
      state.calls.push({ method: 'PATCH', path: `/workouts/${params.id}/exercises/${params.weId}`, body });
      const w = find(params.id);
      const entry = w?.exercises.find((e) => e.id === params.weId);
      if (!w || !entry) return notFound('Workout exercise');
      if (body.notes !== undefined) entry.notes = body.notes;
      if (body.position !== undefined) {
        w.exercises = w.exercises.filter((e) => e.id !== entry.id);
        w.exercises.splice(body.position, 0, entry);
        w.exercises.forEach((e, i) => (e.position = i));
      }
      return HttpResponse.json({ data: structuredClone(entry) });
    }),
    http.delete(`${API}/workouts/:id/exercises/:weId`, ({ params }) => {
      state.calls.push({ method: 'DELETE', path: `/workouts/${params.id}/exercises/${params.weId}` });
      const w = find(params.id);
      if (!w || !w.exercises.some((e) => e.id === params.weId)) return notFound('Workout exercise');
      w.exercises = w.exercises.filter((e) => e.id !== params.weId);
      w.exercises.forEach((e, i) => (e.position = i));
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(`${API}/workouts/:id/exercises/:weId/sets`, async ({ params, request }) => {
      const text = await request.clone().text();
      const body = (text ? JSON.parse(text) : {}) as SetInput;
      state.calls.push({ method: 'POST', path: `/workouts/${params.id}/exercises/${params.weId}/sets`, body });
      const w = find(params.id);
      const entry = w?.exercises.find((e) => e.id === params.weId);
      if (!w || !entry) return notFound('Workout exercise');
      const previous = entry.sets[entry.sets.length - 1];
      const copy = (key: 'weightKg' | 'reps' | 'durationSeconds' | 'distanceMeters') =>
        body[key] !== undefined ? (body[key] as number | null) : (previous?.[key] ?? null);
      const set = mockSet({
        workoutExerciseId: entry.id,
        setNumber: entry.sets.length + 1,
        weightKg: copy('weightKg'),
        reps: copy('reps'),
        durationSeconds: copy('durationSeconds'),
        distanceMeters: copy('distanceMeters'),
      });
      entry.sets.push(set);
      return HttpResponse.json({ data: structuredClone(set) }, { status: 201 });
    }),
    http.patch(`${API}/workouts/:id/sets/:setId`, async ({ params, request }) => {
      const body = (await request.clone().json()) as SetInput;
      state.calls.push({ method: 'PATCH', path: `/workouts/${params.id}/sets/${params.setId}`, body });
      const w = find(params.id);
      const found = w ? findSet(w, params.setId) : null;
      if (!found) return notFound('Set');
      const { set } = found;
      for (const [key, value] of Object.entries(body)) {
        if (key === 'completed') continue;
        (set as unknown as Record<string, unknown>)[key] = value;
      }
      if (body.completed === true && !set.completed) {
        set.completed = true;
        set.completedAt = WORKOUT_NOW;
      } else if (body.completed === false) {
        set.completed = false;
        set.completedAt = null;
      }
      return HttpResponse.json({ data: structuredClone(set) });
    }),
    http.delete(`${API}/workouts/:id/sets/:setId`, ({ params }) => {
      state.calls.push({ method: 'DELETE', path: `/workouts/${params.id}/sets/${params.setId}` });
      const w = find(params.id);
      const found = w ? findSet(w, params.setId) : null;
      if (!found) return notFound('Set');
      found.entry.sets = found.entry.sets.filter((s) => s.id !== params.setId);
      found.entry.sets.forEach((s, i) => (s.setNumber = i + 1));
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return state;
}
