/**
 * The lab unit formatter (#234): canonical values, printed limits and deltas
 * in the preferred unit, using only the catalog's factors and offsets.
 * The pinned conversions match the API's catalog (`metric-registry.ts`).
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAB_UNITS,
  convertLabPoint,
  convertLabRange,
  convertLabRow,
  convertSummaryItem,
  deltaToDisplay,
  labDisplay,
  labDisplayUnit,
  labUnitsNote,
  labUnitsOf,
  toDisplay,
} from '../../utils/labUnits';
import { LAB_METRICS } from '../mocks/fixtures/labReportIntake';
import { biomarkerResult, labMeasurement, labSeriesPoint, summaryItem } from '../mocks/fixtures/biomarkers';

const metric = (key: string) => LAB_METRICS.find((m) => m.key === key)!;

describe('labDisplayUnit', () => {
  it('is the canonical unit under conventional and the siUnit under si', () => {
    expect(labDisplayUnit(metric('fasting_glucose'), 'conventional').unit).toBe('mg/dL');
    expect(labDisplayUnit(metric('fasting_glucose'), 'si').unit).toBe('mmol/L');
    expect(labDisplayUnit(metric('creatinine'), 'si').unit).toBe('µmol/L');
    expect(labDisplayUnit(metric('hba1c'), 'si').unit).toBe('mmol/mol');
  });

  it('stays canonical when the SI unit is the canonical one, or the catalog names none', () => {
    expect(labDisplayUnit(metric('tsh'), 'si').unit).toBe('mIU/L');
    expect(labDisplayUnit({ ...metric('ldl_cholesterol'), siUnit: null }, 'si').unit).toBe('mg/dL');
    expect(labDisplayUnit({ ...metric('ldl_cholesterol'), siUnit: undefined }, 'si').unit).toBe('mg/dL');
    // An siUnit the metric does not accept is ignored rather than guessed.
    expect(labDisplayUnit({ ...metric('ldl_cholesterol'), siUnit: 'g/L' }, 'si').unit).toBe('mg/dL');
  });
});

describe('toDisplay (pinned SI conversions)', () => {
  const si = (key: string) => labDisplayUnit(metric(key), 'si');

  it('glucose 100 mg/dL is 5.6 mmol/L at the unit\'s 1 decimal (5.55 as a raw conversion)', () => {
    expect(toDisplay(100, si('fasting_glucose'))).toBe(5.6);
    expect(toDisplay(100, { ...si('fasting_glucose'), decimals: 2 })).toBe(5.55);
  });

  it('LDL 124 mg/dL is 3.21 mmol/L', () => {
    expect(toDisplay(124, si('ldl_cholesterol'))).toBe(3.21);
  });

  it('creatinine 1.0 mg/dL is 88 µmol/L', () => {
    expect(toDisplay(1.0, si('creatinine'))).toBe(88);
  });

  it('HbA1c 6.5 % is 48 mmol/mol (47.54, the offset applied, rounded to 0 dp)', () => {
    expect(toDisplay(6.5, si('hba1c'))).toBe(48);
    expect(toDisplay(6.5, { ...si('hba1c'), decimals: 2 })).toBe(47.54);
  });

  it('falls back to the given decimals when the unit has none, and is unrounded without either', () => {
    expect(toDisplay(100, { factor: 3 }, 1)).toBe(33.3);
    expect(toDisplay(100, { factor: 4 })).toBe(25);
    expect(toDisplay(100, { factor: 3 })).toBeCloseTo(33.3333, 4);
  });

  it('is the identity in the canonical unit', () => {
    expect(toDisplay(142, labDisplayUnit(metric('ldl_cholesterol'), 'conventional'), 1)).toBe(142);
  });
});

describe('deltaToDisplay', () => {
  it('converts a difference with the factor only, never the offset', () => {
    const hba1c = labDisplayUnit(metric('hba1c'), 'si');
    // +1.0 % is +10.929 mmol/mol; subtracting the offset would make it negative.
    expect(deltaToDisplay(1, hba1c, 2)).toBe(11);
    expect(deltaToDisplay(1, { ...hba1c, decimals: 3 })).toBe(10.929);
    expect(deltaToDisplay(12, labDisplayUnit(metric('ldl_cholesterol'), 'si'))).toBe(0.31);
  });
});

describe('labDisplay', () => {
  it('conventional passes rows through untouched (today’s output)', () => {
    const display = labDisplay(metric('ldl_cholesterol'), 'conventional');
    expect(display).toMatchObject({ unit: 'mg/dL', decimals: 1, converted: false });
    const row = labMeasurement('ldl_cholesterol', 142, 'mg/dL', { referenceLow: 0, referenceHigh: 99.5 });
    expect(convertLabRow(row, display, 'mg/dL')).toBe(row);
  });

  it('si converts the value (unrounded) and the printed limits (rounded), and names the unit', () => {
    const display = labDisplay(metric('ldl_cholesterol'), 'si');
    expect(display).toMatchObject({ unit: 'mmol/L', decimals: 2, converted: true });
    const row = labMeasurement('ldl_cholesterol', 124, 'mg/dL', { referenceLow: 0, referenceHigh: 100, referenceText: '0-100' });
    const shown = convertLabRow(row, display, 'mg/dL');
    expect(shown.unit).toBe('mmol/L');
    expect(shown.value).toBeCloseTo(3.2066, 4);
    expect(shown.referenceLow).toBe(0);
    expect(shown.referenceHigh).toBe(2.59);
    // The printed text is the lab's own; it is not rewritten.
    expect(shown.referenceText).toBe('0-100');
    // The stored row is not modified.
    expect(row.value).toBe(124);
  });

  it('leaves a row that is not in the canonical unit alone', () => {
    const display = labDisplay(metric('ldl_cholesterol'), 'si');
    const row = labMeasurement('ldl_cholesterol', 3.2, 'mmol/L');
    expect(convertLabRow(row, display, 'mg/dL')).toBe(row);
  });

  it('is the identity without a metric (catalog not loaded)', () => {
    const display = labDisplay(null, 'si', 'mg/dL');
    expect(display).toMatchObject({ unit: 'mg/dL', converted: false });
    expect(display.value(5)).toBe(5);
  });

  it('converts a series point and its range, and a range on its own', () => {
    const display = labDisplay(metric('fasting_glucose'), 'si');
    const point = convertLabPoint(labSeriesPoint('2026-01-01T00:00:00.000Z', 100, { referenceLow: 70, referenceHigh: 99 }), display);
    expect(point.value).toBeCloseTo(5.55, 4);
    // Limits are rounded to the unit's 1 decimal.
    expect([point.referenceLow, point.referenceHigh]).toEqual([3.9, 5.5]);
    expect(convertLabRange({ referenceLow: null, referenceHigh: 126 }, display)).toEqual({ referenceLow: null, referenceHigh: 7 });
  });

  it('converts a summary item: latest, previous, delta and unit', () => {
    const display = labDisplay(metric('ldl_cholesterol'), 'si');
    const item = summaryItem(
      'ldl_cholesterol',
      'LDL cholesterol',
      'lipids',
      'mg/dL',
      biomarkerResult(142, '2026-09-15T12:00:00.000Z', { referenceHigh: 100 }),
      biomarkerResult(130, '2026-03-10T12:00:00.000Z'),
    );
    const shown = convertSummaryItem(item, display, 'mg/dL');
    expect(shown.unit).toBe('mmol/L');
    expect(shown.latest.value).toBeCloseTo(3.6721, 4);
    expect(shown.latest.referenceHigh).toBe(2.59);
    expect(shown.previous!.value).toBeCloseTo(3.3618, 4);
    expect(shown.delta).toBeCloseTo(0.3103, 4);
    expect(convertSummaryItem(item, labDisplay(metric('ldl_cholesterol'), 'conventional'), 'mg/dL')).toBe(item);
  });
});

describe('preference helpers', () => {
  it('defaults to conventional when the profile is unknown', () => {
    expect(DEFAULT_LAB_UNITS).toBe('conventional');
    expect(labUnitsOf(null)).toBe('conventional');
    expect(labUnitsOf({})).toBe('conventional');
    expect(labUnitsOf({ labUnits: 'si' })).toBe('si');
  });

  it('names the unit system', () => {
    expect(labUnitsNote('si')).toBe('Values in SI units');
    expect(labUnitsNote('conventional')).toBe('Values in US conventional units');
  });
});
