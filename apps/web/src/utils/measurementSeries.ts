/**
 * Pure helpers behind the Health page's Trend chart and History list, issue
 * #60 (E2.5). No React, no fetching: rows and points in, view models out.
 *
 * Two rules live here and are pinned by `measurementSeries.test.ts`:
 *
 * - **Methods are never merged** (VISION §18, §86). `toChartSeries` makes ONE
 *   series per method over the union of timestamps, `null` wherever that
 *   method has no reading. The chart connects a method's own points across
 *   those nulls (`connectNulls`) and never draws a line from one method to
 *   another, because they are different series.
 * - **Entries are grouped in the client.** `GET /api/measurements` pages
 *   READINGS, so a multi-metric entry (a blood-pressure pair, weight + body
 *   fat) can straddle two pages; `groupByEntry` merges whatever has been
 *   loaded so far into one row per entry.
 *
 * Canonical → display conversion is always delegated to the caller's
 * `toDisplay` (built on `utils/measurementUnits.ts`, which reads every factor
 * off the API's catalog); nothing here knows a factor.
 */

import {
  QUICK_ENTRY_METRIC_KEYS,
  UNSPECIFIED_METHOD,
  type MeasurementDto,
  type MetricDef,
  type UnitSystem,
} from '../services/health';
import { displayUnit, formatMeasurement, formatNumber, toDisplay, withUnit } from './measurementUnits';

export const BP_SYSTOLIC = 'bp_systolic';
export const BP_DIASTOLIC = 'bp_diastolic';

// -----------------------------------------------------------------------------
// History: rows → entries
// -----------------------------------------------------------------------------

/** One History row: every loaded reading of one entry. */
export interface HistoryEntry {
  entryId: string;
  /** ISO instant, shared by every reading of the entry. */
  measuredAt: string;
  /** Registry order (weight, body fat, waist, systolic, diastolic, resting HR). */
  readings: MeasurementDto[];
  notes: string | null;
  /** Any reading has `revision > 1`. */
  edited: boolean;
  /** `manual` today; `ai_read` arrives with E2.6. */
  origin: string;
}

const REGISTRY_ORDER: ReadonlyMap<string, number> = new Map(
  QUICK_ENTRY_METRIC_KEYS.map((key, index) => [key, index]),
);

function registryIndex(metricKey: string): number {
  return REGISTRY_ORDER.get(metricKey) ?? REGISTRY_ORDER.size;
}

/**
 * Rows (in any order, from any number of pages) → one entry per `entryId`,
 * newest `measuredAt` first. A row seen twice (same `id`) counts once. Ties
 * on `measuredAt` keep the order the rows arrived in (the API's own order).
 */
export function groupByEntry(rows: readonly MeasurementDto[]): HistoryEntry[] {
  const byEntry = new Map<string, { entry: HistoryEntry; firstSeen: number; ids: Set<string> }>();

  rows.forEach((row, index) => {
    let group = byEntry.get(row.entryId);
    if (!group) {
      group = {
        entry: {
          entryId: row.entryId,
          measuredAt: row.measuredAt,
          readings: [],
          notes: row.notes,
          edited: false,
          origin: row.origin,
        },
        firstSeen: index,
        ids: new Set(),
      };
      byEntry.set(row.entryId, group);
    }
    if (group.ids.has(row.id)) return;
    group.ids.add(row.id);
    group.entry.readings.push(row);
    group.entry.edited = group.entry.edited || row.revision > 1 || row.edited;
    if (group.entry.notes === null && row.notes !== null) group.entry.notes = row.notes;
  });

  const groups = [...byEntry.values()];
  for (const { entry } of groups) {
    entry.readings.sort((a, b) => registryIndex(a.metricKey) - registryIndex(b.metricKey));
  }
  groups.sort((a, b) => {
    const diff = Date.parse(b.entry.measuredAt) - Date.parse(a.entry.measuredAt);
    return diff !== 0 ? diff : a.firstSeen - b.firstSeen;
  });
  return groups.map((group) => group.entry);
}

/** One line of a History row: a single reading, or the blood-pressure pair. */
export interface EntryReadingView {
  /** `weight`, or `blood_pressure` for the pair. */
  key: string;
  /** `Weight`, `Blood pressure`. */
  label: string;
  /** `208.4 lb`, `128/84 mmHg`. */
  text: string;
  /** Method keys other than `unspecified`, deduplicated (the pair usually shares one). */
  methods: string[];
  /** The readings this line shows. */
  readings: MeasurementDto[];
}

/**
 * The readings of an entry as the user reads them, in their units. A
 * systolic/diastolic pair becomes ONE line (`128/84 mmHg`); a reading whose
 * metric the catalog does not know is skipped rather than shown unconverted.
 */
export function describeEntry(
  entry: Pick<HistoryEntry, 'readings'>,
  metricsByKey: ReadonlyMap<string, MetricDef>,
  unitSystem: UnitSystem,
): EntryReadingView[] {
  const views: EntryReadingView[] = [];
  const systolic = entry.readings.find((r) => r.metricKey === BP_SYSTOLIC);
  const diastolic = entry.readings.find((r) => r.metricKey === BP_DIASTOLIC);
  const methodsOf = (readings: MeasurementDto[]) =>
    [...new Set(readings.map((r) => r.method))].filter((m) => m !== UNSPECIFIED_METHOD);

  for (const reading of entry.readings) {
    if (reading.metricKey === BP_DIASTOLIC && systolic) continue;
    if (reading.metricKey === BP_SYSTOLIC && diastolic) {
      const sysDef = metricsByKey.get(BP_SYSTOLIC);
      const diaDef = metricsByKey.get(BP_DIASTOLIC);
      if (!sysDef || !diaDef) continue;
      const pair = [reading, diastolic];
      views.push({
        key: 'blood_pressure',
        label: 'Blood pressure',
        text: withUnit(
          `${formatMeasurement(sysDef, reading.value, unitSystem, { withUnit: false })}/${formatMeasurement(
            diaDef,
            diastolic.value,
            unitSystem,
            { withUnit: false },
          )}`,
          displayUnit(sysDef, unitSystem),
        ),
        methods: methodsOf(pair),
        readings: pair,
      });
      continue;
    }
    const metric = metricsByKey.get(reading.metricKey);
    if (!metric) continue;
    views.push({
      key: reading.metricKey,
      label: metric.label,
      text: formatMeasurement(metric, reading.value, unitSystem),
      methods: methodsOf([reading]),
      readings: [reading],
    });
  }
  return views;
}

/** `weight`, `weight and body fat`, `weight, body fat and waist`: for accessible names. */
export function spokenList(labels: readonly string[]): string {
  const lower = labels.map((label) => label.toLowerCase());
  if (lower.length <= 1) return lower[0] ?? '';
  return `${lower.slice(0, -1).join(', ')} and ${lower[lower.length - 1]}`;
}

// -----------------------------------------------------------------------------
// Trend: points → per-method series
// -----------------------------------------------------------------------------

/** The part of a series point these helpers read. */
export interface TrendPoint {
  measuredAt: string;
  /** Canonical. */
  value: number;
  method: string;
}

/** One metric's points; blood pressure passes two groups (systolic, diastolic). */
export interface ChartGroupInput {
  /** `bp_systolic`; becomes part of each series id. */
  key: string;
  /** `Systolic`, or `null` for a single-metric chart (the label is then the method's). */
  label: string | null;
  points: readonly TrendPoint[];
  /** Canonical → the user's unit, already rounded for display. */
  toDisplay: (canonical: number) => number;
}

export interface ChartSeries {
  /** `weight:scale`. Stable per metric and method. */
  id: string;
  groupKey: string;
  method: string;
  /** `Scale`, or `Systolic (Blood-pressure cuff)` for a grouped chart. */
  label: string;
  /** One slot per `xData` instant; `null` where this method has no reading then. */
  data: Array<number | null>;
}

export interface ChartData {
  /** The sorted, deduplicated union of every reading's instant. */
  xData: Date[];
  series: ChartSeries[];
}

function methodOrder(methodLabels: ReadonlyMap<string, string>): Map<string, number> {
  return new Map([...methodLabels.keys()].map((key, index) => [key, index]));
}

/**
 * Method keys present in `points`, in catalog order (the order of
 * `methodLabels`), unknown methods last in order of first appearance.
 */
export function distinctMethods(
  points: readonly Pick<TrendPoint, 'method'>[],
  methodLabels: ReadonlyMap<string, string> = new Map(),
): string[] {
  const order = methodOrder(methodLabels);
  const seen: string[] = [];
  for (const point of points) if (!seen.includes(point.method)) seen.push(point.method);
  return seen
    .map((method, index) => ({ method, rank: order.get(method) ?? order.size + index }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ method }) => method);
}

/**
 * Groups of points → x instants and ONE series per (group, method).
 *
 * The x axis is the union of every instant, deduplicated. Each series holds a
 * value only at its own instants and `null` elsewhere, so two readings at the
 * same instant with different methods are both plotted (in two series).
 * Duplicate instants WITHIN one method's series keep the LAST point in input
 * order (the API sends points oldest first, ties by insertion time, so that is
 * the later-saved reading); the earlier one is still listed in History.
 */
export function toGroupedChartSeries(
  groups: readonly ChartGroupInput[],
  methodLabels: ReadonlyMap<string, string>,
): ChartData {
  const instants = new Set<number>();
  for (const group of groups) for (const point of group.points) instants.add(Date.parse(point.measuredAt));
  const times = [...instants].sort((a, b) => a - b);
  const slot = new Map(times.map((time, index) => [time, index]));

  const series: ChartSeries[] = [];
  for (const group of groups) {
    for (const method of distinctMethods(group.points, methodLabels)) {
      const data: Array<number | null> = times.map(() => null);
      for (const point of group.points) {
        if (point.method !== method) continue;
        data[slot.get(Date.parse(point.measuredAt))!] = group.toDisplay(point.value);
      }
      const methodLabel = methodLabels.get(method) ?? method;
      series.push({
        id: `${group.key}:${method}`,
        groupKey: group.key,
        method,
        label: group.label ? `${group.label} (${methodLabel})` : methodLabel,
        data,
      });
    }
  }
  return { xData: times.map((time) => new Date(time)), series };
}

/** A single metric's points → per-method series (see {@link toGroupedChartSeries}). */
export function toChartSeries(
  points: readonly TrendPoint[],
  methodLabels: ReadonlyMap<string, string>,
  toDisplayValue: (canonical: number) => number,
): ChartData {
  return toGroupedChartSeries([{ key: 'value', label: null, points, toDisplay: toDisplayValue }], methodLabels);
}

/**
 * A y-axis domain around `values`, not forced to zero: 5% of the spread on
 * each side, or `flatPadding` (1 unit) either side when every value is equal,
 * so a flat line sits mid-chart instead of on an edge. `null` for no values.
 */
export function yDomain(
  values: ReadonlyArray<number | null>,
  options: { padding?: number; flatPadding?: number } = {},
): { min: number; max: number } | null {
  const { padding = 0.05, flatPadding = 1 } = options;
  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (finite.length === 0) return null;
  const low = Math.min(...finite);
  const high = Math.max(...finite);
  if (high === low) return { min: low - flatPadding, max: high + flatPadding };
  const pad = (high - low) * padding;
  return { min: low - pad, max: high + pad };
}

/** `Weight, last 90 days, 12 readings, latest 208.4 lb, range 205.0 to 212.3 lb`. */
export function summaryLabel(parts: {
  metric: string;
  days: number;
  count: number;
  /** `208.4 lb`, `128/84 mmHg`; omitted with no readings. */
  latest?: string;
  /** `205.0 to 212.3 lb`; omitted with no readings. */
  range?: string;
}): string {
  const pieces = [
    parts.metric,
    `last ${parts.days} days`,
    `${parts.count} ${parts.count === 1 ? 'reading' : 'readings'}`,
  ];
  if (parts.latest) pieces.push(`latest ${parts.latest}`);
  if (parts.range) pieces.push(`range ${parts.range}`);
  return pieces.join(', ');
}

/** `205.0 to 212.3 lb` for one metric's canonical values, in the user's unit. */
export function rangeText(metric: MetricDef, canonicalValues: readonly number[], unitSystem: UnitSystem): string | undefined {
  if (canonicalValues.length === 0) return undefined;
  const display = canonicalValues.map((value) => toDisplay(metric, value, unitSystem));
  const low = formatNumber(metric, Math.min(...display));
  const high = formatNumber(metric, Math.max(...display));
  return `${low} to ${withUnit(high, displayUnit(metric, unitSystem))}`;
}

// -----------------------------------------------------------------------------
// Metric choices shared by the Trend selector and the History filter
// -----------------------------------------------------------------------------

export type MetricChoiceGroup = 'Body' | 'Vitals' | 'How you feel';

export interface MetricChoice {
  /** A metric key, or `blood_pressure` for the pair. */
  id: string;
  label: string;
  group: MetricChoiceGroup;
  /** What to request: one key, or systolic and diastolic. */
  metricKeys: string[];
}

const GROUP_OF_CATEGORY: Record<MetricDef['category'], MetricChoiceGroup> = {
  body: 'Body',
  vital: 'Vitals',
  wellness: 'How you feel',
};

/**
 * The catalog's metrics as the user picks them, in catalog order within
 * "Body", "Vitals", "How you feel". The blood-pressure pair is ONE choice.
 * `includeWellness: false` for History: the list endpoint serves body and
 * vital readings only (check-in scores come from check-ins).
 */
export function metricChoices(
  metrics: readonly MetricDef[],
  options: { includeWellness?: boolean } = {},
): MetricChoice[] {
  const includeWellness = options.includeWellness ?? true;
  const choices: MetricChoice[] = [];
  for (const metric of metrics) {
    if (metric.category === 'wellness' && !includeWellness) continue;
    if (metric.key === BP_DIASTOLIC) continue;
    if (metric.key === BP_SYSTOLIC) {
      choices.push({
        id: 'blood_pressure',
        label: 'Blood pressure',
        group: 'Vitals',
        metricKeys: metrics.some((m) => m.key === BP_DIASTOLIC) ? [BP_SYSTOLIC, BP_DIASTOLIC] : [BP_SYSTOLIC],
      });
      continue;
    }
    choices.push({ id: metric.key, label: metric.label, group: GROUP_OF_CATEGORY[metric.category], metricKeys: [metric.key] });
  }
  const order: MetricChoiceGroup[] = ['Body', 'Vitals', 'How you feel'];
  return order.flatMap((group) => choices.filter((choice) => choice.group === group));
}
