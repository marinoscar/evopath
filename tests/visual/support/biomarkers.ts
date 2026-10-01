import type { Page, Route } from '@playwright/test';

/**
 * Fixture API for the biomarker pages, H5 (#189): `/health/biomarkers` and
 * `/health/biomarkers/:analyteKey`. The harness has no API behind it, so this
 * answers the lab catalog, `GET /api/health/biomarkers/summary`, a lab
 * `GET /api/measurements/series` and `GET /api/measurements` with
 * `page.route()`, the approach of `support/health.ts`. Anything else falls
 * through to the harness's Vite server.
 *
 * Values and limits are canonical, as the API answers them. The LDL series
 * comes from two labs: the second prints a tighter range (`≤ 100` against
 * `0–130`), and one hand-entered result has none, so the band has a gap.
 */

export const BIOMARKERS_FIXED_NOW = Date.parse('2026-09-29T12:00:00.000Z');

function lab(key: string, label: string, panel: string, unit: string, decimals: number) {
  return {
    key,
    label,
    category: 'lab',
    canonicalUnit: unit,
    units: [{ unit, factor: 1, label: unit }],
    displayUnit: { metric: unit, imperial: unit },
    min: 0,
    max: 10000,
    decimals,
    methods: ['lab'],
    scale: null,
    daily: false,
    panel,
    aliases: [],
  };
}

const CATALOG = {
  metrics: [
    lab('total_cholesterol', 'Total cholesterol', 'lipids', 'mg/dL', 0),
    lab('ldl_cholesterol', 'LDL cholesterol', 'lipids', 'mg/dL', 0),
    lab('hdl_cholesterol', 'HDL cholesterol', 'lipids', 'mg/dL', 0),
    lab('triglycerides', 'Triglycerides', 'lipids', 'mg/dL', 0),
    lab('fasting_glucose', 'Fasting glucose', 'glycemic', 'mg/dL', 0),
    lab('hba1c', 'HbA1c', 'glycemic', '%', 1),
    lab('tsh', 'TSH', 'thyroid', 'mIU/L', 2),
    lab('ferritin', 'Ferritin', 'iron', 'ng/mL', 0),
  ],
  methods: [{ key: 'lab', label: 'Lab' }],
};

type Flag = 'low' | 'normal' | 'high' | 'critical' | 'unknown' | null;

let seq = 0;
const id = () => `00000000-0000-4000-8e00-${String(++seq).padStart(12, '0')}`;

function result(value: number, measuredAt: string, flag: Flag, low: number | null, high: number | null) {
  return { measurementId: id(), value, measuredAt, flag, referenceLow: low, referenceHigh: high, referenceText: null };
}

const SEP = '2026-09-15T12:00:00.000Z';
const MAR = '2026-03-10T12:00:00.000Z';

function item(
  analyteKey: string,
  label: string,
  panel: string,
  unit: string,
  latest: ReturnType<typeof result>,
  previous: ReturnType<typeof result> | null,
  count: number,
) {
  return {
    analyteKey,
    label,
    panel,
    unit,
    latest,
    previous,
    delta: previous ? Number((latest.value - previous.value).toFixed(4)) : null,
    count,
  };
}

const SUMMARY = [
  item('total_cholesterol', 'Total cholesterol', 'lipids', 'mg/dL', result(214, SEP, 'high', null, 200), result(198, MAR, 'normal', null, 200), 3),
  item('ldl_cholesterol', 'LDL cholesterol', 'lipids', 'mg/dL', result(142, SEP, 'high', null, 100), result(130, MAR, 'normal', 0, 130), 4),
  item('hdl_cholesterol', 'HDL cholesterol', 'lipids', 'mg/dL', result(55, SEP, 'normal', 40, null), result(58, MAR, 'normal', 40, null), 2),
  item('triglycerides', 'Triglycerides', 'lipids', 'mg/dL', result(110, SEP, 'normal', 0, 150), result(140, MAR, 'normal', 0, 150), 2),
  item('fasting_glucose', 'Fasting glucose', 'glycemic', 'mg/dL', result(97, SEP, 'normal', 70, 99), result(94, MAR, 'normal', 70, 99), 2),
  item('hba1c', 'HbA1c', 'glycemic', '%', result(5.6, SEP, 'normal', 4, 5.6), result(5.6, MAR, 'normal', 4, 5.6), 2),
  item('tsh', 'TSH', 'thyroid', 'mIU/L', result(2.1, SEP, 'normal', 0.4, 4.5), null, 1),
  item('ferritin', 'Ferritin', 'iron', 'ng/mL', result(18, SEP, 'low', 30, 400), result(26, MAR, 'low', 30, 400), 2),
];

const KEPT_DOC = '00000000-0000-4000-8f00-000000000001';
const ERASED_DOC = '00000000-0000-4000-8f00-000000000002';

const LDL = [
  { measuredAt: '2025-09-20T12:00:00.000Z', value: 120, low: 0, high: 130, flag: 'normal' as Flag, origin: 'ai', doc: ERASED_DOC, deleted: true },
  { measuredAt: MAR, value: 130, low: 0, high: 130, flag: 'normal' as Flag, origin: 'ai', doc: ERASED_DOC, deleted: true },
  { measuredAt: '2026-06-01T12:00:00.000Z', value: 125, low: null, high: null, flag: null, origin: 'manual', doc: null, deleted: null },
  { measuredAt: SEP, value: 142, low: null, high: 100, flag: 'high' as Flag, origin: 'ai', doc: KEPT_DOC, deleted: false },
].map((row) => ({ ...row, id: id(), entryId: id() }));

function series(url: URL) {
  const metricKey = url.searchParams.get('metricKey') ?? 'ldl_cholesterol';
  const points = metricKey === 'ldl_cholesterol'
    ? LDL.map((row) => ({
        id: row.id,
        measuredAt: row.measuredAt,
        value: row.value,
        method: 'lab',
        origin: row.origin,
        referenceLow: row.low,
        referenceHigh: row.high,
        referenceText: null,
        flag: row.flag,
      }))
    : [];
  return { metricKey, unit: 'mg/dL', points, truncated: false };
}

function listPage(url: URL) {
  const metricKey = url.searchParams.get('metricKey');
  const pageSize = Number(url.searchParams.get('pageSize') ?? '25');
  const rows = metricKey === 'ldl_cholesterol'
    ? [...LDL].reverse().map((row) => ({
        id: row.id,
        entryId: row.entryId,
        metricKey,
        value: row.value,
        unit: 'mg/dL',
        measuredAt: row.measuredAt,
        method: 'lab',
        origin: row.origin,
        notes: null,
        sourceRef: row.doc ? { kind: 'lab_report', healthDocumentId: row.doc } : null,
        fileDeleted: row.deleted,
        revision: row.measuredAt === SEP ? 2 : 1,
        edited: row.measuredAt === SEP,
        referenceLow: row.low,
        referenceHigh: row.high,
        referenceText: null,
        flag: row.flag,
      }))
    : [];
  return { items: rows, total: rows.length, page: 1, pageSize, totalPages: rows.length ? 1 : 0 };
}

function answer(route: Route, data: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
}

/** Answer the biomarker endpoints. Call before `page.goto()`. */
export async function mockBiomarkersApi(page: Page): Promise<void> {
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    switch (url.pathname) {
      case '/api/measurements/metrics':
        return answer(route, CATALOG);
      case '/api/health/biomarkers/summary': {
        const panel = url.searchParams.get('panel');
        const outOfRange = url.searchParams.get('outOfRange') === 'true';
        return answer(route, {
          items: SUMMARY.filter(
            (i) => (!panel || i.panel === panel) && (!outOfRange || ['low', 'high', 'critical'].includes(i.latest.flag ?? '')),
          ),
        });
      }
      case '/api/measurements/series':
        return answer(route, series(url));
      case '/api/measurements':
        return answer(route, listPage(url));
      default:
        return route.fallback();
    }
  });
}
