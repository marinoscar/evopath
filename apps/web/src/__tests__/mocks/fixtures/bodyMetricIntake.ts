/**
 * A small stateful `/api/intakes` for the `body_metric_reading` kind (issue
 * #64, E2.6), as E3.1's API answers it: create, list (resume), photos,
 * analyze (202, then `scanning` for `scanPolls` reads, then the configured
 * result), item edits with `originalAiValue`/`userVerified`, accept-all,
 * apply and discard. Every request is recorded so a test can assert what was
 * (and was not) sent.
 */
import { http, HttpResponse } from 'msw';
import { server } from '../server';
import type { DraftItemView, PhotoIntakeStatus, PhotoIntakeView } from '../../../services/intake';
import type { BodyMetricReadingValue, MeasurementDto } from '../../../services/health';
import { mockMeasurement } from './measurements';

export type Reading = BodyMetricReadingValue;

const T0 = '2026-09-29T08:00:00.000Z';

let itemSeq = 0;

/** An AI draft item for a reading. */
export function readingItem(value: Reading, extra: Partial<DraftItemView<Reading>> = {}): DraftItemView<Reading> {
  itemSeq += 1;
  return {
    id: `item-${itemSeq}`,
    kind: 'reading',
    origin: 'ai',
    status: 'pending',
    confidence: 'high',
    uncertain: false,
    uncertaintyNote: null,
    sourcePhotoIds: ['obj-1'],
    userVerified: false,
    value,
    originalAiValue: null,
    sortOrder: itemSeq,
    ...extra,
  };
}

/** A scale display: one weight in pounds. */
export const scaleItems = () => [readingItem({ metricKey: 'weight', value: 208.4, unit: 'lb', method: 'scale' })];

/** A cuff display: systolic, diastolic and an uncertain pulse. */
export const cuffItems = () => [
  readingItem({ metricKey: 'bp_systolic', value: 128, unit: 'mmHg', method: 'bp_cuff' }),
  readingItem({ metricKey: 'bp_diastolic', value: 84, unit: 'mmHg', method: 'bp_cuff' }),
  readingItem(
    { metricKey: 'resting_hr', value: 72, unit: 'bpm', method: 'bp_cuff' },
    { confidence: 'medium', uncertain: true, uncertaintyNote: 'Pulse from a blood-pressure cuff may not be a resting rate' },
  ),
];

export function readingIntake(
  status: PhotoIntakeStatus,
  extra: Partial<PhotoIntakeView<Reading>> = {},
): PhotoIntakeView<Reading> {
  return {
    id: 'intake-1',
    kind: 'body_metric_reading',
    status,
    subjectType: null,
    subjectId: null,
    context: {},
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
    ...extra,
  };
}

export interface ScanResult {
  status?: 'ready' | 'failed';
  items?: DraftItemView<Reading>[];
  resultMeta?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
}

export interface ReadingIntakeApiOptions {
  /** Intakes the list (resume) route answers; default none. */
  existing?: PhotoIntakeView<Reading>[];
  /** What the scan ends with. */
  result?: ScanResult;
  /** GETs answered `scanning` before the result; default 1. */
  scanPolls?: number;
  /** A refusal for analyze: `{ status, body }` (an error envelope). */
  analyzeError?: { status: number; body: unknown };
  /** A refusal for create. `network` fails the request outright. */
  createError?: { status: number; body: unknown } | 'network';
  /** A refusal for apply, answered once. */
  applyError?: { status: number; body: unknown };
  /** What apply saves; by default one canonical row per accepted AI/user item. */
  applyItems?: (accepted: DraftItemView<Reading>[]) => MeasurementDto[];
}

export interface ReadingIntakeApiState {
  intakes: Map<string, PhotoIntakeView<Reading>>;
  requests: { method: string; path: string; body?: unknown }[];
  created: number;
  analyzed: { provider: string; modelId: string }[];
  itemPatches: { itemId: string; body: Record<string, unknown> }[];
  itemPosts: { kind: string; value: Reading }[];
  applied: number;
  discarded: number;
}

/** Error envelope as the API's exception filter writes it. */
export function apiError(status: number, message: string, details?: Record<string, unknown>, code = 'ERROR') {
  return { status, body: { code, message, ...(details ? { details } : {}) } };
}

export function readingIntakeApi(options: ReadingIntakeApiOptions = {}): ReadingIntakeApiState {
  const state: ReadingIntakeApiState = {
    intakes: new Map((options.existing ?? []).map((intake) => [intake.id, structuredClone(intake)])),
    requests: [],
    created: 0,
    analyzed: [],
    itemPatches: [],
    itemPosts: [],
    applied: 0,
    discarded: 0,
  };
  // A resumed intake that is already scanning answers `scanning` for `scanPolls` reads too.
  let pollsLeft = new Map<string, number>(
    (options.existing ?? []).filter((i) => i.status === 'scanning').map((i) => [i.id, options.scanPolls ?? 1]),
  );
  let applyError = options.applyError;

  const view = (id: string) => {
    const intake = state.intakes.get(id)!;
    return { ...intake, items: [...intake.items].sort((a, b) => a.sortOrder - b.sortOrder) };
  };
  const notFound = () => HttpResponse.json({ code: 'NOT_FOUND', message: 'Intake not found' }, { status: 404 });
  const record = async (request: Request, path: string) => {
    let body: unknown;
    try {
      body = await request.clone().json();
    } catch {
      body = undefined;
    }
    state.requests.push({ method: request.method, path, body });
    return body;
  };

  server.use(
    http.get('*/api/intakes', async ({ request }) => {
      await record(request, new URL(request.url).pathname + new URL(request.url).search);
      const url = new URL(request.url);
      const statuses = url.searchParams.get('status')?.split(',') ?? null;
      const rows = [...state.intakes.values()]
        .filter((intake) => intake.kind === url.searchParams.get('kind'))
        .filter((intake) => !statuses || statuses.includes(intake.status))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(({ photos, items, ...rest }) => ({ ...rest, photoCount: photos.length, itemCount: items.length }));
      return HttpResponse.json({ data: rows });
    }),

    http.post('*/api/intakes', async ({ request }) => {
      await record(request, '/api/intakes');
      if (options.createError === 'network') return HttpResponse.error();
      if (options.createError) return HttpResponse.json(options.createError.body, { status: options.createError.status });
      state.created += 1;
      const intake = readingIntake('draft', { id: `intake-new-${state.created}` });
      state.intakes.set(intake.id, intake);
      return HttpResponse.json({ data: intake }, { status: 201 });
    }),

    http.get('*/api/intakes/:id', async ({ request, params }) => {
      const id = String(params.id);
      await record(request, `/api/intakes/${id}`);
      const intake = state.intakes.get(id);
      if (!intake) return notFound();
      if (intake.status === 'scanning') {
        const left = pollsLeft.get(id) ?? 0;
        if (left > 0) {
          pollsLeft.set(id, left - 1);
        } else {
          const result = options.result ?? { items: scaleItems() };
          intake.status = result.status ?? 'ready';
          intake.items = result.items ?? [];
          intake.resultMeta = { promptVersion: 1, unreadable: false, ...(result.resultMeta ?? {}) };
          intake.errorCode = result.errorCode ?? null;
          intake.errorMessage = result.errorMessage ?? null;
        }
      }
      return HttpResponse.json({ data: view(id) });
    }),

    http.delete('*/api/intakes/:id', async ({ request, params }) => {
      const id = String(params.id);
      await record(request, `/api/intakes/${id}`);
      if (!state.intakes.delete(id)) return notFound();
      state.discarded += 1;
      return new HttpResponse(null, { status: 204 });
    }),

    http.post('*/api/intakes/:id/photos', async ({ request, params }) => {
      const id = String(params.id);
      const body = (await record(request, `/api/intakes/${id}/photos`)) as { storageObjectId: string };
      const intake = state.intakes.get(id);
      if (!intake) return notFound();
      const photo = { id: `p-${intake.photos.length + 1}`, storageObjectId: body.storageObjectId, name: 'scale.jpg', sortOrder: intake.photos.length };
      intake.photos.push(photo);
      return HttpResponse.json({ data: photo }, { status: 201 });
    }),

    http.delete('*/api/intakes/:id/photos/:objectId', async ({ request, params }) => {
      const id = String(params.id);
      await record(request, `/api/intakes/${id}/photos/${String(params.objectId)}`);
      const intake = state.intakes.get(id);
      if (intake) intake.photos = intake.photos.filter((p) => p.storageObjectId !== params.objectId);
      return new HttpResponse(null, { status: 204 });
    }),

    http.post('*/api/intakes/:id/analyze', async ({ request, params }) => {
      const id = String(params.id);
      const body = (await record(request, `/api/intakes/${id}/analyze`)) as { provider: string; modelId: string };
      if (options.analyzeError) return HttpResponse.json(options.analyzeError.body, { status: options.analyzeError.status });
      const intake = state.intakes.get(id);
      if (!intake) return notFound();
      state.analyzed.push(body);
      intake.status = 'scanning';
      intake.provider = body.provider;
      intake.modelId = body.modelId;
      pollsLeft = new Map(pollsLeft).set(id, options.scanPolls ?? 1);
      return HttpResponse.json({ data: { intakeId: id, jobId: 'job-1' } }, { status: 202 });
    }),

    http.post('*/api/intakes/:id/items', async ({ request, params }) => {
      const id = String(params.id);
      const body = (await record(request, `/api/intakes/${id}/items`)) as { kind: string; value: Reading };
      const intake = state.intakes.get(id);
      if (!intake) return notFound();
      state.itemPosts.push(body);
      const item = readingItem(body.value, {
        origin: 'user',
        status: 'accepted',
        confidence: null,
        userVerified: true,
        sourcePhotoIds: [],
      });
      intake.items.push(item);
      return HttpResponse.json({ data: item }, { status: 201 });
    }),

    http.patch('*/api/intakes/:id/items/:itemId', async ({ request, params }) => {
      const id = String(params.id);
      const itemId = String(params.itemId);
      const body = (await record(request, `/api/intakes/${id}/items/${itemId}`)) as Record<string, unknown>;
      const intake = state.intakes.get(id);
      const item = intake?.items.find((entry) => entry.id === itemId);
      if (!intake || !item) return notFound();
      state.itemPatches.push({ itemId, body });
      if (body.value !== undefined) {
        if (item.origin === 'ai' && item.originalAiValue === null) item.originalAiValue = item.value;
        item.value = body.value as Reading;
        item.userVerified = true;
      }
      if (typeof body.status === 'string') {
        item.status = body.status as DraftItemView['status'];
        if (body.status === 'accepted') item.userVerified = true;
      }
      return HttpResponse.json({ data: item });
    }),

    http.post('*/api/intakes/:id/items/accept-all', async ({ request, params }) => {
      const id = String(params.id);
      await record(request, `/api/intakes/${id}/items/accept-all`);
      const intake = state.intakes.get(id);
      if (!intake) return notFound();
      const changed = intake.items.filter((item) => item.status === 'pending');
      for (const item of changed) {
        item.status = 'accepted';
        item.userVerified = true;
      }
      return HttpResponse.json({ data: changed });
    }),

    http.post('*/api/intakes/:id/apply', async ({ request, params }) => {
      const id = String(params.id);
      await record(request, `/api/intakes/${id}/apply`);
      const intake = state.intakes.get(id);
      if (!intake) return notFound();
      if (applyError) {
        const refusal = applyError;
        applyError = undefined;
        return HttpResponse.json(refusal.body, { status: refusal.status });
      }
      if (intake.status === 'applied') {
        return HttpResponse.json(apiError(409, 'This intake was already applied', { reason: 'ALREADY_APPLIED' }, 'CONFLICT').body, {
          status: 409,
        });
      }
      const accepted = intake.items.filter((item) => item.status === 'accepted');
      intake.status = 'applied';
      state.applied += 1;
      const items =
        options.applyItems?.(accepted) ??
        accepted.map((item) =>
          mockMeasurement(item.value.metricKey, item.value.value, {
            entryId: 'entry-photo-1',
            origin: item.origin === 'ai' ? 'ai' : 'manual',
            method: item.value.method ?? 'unspecified',
          }),
        );
      return HttpResponse.json({ data: { entryId: items.length ? 'entry-photo-1' : null, items } });
    }),

    // Photos upload already `ready` so the tile does not wait on processing.
    http.post('*/api/storage/objects', () =>
      HttpResponse.json(
        {
          data: {
            id: 'obj-1',
            name: 'scale.jpg',
            size: '1024',
            mimeType: 'image/jpeg',
            status: 'ready',
            metadata: null,
            createdAt: T0,
            updatedAt: T0,
          },
        },
        { status: 201 },
      ),
    ),
  );
  return state;
}
