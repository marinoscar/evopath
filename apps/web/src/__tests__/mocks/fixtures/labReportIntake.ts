/**
 * A small stateful `/api/intakes` for the `lab_report` kind (H4, #188), plus
 * `GET /api/measurements/lab-reports/:id/duplicates` and a lab catalog, as the
 * API answers them (docs/specs/health-records.md §2.10).
 *
 * The scan ends with the fake vision server's `lab-report-panel` drafts as the
 * server would store them after matching and conversion: four lipids, an
 * unmatched "Lipoprotein (a)", glucose 5.4 mmol/L drafted as 97.2973 mg/dL,
 * and HbA1c. An edit re-matches like `normalizeValue` (a key the printed name
 * does not resolve to is `user_mapped`); apply refuses accepted unmatched
 * results with 409 `UNRESOLVED_ANALYTES`. Every request is recorded.
 */
import { http, HttpResponse } from 'msw';
import { server } from '../server';
import type { DraftItemView, PhotoIntakeStatus, PhotoIntakeView } from '../../../services/intake';
import type { MetricCatalog, MetricDef } from '../../../services/health';
import type {
  LabReportContext,
  LabReportDuplicate,
  LabReportValue,
} from '../../../services/labReport';
import { mockMeasurement, mockMetricCatalog } from './measurements';

const T0 = '2026-09-29T08:00:00.000Z';

/** A unit an analyte accepts: `canonical = value × factor + offset`, shown with `decimals`. */
interface AltUnit {
  unit: string;
  factor: number;
  offset?: number;
  decimals?: number;
}

function lab(
  key: string,
  label: string,
  panel: string,
  canonicalUnit: string,
  alt: AltUnit[],
  aliases: string[],
  options: { min?: number; max?: number; decimals?: number; siUnit?: string } = {},
): MetricDef {
  return {
    key,
    label,
    category: 'lab',
    canonicalUnit,
    units: [{ unit: canonicalUnit, factor: 1, label: canonicalUnit }, ...alt.map((u) => ({ ...u, label: u.unit }))],
    displayUnit: { metric: canonicalUnit, imperial: canonicalUnit },
    min: options.min ?? 0,
    max: options.max ?? 10000,
    decimals: options.decimals ?? 1,
    methods: ['lab'],
    scale: null,
    daily: false,
    panel,
    aliases,
    // #234: the unit the SI preference shows; the canonical one when they agree.
    siUnit: options.siUnit ?? canonicalUnit,
  };
}

/** `per(x)`: the registry's "x SI units per conventional unit", as a factor. */
const per = (x: number) => 1 / x;
const CHOLESTEROL_MMOL: AltUnit = { unit: 'mmol/L', factor: per(0.02586), decimals: 2 }; // 38.6698
const SI = { siUnit: 'mmol/L' };

/** The lab analytes the tests need, mirroring `metric-registry.ts`. */
export const LAB_METRICS: MetricDef[] = [
  lab('total_cholesterol', 'Total cholesterol', 'lipids', 'mg/dL', [CHOLESTEROL_MMOL], ['Cholesterol', 'Cholesterol, total', 'TC'], SI),
  lab('ldl_cholesterol', 'LDL cholesterol', 'lipids', 'mg/dL', [CHOLESTEROL_MMOL], ['LDL', 'LDL-C', 'LDL Chol Calc'], SI),
  lab('hdl_cholesterol', 'HDL cholesterol', 'lipids', 'mg/dL', [CHOLESTEROL_MMOL], ['HDL', 'HDL-C'], SI),
  lab('triglycerides', 'Triglycerides', 'lipids', 'mg/dL', [{ unit: 'mmol/L', factor: per(0.01129), decimals: 2 }], ['TG', 'TRIG'], SI),
  lab('apob', 'Apolipoprotein B', 'lipids', 'mg/dL', [{ unit: 'g/L', factor: 100, decimals: 2 }], ['ApoB', 'Apo B'], { siUnit: 'g/L' }),
  lab('fasting_glucose', 'Fasting glucose', 'glycemic', 'mg/dL', [{ unit: 'mmol/L', factor: per(0.0555), decimals: 2 }], ['Glucose', 'FPG', 'GLU'], SI),
  lab('hba1c', 'HbA1c', 'glycemic', '%', [{ unit: 'mmol/mol', factor: per(10.929), offset: 2.15, decimals: 0 }], ['A1c', 'Hemoglobin A1c'], {
    siUnit: 'mmol/mol',
  }),
  lab('creatinine', 'Creatinine', 'cmp', 'mg/dL', [{ unit: 'µmol/L', factor: per(88.42), decimals: 0 }], ['CREA', 'Creat'], {
    decimals: 2,
    siUnit: 'µmol/L',
  }),
  lab('tsh', 'TSH', 'thyroid', 'mIU/L', [{ unit: 'µIU/mL', factor: 1 }], ['Thyrotropin', 'Thyroid stimulating hormone']),
];

/** `GET /api/measurements/metrics` with the lab analytes appended. */
export const mockLabCatalog: MetricCatalog = {
  metrics: [...mockMetricCatalog.metrics, ...LAB_METRICS],
  methods: [...mockMetricCatalog.methods, { key: 'lab', label: 'Lab' }],
};

function resolves(name: string | null, key: string): boolean {
  if (!name) return false;
  const metric = LAB_METRICS.find((m) => m.key === key);
  const needle = name.trim().toLowerCase();
  return !!metric && [metric.key, metric.label, ...(metric.aliases ?? [])].some((n) => n.toLowerCase() === needle);
}

export function labValue(overrides: Partial<LabReportValue>): LabReportValue {
  return {
    analyteKey: null,
    nameAsPrinted: null,
    value: null,
    unit: null,
    valueText: null,
    originalValue: null,
    originalUnit: null,
    referenceLow: null,
    referenceHigh: null,
    referenceText: null,
    flag: null,
    panel: null,
    match: 'matched',
    ...overrides,
  };
}

let itemSeq = 0;

export function labItem(value: LabReportValue, extra: Partial<DraftItemView<LabReportValue>> = {}): DraftItemView<LabReportValue> {
  itemSeq += 1;
  return {
    id: `lab-item-${itemSeq}`,
    kind: 'result',
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

/** The `lab-report-panel` fixture as drafted by the server. */
export function panelItems(): DraftItemView<LabReportValue>[] {
  return [
    labItem(labValue({ analyteKey: 'total_cholesterol', nameAsPrinted: 'Cholesterol, Total', value: 212, unit: 'mg/dL', referenceHigh: 200, referenceText: '<200', flag: 'high', panel: 'lipids' })),
    labItem(labValue({ analyteKey: 'hdl_cholesterol', nameAsPrinted: 'HDL Cholesterol', value: 48, unit: 'mg/dL', referenceLow: 39, referenceText: '>39', panel: 'lipids' })),
    labItem(labValue({ analyteKey: 'ldl_cholesterol', nameAsPrinted: 'LDL Chol Calc', value: 138, unit: 'mg/dL', referenceLow: 0, referenceHigh: 99, referenceText: '0-99', flag: 'high', panel: 'lipids' })),
    labItem(labValue({ analyteKey: 'triglycerides', nameAsPrinted: 'Triglycerides', value: 130, unit: 'mg/dL', referenceLow: 0, referenceHigh: 149, referenceText: '0-149', panel: 'lipids' })),
    labItem(
      labValue({ analyteKey: null, nameAsPrinted: 'Lipoprotein (a)', value: 32, unit: 'nmol/L', referenceHigh: 75, referenceText: '<75', panel: 'lipids', match: 'unmatched' }),
      { uncertain: true, uncertaintyNote: 'Not in the lab catalog: map it to an analyte or reject it' },
    ),
    labItem(
      labValue({
        analyteKey: 'fasting_glucose',
        nameAsPrinted: 'Glucose',
        value: 97.2973,
        unit: 'mg/dL',
        originalValue: 5.4,
        originalUnit: 'mmol/L',
        referenceLow: 70.2703,
        referenceHigh: 99.0991,
        referenceText: '3.9-5.5',
        panel: 'glycemic',
      }),
    ),
    labItem(labValue({ analyteKey: 'hba1c', nameAsPrinted: 'Hemoglobin A1c', value: 5.6, unit: '%', referenceLow: 4.8, referenceHigh: 5.6, referenceText: '4.8-5.6', panel: 'glycemic' }), {
      confidence: 'medium',
    }),
  ];
}

export function labIntake(
  status: PhotoIntakeStatus,
  extra: Partial<PhotoIntakeView<LabReportValue, LabReportContext>> = {},
): PhotoIntakeView<LabReportValue, LabReportContext> {
  return {
    id: 'lab-intake-1',
    kind: 'lab_report',
    status,
    subjectType: null,
    subjectId: null,
    context: null,
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
    ...extra,
  };
}

export interface LabIntakeApiOptions {
  /** Intakes the list (resume) route answers. */
  existing?: PhotoIntakeView<LabReportValue, LabReportContext>[];
  /** What a scan ends with; default the panel, collected 2026-09-15. */
  result?: { items: DraftItemView<LabReportValue>[]; context?: LabReportContext };
  /** What the duplicates route answers for each check (default none). */
  duplicates?: (intake: PhotoIntakeView<LabReportValue, LabReportContext>) => LabReportDuplicate[];
  /** A refusal for an item PATCH, answered once. */
  itemPatchError?: { status: number; body: unknown };
  /** The name the server reports for an attached file. */
  photoName?: string;
}

export interface LabIntakeApiState {
  intakes: Map<string, PhotoIntakeView<LabReportValue, LabReportContext>>;
  requests: { method: string; path: string; body?: unknown }[];
  created: { kind: string; retainFiles?: boolean }[];
  itemPatches: { itemId: string; body: Record<string, unknown> }[];
  itemPosts: { kind: string; value: Partial<LabReportValue> }[];
  intakePatches: { id: string; body: Record<string, unknown> }[];
  duplicateChecks: number;
  applied: number;
}

export function labIntakeApi(options: LabIntakeApiOptions = {}): LabIntakeApiState {
  const state: LabIntakeApiState = {
    intakes: new Map((options.existing ?? []).map((intake) => [intake.id, structuredClone(intake)])),
    requests: [],
    created: [],
    itemPatches: [],
    itemPosts: [],
    intakePatches: [],
    duplicateChecks: 0,
    applied: 0,
  };
  let itemPatchError = options.itemPatchError;
  let uploads = 0;

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
  /** The server's `normalizeValue`, enough for these tests. */
  const normalize = (raw: Partial<LabReportValue>, previous?: LabReportValue): LabReportValue => {
    const next = labValue({ ...(previous ?? {}), ...raw });
    const metric = LAB_METRICS.find((m) => m.key === next.analyteKey);
    next.match = !next.analyteKey ? 'unmatched' : resolves(next.nameAsPrinted, next.analyteKey) ? 'matched' : 'user_mapped';
    next.panel = (metric?.panel as LabReportValue['panel']) ?? next.panel;
    if (metric && next.unit === null) next.unit = metric.canonicalUnit;
    return next;
  };

  server.use(
    http.get('*/api/measurements/metrics', () => HttpResponse.json({ data: mockLabCatalog })),

    http.get('*/api/intakes', async ({ request }) => {
      const url = new URL(request.url);
      await record(request, url.pathname + url.search);
      const statuses = url.searchParams.get('status')?.split(',') ?? null;
      const rows = [...state.intakes.values()]
        .filter((intake) => intake.kind === url.searchParams.get('kind'))
        .filter((intake) => !statuses || statuses.includes(intake.status))
        .map(({ photos, items, ...rest }) => ({ ...rest, photoCount: photos.length, itemCount: items.length }));
      return HttpResponse.json({ data: rows });
    }),

    http.post('*/api/intakes', async ({ request }) => {
      const body = ((await record(request, '/api/intakes')) ?? {}) as { kind: string; retainFiles?: boolean };
      state.created.push(body);
      const retainFiles = body.retainFiles !== false;
      const intake = labIntake('draft', {
        id: `lab-intake-new-${state.created.length}`,
        retainFiles,
        retention: retainFiles ? 'keep' : 'delete_after_processing',
      });
      state.intakes.set(intake.id, intake);
      return HttpResponse.json({ data: intake }, { status: 201 });
    }),

    http.get('*/api/intakes/:id', async ({ request, params }) => {
      const id = String(params.id);
      await record(request, `/api/intakes/${id}`);
      const intake = state.intakes.get(id);
      if (!intake) return notFound();
      if (intake.status === 'scanning') {
        const result = options.result ?? { items: panelItems(), context: { collectionDate: '2026-09-15', labName: 'Acme Clinical Laboratories' } };
        intake.status = 'ready';
        intake.items = result.items;
        intake.context = result.context ?? null;
        intake.resultMeta = { promptVersion: 1, unmatched: 1 };
      }
      return HttpResponse.json({ data: view(id) });
    }),

    http.patch('*/api/intakes/:id', async ({ request, params }) => {
      const id = String(params.id);
      const body = (await record(request, `/api/intakes/${id}`)) as Record<string, unknown>;
      state.intakePatches.push({ id, body });
      const intake = state.intakes.get(id);
      if (!intake) return notFound();
      if (body.context !== undefined) intake.context = body.context as LabReportContext;
      if (typeof body.retainFiles === 'boolean') {
        intake.retainFiles = body.retainFiles;
        intake.retention = body.retainFiles ? 'keep' : 'delete_after_processing';
      }
      return HttpResponse.json({ data: view(id) });
    }),

    http.delete('*/api/intakes/:id', async ({ request, params }) => {
      const id = String(params.id);
      await record(request, `/api/intakes/${id}`);
      state.intakes.delete(id);
      return new HttpResponse(null, { status: 204 });
    }),

    http.post('*/api/intakes/:id/photos', async ({ request, params }) => {
      const id = String(params.id);
      const body = (await record(request, `/api/intakes/${id}/photos`)) as { storageObjectId: string; retainFiles?: boolean };
      const intake = state.intakes.get(id);
      if (!intake) return notFound();
      const keep = body.retainFiles ?? intake.retainFiles;
      const photo = {
        id: `p-${intake.photos.length + 1}`,
        storageObjectId: body.storageObjectId,
        name: options.photoName ?? 'report.pdf',
        sortOrder: intake.photos.length,
        healthDocumentId: `doc-${intake.photos.length + 1}`,
        retention: keep ? ('keep' as const) : ('delete_after_processing' as const),
      };
      intake.photos.push(photo);
      return HttpResponse.json({ data: photo }, { status: 201 });
    }),

    http.post('*/api/intakes/:id/analyze', async ({ request, params }) => {
      const id = String(params.id);
      await record(request, `/api/intakes/${id}/analyze`);
      const intake = state.intakes.get(id);
      if (!intake) return notFound();
      intake.status = 'scanning';
      intake.provider = 'openai';
      intake.modelId = 'gpt-5-mini';
      return HttpResponse.json({ data: { intakeId: id, jobId: 'job-1' } }, { status: 202 });
    }),

    http.post('*/api/intakes/:id/items', async ({ request, params }) => {
      const id = String(params.id);
      const body = (await record(request, `/api/intakes/${id}/items`)) as { kind: string; value: Partial<LabReportValue> };
      const intake = state.intakes.get(id);
      if (!intake) return notFound();
      state.itemPosts.push(body);
      const item = labItem(normalize(body.value), {
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
      if (itemPatchError) {
        const refusal = itemPatchError;
        itemPatchError = undefined;
        return HttpResponse.json(refusal.body, { status: refusal.status });
      }
      if (body.value !== undefined) {
        if (item.origin === 'ai' && item.originalAiValue === null) item.originalAiValue = item.value;
        item.value = normalize(body.value as Partial<LabReportValue>, item.value);
        item.userVerified = true;
        item.uncertain = false;
        item.uncertaintyNote = null;
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
      const pending = intake.items.filter((item) => item.status === 'pending');
      if (pending.length > 0) {
        return HttpResponse.json(
          { code: 'BAD_REQUEST', message: 'Items are pending', details: { reason: 'PENDING_ITEMS', count: pending.length } },
          { status: 400 },
        );
      }
      const accepted = intake.items.filter((item) => item.status === 'accepted');
      const unresolved = accepted.filter((item) => !item.value.analyteKey).map((item) => item.id);
      if (unresolved.length > 0) {
        return HttpResponse.json(
          {
            code: 'CONFLICT',
            message: 'Some results are not matched to a lab analyte',
            details: { reason: 'UNRESOLVED_ANALYTES', itemIds: unresolved, count: unresolved.length },
          },
          { status: 409 },
        );
      }
      intake.status = 'applied';
      state.applied += 1;
      const collectionDate = intake.context?.collectionDate ?? null;
      const items = accepted.map((item) =>
        mockMeasurement(item.value.analyteKey!, item.value.value ?? 0, {
          entryId: 'entry-lab-1',
          unit: item.value.unit ?? '',
          method: 'lab',
          origin: item.origin === 'ai' ? 'ai' : 'manual',
        }),
      );
      return HttpResponse.json({
        data: {
          entryId: items.length ? 'entry-lab-1' : null,
          items,
          measuredAtSource: collectionDate ? 'collection_date' : 'apply_time',
          documentDate: collectionDate,
        },
      });
    }),

    http.get('*/api/measurements/lab-reports/:intakeId/duplicates', async ({ request, params }) => {
      const id = String(params.intakeId);
      await record(request, `/api/measurements/lab-reports/${id}/duplicates`);
      const intake = state.intakes.get(id);
      if (!intake) return notFound();
      state.duplicateChecks += 1;
      return HttpResponse.json({
        data: {
          intakeId: id,
          checkedDate: intake.context?.collectionDate ?? '2026-10-01',
          collectionDate: intake.context?.collectionDate ?? null,
          duplicates: options.duplicates?.(intake) ?? [],
        },
      });
    }),

    http.post('*/api/storage/objects', async () => {
      uploads += 1;
      return HttpResponse.json(
        {
          data: {
            id: `obj-${uploads}`,
            name: options.photoName ?? 'report.pdf',
            size: '1024',
            mimeType: 'application/pdf',
            status: 'ready',
            metadata: null,
            createdAt: T0,
            updatedAt: T0,
          },
        },
        { status: 201 },
      );
    }),
  );
  return state;
}

/** The duplicate the server reports for a saved total cholesterol of the same day and value. */
export function cholesterolDuplicate(intake: PhotoIntakeView<LabReportValue, LabReportContext>): LabReportDuplicate[] {
  const item = intake.items.find((entry) => entry.value.analyteKey === 'total_cholesterol' && entry.status !== 'rejected');
  if (!item) return [];
  return [
    {
      itemId: item.id,
      analyteKey: 'total_cholesterol',
      value: 212,
      unit: 'mg/dL',
      matches: [
        {
          measurementId: 'm-1',
          entryId: 'e-1',
          measuredAt: '2026-09-15T12:00:00.000Z',
          origin: 'ai',
          healthDocumentId: 'doc-old',
          intakeId: 'lab-intake-old',
        },
      ],
    },
  ];
}
