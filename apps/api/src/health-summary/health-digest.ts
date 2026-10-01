import { createHash } from 'node:crypto';

import { CHECK_IN_FIELDS, type CheckInField } from '../check-ins/dto/check-in.dto';
import { addDays } from '../check-ins/local-date';
import { getMetric, LAB_PANELS, type LabPanel } from '../measurements/metric-registry';

// =============================================================================
// The health digest: what the `ai.health.summary` model is given (H8, #192)
// =============================================================================
//
// PURE and SERVER-ONLY. `buildHealthDigest` turns the rows the loader read
// into a small, bounded JSON object, copied FIELD BY FIELD from an allow-list:
//
//   profile   age in whole years and sex at birth (never the birth date)
//   labs      per panel, per analyte: the latest and the previous value with
//             its date, flag and numeric reference range (metric key and
//             canonical unit, never the name as printed, the lab's name, the
//             printed reference text, a note or a document)
//   vitals    blood pressure and resting heart rate: the latest reading, the
//             30-day average and the average of the 60 days before it
//   body      weight (latest, 8-week trend), body fat and waist (latest and
//             previous)
//   wellness  the four check-in scores averaged over 28 days, how many of
//             those days were low, and the low-day streak (never the note)
//
// NOTHING ELSE. No document, file name, storage key, note, free text, name,
// e-mail or id can be in it: the source types do not even carry them.
//
// ANCHORED ON THE DATA, NOT THE CLOCK. Every window ends at the newest input
// of its own section, and the age is computed at the newest input of all.
// The digest is therefore a function of the stored data only, so its hash
// (`digestHash`) changes exactly when the inputs change. That is what the
// staleness marker compares, and why a summary does not go stale overnight.
// =============================================================================

export const DIGEST_VERSION = 1;

export const DIGEST_LIMITS = {
  /** Vital averages: the recent window, then the window before it (days). */
  vitalRecentDays: 30,
  vitalPriorDays: 60,
  weightTrendDays: 56,
  wellnessDays: 28,
} as const;

export const BP_KEYS = { systolic: 'bp_systolic', diastolic: 'bp_diastolic' } as const;
export const RESTING_HR_KEY = 'resting_hr';
export const BODY_KEYS = { weight: 'weight', bodyFat: 'body_fat_pct', waist: 'waist_circumference' } as const;

/** One active measurement row, as the loader selects it (no note, no source, no reference text). */
export interface DigestMeasurement {
  metricKey: string;
  value: number;
  measuredAt: Date;
  /** `YYYY-MM-DD` for a daily (check-in) score, else null. */
  localDate: string | null;
  flag: string | null;
  referenceLow: number | null;
  referenceHigh: number | null;
}

export interface HealthDigestSource {
  profile: { dateOfBirth: string | null; sexAtBirth: string | null } | null;
  measurements: DigestMeasurement[];
}

export interface DigestReading {
  value: number;
  date: string;
  flag: string | null;
}

export interface DigestAnalyte {
  key: string;
  label: string;
  unit: string;
  latest: DigestReading;
  previous: DigestReading | null;
  range: { low: number | null; high: number | null } | null;
}

export interface DigestAverage {
  value: number;
  readings: number;
}

export interface HealthDigest {
  version: typeof DIGEST_VERSION;
  /** The newest input's date (`YYYY-MM-DD`), null when there is no input at all. */
  asOf: string | null;
  profile?: { ageYears: number | null; sexAtBirth: 'female' | 'male' | null };
  labs?: Array<{ panel: LabPanel; analytes: DigestAnalyte[] }>;
  vitals?: {
    asOf: string;
    bloodPressure?: {
      latest: { systolic: number; diastolic: number | null; date: string } | null;
      recent30d: { systolic: DigestAverage; diastolic: DigestAverage | null } | null;
      prior60d: { systolic: DigestAverage; diastolic: DigestAverage | null } | null;
    };
    restingHeartRate?: {
      latest: { value: number; date: string };
      recent30d: DigestAverage | null;
      prior60d: DigestAverage | null;
    };
  };
  body?: {
    weightKg?: { latest: number; date: string; trendKgPerWeek: number | null; readings8w: number };
    bodyFatPercent?: { latest: number; date: string; previous: number | null };
    waistCm?: { latest: number; date: string; previous: number | null };
  };
  wellness?: {
    asOf: string;
    days: number;
    averages: Record<CheckInField, number | null>;
    lowDays: number;
    /** Consecutive low days ending at the newest check-in. */
    lowDayStreak: number;
    longestLowDayStreak: number;
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

const round = (value: number, decimals: number) => {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
};

const dateOf = (row: DigestMeasurement) => row.localDate ?? row.measuredAt.toISOString().slice(0, 10);

const newestFirst = (a: DigestMeasurement, b: DigestMeasurement) =>
  b.measuredAt.getTime() - a.measuredAt.getTime() || (dateOf(a) < dateOf(b) ? 1 : dateOf(a) > dateOf(b) ? -1 : 0);

function decimalsOf(key: string): number {
  return getMetric(key)?.decimals ?? 2;
}

function reading(row: DigestMeasurement): DigestReading {
  return { value: round(row.value, decimalsOf(row.metricKey)), date: dateOf(row), flag: row.flag ?? null };
}

/** Whole years between a `YYYY-MM-DD` birth date and `at` (UTC calendar), or null. */
export function ageAt(dateOfBirth: string | null, at: Date): number | null {
  if (!dateOfBirth || !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) return null;
  const [y, m, d] = dateOfBirth.split('-').map(Number);
  let age = at.getUTCFullYear() - y;
  const month = at.getUTCMonth() + 1;
  if (month < m || (month === m && at.getUTCDate() < d)) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

function average(rows: DigestMeasurement[], decimals: number): DigestAverage | null {
  if (rows.length === 0) return null;
  return { value: round(rows.reduce((sum, r) => sum + r.value, 0) / rows.length, decimals), readings: rows.length };
}

/** Rows in `(end - days, end]`, `end` a timestamp. */
function within(rows: DigestMeasurement[], end: number, fromDaysAgo: number, toDaysAgo: number): DigestMeasurement[] {
  return rows.filter((r) => {
    const age = end - r.measuredAt.getTime();
    return age >= toDaysAgo * DAY_MS && age < fromDaysAgo * DAY_MS;
  });
}

/** Least-squares slope, kg per week; null with fewer than two points or no spread. */
function slopePerWeek(rows: DigestMeasurement[]): number | null {
  if (rows.length < 2) return null;
  const xs = rows.map((r) => r.measuredAt.getTime() / (7 * DAY_MS));
  const ys = rows.map((r) => r.value);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i += 1) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den === 0 ? null : round(num / den, 2);
}

function byKey(rows: DigestMeasurement[]): Map<string, DigestMeasurement[]> {
  const map = new Map<string, DigestMeasurement[]>();
  for (const row of rows) {
    if (!Number.isFinite(row.value)) continue;
    const list = map.get(row.metricKey) ?? [];
    list.push(row);
    map.set(row.metricKey, list);
  }
  for (const list of map.values()) list.sort(newestFirst);
  return map;
}

function labsOf(rows: Map<string, DigestMeasurement[]>): HealthDigest['labs'] {
  const panels = new Map<LabPanel, DigestAnalyte[]>();
  for (const [key, list] of rows) {
    const metric = getMetric(key);
    if (!metric || metric.category !== 'lab' || !metric.panel || list.length === 0) continue;
    const latest = list[0];
    const range =
      latest.referenceLow !== null || latest.referenceHigh !== null
        ? { low: latest.referenceLow, high: latest.referenceHigh }
        : null;
    const analytes = panels.get(metric.panel) ?? [];
    analytes.push({
      key,
      label: metric.label,
      unit: metric.canonicalUnit,
      latest: reading(latest),
      previous: list[1] ? reading(list[1]) : null,
      range,
    });
    panels.set(metric.panel, analytes);
  }
  const out = LAB_PANELS.filter((panel) => panels.has(panel)).map((panel) => ({
    panel,
    analytes: panels.get(panel)!.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
  }));
  return out.length > 0 ? out : undefined;
}

function vitalsOf(rows: Map<string, DigestMeasurement[]>): HealthDigest['vitals'] {
  const systolic = rows.get(BP_KEYS.systolic) ?? [];
  const diastolic = rows.get(BP_KEYS.diastolic) ?? [];
  const hr = rows.get(RESTING_HR_KEY) ?? [];
  const all = [...systolic, ...diastolic, ...hr].sort(newestFirst);
  if (all.length === 0) return undefined;

  const end = all[0].measuredAt.getTime();
  const { vitalRecentDays: recent, vitalPriorDays: prior } = DIGEST_LIMITS;
  const vitals: NonNullable<HealthDigest['vitals']> = { asOf: dateOf(all[0]) };

  if (systolic.length > 0) {
    const latest = systolic[0];
    const pair = diastolic.find((d) => d.measuredAt.getTime() === latest.measuredAt.getTime()) ?? null;
    const window = (from: number, to: number) => {
      const s = average(within(systolic, end, from, to), 0);
      return s ? { systolic: s, diastolic: average(within(diastolic, end, from, to), 0) } : null;
    };
    vitals.bloodPressure = {
      latest: { systolic: round(latest.value, 0), diastolic: pair ? round(pair.value, 0) : null, date: dateOf(latest) },
      recent30d: window(recent, 0),
      prior60d: window(recent + prior, recent),
    };
  }

  if (hr.length > 0) {
    vitals.restingHeartRate = {
      latest: { value: round(hr[0].value, 0), date: dateOf(hr[0]) },
      recent30d: average(within(hr, end, recent, 0), 0),
      prior60d: average(within(hr, end, recent + prior, recent), 0),
    };
  }

  return vitals;
}

function bodyOf(rows: Map<string, DigestMeasurement[]>): HealthDigest['body'] {
  const body: NonNullable<HealthDigest['body']> = {};
  const weights = rows.get(BODY_KEYS.weight) ?? [];
  if (weights.length > 0) {
    const end = weights[0].measuredAt.getTime();
    const window = within(weights, end, DIGEST_LIMITS.weightTrendDays, 0);
    body.weightKg = {
      latest: round(weights[0].value, 1),
      date: dateOf(weights[0]),
      trendKgPerWeek: slopePerWeek(window),
      readings8w: window.length,
    };
  }
  const latestAndPrevious = (key: string) => {
    const list = rows.get(key) ?? [];
    return list.length === 0
      ? undefined
      : { latest: round(list[0].value, 1), date: dateOf(list[0]), previous: list[1] ? round(list[1].value, 1) : null };
  };
  const bodyFat = latestAndPrevious(BODY_KEYS.bodyFat);
  if (bodyFat) body.bodyFatPercent = bodyFat;
  const waist = latestAndPrevious(BODY_KEYS.waist);
  if (waist) body.waistCm = waist;
  return Object.keys(body).length > 0 ? body : undefined;
}

type DayScores = Record<CheckInField, number | null>;

function isLowDay(day: DayScores): boolean {
  const low = (v: number | null) => v !== null && v <= 2;
  const high = (v: number | null) => v !== null && v >= 4;
  return low(day.energy) || low(day.sleepQuality) || high(day.soreness) || high(day.stress);
}

function wellnessOf(rows: Map<string, DigestMeasurement[]>): HealthDigest['wellness'] {
  const days = new Map<string, DayScores>();
  for (const { field, metricKey } of CHECK_IN_FIELDS) {
    for (const row of rows.get(metricKey) ?? []) {
      if (!row.localDate) continue;
      const day = days.get(row.localDate) ?? { energy: null, sleepQuality: null, soreness: null, stress: null };
      // Rows are newest first: the first value seen for a day wins.
      if (day[field] === null) day[field] = row.value;
      days.set(row.localDate, day);
    }
  }
  if (days.size === 0) return undefined;

  const asOf = [...days.keys()].sort().at(-1)!;
  const from = addDays(asOf, -(DIGEST_LIMITS.wellnessDays - 1));
  const inWindow = [...days.entries()].filter(([date]) => date >= from && date <= asOf).sort(([a], [b]) => (a < b ? -1 : 1));

  const averages = Object.fromEntries(
    CHECK_IN_FIELDS.map(({ field }) => {
      const values = inWindow.map(([, d]) => d[field]).filter((v): v is number => v !== null);
      return [field, values.length === 0 ? null : round(values.reduce((a, b) => a + b, 0) / values.length, 1)];
    }),
  ) as Record<CheckInField, number | null>;

  let streak = 0;
  for (let date = asOf; date >= from; date = addDays(date, -1)) {
    const day = days.get(date);
    if (!day || !isLowDay(day)) break;
    streak += 1;
  }

  let longest = 0;
  let run = 0;
  for (let date = from; date <= asOf; date = addDays(date, 1)) {
    const day = days.get(date);
    run = day && isLowDay(day) ? run + 1 : 0;
    longest = Math.max(longest, run);
  }

  return {
    asOf,
    days: inWindow.length,
    averages,
    lowDays: inWindow.filter(([, d]) => isLowDay(d)).length,
    lowDayStreak: streak,
    longestLowDayStreak: longest,
  };
}

/** The digest of one user's stored health data. */
export function buildHealthDigest(source: HealthDigestSource): HealthDigest {
  const rows = byKey(source.measurements);
  const newest = [...source.measurements].filter((r) => Number.isFinite(r.value)).sort(newestFirst)[0] ?? null;
  const digest: HealthDigest = { version: DIGEST_VERSION, asOf: newest ? dateOf(newest) : null };

  if (source.profile) {
    const sex = source.profile.sexAtBirth;
    const age = newest ? ageAt(source.profile.dateOfBirth, newest.measuredAt) : null;
    const sexAtBirth = sex === 'female' || sex === 'male' ? sex : null;
    if (age !== null || sexAtBirth !== null) digest.profile = { ageYears: age, sexAtBirth };
  }

  const labs = labsOf(rows);
  if (labs) digest.labs = labs;
  const vitals = vitalsOf(rows);
  if (vitals) digest.vitals = vitals;
  const body = bodyOf(rows);
  if (body) digest.body = body;
  const wellness = wellnessOf(rows);
  if (wellness) digest.wellness = wellness;

  return digest;
}

/** Whether the digest has anything worth summarising (a profile alone is not). */
export function digestHasData(digest: HealthDigest): boolean {
  return Boolean(digest.labs || digest.vitals || digest.body || digest.wellness);
}

/** The digest's hash: what a summary records and the staleness marker compares. */
export function digestHash(digest: HealthDigest): string {
  return createHash('sha256').update(JSON.stringify(digest)).digest('hex');
}

/** The flagged lab analytes (`low`, `high`, `critical`), by key: the prompt asks for clinician follow-up on these. */
export function flaggedAnalytes(digest: HealthDigest): string[] {
  return (digest.labs ?? [])
    .flatMap((panel) => panel.analytes)
    .filter((a) => a.latest.flag === 'low' || a.latest.flag === 'high' || a.latest.flag === 'critical')
    .map((a) => a.key);
}

/** The metric keys the loader reads. */
export function digestMetricKeys(labKeys: readonly string[]): string[] {
  return [
    ...labKeys,
    BP_KEYS.systolic,
    BP_KEYS.diastolic,
    RESTING_HR_KEY,
    BODY_KEYS.weight,
    BODY_KEYS.bodyFat,
    BODY_KEYS.waist,
    ...CHECK_IN_FIELDS.map((f) => f.metricKey),
  ];
}
