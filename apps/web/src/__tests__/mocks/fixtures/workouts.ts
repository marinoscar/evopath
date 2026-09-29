/**
 * Workout logging fixtures (E4.3): builders for the API views and a small
 * stateful MSW API that behaves like `apps/api/src/workouts` for the web
 * suites: one workout in progress at a time (`existing: true` otherwise),
 * owner-less but 404 for unknown ids, sets copied from the previous set on
 * create, totals over completed working sets, dense renumbering. Every
 * mutating request is recorded in `calls` with its body.
 *
 * E4.4: every set carries `prs` and `summary.prs`, and
 * `GET /exercises/:id/history` answers from the same state, with a compact
 * port of `apps/api/src/workouts/workout-records.ts` (a test double only;
 * the API is the single home of the rules).
 */
import { http, HttpResponse } from 'msw';
import { server } from '../server';
import type { Exercise, ExerciseHistory, LastTimeSet } from '../../../services/exercises';
import type {
  GymRef,
  PrType,
  ReadinessSnapshot,
  SetPr,
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
    prs: [],
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
    prs: summaryPrs(workout.exercises),
  };
}

// -----------------------------------------------------------------------------
// Records (E4.4): a compact port of the API's rules, for the test double
// -----------------------------------------------------------------------------

interface Working {
  weightKg: number;
  reps: number;
}

const PR_ORDER: PrType[] = ['first_time', 'weight', 'reps', 'e1rm'];
const round1 = (v: number) => Math.round(v * 10 + 1e-9) / 10;

export function fixtureE1rm(weightKg: number, reps: number): number | null {
  if (!(weightKg > 0) || reps < 1 || reps > 12) return null;
  return round1(reps === 1 ? weightKg : weightKg * (1 + reps / 30));
}

function working(set: SetLogView, mode: string): Working | null {
  if (mode !== 'weight_reps' && mode !== 'bodyweight_reps') return null;
  if (!set.completed || set.isWarmup || set.reps === null || set.reps < 1) return null;
  if (set.weightKg === null) return mode === 'bodyweight_reps' ? { weightKg: 0, reps: set.reps } : null;
  return { weightKg: set.weightKg, reps: set.reps };
}

export function fixtureClassify(set: Working, prior: readonly Working[]): SetPr[] {
  if (prior.length === 0) return [{ type: 'first_time', value: set.weightKg, previous: null }];
  const prs: SetPr[] = [];
  const maxWeight = Math.max(...prior.map((p) => p.weightKg));
  if (set.weightKg > maxWeight) prs.push({ type: 'weight', value: set.weightKg, previous: maxWeight });
  const heavier = prior.filter((p) => p.weightKg >= set.weightKg - 0.01);
  if (heavier.length > 0) {
    const maxReps = Math.max(...heavier.map((p) => p.reps));
    if (set.reps > maxReps) prs.push({ type: 'reps', value: set.reps, previous: maxReps });
  }
  const e = fixtureE1rm(set.weightKg, set.reps);
  const priorE = prior.map((p) => fixtureE1rm(p.weightKg, p.reps)).filter((v): v is number => v !== null);
  if (e !== null && priorE.length > 0 && e > Math.max(...priorE)) {
    prs.push({ type: 'e1rm', value: e, previous: Math.max(...priorE) });
  }
  return prs;
}

const byTime = (a: Pick<Workout, 'date' | 'startedAt'>, b: Pick<Workout, 'date' | 'startedAt'>) =>
  a.date === b.date ? a.startedAt.localeCompare(b.startedAt) : a.date.localeCompare(b.date);

/** Completed workouts other than `w`, earlier than it by (date, startedAt), oldest first. */
function earlierCompleted(all: readonly Workout[], w: Pick<Workout, 'id' | 'date' | 'startedAt'>): Workout[] {
  return all.filter((o) => o.id !== w.id && o.status === 'completed' && byTime(o, w) < 0).sort(byTime);
}

/** Sets every set's `prs` in `w` against `all` (the other workouts). */
export function applyPrs(w: Workout, all: readonly Workout[]): void {
  const earlier = earlierCompleted(all, w);
  const running = new Map<string, Working[]>();
  const priorFor = (exerciseId: string, mode: string) => {
    let list = running.get(exerciseId);
    if (!list) {
      list = [];
      for (const o of earlier) {
        for (const e of o.exercises) {
          if (e.exerciseId !== exerciseId) continue;
          for (const s of e.sets) {
            const ws = working(s, mode);
            if (ws) list.push(ws);
          }
        }
      }
      running.set(exerciseId, list);
    }
    return list;
  };
  for (const entry of [...w.exercises].sort((a, b) => a.position - b.position)) {
    const mode = entry.exercise.trackingMode;
    const prior = priorFor(entry.exerciseId, mode);
    for (const set of entry.sets) {
      const ws = working(set, mode);
      if (!ws) {
        set.prs = [];
        continue;
      }
      set.prs = fixtureClassify(ws, prior);
      prior.push(ws);
    }
  }
}

/** The best set per PR type per exercise (highest value, earliest on a tie). */
export function summaryPrs(exercises: readonly WorkoutExerciseView[]): Workout['summary']['prs'] {
  const out: Workout['summary']['prs'] = [];
  const seen = new Set<string>();
  for (const entry of exercises) {
    if (seen.has(entry.exerciseId)) continue;
    seen.add(entry.exerciseId);
    const entries = exercises.filter((e) => e.exerciseId === entry.exerciseId);
    for (const type of PR_ORDER) {
      let best: Workout['summary']['prs'][number] | null = null;
      for (const e of entries) {
        for (const set of e.sets) {
          const pr = (set.prs ?? []).find((p) => p.type === type);
          if (pr && (!best || pr.value > best.value)) {
            best = {
              exerciseId: e.exerciseId,
              exerciseName: e.exercise.name,
              workoutExerciseId: e.id,
              setId: set.id,
              setNumber: set.setNumber,
              ...pr,
            };
          }
        }
      }
      if (best) out.push(best);
    }
  }
  return out;
}

/** `GET /exercises/:id/history` over `all`, in the context of `context` (or as of now). */
export function fixtureHistory(
  all: readonly Workout[],
  exerciseId: string,
  context: Pick<Workout, 'id' | 'date' | 'startedAt' | 'gymId'> | null,
  gymId: string | null,
  limit = 3,
): ExerciseHistory {
  const pool = context
    ? earlierCompleted(all, context)
    : all.filter((o) => o.status === 'completed').sort(byTime);
  const withExercise = pool
    .filter((o) => o.exercises.some((e) => e.exerciseId === exerciseId && e.sets.some((s) => s.completed)))
    .reverse();
  const preferred = gymId ?? context?.gymId ?? null;
  const pick = withExercise.slice(0, 2).find((o) => preferred && o.gymId === preferred) ?? withExercise[0] ?? null;
  const setsOf = (o: Workout) =>
    o.exercises
      .filter((e) => e.exerciseId === exerciseId)
      .flatMap((e) => e.sets.filter((s) => s.completed).map((s) => ({ s, mode: e.exercise.trackingMode })));
  const lastTime = pick
    ? {
        workoutId: pick.id,
        date: pick.date,
        gym: pick.gym,
        sets: setsOf(pick).map(
          ({ s }): LastTimeSet => ({
            setNumber: s.setNumber,
            weightKg: s.weightKg,
            reps: s.reps,
            durationSeconds: s.durationSeconds,
            distanceMeters: s.distanceMeters,
            rpe: s.rpe,
            isWarmup: s.isWarmup,
          }),
        ),
      }
    : null;
  const records: ExerciseHistory['records'] = { maxWeightKg: null, maxReps: null, bestE1rmKg: null };
  const recent: ExerciseHistory['recent'] = [];
  for (const o of withExercise) {
    let top: Working | null = null;
    let best: number | null = null;
    for (const { s, mode } of setsOf(o)) {
      const ws = working(s, mode);
      if (!ws) continue;
      if (!top || ws.weightKg > top.weightKg || (ws.weightKg === top.weightKg && ws.reps > top.reps)) top = ws;
      const e = fixtureE1rm(ws.weightKg, ws.reps);
      if (e !== null && (best === null || e > best)) best = e;
      if (!records.maxWeightKg || ws.weightKg > records.maxWeightKg.value) {
        records.maxWeightKg = { value: ws.weightKg, reps: ws.reps, date: o.date };
      }
      if (!records.maxReps || ws.reps > records.maxReps.value) {
        records.maxReps = { value: ws.reps, weightKg: ws.weightKg, date: o.date };
      }
      if (e !== null && (!records.bestE1rmKg || e > records.bestE1rmKg.value)) {
        records.bestE1rmKg = { value: e, weightKg: ws.weightKg, reps: ws.reps, date: o.date };
      }
    }
    if (recent.length < limit) recent.push({ workoutId: o.id, date: o.date, topSet: top, e1rmKg: best });
  }
  return { exerciseId, lastTime, recent, records };
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
    summary: { durationSeconds: null, exerciseCount: 0, setCount: 0, volumeKg: 0, prs: [] },
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
  /** `GET /exercises/:id/history` requests (reads are not in `calls`). */
  historyCalls: { exerciseId: string; query: string }[];
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
  const state: WorkoutsApiState = { workouts: initial.map((w) => structuredClone(w)), calls: [], historyCalls: [] };
  const gyms = options.gyms ?? [];
  const exercises = options.exercises ?? [];

  const find = (id: unknown) => state.workouts.find((w) => w.id === id);
  const view = (w: Workout): Workout => {
    applyPrs(w, state.workouts);
    w.summary = computeSummary(w);
    return structuredClone(w);
  };
  /** A set as the API answers a write: its `prs` computed against the rest. */
  const setView = (w: Workout, set: SetLogView): SetLogView => {
    applyPrs(w, state.workouts);
    return structuredClone(set);
  };
  const findSet = (w: Workout, setId: unknown) => {
    for (const entry of w.exercises) {
      const set = entry.sets.find((s) => s.id === setId);
      if (set) return { entry, set };
    }
    return null;
  };

  server.use(
    http.get(`${API}/exercises/:id/history`, ({ params, request }) => {
      const url = new URL(request.url);
      const workoutId = url.searchParams.get('workoutId');
      const context = workoutId ? (find(workoutId) ?? null) : null;
      if (workoutId && !context) return notFound('Workout');
      state.historyCalls.push({ exerciseId: String(params.id), query: url.search });
      return HttpResponse.json({
        data: fixtureHistory(
          state.workouts,
          String(params.id),
          context,
          url.searchParams.get('gymId'),
          Number(url.searchParams.get('limit') ?? 3),
        ),
      });
    }),
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
      if (body.isWarmup !== undefined) set.isWarmup = body.isWarmup;
      if (body.completed === true) {
        set.completed = true;
        set.completedAt = WORKOUT_NOW;
      }
      entry.sets.push(set);
      return HttpResponse.json({ data: setView(w, set) }, { status: 201 });
    }),
    http.patch(`${API}/workouts/:id/sets/:setId`, async ({ params, request }) => {
      const body = (await request.clone().json()) as SetInput;
      state.calls.push({ method: 'PATCH', path: `/workouts/${params.id}/sets/${params.setId}`, body });
      const w = find(params.id);
      const found = w ? findSet(w, params.setId) : null;
      if (!w || !found) return notFound('Set');
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
      return HttpResponse.json({ data: setView(w, set) });
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
