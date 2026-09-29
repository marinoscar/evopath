/**
 * Height conversions for the Health Profile form (issue #47).
 *
 * The stored unit is integer millimetres. An inch is exactly 25.4 mm, so
 * 5 ft 10 in is exactly 1778 mm and reads back as 177.8 cm; a float in
 * centimetres would drift. These helpers only format and parse for display;
 * the API decides what is valid.
 */

export const MM_PER_INCH = 25.4;
const INCHES_PER_FOOT = 12;

/** `1778` → `'177.8'`, `1800` → `'180'`. */
export function mmToCmText(mm: number): string {
  return String(mm / 10);
}

/** `'177.8'` → `1778`. `null` for anything that is not a finite number. */
export function cmTextToMm(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const cm = Number(trimmed);
  if (!Number.isFinite(cm)) return null;
  return Math.round(cm * 10);
}

/**
 * `1778` → `{ feet: 5, inches: 10 }`. Inches are rounded to one decimal, and
 * a rounding that reaches 12 carries into the next foot.
 */
export function mmToFeetInches(mm: number): { feet: number; inches: number } {
  const tenthsOfInch = Math.round((mm / MM_PER_INCH) * 10);
  const feet = Math.floor(tenthsOfInch / (INCHES_PER_FOOT * 10));
  const inches = (tenthsOfInch - feet * INCHES_PER_FOOT * 10) / 10;
  return { feet, inches };
}

/** `(5, 10)` → `1778`, rounded to the nearest whole millimetre. */
export function feetInchesToMm(feet: number, inches: number): number {
  return Math.round((feet * INCHES_PER_FOOT + inches) * MM_PER_INCH);
}
