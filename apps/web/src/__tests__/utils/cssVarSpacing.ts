/**
 * Helpers for asserting on spacing under the CSS-variables theme.
 *
 * With `cssVariables` on, `theme.spacing(n)` — and so every `sx` spacing
 * shorthand (`px`, `mx`, `pb`, …) — emits `calc(n * var(--mui-spacing))`,
 * not a pixel length. jsdom cannot resolve `var()` (setting `--mui-spacing`
 * on `<html>` does not make `getComputedStyle` return a resolved value), so a
 * `parseFloat` of a computed padding is `NaN`.
 *
 * The honest assertion is on the EMITTED declaration. These helpers read it
 * back as a number of spacing UNITS (`calc(10 * var(--mui-spacing))` -> 10;
 * a lone `var(--mui-spacing)` is 1),
 * which is the quantity the component's `sx` actually states, or — for tests
 * that compare against a pixel budget — as pixels at the theme's 8px unit.
 */

/** MUI's default spacing unit; the theme does not override `spacing`. */
export const SPACING_UNIT_PX = 8;

/**
 * What the rendered `sx` emits for `n` spacing units under the CSS-variables
 * theme: `calc(n * var(--mui-spacing))`, except that MUI collapses exactly one
 * unit to the bare `var(--mui-spacing)`.
 *
 * Note this is the RENDERED form. A bare `theme.spacing(n)` call on the
 * module-level theme object adds a `, 8px` fallback inside the `var()`, so do
 * not derive an expectation about emitted CSS from it.
 */
export function spacingDeclaration(units: number): string {
  return units === 1 ? 'var(--mui-spacing)' : `calc(${units} * var(--mui-spacing))`;
}

const SPACING_CALC = /^calc\(\s*(-?[\d.]+)\s*\*\s*var\(--mui-spacing\)\s*\)$/;

/**
 * Reads a computed spacing declaration as a number of spacing units.
 * Accepts the emitted `calc(N * var(--mui-spacing))`, and plain `Npx`
 * (interpreted at `SPACING_UNIT_PX`) or an empty / `0` value so a side the
 * component does not set reads as 0. Throws on anything else, so an
 * unrecognised emission fails loudly instead of comparing as `NaN`.
 */
export function spacingUnits(declaration: string): number {
  const value = declaration.trim();
  if (value === '' || value === '0' || value === '0px') return 0;
  if (value === 'var(--mui-spacing)') return 1;
  const calc = SPACING_CALC.exec(value);
  if (calc) return Number.parseFloat(calc[1]);
  const px = /^(-?[\d.]+)px$/.exec(value);
  if (px) return Number.parseFloat(px[1]) / SPACING_UNIT_PX;
  throw new Error(`cssVarSpacing: unrecognised spacing declaration "${declaration}"`);
}

/** `spacingUnits` at the theme's unit, in pixels. */
export function spacingPx(declaration: string): number {
  return spacingUnits(declaration) * SPACING_UNIT_PX;
}
