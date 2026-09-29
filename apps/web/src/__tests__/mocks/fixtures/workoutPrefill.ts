/**
 * Photo-intake fixtures for "Prefill from photo" (E4.5): the two reference
 * examples' drafts (`placard`, `notebook` for an Imperial user, as the API's
 * `apps/api/test/fixtures/workout-prefill/*.expected-drafts.json` defines
 * them) and a small stateful MSW `/api/intakes` for the `workout_prefill`
 * kind that behaves like `apps/api/src/intake`: resume by `kind` +
 * `subjectId` + `status`, `PATCH` replacing the context, analyze ->
 * `scanning` -> `ready` with the scripted drafts on the next read,
 * `originalAiValue` on the first edit of an AI item, accept-all, apply
 * refused while items are pending and answered 409 `ALREADY_APPLIED` twice.
 */
import { http, HttpResponse } from 'msw';
import { server } from '../server';
import type { DraftItemView, PhotoIntakePhotoView, PhotoIntakeStatus, PhotoIntakeView } from '../../../services/intake';
import type {
  ExerciseDraftSet,
  ExerciseDraftValue,
  WorkoutPrefillApplyResult,
  WorkoutPrefillContext,
} from '../../../services/workoutPrefill';

const API = '*/api';
const T0 = '2026-09-29T12:00:00.000Z';

let seq = 0;
const nextId = (prefix: string) => {
  seq += 1;
  return `00000000-0000-4000-8000-${prefix}${String(seq).padStart(12 - prefix.length, '0')}`;
};

export const PREFILL_PHOTO0 = '00000000-0000-4000-8000-910000000000';

export type PrefillDraft = Omit<DraftItemView<ExerciseDraftValue>, 'id' | 'sortOrder'>;
export type PrefillIntakeView = PhotoIntakeView<ExerciseDraftValue, WorkoutPrefillContext>;

const s = (weightKg: number | null, reps: number | null, durationSeconds: number | null = null): ExerciseDraftSet => ({
  reps,
  weightKg,
  durationSeconds,
  distanceMeters: null,
});

function aiDraft(
  confidence: 'high' | 'medium' | 'low',
  uncertain: boolean,
  uncertaintyNote: string | null,
  value: ExerciseDraftValue,
): PrefillDraft {
  return {
    kind: 'exercise',
    origin: 'ai',
    status: 'pending',
    confidence,
    uncertain,
    uncertaintyNote,
    sourcePhotoIds: [PREFILL_PHOTO0],
    userVerified: false,
    originalAiValue: null,
    value,
  };
}

const UNIT_NOTE = 'Unit not written; assumed lb';

/** `placard.expected-drafts.json`. */
export const PLACARD_DRAFTS: PrefillDraft[] = [
  aiDraft(
    'high',
    false,
    'The placard reads LEG CURL under a PRECOR logo; it shows no weights or reps, so no sets are drafted.',
    { exerciseSlug: 'leg_curl', name: 'Leg curl', rawText: 'LEG CURL', sets: [] },
  ),
];

/** `notebook.expected-drafts.json` for an Imperial (lb) user. */
export const NOTEBOOK_DRAFTS: PrefillDraft[] = [
  aiDraft('medium', true, `Bench is read as barbell bench press; the weight unit is not written. ${UNIT_NOTE}`, {
    exerciseSlug: 'barbell_bench_press',
    name: 'Barbell bench press',
    rawText: 'Bench 135 x 10, 10, 8',
    sets: [s(61.235, 10), s(61.235, 10), s(61.235, 8)],
  }),
  aiDraft(
    'medium',
    true,
    `Read as 50 x 12 for 3 sets; the notation order is ambiguous and the unit is not written. ${UNIT_NOTE}`,
    {
      exerciseSlug: 'incline_dumbbell_press',
      name: 'Incline dumbbell press',
      rawText: 'Incline DB press 50 x 12 x 3',
      sets: [s(22.68, 12), s(22.68, 12), s(22.68, 12)],
    },
  ),
  aiDraft('medium', true, UNIT_NOTE, {
    exerciseSlug: 'triceps_pushdown',
    name: 'Triceps pushdown',
    rawText: 'Tricep pushdown 40 x 15, 15',
    sets: [s(18.144, 15), s(18.144, 15)],
  }),
  aiDraft('high', false, null, {
    exerciseSlug: 'plank',
    name: 'Plank',
    rawText: 'Plank 60s',
    sets: [s(null, null, 60)],
  }),
  aiDraft('low', true, `Handwriting is unclear; it might be a cable row. ${UNIT_NOTE}`, {
    exerciseSlug: null,
    name: 'Unreadable cable exercise',
    rawText: 'Cbl r? 25x12',
    sets: [s(11.34, 12)],
  }),
];

export const NOTEBOOK_RESULT_META = {
  promptVersion: 1,
  chunks: 1,
  photoCount: 1,
  sourceKind: 'notebook',
  sourceKinds: ['notebook'],
  suggestedName: 'Push day',
  ignoredNotes: ['Push day heading'],
  assumedWeightUnit: 'lb',
  failedChunks: [],
};

export function toPrefillItems(drafts: PrefillDraft[]): DraftItemView<ExerciseDraftValue>[] {
  return drafts.map((draft, index) => ({ ...draft, id: nextId('a'), sortOrder: index }));
}

export function mockPrefillPhoto(storageObjectId: string, name: string, sortOrder = 0): PhotoIntakePhotoView {
  return { id: nextId('f'), storageObjectId, name, sortOrder };
}

export function mockPrefillIntake(workoutId: string, overrides: Partial<PrefillIntakeView> = {}): PrefillIntakeView {
  return {
    id: nextId('6'),
    kind: 'workout_prefill',
    status: 'draft',
    subjectType: 'workout',
    subjectId: workoutId,
    context: { workoutId },
    provider: null,
    modelId: null,
    jobId: null,
    errorCode: null,
    errorMessage: null,
    resultMeta: null,
    createdAt: T0,
    updatedAt: T0,
    completedAt: null,
    photos: [],
    items: [],
    ...overrides,
  };
}

export interface PrefillApiOptions {
  /** What the analysis "finds" on the first read after `analyze`. */
  scanResult?: PrefillDraft[] | { failed: { code: string; message: string } };
  /** Reads that still answer `scanning` after `analyze` (default 0). */
  scanningReads?: number;
  resultMeta?: Record<string, unknown>;
  /** Called on a successful apply (e.g. to add the exercises to the workouts fixture); its result is merged in. */
  onApply?: (intake: PrefillIntakeView) => Partial<WorkoutPrefillApplyResult> | void;
}

export interface PrefillApiState {
  intakes: PrefillIntakeView[];
  calls: Array<{ method: string; path: string; body?: unknown }>;
}

/** Install a stateful `/api/intakes` (the `workout_prefill` kind) for one test. */
export function statefulPrefillApi(initial: PrefillIntakeView[] = [], options: PrefillApiOptions = {}): PrefillApiState {
  const state: PrefillApiState = { intakes: initial.map((i) => structuredClone(i)), calls: [] };
  let scanningReadsLeft = options.scanningReads ?? 0;
  const find = (id: string) => state.intakes.find((i) => i.id === id);
  const notFound = () => HttpResponse.json({ statusCode: 404, message: 'Intake not found' }, { status: 404 });
  const record = async (request: Request, path: string) => {
    let body: unknown;
    if (request.method !== 'GET' && request.method !== 'DELETE') {
      body = await request.clone().json().catch(() => undefined);
    }
    state.calls.push({ method: request.method, path, body });
    return body;
  };

  const settle = (intake: PrefillIntakeView) => {
    if (intake.status !== 'scanning') return;
    if (scanningReadsLeft > 0) {
      scanningReadsLeft -= 1;
      return;
    }
    const result = options.scanResult ?? [];
    if ('failed' in result) {
      intake.status = 'failed';
      intake.errorCode = result.failed.code;
      intake.errorMessage = result.failed.message;
      return;
    }
    const kept = intake.items.filter((i) => !(i.origin === 'ai' && i.status === 'pending' && !i.userVerified));
    intake.items = [...kept, ...toPrefillItems(result).map((item, index) => ({ ...item, sortOrder: kept.length + index }))];
    intake.resultMeta = options.resultMeta ?? {
      promptVersion: 1,
      chunks: 1,
      photoCount: intake.photos.length,
      sourceKind: 'other',
      sourceKinds: ['other'],
      suggestedName: null,
      ignoredNotes: [],
      assumedWeightUnit: 'kg',
      failedChunks: [],
    };
    intake.status = 'ready';
  };

  server.use(
    http.get(`${API}/intakes`, ({ request }) => {
      const url = new URL(request.url);
      state.calls.push({ method: 'GET', path: `/intakes${url.search}` });
      const kind = url.searchParams.get('kind');
      const subjectId = url.searchParams.get('subjectId');
      const statuses = url.searchParams.get('status')?.split(',') as PhotoIntakeStatus[] | undefined;
      const data = [...state.intakes]
        .reverse()
        .filter(
          (i) =>
            (!kind || i.kind === kind) &&
            (!subjectId || i.subjectId === subjectId) &&
            (!statuses || statuses.includes(i.status)),
        )
        .map(({ photos, items, ...rest }) => ({ ...rest, photoCount: photos.length, itemCount: items.length }));
      return HttpResponse.json({ data });
    }),
    http.post(`${API}/intakes`, async ({ request }) => {
      const body = (await record(request, '/intakes')) as { context: WorkoutPrefillContext };
      const intake = mockPrefillIntake(body.context.workoutId, { context: body.context });
      state.intakes.push(intake);
      return HttpResponse.json({ data: intake }, { status: 201 });
    }),
    http.get(`${API}/intakes/:id`, ({ params }) => {
      const intake = find(String(params.id));
      if (!intake) return notFound();
      settle(intake);
      return HttpResponse.json({ data: intake });
    }),
    http.patch(`${API}/intakes/:id`, async ({ request, params }) => {
      const body = (await record(request, `/intakes/${params.id}`)) as { context: WorkoutPrefillContext };
      const intake = find(String(params.id));
      if (!intake) return notFound();
      intake.context = body.context;
      return HttpResponse.json({ data: intake });
    }),
    http.delete(`${API}/intakes/:id`, async ({ request, params }) => {
      await record(request, `/intakes/${params.id}`);
      if (!find(String(params.id))) return notFound();
      state.intakes = state.intakes.filter((i) => i.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(`${API}/intakes/:id/photos`, async ({ request, params }) => {
      const body = (await record(request, `/intakes/${params.id}/photos`)) as { storageObjectId: string };
      const intake = find(String(params.id));
      if (!intake) return notFound();
      const photo = mockPrefillPhoto(body.storageObjectId, 'photo.jpg', intake.photos.length);
      intake.photos.push(photo);
      return HttpResponse.json({ data: photo }, { status: 201 });
    }),
    http.delete(`${API}/intakes/:id/photos/:oid`, async ({ request, params }) => {
      await record(request, `/intakes/${params.id}/photos/${params.oid}`);
      const intake = find(String(params.id));
      if (!intake) return notFound();
      intake.photos = intake.photos.filter((p) => p.storageObjectId !== params.oid);
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(`${API}/intakes/:id/analyze`, async ({ request, params }) => {
      const body = (await record(request, `/intakes/${params.id}/analyze`)) as { provider: string; modelId: string };
      const intake = find(String(params.id));
      if (!intake) return notFound();
      intake.status = 'scanning';
      intake.provider = body.provider;
      intake.modelId = body.modelId;
      intake.jobId = 'job-prefill-1';
      intake.errorCode = null;
      intake.errorMessage = null;
      scanningReadsLeft = options.scanningReads ?? 0;
      return HttpResponse.json({ data: { intakeId: intake.id, jobId: 'job-prefill-1' } }, { status: 202 });
    }),
    http.post(`${API}/intakes/:id/items/accept-all`, async ({ request, params }) => {
      await record(request, `/intakes/${params.id}/items/accept-all`);
      const intake = find(String(params.id));
      if (!intake) return notFound();
      intake.items = intake.items.map((i) => (i.status === 'pending' ? { ...i, status: 'accepted', userVerified: true } : i));
      return HttpResponse.json({ data: intake.items });
    }),
    http.post(`${API}/intakes/:id/items`, async ({ request, params }) => {
      const body = (await record(request, `/intakes/${params.id}/items`)) as {
        kind: string;
        value: Partial<ExerciseDraftValue> & { name: string };
      };
      const intake = find(String(params.id));
      if (!intake) return notFound();
      const item: DraftItemView<ExerciseDraftValue> = {
        id: nextId('a'),
        kind: body.kind,
        origin: 'user',
        status: 'accepted',
        confidence: null,
        uncertain: false,
        uncertaintyNote: null,
        sourcePhotoIds: [],
        userVerified: true,
        value: { exerciseSlug: null, rawText: null, sets: [], ...body.value },
        originalAiValue: null,
        sortOrder: intake.items.length,
      };
      intake.items.push(item);
      return HttpResponse.json({ data: item }, { status: 201 });
    }),
    http.patch(`${API}/intakes/:id/items/:itemId`, async ({ request, params }) => {
      const body = (await record(request, `/intakes/${params.id}/items/${params.itemId}`)) as {
        value?: ExerciseDraftValue;
        status?: DraftItemView['status'];
      };
      const intake = find(String(params.id));
      const index = intake?.items.findIndex((i) => i.id === params.itemId) ?? -1;
      if (!intake || index < 0) return notFound();
      const current = intake.items[index];
      const next: DraftItemView<ExerciseDraftValue> = { ...current };
      if (body.value !== undefined) {
        if (current.origin === 'ai' && current.originalAiValue === null) next.originalAiValue = current.value;
        next.value = body.value;
        next.userVerified = true;
      }
      if (body.status !== undefined) {
        next.status = body.status;
        if (body.status === 'accepted') next.userVerified = true;
      }
      intake.items[index] = next;
      return HttpResponse.json({ data: next });
    }),
    http.post(`${API}/intakes/:id/apply`, async ({ request, params }) => {
      await record(request, `/intakes/${params.id}/apply`);
      const intake = find(String(params.id));
      if (!intake) return notFound();
      if (intake.status === 'applied') {
        return HttpResponse.json(
          { statusCode: 409, code: 'ALREADY_APPLIED', message: 'This intake was already applied' },
          { status: 409 },
        );
      }
      const pending = intake.items.filter((i) => i.status === 'pending').length;
      if (pending > 0) {
        return HttpResponse.json(
          { statusCode: 400, code: 'PENDING_ITEMS', message: `${pending} items are still pending`, details: { count: pending } },
          { status: 400 },
        );
      }
      intake.status = 'applied';
      const accepted = intake.items.filter((i) => i.status === 'accepted');
      const result: WorkoutPrefillApplyResult = {
        workoutId: intake.context?.workoutId ?? '',
        exercisesAdded: accepted.length,
        setsAdded: accepted.reduce((n, i) => n + i.value.sets.length, 0),
        skipped: 0,
        photosAttached: intake.photos.length,
        ...(options.onApply?.(intake) ?? {}),
      };
      return HttpResponse.json({ data: result });
    }),
  );
  return state;
}
