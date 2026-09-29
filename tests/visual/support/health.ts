import type { Page, Route } from '@playwright/test';

/**
 * Fixture API for the Health page and the Today body snapshot — issue #53
 * (E2.3), epic E2.
 *
 * The harness (`apps/web/visual/main.tsx`) has no API behind it. These pages
 * ARE their data, so this answers `/api/measurements/metrics`,
 * `/api/measurements/latest` and `/api/health-profile` with `page.route()`,
 * the approach of `support/telemetryDashboard.ts`. Anything else falls through
 * to the harness's Vite server (`route.fallback()`).
 *
 * Every timestamp is a pure function of {@link FIXED_NOW}; specs pin the page
 * clock to it (`page.clock.setFixedTime`) so "Today" and "3 days ago" never
 * move. The catalog mirrors `catalogView()` in
 * `apps/api/src/measurements/metric-registry.ts` (body and vital metrics
 * only: the web app reads nothing else from it here).
 */

export const FIXED_NOW = Date.parse('2026-09-29T12:00:00.000Z');

export type HealthScenario = 'empty' | 'data';

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (msAgo: number) => new Date(FIXED_NOW - msAgo).toISOString();

const CATALOG = {
  metrics: [
    {
      key: 'weight',
      label: 'Weight',
      category: 'body',
      canonicalUnit: 'kg',
      units: [
        { unit: 'kg', factor: 1, label: 'kg' },
        { unit: 'lb', factor: 0.45359237, label: 'lb' },
      ],
      displayUnit: { metric: 'kg', imperial: 'lb' },
      min: 20,
      max: 500,
      decimals: 1,
      methods: ['unspecified', 'scale', 'smart_scale', 'clinical', 'other'],
      scale: null,
      daily: false,
    },
    {
      key: 'body_fat_pct',
      label: 'Body fat',
      category: 'body',
      canonicalUnit: '%',
      units: [{ unit: '%', factor: 1, label: '%' }],
      displayUnit: { metric: '%', imperial: '%' },
      min: 2,
      max: 70,
      decimals: 1,
      methods: ['unspecified', 'smart_scale', 'bia', 'skinfold', 'dexa', 'air_displacement', 'hydrostatic', 'other'],
      scale: null,
      daily: false,
    },
    {
      key: 'waist_circumference',
      label: 'Waist',
      category: 'body',
      canonicalUnit: 'cm',
      units: [
        { unit: 'cm', factor: 1, label: 'cm' },
        { unit: 'in', factor: 2.54, label: 'in' },
      ],
      displayUnit: { metric: 'cm', imperial: 'in' },
      min: 30,
      max: 250,
      decimals: 1,
      methods: ['unspecified', 'tape', 'other'],
      scale: null,
      daily: false,
    },
    {
      key: 'bp_systolic',
      label: 'Systolic pressure',
      category: 'vital',
      canonicalUnit: 'mmHg',
      units: [{ unit: 'mmHg', factor: 1, label: 'mmHg' }],
      displayUnit: { metric: 'mmHg', imperial: 'mmHg' },
      min: 60,
      max: 260,
      decimals: 0,
      methods: ['unspecified', 'bp_cuff', 'clinical', 'wearable', 'other'],
      scale: null,
      daily: false,
    },
    {
      key: 'bp_diastolic',
      label: 'Diastolic pressure',
      category: 'vital',
      canonicalUnit: 'mmHg',
      units: [{ unit: 'mmHg', factor: 1, label: 'mmHg' }],
      displayUnit: { metric: 'mmHg', imperial: 'mmHg' },
      min: 30,
      max: 160,
      decimals: 0,
      methods: ['unspecified', 'bp_cuff', 'clinical', 'wearable', 'other'],
      scale: null,
      daily: false,
    },
    {
      key: 'resting_hr',
      label: 'Resting heart rate',
      category: 'vital',
      canonicalUnit: 'bpm',
      units: [{ unit: 'bpm', factor: 1, label: 'bpm' }],
      displayUnit: { metric: 'bpm', imperial: 'bpm' },
      min: 25,
      max: 220,
      decimals: 0,
      methods: ['unspecified', 'wearable', 'bp_cuff', 'manual_pulse', 'other'],
      scale: null,
      daily: false,
    },
  ],
  methods: [
    { key: 'unspecified', label: 'Not specified' },
    { key: 'scale', label: 'Scale' },
    { key: 'smart_scale', label: 'Smart scale' },
    { key: 'bia', label: 'Bioelectrical impedance (BIA)' },
    { key: 'dexa', label: 'DEXA scan' },
    { key: 'air_displacement', label: 'Air displacement' },
    { key: 'skinfold', label: 'Skinfold calipers' },
    { key: 'hydrostatic', label: 'Hydrostatic weighing' },
    { key: 'tape', label: 'Tape measure' },
    { key: 'bp_cuff', label: 'Blood-pressure cuff' },
    { key: 'manual_pulse', label: 'Manual pulse' },
    { key: 'wearable', label: 'Wearable' },
    { key: 'clinical', label: 'Clinical' },
    { key: 'self_report', label: 'Self-report' },
    { key: 'other', label: 'Other' },
  ],
};

const UNITS: Record<string, string> = {
  weight: 'kg',
  body_fat_pct: '%',
  waist_circumference: 'cm',
  bp_systolic: 'mmHg',
  bp_diastolic: 'mmHg',
  resting_hr: 'bpm',
};

let n = 0;
function reading(metricKey: string, value: number, msAgo: number, entry: string, method = 'unspecified') {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    entryId: `00000000-0000-4000-9000-${entry.padStart(12, '0')}`,
    metricKey,
    value,
    unit: UNITS[metricKey],
    measuredAt: iso(msAgo),
    method,
    origin: 'manual',
    notes: null,
    sourceRef: null,
    revision: 1,
    edited: false,
  };
}

function latest(scenario: HealthScenario) {
  const keys = Object.keys(UNITS);
  if (scenario === 'empty') return keys.map((metricKey) => ({ metricKey, latest: null, previous: null }));

  const hours = 60 * 60 * 1000;
  const entries: Record<string, { latest: ReturnType<typeof reading>; previous: ReturnType<typeof reading> | null }> = {
    // 208.4 lb today, 208.9 lb three days ago.
    weight: { latest: reading('weight', 94.5327, 4 * hours, '1', 'smart_scale'), previous: reading('weight', 94.7595, 3 * DAY_MS, '2', 'smart_scale') },
    body_fat_pct: { latest: reading('body_fat_pct', 27.8, 4 * hours, '1', 'smart_scale'), previous: reading('body_fat_pct', 28.1, 3 * DAY_MS, '2', 'smart_scale') },
    // 34.0 in, a first reading: no delta.
    waist_circumference: { latest: reading('waist_circumference', 86.36, 3 * DAY_MS, '2', 'tape'), previous: null },
    bp_systolic: { latest: reading('bp_systolic', 128, 1 * DAY_MS, '3', 'bp_cuff'), previous: null },
    bp_diastolic: { latest: reading('bp_diastolic', 84, 1 * DAY_MS, '3', 'bp_cuff'), previous: null },
    resting_hr: { latest: reading('resting_hr', 58, 1 * DAY_MS, '4'), previous: reading('resting_hr', 58, 8 * DAY_MS, '5') },
  };
  return keys.map((metricKey) => ({ metricKey, ...entries[metricKey] }));
}

const PROFILE = {
  dateOfBirth: '1990-02-28',
  sexAtBirth: 'female',
  heightMm: 1778,
  unitSystem: 'imperial',
  timeZone: 'UTC',
  bio: null,
  version: 3,
  updatedAt: '2026-09-01T10:00:00.000Z',
};

function answer(route: Route, data: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
}

/** Answer the health endpoints with `scenario`. Call before `page.goto()`. */
export async function mockHealthApi(page: Page, scenario: HealthScenario): Promise<void> {
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    switch (url.pathname) {
      case '/api/measurements/metrics':
        return answer(route, CATALOG);
      case '/api/measurements/latest':
        return answer(route, { items: latest(scenario) });
      case '/api/health-profile':
        return answer(route, PROFILE);
      default:
        return route.fallback();
    }
  });
}
