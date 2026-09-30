/**
 * Presentation helpers for workout logging (E4.3): what a set field shows,
 * how typed text becomes the API's canonical value (kilograms, metres,
 * seconds), and how a set's effort reads as one of three chips.
 *
 * Nothing here decides anything the API decides; the parsers only say
 * whether text is a plain number in range, so a row can explain a problem
 * before the round trip.
 */
import type { SetLogView } from '../services/workouts';
import { SET_BOUNDS } from '../services/workouts';
import { kgToDisplay, parseWeight, type WeightUnit } from './units';

// -----------------------------------------------------------------------------
// Weight (input text)
// -----------------------------------------------------------------------------

/**
 * A kilogram value as an input's text in the display unit, without trailing
 * zeros: `31.751` kg -> `'70'` lb or `'31.75'` kg. Null reads as `''`.
 */
export function weightInputText(kg: number | null, unit: WeightUnit): string {
  if (kg === null || !Number.isFinite(kg)) return '';
  return String(kgToDisplay(kg, unit));
}

export { parseWeight };

// -----------------------------------------------------------------------------
// Whole numbers (reps, RIR, rest)
// -----------------------------------------------------------------------------

export type ParseResult<T> = { ok: true; value: T | null } | { ok: false; message: string };

/** A whole number in `[min, max]`; blank is a valid "no value". */
export function parseWholeNumber(text: string, min: number, max: number): ParseResult<number> {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, value: null };
  if (!/^\d+$/.test(trimmed)) return { ok: false, message: 'Enter a whole number.' };
  const value = Number(trimmed);
  if (value < min || value > max) return { ok: false, message: `Between ${min} and ${max}.` };
  return { ok: true, value };
}

export function parseReps(text: string): ParseResult<number> {
  return parseWholeNumber(text, SET_BOUNDS.reps.min, SET_BOUNDS.reps.max);
}

// -----------------------------------------------------------------------------
// Durations
// -----------------------------------------------------------------------------

/** `75` -> `'1:15'`, `3725` -> `'1:02:05'`; null reads as `''`. */
export function formatClock(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const ss = String(sec).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

/**
 * A duration as typed: `mm:ss`, `h:mm:ss`, or plain seconds (`90`). Blank is
 * a valid "no value".
 */
export function parseClock(text: string): ParseResult<number> {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, value: null };
  let seconds: number;
  if (/^\d+$/.test(trimmed)) {
    seconds = Number(trimmed);
  } else if (/^\d+:\d{1,2}$/.test(trimmed)) {
    const [m, s] = trimmed.split(':').map(Number);
    if (s >= 60) return { ok: false, message: 'Seconds must be under 60.' };
    seconds = m * 60 + s;
  } else if (/^\d+:\d{1,2}:\d{1,2}$/.test(trimmed)) {
    const [h, m, s] = trimmed.split(':').map(Number);
    if (m >= 60 || s >= 60) return { ok: false, message: 'Minutes and seconds must be under 60.' };
    seconds = h * 3600 + m * 60 + s;
  } else {
    return { ok: false, message: 'Use mm:ss, for example 1:30.' };
  }
  if (seconds > SET_BOUNDS.durationSeconds.max) return { ok: false, message: 'At most 24 hours.' };
  return { ok: true, value: seconds };
}

/** A workout's length for reading: `'1 h 05 min'`, `'45 min'`, `'under 1 min'`. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return 'under 1 min';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return `${h} h ${String(m).padStart(2, '0')} min`;
}

// -----------------------------------------------------------------------------
// Distance (km for kg users, miles for lb users)
// -----------------------------------------------------------------------------

export type DistanceUnit = 'km' | 'mi';

export const METERS_PER_MILE = 1609.344;

export function distanceUnitFor(weightUnit: WeightUnit): DistanceUnit {
  return weightUnit === 'lb' ? 'mi' : 'km';
}

function roundTo(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  const rounded = Math.round(value * scale + 1e-9) / scale;
  return rounded === 0 ? 0 : rounded;
}

/** Metres as an input's text: `5000` -> `'5'` km or `'3.11'` mi. */
export function distanceInputText(meters: number | null, unit: DistanceUnit): string {
  if (meters === null || !Number.isFinite(meters)) return '';
  const value = unit === 'mi' ? meters / METERS_PER_MILE : meters / 1000;
  return String(roundTo(value, 2));
}

/** Typed km/mi -> metres (2 decimals, the API's precision). */
export function parseDistance(text: string, unit: DistanceUnit): ParseResult<number> {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, value: null };
  if (trimmed.includes(',')) return { ok: false, message: 'Use a dot for decimals, for example 5.5.' };
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(trimmed)) return { ok: false, message: 'Enter a number, for example 5.5.' };
  const value = Number(trimmed);
  const meters = roundTo(unit === 'mi' ? value * METERS_PER_MILE : value * 1000, 2);
  if (meters > SET_BOUNDS.distanceMeters.max) return { ok: false, message: 'That is too far.' };
  return { ok: true, value: meters };
}

// -----------------------------------------------------------------------------
// Volume
// -----------------------------------------------------------------------------

/** Kilograms of volume in the display unit, whole numbers: `920.779` kg -> `'2,030 lb'`. */
export function formatVolume(volumeKg: number, unit: WeightUnit): string {
  const value = Math.round(kgToDisplay(volumeKg, unit));
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${unit}`;
}

// -----------------------------------------------------------------------------
// Effort (the evaluator's one-tap input)
// -----------------------------------------------------------------------------

export const EFFORTS = ['easy', 'right', 'hard'] as const;
export type Effort = (typeof EFFORTS)[number];

export const EFFORT_LABEL: Record<Effort, string> = {
  easy: 'Easy',
  right: 'Right',
  hard: 'Hard',
};

/**
 * The RIR a chip stores: Easy -> 3 (3 or more in reserve), Right -> 2 (1-2),
 * Hard -> 0 (nothing left).
 */
export const EFFORT_RIR: Record<Effort, number> = {
  easy: 3,
  right: 2,
  hard: 0,
};

/** Which chip a RIR reads as: 3+ Easy, 1-2 Right, 0 Hard. */
export function effortFromRir(rir: number): Effort {
  if (rir >= 3) return 'easy';
  if (rir >= 1) return 'right';
  return 'hard';
}

/**
 * The chip a set shows: from its RIR, else from its RPE (RIR ~ 10 - RPE),
 * else none. An untouched set has no effort.
 */
export function effortOf(set: Pick<SetLogView, 'rir' | 'rpe'>): Effort | null {
  if (set.rir !== null) return effortFromRir(set.rir);
  if (set.rpe !== null) return effortFromRir(10 - set.rpe);
  return null;
}

/** RPE choices, 1 to 10 in steps of 0.5. */
export const RPE_OPTIONS: number[] = Array.from({ length: 19 }, (_, i) => 1 + i * 0.5);
/** RIR choices, 0 to 10. */
export const RIR_OPTIONS: number[] = Array.from({ length: 11 }, (_, i) => i);

/** A set that holds a value the user typed (weight, reps, time or distance). */
export function setHasValues(
  set: Pick<SetLogView, 'weightKg' | 'reps' | 'durationSeconds' | 'distanceMeters'>,
): boolean {
  return (
    set.weightKg !== null || set.reps !== null || set.durationSeconds !== null || set.distanceMeters !== null
  );
}

// -----------------------------------------------------------------------------
// Days since (E4.6, the Today card's last workout)
// -----------------------------------------------------------------------------

/**
 * Whole calendar days since a workout as the user reads them: `'Today'`,
 * `'Yesterday'`, `'3 days ago'`, `'2 weeks ago'`, `'3 months ago'`,
 * `'1 year ago'`. Built on `Intl.RelativeTimeFormat` so plurals are right.
 */
export function formatDaysAgo(days: number): string {
  const d = Math.max(0, Math.floor(days));
  if (d === 0) return 'Today';
  if (d === 1) return 'Yesterday';
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'always' });
  if (d < 7) return rtf.format(-d, 'day');
  if (d < 30) return rtf.format(-Math.floor(d / 7), 'week');
  if (d < 365) return rtf.format(-Math.max(1, Math.floor(d / 30.44)), 'month');
  return rtf.format(-Math.floor(d / 365), 'year');
}

/** `1 workout`, `2 workouts`; `1 set`, `17 sets`. */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}
