import { describe, it, expect } from 'vitest';
import {
  bmi,
  boundsInDisplayUnits,
  displayUnit,
  formatMeasurement,
  fromDisplay,
  measurementDelta,
  parseDecimal,
  percentDifference,
  toDisplay,
  unitFactor,
} from '../../utils/measurementUnits';
import { catalogMetric, mockMetricCatalog } from '../mocks/fixtures/measurements';

const weight = catalogMetric('weight');
const bodyFat = catalogMetric('body_fat_pct');
const waist = catalogMetric('waist_circumference');
const systolic = catalogMetric('bp_systolic');

describe('measurementUnits', () => {
  describe('displayUnit / unitFactor', () => {
    it('reads the unit per unit system off the catalog', () => {
      expect(displayUnit(weight, 'metric')).toBe('kg');
      expect(displayUnit(weight, 'imperial')).toBe('lb');
      expect(displayUnit(waist, 'imperial')).toBe('in');
      expect(displayUnit(bodyFat, 'imperial')).toBe('%');
    });

    it('uses the factor the catalog publishes, not a constant of its own', () => {
      const altered = { ...weight, units: [{ unit: 'kg', factor: 1, label: 'kg' }, { unit: 'lb', factor: 0.5, label: 'lb' }] };
      expect(unitFactor(altered, 'lb')).toBe(0.5);
      expect(toDisplay(altered, 50, 'imperial')).toBe(100);
    });

    it('throws for a unit the metric does not allow', () => {
      expect(() => unitFactor(weight, 'stone')).toThrow();
    });
  });

  describe('toDisplay / fromDisplay', () => {
    it('converts canonical kg to lb rounded to the metric decimals', () => {
      expect(toDisplay(weight, 94.5327, 'imperial')).toBe(208.4);
      expect(toDisplay(weight, 94.5327, 'metric')).toBe(94.5);
    });

    it('converts cm to in', () => {
      expect(toDisplay(waist, 81.28, 'imperial')).toBe(32);
    });

    it('rounds to whole numbers for a zero-decimal metric', () => {
      expect(toDisplay(systolic, 127.6, 'metric')).toBe(128);
    });

    it('converts a displayed value back to canonical', () => {
      expect(fromDisplay(weight, 208.4, 'imperial')).toBeCloseTo(94.5287, 3);
      expect(fromDisplay(weight, 80, 'metric')).toBe(80);
    });
  });

  describe('formatMeasurement', () => {
    it('formats with the unit and fixed decimals', () => {
      expect(formatMeasurement(weight, 94.5327, 'imperial')).toBe('208.4 lb');
      expect(formatMeasurement(weight, 80, 'metric')).toBe('80.0 kg');
      expect(formatMeasurement(bodyFat, 27.8, 'metric')).toBe('27.8%');
      expect(formatMeasurement(systolic, 128, 'metric')).toBe('128 mmHg');
    });

    it('can leave the unit out', () => {
      expect(formatMeasurement(weight, 94.5327, 'imperial', { withUnit: false })).toBe('208.4');
    });
  });

  describe('parseDecimal', () => {
    it.each([
      ['208.4', 208.4],
      ['208,4', 208.4],
      ['  80 ', 80],
      ['0.5', 0.5],
      ['.5', 0.5],
      ['80.', 80],
    ])('accepts %j as %d', (text, expected) => {
      expect(parseDecimal(text)).toBe(expected);
    });

    it.each(['', '   ', '1e3', 'Infinity', 'NaN', '-5', '+5', '1,000.5', '1.2.3', 'abc', '12 kg', '0x10'])(
      'rejects %j',
      (text) => {
        expect(parseDecimal(text)).toBeNull();
      },
    );
  });

  describe('boundsInDisplayUnits', () => {
    it('returns the canonical bounds for the canonical unit', () => {
      expect(boundsInDisplayUnits(weight, 'metric')).toEqual({ min: 20, max: 500 });
      expect(boundsInDisplayUnits(systolic, 'imperial')).toEqual({ min: 60, max: 260 });
    });

    it('rounds converted bounds inward', () => {
      // 20 kg = 44.092 lb, 500 kg = 1102.311 lb.
      expect(boundsInDisplayUnits(weight, 'imperial')).toEqual({ min: 44.1, max: 1102.3 });
      // 30 cm = 11.811 in, 250 cm = 98.425 in.
      expect(boundsInDisplayUnits(waist, 'imperial')).toEqual({ min: 11.9, max: 98.4 });
    });
  });

  describe('bmi', () => {
    it('computes kg / m² to one decimal', () => {
      expect(bmi(76.2, 1778)).toBe(24.1);
      expect(bmi(80, 1800)).toBe(24.7);
    });

    it('is null without weight or height', () => {
      expect(bmi(null, 1778)).toBeNull();
      expect(bmi(80, null)).toBeNull();
      expect(bmi(80, 0)).toBeNull();
    });
  });

  describe('percentDifference', () => {
    it('is relative to the previous value', () => {
      expect(percentDifference(120, 80)).toBe(50);
      expect(percentDifference(60, 80)).toBe(25);
      expect(percentDifference(80, 80)).toBe(0);
    });
  });

  describe('measurementDelta', () => {
    it('reads up and down in the user unit, neutrally', () => {
      const up = measurementDelta(weight, 94.5327, 94.3513, 'imperial');
      expect(up).toEqual({
        direction: 'up',
        text: '+0.4 lb',
        spoken: 'up 0.4 pounds since previous reading',
      });
      const down = measurementDelta(weight, 94.3, 94.5, 'metric');
      expect(down).toEqual({
        direction: 'down',
        text: '-0.2 kg',
        spoken: 'down 0.2 kilograms since previous reading',
      });
    });

    it('says "no change" when the displayed values are equal', () => {
      expect(measurementDelta(weight, 80.01, 80.02, 'metric')).toEqual({
        direction: 'none',
        text: 'no change',
        spoken: 'no change since previous reading',
      });
    });

    it('writes percentages without a space', () => {
      expect(measurementDelta(bodyFat, 27.8, 28.3, 'metric').text).toBe('-0.5%');
    });
  });

  it('the fixture catalog carries factors for every body and vital metric', () => {
    for (const metric of mockMetricCatalog.metrics.filter((m) => m.category !== 'wellness')) {
      expect(unitFactor(metric, displayUnit(metric, 'metric'))).toBeGreaterThan(0);
      expect(unitFactor(metric, displayUnit(metric, 'imperial'))).toBeGreaterThan(0);
    }
  });
});
