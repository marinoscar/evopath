/** `utils/units.ts` (E4.2): kg <-> lb display conversions and weight parsing. */
import { describe, it, expect } from 'vitest';
import {
  KG_PER_LB,
  displayToKg,
  formatWeight,
  formatWeightNumber,
  kgToDisplay,
  maxWeightInUnit,
  parseWeight,
  weightUnitFor,
} from '../../utils/units';

describe('utils/units', () => {
  it('maps the Health Profile unit system to a weight unit (metric by default)', () => {
    expect(weightUnitFor('imperial')).toBe('lb');
    expect(weightUnitFor('metric')).toBe('kg');
    expect(weightUnitFor(null)).toBe('kg');
    expect(weightUnitFor(undefined)).toBe('kg');
  });

  it('uses the exact pound', () => {
    expect(KG_PER_LB).toBe(0.45359237);
  });

  it('converts display values to kilograms at 0.001 kg', () => {
    expect(displayToKg(135, 'lb')).toBe(61.235);
    expect(displayToKg(70, 'lb')).toBe(31.751);
    expect(displayToKg(31.75, 'kg')).toBe(31.75);
    expect(displayToKg(12.3456, 'kg')).toBe(12.346);
    expect(displayToKg(0, 'lb')).toBe(0);
  });

  it('rounds pounds to 0.1 and kilograms to 0.05 for display', () => {
    expect(kgToDisplay(61.235, 'lb')).toBe(135);
    expect(kgToDisplay(31.751, 'lb')).toBe(70);
    expect(kgToDisplay(31.751, 'kg')).toBe(31.75);
    expect(kgToDisplay(62.52, 'kg')).toBe(62.5);
    expect(kgToDisplay(62.53, 'kg')).toBe(62.55);
    expect(kgToDisplay(0.1, 'kg')).toBe(0.1);
    expect(kgToDisplay(20, 'lb')).toBe(44.1);
  });

  it('round-trips 135 lb -> 61.235 kg -> 135.0 lb and 70 lb -> 31.751 kg -> 70.0 lb', () => {
    const kg135 = displayToKg(135, 'lb');
    expect(kg135).toBe(61.235);
    expect(formatWeight(kg135, 'lb')).toBe('135.0 lb');
    const kg70 = displayToKg(70, 'lb');
    expect(kg70).toBe(31.751);
    expect(formatWeight(kg70, 'lb')).toBe('70.0 lb');
  });

  it('round-trips every 0.1 lb step and every 0.05 kg step within display precision', () => {
    for (let tenths = 0; tenths <= 22046; tenths += 7) {
      const lb = tenths / 10;
      expect(kgToDisplay(displayToKg(lb, 'lb'), 'lb')).toBe(lb);
    }
    for (let twentieths = 0; twentieths <= 20000; twentieths += 3) {
      const kg = Number((twentieths / 20).toFixed(2));
      expect(kgToDisplay(displayToKg(kg, 'kg'), 'kg')).toBe(kg);
    }
  });

  it('formats kilograms without trailing zeros and pounds with one decimal', () => {
    expect(formatWeight(100, 'kg')).toBe('100 kg');
    expect(formatWeight(31.75, 'kg')).toBe('31.75 kg');
    expect(formatWeight(62.5, 'kg')).toBe('62.5 kg');
    expect(formatWeight(0, 'kg')).toBe('0 kg');
    expect(formatWeight(100, 'lb')).toBe('220.5 lb');
    expect(formatWeight(0, 'lb')).toBe('0.0 lb');
    expect(formatWeight(317.5, 'kg')).toBe('317.5 kg');
    expect(formatWeightNumber(61.235, 'lb')).toBe('135.0');
    expect(formatWeight(61.235, 'lb', { withUnit: false })).toBe('135.0');
  });

  it('formats a missing weight as an empty string', () => {
    expect(formatWeight(null, 'kg')).toBe('');
    expect(formatWeight(undefined, 'lb')).toBe('');
    expect(formatWeight(Number.NaN, 'kg')).toBe('');
  });

  it('parses "12.5" and refuses "12,5" with a message', () => {
    expect(parseWeight('12.5', 'kg')).toEqual({ ok: true, kg: 12.5, value: 12.5 });
    expect(parseWeight(' 135 ', 'lb')).toEqual({ ok: true, kg: 61.235, value: 135 });
    expect(parseWeight('.5', 'kg')).toEqual({ ok: true, kg: 0.5, value: 0.5 });
    const comma = parseWeight('12,5', 'kg');
    expect(comma.ok).toBe(false);
    if (!comma.ok) expect(comma.message).toMatch(/dot for decimals/);
  });

  it('treats a blank field as no weight', () => {
    expect(parseWeight('', 'kg')).toEqual({ ok: true, kg: null, value: null });
    expect(parseWeight('   ', 'lb')).toEqual({ ok: true, kg: null, value: null });
  });

  it('refuses negatives, exponents and non-numbers', () => {
    for (const text of ['-5', '1e3', 'abc', '12.5kg', 'Infinity', '1.2.3', '+5']) {
      const result = parseWeight(text, 'kg');
      expect(result.ok, text).toBe(false);
      if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
    }
    const negative = parseWeight('-5', 'lb');
    if (!negative.ok) expect(negative.message).toMatch(/negative/);
  });

  it('refuses a value above 1000 kg in either unit', () => {
    expect(maxWeightInUnit('kg')).toBe(1000);
    expect(maxWeightInUnit('lb')).toBe(2204.6);
    expect(parseWeight('1000', 'kg').ok).toBe(true);
    expect(parseWeight('2204.6', 'lb').ok).toBe(true);
    const overKg = parseWeight('1000.01', 'kg');
    expect(overKg).toEqual({ ok: false, message: 'At most 1000 kg.' });
    const overLb = parseWeight('2204.7', 'lb');
    expect(overLb).toEqual({ ok: false, message: 'At most 2204.6 lb.' });
  });
});
