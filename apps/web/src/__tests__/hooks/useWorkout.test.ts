/**
 * `useWorkout` (E4.3) against the stateful MSW workouts API: load, not found,
 * optimistic set edits that reconcile with the server, revert on failure,
 * exercises added in order.
 */
import { describe, it, expect } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse, delay } from 'msw';
import { server } from '../mocks/server';
import { useWorkout } from '../../hooks/useWorkout';
import { mockEntry, mockSet, mockWorkout, statefulWorkoutsApi } from '../mocks/fixtures/workouts';
import { mockExercise } from '../mocks/fixtures/exercises';

const bench = mockExercise({ name: 'Dumbbell bench press', slug: 'dumbbell_bench_press' });
const curl = mockExercise({ name: 'Dumbbell curl', slug: 'dumbbell_curl' });
const plank = mockExercise({ name: 'Plank', slug: 'plank', trackingMode: 'time' });

function seeded() {
  const set1 = mockSet({ weightKg: 31.751, reps: 10 });
  const workout = mockWorkout({ exercises: [mockEntry(bench, { sets: [set1] })] });
  const api = statefulWorkoutsApi([workout], { exercises: [bench, curl, plank] });
  return { api, workout, setId: workout.exercises[0].sets[0].id, weId: workout.exercises[0].id };
}

async function renderLoaded(id: string) {
  const hook = renderHook(() => useWorkout(id));
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  return hook;
}

describe('useWorkout', () => {
  it('loads the workout', async () => {
    const { workout } = seeded();
    const { result } = await renderLoaded(workout.id);
    expect(result.current.workout?.id).toBe(workout.id);
    expect(result.current.workout?.exercises[0].sets[0].reps).toBe(10);
    expect(result.current.notFound).toBe(false);
  });

  it('answers notFound on 404', async () => {
    statefulWorkoutsApi([]);
    const { result } = await renderLoaded('00000000-0000-4000-8000-000000000000');
    expect(result.current.notFound).toBe(true);
    expect(result.current.workout).toBeNull();
  });

  it('applies a set edit at once, then reconciles with the server answer', async () => {
    const { workout, setId, api } = seeded();
    server.use(
      http.patch('*/api/workouts/:id/sets/:setId', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        api.calls.push({ method: 'PATCH', path: 'set', body });
        await delay(30);
        return HttpResponse.json({
          data: { ...workout.exercises[0].sets[0], reps: 12, rir: 2, completed: true, completedAt: 'x', restSeconds: 95 },
        });
      }),
    );
    const { result } = await renderLoaded(workout.id);
    let promise: Promise<unknown>;
    act(() => {
      promise = result.current.updateSet(setId, { reps: 12, rir: 2, completed: true });
    });
    const optimistic = result.current.workout!.exercises[0].sets[0];
    expect(optimistic.reps).toBe(12);
    expect(optimistic.completed).toBe(true);
    expect(optimistic.restSeconds).toBeNull();
    await act(async () => {
      await promise;
    });
    expect(result.current.workout!.exercises[0].sets[0].restSeconds).toBe(95);
    expect(api.calls.at(-1)?.body).toEqual({ reps: 12, rir: 2, completed: true });
  });

  it('reverts a failed set edit to the last confirmed value and rejects', async () => {
    const { workout, setId } = seeded();
    server.use(
      http.patch('*/api/workouts/:id/sets/:setId', () =>
        HttpResponse.json({ statusCode: 500, message: 'Boom' }, { status: 500 }),
      ),
    );
    const { result } = await renderLoaded(workout.id);
    await act(async () => {
      await expect(result.current.updateSet(setId, { reps: 5 })).rejects.toThrow();
    });
    expect(result.current.workout!.exercises[0].sets[0].reps).toBe(10);
  });

  it('adds exercises one after another, in the order given', async () => {
    const { workout, api } = seeded();
    const { result } = await renderLoaded(workout.id);
    await act(async () => {
      await result.current.addExercises([plank.id, curl.id]);
    });
    expect(result.current.workout!.exercises.map((e) => e.exercise.name)).toEqual([
      'Dumbbell bench press',
      'Plank',
      'Dumbbell curl',
    ]);
    const posts = api.calls.filter((c) => c.path.endsWith('/exercises'));
    expect(posts.map((c) => (c.body as { exerciseId: string }).exerciseId)).toEqual([plank.id, curl.id]);
  });

  it('adds a set that the server prefilled from the previous one', async () => {
    const { workout, weId } = seeded();
    const { result } = await renderLoaded(workout.id);
    await act(async () => {
      await result.current.addSet(weId);
    });
    const sets = result.current.workout!.exercises[0].sets;
    expect(sets).toHaveLength(2);
    expect(sets[1]).toMatchObject({ setNumber: 2, weightKg: 31.751, reps: 10, completed: false });
  });

  it('discards only untouched auto-added rows that are not done', async () => {
    const { workout, weId, api } = seeded();
    const { result } = await renderLoaded(workout.id);
    let untouched = '';
    let edited = '';
    let manual = '';
    await act(async () => {
      untouched = (await result.current.addSet(weId, {}, { auto: true })).id;
      edited = (await result.current.addSet(weId, {}, { auto: true })).id;
      manual = (await result.current.addSet(weId)).id;
    });
    await act(async () => {
      await result.current.updateSet(edited, { reps: 4 });
    });
    let discarded: string[] = [];
    await act(async () => {
      discarded = await result.current.discardUntouchedAutoSets();
    });
    expect(discarded).toEqual([untouched]);
    const ids = result.current.workout!.exercises[0].sets.map((s) => s.id);
    expect(ids).toContain(edited);
    expect(ids).toContain(manual);
    expect(ids).not.toContain(untouched);
    expect(api.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('deletes a set and renumbers the rest locally', async () => {
    const { workout, weId, setId } = seeded();
    const { result } = await renderLoaded(workout.id);
    await act(async () => {
      await result.current.addSet(weId);
    });
    await act(async () => {
      await result.current.deleteSet(setId);
    });
    const sets = result.current.workout!.exercises[0].sets;
    expect(sets).toHaveLength(1);
    expect(sets[0].setNumber).toBe(1);
  });

  it('turns into notFound when a mutation meets a deleted workout', async () => {
    const { workout, api, setId } = seeded();
    const { result } = await renderLoaded(workout.id);
    api.workouts = [];
    await act(async () => {
      await expect(result.current.updateSet(setId, { reps: 3 })).rejects.toThrow();
    });
    await waitFor(() => expect(result.current.notFound).toBe(true));
  });

  it('finishes and moves the exercise order', async () => {
    const { workout } = seeded();
    const { result } = await renderLoaded(workout.id);
    await act(async () => {
      await result.current.addExercises([curl.id]);
    });
    const curlEntry = result.current.workout!.exercises[1].id;
    await act(async () => {
      await result.current.moveExercise(curlEntry, -1);
    });
    expect(result.current.workout!.exercises[0].exercise.name).toBe('Dumbbell curl');
    await act(async () => {
      await result.current.finish();
    });
    expect(result.current.workout!.status).toBe('completed');
  });
});
