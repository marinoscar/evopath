import type { Page, Route } from '@playwright/test';

/**
 * Fixture API for the Health page, the Today body snapshot (issue #53, E2.3),
 * the daily check-in (issue #56, E2.4) and the Trend and History sections
 * (issue #60, E2.5), epic E2.
 *
 * The harness (`apps/web/visual/main.tsx`) has no API behind it. These pages
 * ARE their data, so this answers `/api/measurements/metrics`,
 * `/api/measurements/latest`, `/api/measurements` (History),
 * `/api/measurements/series` (Trend) and `/api/health-profile` with
 * `page.route()`, and `/api/check-ins/*` (the check-in section, the dialog and
 * the Today Readiness card), the approach of `support/telemetryDashboard.ts`.
 * Anything else falls through
 * to the harness's Vite server (`route.fallback()`).
 *
 * Every timestamp is a pure function of {@link FIXED_NOW}; specs pin the page
 * clock to it (`page.clock.setFixedTime`) so "Today" and "3 days ago" never
 * move. The catalog mirrors `catalogView()` in
 * `apps/api/src/measurements/metric-registry.ts` (the body and vital metrics,
 * and the four wellness scores the check-in reads its scales from).
 */

export const FIXED_NOW = Date.parse('2026-09-29T12:00:00.000Z');

export type HealthScenario = 'empty' | 'data';

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (msAgo: number) => new Date(FIXED_NOW - msAgo).toISOString();

/** A daily 1-5 self-report score, as the registry's `wellness()` builds it. */
function wellness(key: string, label: string, lowLabel: string, highLabel: string) {
  return {
    key,
    label,
    category: 'wellness',
    canonicalUnit: 'score',
    units: [{ unit: 'score', factor: 1, label: 'score' }],
    displayUnit: { metric: 'score', imperial: 'score' },
    min: 1,
    max: 5,
    decimals: 0,
    methods: ['self_report'],
    scale: { min: 1, max: 5, lowLabel, highLabel },
    daily: true,
  };
}

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
    wellness('energy', 'Energy', 'Drained', 'Energised'),
    wellness('sleep_quality', 'Sleep quality', 'Poor', 'Great'),
    wellness('muscle_soreness', 'Muscle soreness', 'None', 'Severe'),
    wellness('stress', 'Stress', 'Calm', 'Overwhelmed'),
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
function reading(
  metricKey: string,
  value: number,
  msAgo: number,
  entry: string,
  method = 'unspecified',
  extra: { revision?: number; notes?: string | null } = {},
) {
  n += 1;
  const revision = extra.revision ?? 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    entryId: `00000000-0000-4000-9000-${entry.padStart(12, '0')}`,
    metricKey,
    value,
    unit: UNITS[metricKey],
    measuredAt: iso(msAgo),
    method,
    origin: 'manual',
    notes: extra.notes ?? null,
    sourceRef: null,
    revision,
    edited: revision > 1,
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

/** The server's "today" (the profile time zone is UTC) at {@link FIXED_NOW}. */
export const CHECK_IN_TODAY = '2026-09-29';

function checkIn(date: string, scores: [number | null, number | null, number | null, number | null], note: string | null) {
  const [energy, sleepQuality, soreness, stress] = scores;
  return { date, energy, sleepQuality, soreness, stress, note, updatedAt: `${date}T07:30:00.000Z` };
}

/** Today (four scores and a note) and three earlier days, newest first. */
function checkIns(scenario: HealthScenario) {
  if (scenario === 'empty') return [];
  return [
    checkIn(CHECK_IN_TODAY, [4, 3, 2, 3], 'Big presentation'),
    checkIn('2026-09-28', [3, 4, 3, 2], null),
    checkIn('2026-09-26', [2, null, 4, null], 'Long run yesterday'),
    checkIn('2026-09-24', [5, 5, 1, 1], null),
  ];
}

/**
 * Every stored reading of the `data` scenario, newest first (History and the
 * Trend series read this). Twelve weights over four weeks alternating "Scale"
 * and "Smart scale", so the chart draws two series and the mixed-methods note;
 * the weight 16 days ago was edited (revision 2, the Edited chip). The newest
 * two weights and the other metrics are the tiles' latest/previous readings.
 */
function history(scenario: HealthScenario) {
  if (scenario === 'empty') return [];
  const hours = 60 * 60 * 1000;
  const weights: Array<[msAgo: number, kg: number, method: string, entry: string, revision?: number]> = [
    [4 * hours, 94.5327, 'smart_scale', '1'],
    [3 * DAY_MS, 94.7595, 'smart_scale', '2'],
    [6 * DAY_MS, 94.8, 'smart_scale', '10'],
    [8 * DAY_MS, 95.0, 'scale', '11'],
    [10 * DAY_MS, 94.9, 'smart_scale', '12'],
    [13 * DAY_MS, 95.2, 'scale', '13'],
    [16 * DAY_MS, 95.1, 'smart_scale', '14', 2],
    [18 * DAY_MS, 95.4, 'scale', '15'],
    [21 * DAY_MS, 95.3, 'smart_scale', '16'],
    [23 * DAY_MS, 95.7, 'scale', '17'],
    [26 * DAY_MS, 95.6, 'smart_scale', '18'],
    [28 * DAY_MS, 95.8, 'scale', '19'],
  ];
  const note = 'Morning, before breakfast';
  const rows = weights.map(([msAgo, kg, method, entry, revision]) =>
    reading('weight', kg, msAgo, entry, method, { revision, notes: entry === '1' ? note : null }),
  );
  rows.push(
    reading('body_fat_pct', 27.8, 4 * hours, '1', 'smart_scale', { notes: note }),
    reading('body_fat_pct', 28.1, 3 * DAY_MS, '2', 'smart_scale'),
    reading('waist_circumference', 86.36, 3 * DAY_MS, '2', 'tape'),
    reading('bp_systolic', 128, 1 * DAY_MS, '3', 'bp_cuff'),
    reading('bp_diastolic', 84, 1 * DAY_MS, '3', 'bp_cuff'),
    reading('resting_hr', 58, 1 * DAY_MS, '4'),
    reading('resting_hr', 58, 8 * DAY_MS, '5'),
  );
  return rows.sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt));
}

function listPage(scenario: HealthScenario, url: URL) {
  const metricKey = url.searchParams.get('metricKey');
  const page = Number(url.searchParams.get('page') ?? '1');
  const pageSize = Number(url.searchParams.get('pageSize') ?? '20');
  const rows = history(scenario).filter((row) => !metricKey || row.metricKey === metricKey);
  return {
    items: rows.slice((page - 1) * pageSize, page * pageSize),
    total: rows.length,
    page,
    pageSize,
    totalPages: Math.ceil(rows.length / pageSize),
  };
}

function series(scenario: HealthScenario, url: URL) {
  const metricKey = url.searchParams.get('metricKey') ?? 'weight';
  const from = url.searchParams.get('from');
  const points = history(scenario)
    .filter((row) => row.metricKey === metricKey && (!from || Date.parse(row.measuredAt) >= Date.parse(from)))
    .reverse()
    .map(({ id, measuredAt, value, method, origin }) => ({ id, measuredAt, value, method, origin }));
  return { metricKey, unit: UNITS[metricKey] ?? 'score', points, truncated: false };
}

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
      case '/api/measurements':
        return answer(route, listPage(scenario, url));
      case '/api/measurements/series':
        return answer(route, series(scenario, url));
      case '/api/health-profile':
        return answer(route, PROFILE);
      case '/api/check-ins/today':
        return answer(route, {
          date: CHECK_IN_TODAY,
          checkIn: checkIns(scenario).find((c) => c.date === CHECK_IN_TODAY) ?? null,
        });
      case '/api/check-ins':
        return answer(route, { items: checkIns(scenario) });
      default:
        return route.fallback();
    }
  });
}
