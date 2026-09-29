/** `services/workouts.ts` (E4.2): every route's method, path, body and query string. */
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { ApiError } from '../../services/api';
import {
  addSet,
  addWorkoutExercise,
  deleteSet,
  deleteWorkout,
  finishWorkout,
  getWorkout,
  isWorkoutNotFound,
  listWorkouts,
  removeWorkoutExercise,
  startWorkout,
  updateSet,
  updateWorkout,
  updateWorkoutExercise,
  workoutErrorMessage,
  workoutRefusalReason,
  workoutsQueryString,
} from '../../services/workouts';

type Method = 'get' | 'post' | 'patch' | 'delete';

interface Seen {
  url?: string;
  method?: string;
  body?: unknown;
}

function capture(method: Method, path: string, data: unknown = null, status = 200): Seen {
  const seen: Seen = {};
  server.use(
    http[method](`*/api${path}`, async ({ request }) => {
      seen.url = request.url;
      seen.method = request.method;
      const text = await request.clone().text();
      seen.body = text ? JSON.parse(text) : undefined;
      if (method === 'delete') return new HttpResponse(null, { status: 204 });
      return HttpResponse.json({ data }, { status });
    }),
  );
  return seen;
}

const W = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const S = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const workout = {
  id: W,
  name: 'Tuesday workout',
  date: '2026-09-29',
  status: 'in_progress',
  startedAt: '2026-09-29T10:00:00.000Z',
  endedAt: null,
  durationSeconds: null,
  gymId: null,
  gym: null,
  notes: null,
  programWorkoutId: null,
  readinessSnapshot: null,
  exercises: [],
  summary: { durationSeconds: null, exerciseCount: 0, setCount: 0, volumeKg: 0 },
  createdAt: '2026-09-29T10:00:00.000Z',
  updatedAt: '2026-09-29T10:00:00.000Z',
};

describe('services/workouts', () => {
  it('starts a workout and passes `existing` through (201 new, 200 existing)', async () => {
    const created = capture('post', '/workouts', { ...workout, existing: false }, 201);
    const fresh = await startWorkout({ date: '2026-09-29' });
    expect(created.body).toEqual({ date: '2026-09-29' });
    expect(fresh.existing).toBe(false);

    capture('post', '/workouts', { ...workout, existing: true }, 200);
    const again = await startWorkout();
    expect(again.existing).toBe(true);
    expect(again.id).toBe(W);
  });

  it('lists workouts with the flat page shape and builds the query', async () => {
    const page = {
      items: [
        {
          id: W,
          name: 'Tuesday workout',
          date: '2026-09-29',
          status: 'completed',
          startedAt: workout.startedAt,
          endedAt: workout.startedAt,
          durationSeconds: 3600,
          gym: null,
          exerciseCount: 1,
          setCount: 2,
          volumeKg: 317.5,
          exercises: [{ id: 'e1', name: 'Bench' }],
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    };
    const seen = capture('get', '/workouts', page);
    const result = await listWorkouts({
      page: 2,
      pageSize: 50,
      status: 'completed',
      gymId: 'g1',
      from: '2026-09-01',
      to: '2026-09-30',
      exerciseId: 'e1',
    });
    expect(result.items[0].volumeKg).toBe(317.5);
    expect(result.totalPages).toBe(1);
    const params = new URL(seen.url!).searchParams;
    expect(Object.fromEntries(params)).toEqual({
      page: '2',
      pageSize: '50',
      status: 'completed',
      gymId: 'g1',
      from: '2026-09-01',
      to: '2026-09-30',
      exerciseId: 'e1',
    });

    await listWorkouts();
    expect(new URL(seen.url!).search).toBe('');
  });

  it('leaves empty filters out of the query string', () => {
    expect(workoutsQueryString()).toBe('');
    expect(workoutsQueryString({ gymId: '', from: '' })).toBe('');
    expect(workoutsQueryString({ page: 1 })).toBe('?page=1');
  });

  it('reads, edits, finishes and deletes a workout by id', async () => {
    const get = capture('get', `/workouts/${W}`, workout);
    expect((await getWorkout(W)).id).toBe(W);
    expect(get.method).toBe('GET');

    const patch = capture('patch', `/workouts/${W}`, workout);
    await updateWorkout(W, { name: 'Push day', gymId: null });
    expect(patch.method).toBe('PATCH');
    expect(patch.body).toEqual({ name: 'Push day', gymId: null });

    const finish = capture('post', `/workouts/${W}/finish`, { ...workout, status: 'completed' });
    const finished = await finishWorkout(W, { notes: 'Good' });
    expect(finish.body).toEqual({ notes: 'Good' });
    expect(finished.status).toBe('completed');

    const del = capture('delete', `/workouts/${W}`);
    await expect(deleteWorkout(W)).resolves.toBeUndefined();
    expect(del.method).toBe('DELETE');
    expect(del.url).toMatch(new RegExp(`/api/workouts/${W}$`));
  });

  it('adds, moves and removes a workout exercise', async () => {
    const add = capture('post', `/workouts/${W}/exercises`, { id: WE }, 201);
    await addWorkoutExercise(W, { exerciseId: 'e1', position: 0 });
    expect(add.body).toEqual({ exerciseId: 'e1', position: 0 });

    const move = capture('patch', `/workouts/${W}/exercises/${WE}`, { id: WE });
    await updateWorkoutExercise(W, WE, { position: 2 });
    expect(move.method).toBe('PATCH');
    expect(move.body).toEqual({ position: 2 });

    const remove = capture('delete', `/workouts/${W}/exercises/${WE}`);
    await removeWorkoutExercise(W, WE);
    expect(remove.url).toMatch(new RegExp(`/api/workouts/${W}/exercises/${WE}$`));
  });

  it('adds, edits and deletes sets in kilograms, keeping null distinct from omitted', async () => {
    const add = capture('post', `/workouts/${W}/exercises/${WE}/sets`, { id: S }, 201);
    await addSet(W, WE, { weightKg: 31.75, reps: 10, rpe: null });
    expect(add.body).toEqual({ weightKg: 31.75, reps: 10, rpe: null });

    await addSet(W, WE);
    expect(add.body).toEqual({});

    const patch = capture('patch', `/workouts/${W}/sets/${S}`, { id: S, completed: true });
    await updateSet(W, S, { completed: true });
    expect(patch.url).toMatch(new RegExp(`/api/workouts/${W}/sets/${S}$`));
    expect(patch.body).toEqual({ completed: true });

    const del = capture('delete', `/workouts/${W}/sets/${S}`);
    await deleteSet(W, S);
    expect(del.method).toBe('DELETE');
  });

  it('surfaces the refusal reason and 404s', async () => {
    server.use(
      http.post(`*/api/workouts/${W}/exercises`, () =>
        HttpResponse.json(
          { message: 'At most 30 exercises', code: 'BAD_REQUEST', details: { reason: 'WORKOUT_EXERCISE_LIMIT' } },
          { status: 400 },
        ),
      ),
      http.get(`*/api/workouts/${W}`, () =>
        HttpResponse.json({ message: 'Workout not found', code: 'NOT_FOUND' }, { status: 404 }),
      ),
    );

    const limit = await addWorkoutExercise(W, { exerciseId: 'e1' }).catch((err: unknown) => err);
    expect(limit).toBeInstanceOf(ApiError);
    expect(workoutRefusalReason(limit)).toBe('WORKOUT_EXERCISE_LIMIT');
    expect(workoutErrorMessage(limit, 'fallback')).toBe('At most 30 exercises');

    const missing = await getWorkout(W).catch((err: unknown) => err);
    expect(isWorkoutNotFound(missing)).toBe(true);
    expect(workoutRefusalReason(missing)).toBeNull();
    expect(workoutRefusalReason(new Error('x'))).toBeNull();
    expect(workoutErrorMessage('nope', 'fallback')).toBe('fallback');
  });
});
