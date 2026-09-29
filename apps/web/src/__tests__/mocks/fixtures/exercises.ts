/**
 * Exercise library fixtures (E4.1): builders for the API views and a small
 * stateful MSW API that behaves like `apps/api/src/exercises` for the web
 * suites (search by name and alias, filter by muscle and custom, owner-scoped
 * custom exercises created by `POST`, requirement groups expanded on `GET
 * /exercises/:id`). Equipment types come from the gyms fixtures' catalog.
 */
import { http, HttpResponse } from 'msw';
import { server } from '../server';
import type { EquipmentType } from '../../../services/gyms';
import type { Exercise, ExerciseInput } from '../../../services/exercises';
import { CATALOG } from './gyms';

const API = '*/api';
const NOW = '2026-09-29T12:00:00.000Z';

let seq = 0;
const nextId = () => {
  seq += 1;
  return `00000000-0000-4000-8000-b${String(seq).padStart(11, '0')}`;
};

export function mockExercise(overrides: Partial<Exercise> = {}): Exercise {
  return {
    id: nextId(),
    slug: 'barbell_bench_press',
    name: 'Barbell bench press',
    aliases: [],
    primaryMuscles: ['chest'],
    secondaryMuscles: ['triceps', 'shoulders'],
    movementPattern: 'horizontal_push',
    trackingMode: 'weight_reps',
    isUnilateral: false,
    isBodyweight: false,
    notes: null,
    isCustom: false,
    origin: 'seed',
    status: 'active',
    proposedByRunId: null,
    requirements: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const eq = (id: string, slug: string, name: string) => ({
  kind: 'equipment' as const,
  id,
  slug,
  name,
});

/** A small library: four "bench" exercises, curls, a bodyweight move. */
export function mockLibrary(): Exercise[] {
  return [
    mockExercise({
      slug: 'barbell_bench_press',
      name: 'Barbell bench press',
      requirements: [
        { groupIndex: 0, options: [eq('t-barbell', 'barbell', 'Barbell')] },
        {
          groupIndex: 1,
          options: [
            eq('t-flat', 'flat_bench', 'Flat bench'),
            eq('t-adj', 'adjustable_bench', 'Adjustable bench'),
          ],
        },
      ],
    }),
    mockExercise({ slug: 'dumbbell_bench_press', name: 'Dumbbell bench press' }),
    mockExercise({
      slug: 'close_grip_bench_press',
      name: 'Close-grip bench press',
      primaryMuscles: ['triceps'],
    }),
    mockExercise({
      slug: 'bench_dip',
      name: 'Bench dip',
      primaryMuscles: ['triceps'],
      movementPattern: 'vertical_push',
    }),
    mockExercise({
      slug: 'dumbbell_curl',
      name: 'Dumbbell curl',
      primaryMuscles: ['biceps'],
      secondaryMuscles: ['forearms'],
      movementPattern: 'isolation',
    }),
    mockExercise({
      slug: 'push_up',
      name: 'Push-up',
      aliases: ['press-up'],
      isBodyweight: true,
      trackingMode: 'bodyweight_reps',
    }),
  ];
}

export interface ExercisesApiState {
  exercises: Exercise[];
  types: EquipmentType[];
  calls: { method: string; path: string; body?: unknown }[];
}

export function statefulExercisesApi(
  initial: Exercise[] = mockLibrary(),
  types: EquipmentType[] = CATALOG
): ExercisesApiState {
  const state: ExercisesApiState = {
    exercises: initial.map((e) => ({ ...e })),
    types: [...types],
    calls: [],
  };

  server.use(
    http.get(`${API}/exercises`, ({ request }) => {
      const url = new URL(request.url);
      state.calls.push({ method: 'GET', path: `/exercises${url.search}` });
      const q = url.searchParams.get('q')?.toLowerCase();
      const muscle = url.searchParams.get('muscle');
      // `custom=true`: only custom; `custom=false`: only the library; omitted: both.
      const custom = url.searchParams.get('custom');
      const includePending = url.searchParams.get('includePending') === 'true';
      const data = state.exercises
        .filter(
          (e) =>
            (!q ||
              e.name.toLowerCase().includes(q) ||
              e.aliases.some((a) => a.toLowerCase().includes(q))) &&
            (!muscle || e.primaryMuscles.includes(muscle) || e.secondaryMuscles.includes(muscle)) &&
            (custom === null || e.isCustom === (custom === 'true')) &&
            (includePending || e.status !== 'pending_review')
        )
        .sort((a, b) => a.name.localeCompare(b.name));
      return HttpResponse.json({ data });
    }),
    http.get(`${API}/exercises/:id`, ({ params }) => {
      const found = state.exercises.find((e) => e.id === params.id);
      return found
        ? HttpResponse.json({ data: found })
        : HttpResponse.json(
            { statusCode: 404, message: 'Exercise not found', error: 'Not Found' },
            { status: 404 }
          );
    }),
    http.post(`${API}/exercises`, async ({ request }) => {
      const body = (await request.clone().json()) as ExerciseInput;
      state.calls.push({ method: 'POST', path: '/exercises', body });
      const byId = new Map(state.types.map((t) => [t.id, t]));
      const created = mockExercise({
        slug: 'custom-abcdefgh',
        name: body.name,
        primaryMuscles: body.primaryMuscles,
        secondaryMuscles: body.secondaryMuscles ?? [],
        movementPattern: body.movementPattern,
        isUnilateral: body.isUnilateral ?? false,
        isBodyweight: body.isBodyweight ?? false,
        notes: body.notes ?? null,
        trackingMode: body.trackingMode ?? 'weight_reps',
        isCustom: true,
        origin: 'user',
        requirements: (body.requirements ?? []).map((g, groupIndex) => ({
          groupIndex,
          options: (g.equipmentTypeIds ?? []).map((id) => {
            const t = byId.get(id);
            return eq(id, t?.slug ?? id, t?.name ?? id);
          }),
        })),
      });
      state.exercises.push(created);
      return HttpResponse.json({ data: created }, { status: 201 });
    }),
    http.get(`${API}/equipment-types`, ({ request }) => {
      const q = new URL(request.url).searchParams.get('q')?.toLowerCase();
      const data = state.types.filter((t) => !q || t.name.toLowerCase().includes(q));
      return HttpResponse.json({ data });
    })
  );
  return state;
}
