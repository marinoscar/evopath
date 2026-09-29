/** Height conversions for the Health Profile form (issue #47, E2.1). */
import { describe, it, expect } from 'vitest';
import {
  cmTextToMm,
  feetInchesToMm,
  mmToCmText,
  mmToFeetInches,
} from '../../utils/heightUnits';

describe('heightUnits', () => {
  it('5 ft 10 in is exactly 1778 mm, which reads as 177.8 cm', () => {
    expect(feetInchesToMm(5, 10)).toBe(1778);
    expect(mmToCmText(1778)).toBe('177.8');
    expect(cmTextToMm('177.8')).toBe(1778);
    expect(mmToFeetInches(1778)).toEqual({ feet: 5, inches: 10 });
  });

  it('formats whole centimetres without a decimal', () => {
    expect(mmToCmText(1800)).toBe('180');
  });

  it('rounds inches to one decimal and carries into the next foot', () => {
    expect(mmToFeetInches(1800)).toEqual({ feet: 5, inches: 10.9 });
    // 71.99 in rounds to 72.0 in: 6 ft 0 in, never 5 ft 12 in.
    expect(mmToFeetInches(1828.6)).toEqual({ feet: 6, inches: 0 });
  });

  it('parses centimetre text to whole millimetres, or null', () => {
    expect(cmTextToMm(' 180 ')).toBe(1800);
    expect(cmTextToMm('180.04')).toBe(1800);
    expect(cmTextToMm('')).toBeNull();
    expect(cmTextToMm('abc')).toBeNull();
  });
});
