/**
 * Photo-intake fixtures for the gym scan (E3.4): the two reference examples'
 * drafts (`cardio-row-wide`, `leg-curl-placard`, as the API's
 * `apps/api/test/fixtures/gym-scan/*.expected-drafts.json` defines them) and a
 * small stateful MSW `/api/intakes` that behaves like `apps/api/src/intake`:
 * resume by `kind` + `subjectId` + `status`, analyze -> `scanning` -> `ready`
 * with the scripted drafts on the next read, `originalAiValue` written on the
 * first edit of an AI item, accept-all, apply refused while items are pending.
 */
import { http, HttpResponse } from 'msw';
import { server } from '../server';
import type { DraftItemView, PhotoIntakePhotoView, PhotoIntakeStatus, PhotoIntakeView } from '../../../services/intake';
import type { EquipmentValue, GymEquipmentApplyResult, GymScanContext } from '../../../services/gymScan';

const API = '*/api';
const T0 = '2026-09-29T12:00:00.000Z';

let seq = 0;
const nextId = (prefix: string) => {
  seq += 1;
  return `00000000-0000-4000-8000-${prefix}${String(seq).padStart(12 - prefix.length, '0')}`;
};

export const PHOTO0 = '00000000-0000-4000-8000-900000000000';
export const PHOTO1 = '00000000-0000-4000-8000-900000000001';

type Draft = Omit<DraftItemView<EquipmentValue>, 'id' | 'sortOrder'>;

const CARDIO = ['steady_state_cardio', 'interval_cardio', 'low_impact_cardio'];

function value(overrides: Partial<EquipmentValue>): EquipmentValue {
  return {
    equipmentTypeSlug: null,
    name: '',
    quantity: 1,
    quantityUncertain: false,
    brand: null,
    brandEvidence: null,
    model: null,
    configuration: null,
    notes: null,
    capabilitySlugs: [],
    targetMuscles: [],
    ...overrides,
  };
}

function aiDraft(
  confidence: 'high' | 'medium' | 'low',
  uncertain: boolean,
  uncertaintyNote: string | null,
  v: EquipmentValue,
  photo = PHOTO0,
): Draft {
  return {
    kind: 'equipment',
    origin: 'ai',
    status: 'pending',
    confidence,
    uncertain,
    uncertaintyNote,
    sourcePhotoIds: [photo],
    userVerified: false,
    originalAiValue: null,
    value: v,
  };
}

/** `cardio-row-wide.expected-drafts.json`. */
export const CARDIO_ROW_DRAFTS: Draft[] = [
  aiDraft(
    'medium',
    true,
    'Three near-identical ellipticals in a row; the right-most one is close to the edge of the frame, so the count may be off.',
    value({
      equipmentTypeSlug: 'elliptical',
      name: 'Elliptical',
      quantity: 3,
      quantityUncertain: true,
      brand: 'Precor',
      brandEvidence:
        'No logo is readable on the ellipticals; brand inferred from the PRECOR-labelled bike beside them and the matching frames.',
      capabilitySlugs: CARDIO,
      targetMuscles: ['full_body'],
    }),
  ),
  aiDraft(
    'medium',
    true,
    'Bike style (upright vs recumbent) is not clear from this angle.',
    value({
      equipmentTypeSlug: 'stationary_bike',
      name: 'Stationary bike',
      brand: 'Matrix',
      brandEvidence: 'MATRIX lettering on the frame.',
      configuration: 'upright or recumbent (unclear)',
      capabilitySlugs: CARDIO,
      targetMuscles: ['full_body'],
    }),
  ),
  aiDraft(
    'medium',
    false,
    null,
    value({
      equipmentTypeSlug: 'stationary_bike',
      name: 'Stationary bike',
      brand: 'Precor',
      brandEvidence: 'PRECOR logo on the base cover.',
      capabilitySlugs: CARDIO,
      targetMuscles: ['full_body'],
    }),
  ),
  aiDraft(
    'low',
    true,
    'Only part of a machine is visible at the right edge of the photo; its type cannot be determined.',
    value({ name: 'Unidentified machine (partly out of frame)' }),
  ),
];

/** `leg-curl-placard.expected-drafts.json`. */
export const LEG_CURL_DRAFTS: Draft[] = [
  aiDraft(
    'high',
    false,
    'The placard text LEG CURL is readable; the muscle diagram highlights the hamstrings and calves and the illustrations show a seated position.',
    value({
      equipmentTypeSlug: 'leg_curl_machine',
      name: 'Leg curl machine',
      brand: 'Precor',
      brandEvidence: 'PRECOR logo above the placard.',
      configuration: 'seated, selectorized',
      capabilitySlugs: ['leg_curl'],
      targetMuscles: ['hamstrings'],
    }),
  ),
];

export function toItems(drafts: Draft[]): DraftItemView<EquipmentValue>[] {
  return drafts.map((draft, index) => ({ ...draft, id: nextId('i'), sortOrder: index }));
}

export function mockIntakePhoto(storageObjectId: string, name: string, sortOrder = 0): PhotoIntakePhotoView {
  return { id: nextId('p'), storageObjectId, name, sortOrder, healthDocumentId: null, retention: null };
}

export function mockScanIntake(
  gymId: string,
  overrides: Partial<PhotoIntakeView<EquipmentValue, GymScanContext>> = {},
): PhotoIntakeView<EquipmentValue, GymScanContext> {
  return {
    id: nextId('7'),
    kind: 'gym_equipment',
    status: 'draft',
    subjectType: 'gym',
    subjectId: gymId,
    context: { gymId },
    provider: null,
    modelId: null,
    jobId: null,
    errorCode: null,
    errorMessage: null,
    retention: 'keep',
    retainFiles: true,
    resultMeta: null,
    createdAt: T0,
    updatedAt: T0,
    completedAt: null,
    photos: [],
    items: [],
    ...overrides,
  };
}

export interface IntakeApiOptions {
  /** What the scan "finds" on the first read after `analyze`. */
  scanResult?: Draft[] | { failed: { code: string; message: string } };
  /** Reads that still answer `scanning` after `analyze` (default 0). */
  scanningReads?: number;
  /** `resultMeta` written with the scan result. */
  resultMeta?: Record<string, unknown>;
  /** What apply answers (defaults derived from the accepted items). */
  applyResult?: Partial<GymEquipmentApplyResult>;
}

export interface IntakeApiState {
  intakes: PhotoIntakeView<EquipmentValue, GymScanContext>[];
  calls: Array<{ method: string; path: string; body?: unknown }>;
}

/** Install a stateful `/api/intakes` for one test. */
export function statefulIntakeApi(
  initial: PhotoIntakeView<EquipmentValue, GymScanContext>[] = [],
  options: IntakeApiOptions = {},
): IntakeApiState {
  const state: IntakeApiState = { intakes: initial.map((i) => ({ ...i })), calls: [] };
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

  const settleScan = (intake: PhotoIntakeView<EquipmentValue, GymScanContext>) => {
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
    intake.items = [...kept, ...toItems(result).map((item, index) => ({ ...item, sortOrder: kept.length + index }))];
    intake.resultMeta = options.resultMeta ?? { promptVersion: 1, chunks: 1, photoCount: intake.photos.length, ignoredObjects: [], failedChunks: [] };
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
      const body = (await record(request, '/intakes')) as { context: GymScanContext; subjectId?: string };
      const intake = mockScanIntake(body.context.gymId, { subjectId: body.subjectId ?? null });
      state.intakes.push(intake);
      return HttpResponse.json({ data: intake }, { status: 201 });
    }),
    http.get(`${API}/intakes/:id`, ({ params }) => {
      const intake = find(String(params.id));
      if (!intake) return notFound();
      settleScan(intake);
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
      const photo = mockIntakePhoto(body.storageObjectId, 'photo.jpg', intake.photos.length);
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
      await record(request, `/intakes/${params.id}/analyze`);
      const intake = find(String(params.id));
      if (!intake) return notFound();
      intake.status = 'scanning';
      // The server resolves the model (#173); the body names none.
      intake.provider = 'openai';
      intake.modelId = 'gpt-5-mini';
      intake.jobId = 'job-scan-1';
      intake.errorCode = null;
      intake.errorMessage = null;
      scanningReadsLeft = options.scanningReads ?? 0;
      return HttpResponse.json({ data: { intakeId: intake.id, jobId: 'job-scan-1' } }, { status: 202 });
    }),
    http.post(`${API}/intakes/:id/items/accept-all`, async ({ request, params }) => {
      await record(request, `/intakes/${params.id}/items/accept-all`);
      const intake = find(String(params.id));
      if (!intake) return notFound();
      intake.items = intake.items.map((i) => (i.status === 'pending' ? { ...i, status: 'accepted', userVerified: true } : i));
      return HttpResponse.json({ data: intake.items });
    }),
    http.post(`${API}/intakes/:id/items`, async ({ request, params }) => {
      const body = (await record(request, `/intakes/${params.id}/items`)) as { kind: string; value: EquipmentValue };
      const intake = find(String(params.id));
      if (!intake) return notFound();
      const item: DraftItemView<EquipmentValue> = {
        id: nextId('i'),
        kind: body.kind,
        origin: 'user',
        status: 'accepted',
        confidence: null,
        uncertain: false,
        uncertaintyNote: null,
        sourcePhotoIds: [],
        userVerified: true,
        value: body.value,
        originalAiValue: null,
        sortOrder: intake.items.length,
      };
      intake.items.push(item);
      return HttpResponse.json({ data: item }, { status: 201 });
    }),
    http.patch(`${API}/intakes/:id/items/:itemId`, async ({ request, params }) => {
      const body = (await record(request, `/intakes/${params.id}/items/${params.itemId}`)) as {
        value?: EquipmentValue;
        status?: DraftItemView['status'];
      };
      const intake = find(String(params.id));
      const index = intake?.items.findIndex((i) => i.id === params.itemId) ?? -1;
      if (!intake || index < 0) return notFound();
      const current = intake.items[index];
      const next: DraftItemView<EquipmentValue> = { ...current };
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
      const pending = intake.items.filter((i) => i.status === 'pending').length;
      if (pending > 0) {
        return HttpResponse.json(
          { statusCode: 400, code: 'PENDING_ITEMS', message: `${pending} items are still pending`, details: { count: pending } },
          { status: 400 },
        );
      }
      intake.status = 'applied';
      const accepted = intake.items.filter((i) => i.status === 'accepted').length;
      const result: GymEquipmentApplyResult = {
        gymId: intake.context?.gymId ?? '',
        created: accepted,
        merged: 0,
        photosAttached: intake.photos.length,
        photosSkipped: 0,
        ...options.applyResult,
      };
      return HttpResponse.json({ data: result });
    }),
  );
  return state;
}
