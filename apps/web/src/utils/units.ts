/**
 * Weight display conversions for workout logging (E4.2).
 *
 * The API stores and speaks kilograms only (`weightKg`, at most 3 decimals).
 * The display unit is not a setting of its own: it is the Health Profile
 * `unitSystem` (`imperial` -> lb, `metric` -> kg). These helpers turn a
 * canonical kilogram value into what the user reads and what the user types
 * back into kilograms; the API decides what is valid.
 *
 * Precision: pounds are shown to 0.1 lb, kilograms to 0.05 kg. A typed value
 * converts to kilograms rounded to 0.001 kg (the API's precision), which is
 * far finer than either display step, so a value round-trips unchanged:
 * 135 lb -> 61.235 kg -> 135.0 lb.
 */

import type { UnitSystem } from '../services/health';

export type WeightUnit = 'kg' | 'lb';

/** Exact, by definition (international avoirdupois pound). */
export const KG_PER_LB = 0.45359237;

/** The API's bounds on `weightKg`. */
export const WEIGHT_KG_MIN = 0;
export const WEIGHT_KG_MAX = 1000;
/** Decimal places the API keeps on `weightKg`. */
export const WEIGHT_KG_DECIMALS = 3;

/** The display step per unit, and the decimals it needs. */
export const WEIGHT_DISPLAY_STEP: Record<WeightUnit, { step: number; decimals: number }> = {
  kg: { step: 0.05, decimals: 2 },
  lb: { step: 0.1, decimals: 1 },
};

/** The weight unit a Health Profile `unitSystem` reads in. */
export function weightUnitFor(unitSystem: UnitSystem | null | undefined): WeightUnit {
  return unitSystem === 'imperial' ? 'lb' : 'kg';
}

/** Round to the nearest multiple of `step`, returning a clean float (no `0.30000000000000004`). */
function roundToStep(value: number, step: number, decimals: number): number {
  // The epsilon absorbs float noise so an exact half-step rounds up consistently.
  const rounded = Number((Math.round(value / step + 1e-9) * step).toFixed(decimals));
  return rounded === 0 ? 0 : rounded;
}

function roundTo(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  const rounded = Math.round(value * scale + 1e-9) / scale;
  return rounded === 0 ? 0 : rounded;
}

/** Kilograms -> the display unit, rounded to its step (`61.235` kg -> `135` lb; `31.751` kg -> `31.75` kg). */
export function kgToDisplay(kg: number, unit: WeightUnit): number {
  const { step, decimals } = WEIGHT_DISPLAY_STEP[unit];
  const value = unit === 'lb' ? kg / KG_PER_LB : kg;
  return roundToStep(value, step, decimals);
}

/** A value in the display unit -> kilograms, rounded to the API's 0.001 kg (`70` lb -> `31.751`). */
export function displayToKg(value: number, unit: WeightUnit): number {
  const kg = unit === 'lb' ? value * KG_PER_LB : value;
  return roundTo(kg, WEIGHT_KG_DECIMALS);
}

/** The display number as text: `135.0` lb, `100` / `62.5` / `31.75` kg. */
export function formatWeightNumber(kg: number, unit: WeightUnit): string {
  const value = kgToDisplay(kg, unit);
  if (unit === 'lb') return value.toFixed(WEIGHT_DISPLAY_STEP.lb.decimals);
  // Kilograms drop trailing zeros: 100.00 -> 100, 62.50 -> 62.5.
  return value.toFixed(WEIGHT_DISPLAY_STEP.kg.decimals).replace(/\.?0+$/, '');
}

/**
 * A kilogram value as the user reads it: `'135.0 lb'`, `'100 kg'`. `null` or
 * `undefined` reads as an empty string. `withUnit: false` gives the number only.
 */
export function formatWeight(
  kg: number | null | undefined,
  unit: WeightUnit,
  options: { withUnit?: boolean } = {},
): string {
  if (kg === null || kg === undefined || !Number.isFinite(kg)) return '';
  const text = formatWeightNumber(kg, unit);
  return options.withUnit === false ? text : `${text} ${unit}`;
}

/** The largest value in `unit` that still converts to at most 1000 kg (2204.6 lb). */
export function maxWeightInUnit(unit: WeightUnit): number {
  if (unit === 'kg') return WEIGHT_KG_MAX;
  const { decimals } = WEIGHT_DISPLAY_STEP.lb;
  const scale = 10 ** decimals;
  return Math.floor((WEIGHT_KG_MAX / KG_PER_LB) * scale + 1e-9) / scale;
}

export type WeightParseResult =
  /** `kg` is null when the field was left blank (no weight). */
  | { ok: true; kg: number | null; value: number | null }
  | { ok: false; message: string };

const NUMBER_PATTERN = /^(\d+(\.\d*)?|\.\d+)$/;

/**
 * What the user typed in `unit` -> kilograms, or a message saying why not.
 *
 * Only `.` is a decimal separator: `12,5` is refused (it could be a thousands
 * separator), as are signs, exponents and anything that is not a plain
 * number. A blank field is a valid "no weight". The value must convert into
 * the API's 0..1000 kg.
 */
export function parseWeight(text: string, unit: WeightUnit): WeightParseResult {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, kg: null, value: null };
  if (trimmed.includes(',')) {
    return { ok: false, message: 'Use a dot for decimals, for example 12.5.' };
  }
  if (trimmed.startsWith('-')) {
    return { ok: false, message: 'Weight cannot be negative.' };
  }
  if (!NUMBER_PATTERN.test(trimmed)) {
    return { ok: false, message: 'Enter a number, for example 12.5.' };
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    return { ok: false, message: 'Enter a number, for example 12.5.' };
  }
  const kg = displayToKg(value, unit);
  if (kg > WEIGHT_KG_MAX) {
    return { ok: false, message: `At most ${maxWeightInUnit(unit)} ${unit}.` };
  }
  return { ok: true, kg, value };
}
