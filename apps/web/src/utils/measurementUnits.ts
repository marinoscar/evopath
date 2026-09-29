/**
 * Display conversions for measurements, issue #53 (E2.3).
 *
 * EVERY FACTOR COMES FROM THE CATALOG (`GET /api/measurements/metrics`); this
 * file holds no conversion constant of its own. The API stores canonical
 * values and converts what the form sends, so these helpers only turn a
 * canonical value into what the user reads (and back, for the soft warning),
 * and parse what the user types. The API decides what is valid.
 */

import type { MetricDef, UnitSystem } from '../services/health';

/** The unit `unitSystem` reads `metric` in (`kg` or `lb`, `cm` or `in`, `%`). */
export function displayUnit(metric: MetricDef, unitSystem: UnitSystem): string {
  return metric.displayUnit[unitSystem];
}

/** The catalog factor of `unit` (a value in `unit` times this is canonical). */
export function unitFactor(metric: MetricDef, unit: string): number {
  const def = metric.units.find((candidate) => candidate.unit === unit);
  if (!def) throw new Error(`Unit ${unit} is not allowed for ${metric.key}`);
  return def.factor;
}

/** Round to `decimals` places, normalising `-0`. */
export function roundTo(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  const rounded = Math.round(value * scale) / scale;
  return rounded === 0 ? 0 : rounded;
}

/** Canonical value → the user's unit, rounded to the metric's `decimals` (`94.5327` kg → `208.4` lb). */
export function toDisplay(metric: MetricDef, canonicalValue: number, unitSystem: UnitSystem): number {
  const factor = unitFactor(metric, displayUnit(metric, unitSystem));
  return roundTo(canonicalValue / factor, metric.decimals);
}

/** A value in the user's unit → canonical, unrounded (for comparisons only; the API converts what is saved). */
export function fromDisplay(metric: MetricDef, displayValue: number, unitSystem: UnitSystem): number {
  return displayValue * unitFactor(metric, displayUnit(metric, unitSystem));
}

/** `80` → `'80.0'` for a one-decimal metric. */
export function formatNumber(metric: MetricDef, displayValue: number): string {
  return roundTo(displayValue, metric.decimals).toFixed(metric.decimals);
}

/** Joins a number and its unit: `208.4 lb`, but `27.8%`. */
export function withUnit(text: string, unit: string): string {
  return unit === '%' ? `${text}%` : `${text} ${unit}`;
}

/** A canonical value as the user reads it: `'208.4 lb'`, or `'208.4'` with `withUnit: false`. */
export function formatMeasurement(
  metric: MetricDef,
  canonicalValue: number,
  unitSystem: UnitSystem,
  options: { withUnit?: boolean } = {},
): string {
  const text = formatNumber(metric, toDisplay(metric, canonicalValue, unitSystem));
  return options.withUnit === false ? text : withUnit(text, displayUnit(metric, unitSystem));
}

const DECIMAL_PATTERN = /^(\d+([.,]\d*)?|[.,]\d+)$/;

/**
 * What the user typed → a number, or `null`. Accepts `.` or `,` as the
 * decimal separator and surrounding spaces; refuses everything else,
 * including `1e3`, `Infinity`, `NaN`, signs and thousands separators.
 */
export function parseDecimal(text: string): number | null {
  const trimmed = text.trim();
  if (!DECIMAL_PATTERN.test(trimmed)) return null;
  const value = Number(trimmed.replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

/**
 * The metric's hard bounds in the user's unit, rounded INWARD to `decimals`
 * so any value inside them converts to a canonical value inside the API's
 * bounds (20 kg is 44.09 lb, so the lower bound reads 44.1).
 */
export function boundsInDisplayUnits(
  metric: MetricDef,
  unitSystem: UnitSystem,
): { min: number; max: number } {
  const factor = unitFactor(metric, displayUnit(metric, unitSystem));
  const scale = 10 ** metric.decimals;
  // The epsilon absorbs float noise (500 / 1 must not become 499.9).
  const min = Math.ceil((metric.min / factor) * scale - 1e-9) / scale;
  const max = Math.floor((metric.max / factor) * scale + 1e-9) / scale;
  return { min, max };
}

/** Body-mass index from canonical kilograms and millimetres, one decimal. `null` without both. */
export function bmi(weightKg: number | null | undefined, heightMm: number | null | undefined): number | null {
  if (!weightKg || !heightMm || weightKg <= 0 || heightMm <= 0) return null;
  const metres = heightMm / 1000;
  return roundTo(weightKg / (metres * metres), 1);
}

/** How far `next` is from `previous`, in percent of `previous` (both canonical). */
export function percentDifference(next: number, previous: number): number {
  if (previous === 0) return next === 0 ? 0 : Infinity;
  return (Math.abs(next - previous) / Math.abs(previous)) * 100;
}

/** Spoken names for units, for screen-reader text. A unit not listed is read as written. */
const SPOKEN_UNITS: Record<string, string> = {
  kg: 'kilograms',
  lb: 'pounds',
  cm: 'centimetres',
  in: 'inches',
  '%': 'percentage points',
  mmHg: 'millimetres of mercury',
  bpm: 'beats per minute',
};

export function spokenUnit(unit: string): string {
  return SPOKEN_UNITS[unit] ?? unit;
}

export interface MeasurementDelta {
  direction: 'up' | 'down' | 'none';
  /** `+0.4 lb`, `-0.4 lb` or `no change`. */
  text: string;
  /** `up 0.4 pounds since previous reading`. */
  spoken: string;
}

/**
 * The change from `previousCanonical` to `latestCanonical`, in the user's
 * unit. Both are rounded to the display precision first, so the delta always
 * matches the two numbers the user can see. Neutral by design: no judgement.
 */
export function measurementDelta(
  metric: MetricDef,
  latestCanonical: number,
  previousCanonical: number,
  unitSystem: UnitSystem,
): MeasurementDelta {
  const unit = displayUnit(metric, unitSystem);
  const diff = roundTo(
    toDisplay(metric, latestCanonical, unitSystem) - toDisplay(metric, previousCanonical, unitSystem),
    metric.decimals,
  );
  if (diff === 0) {
    return { direction: 'none', text: 'no change', spoken: 'no change since previous reading' };
  }
  const magnitude = formatNumber(metric, Math.abs(diff));
  const up = diff > 0;
  return {
    direction: up ? 'up' : 'down',
    text: withUnit(`${up ? '+' : '-'}${magnitude}`, unit),
    spoken: `${up ? 'up' : 'down'} ${magnitude} ${spokenUnit(unit)} since previous reading`,
  };
}
