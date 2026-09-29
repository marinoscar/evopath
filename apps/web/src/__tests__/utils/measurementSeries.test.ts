/**
 * The Trend/History helpers (issue #60, E2.5): grouping readings into entries
 * across pages, one series per method over the union of timestamps, the
 * y-domain, the accessible summary, and conversion through the catalog.
 */
import { describe, expect, it } from 'vitest';
import {
  describeEntry,
  distinctMethods,
  groupByEntry,
  metricChoices,
  rangeText,
  spokenList,
  summaryLabel,
  toChartSeries,
  toGroupedChartSeries,
  yDomain,
} from '../../utils/measurementSeries';
import { toDisplay } from '../../utils/measurementUnits';
import { catalogMetric, mockMeasurement, mockMetricCatalog } from '../mocks/fixtures/measurements';

const METHOD_LABELS = new Map(mockMetricCatalog.methods.map((m) => [m.key, m.label]));
const METRICS = new Map(mockMetricCatalog.metrics.map((m) => [m.key, m]));
const identity = (v: number) => v;

describe('groupByEntry', () => {
  it('groups rows by entry, newest first, readings in registry order', () => {
    const rows = [
      mockMeasurement('body_fat_pct', 27.8, { entryId: 'e2', measuredAt: '2026-09-29T08:00:00.000Z' }),
      mockMeasurement('weight', 80, { entryId: 'e2', measuredAt: '2026-09-29T08:00:00.000Z' }),
      mockMeasurement('weight', 81, { entryId: 'e1', measuredAt: '2026-09-20T08:00:00.000Z' }),
    ];
    const entries = groupByEntry(rows);
    expect(entries.map((e) => e.entryId)).toEqual(['e2', 'e1']);
    expect(entries[0].readings.map((r) => r.metricKey)).toEqual(['weight', 'body_fat_pct']);
  });

  it('merges an entry split across two pages and counts a repeated row once', () => {
    const systolic = mockMeasurement('bp_systolic', 128, { entryId: 'bp', measuredAt: '2026-09-28T08:00:00.000Z' });
    const diastolic = mockMeasurement('bp_diastolic', 84, { entryId: 'bp', measuredAt: '2026-09-28T08:00:00.000Z' });
    const page1 = [mockMeasurement('weight', 80, { entryId: 'w', measuredAt: '2026-09-29T08:00:00.000Z' }), systolic];
    const page2 = [diastolic, systolic];
    const entries = groupByEntry([...page1, ...page2]);
    expect(entries).toHaveLength(2);
    expect(entries[1].readings.map((r) => r.metricKey)).toEqual(['bp_systolic', 'bp_diastolic']);
  });

  it('marks an entry edited when any reading has revision > 1 and keeps its note', () => {
    const [entry] = groupByEntry([
      mockMeasurement('weight', 80, { entryId: 'e', notes: 'after run', revision: 2, edited: true }),
      mockMeasurement('body_fat_pct', 20, { entryId: 'e', notes: 'after run', revision: 2, edited: true }),
    ]);
    expect(entry.edited).toBe(true);
    expect(entry.notes).toBe('after run');
    expect(groupByEntry([mockMeasurement('weight', 80)])[0].edited).toBe(false);
  });

  it('keeps arrival order for entries at the same instant', () => {
    const at = '2026-09-29T08:00:00.000Z';
    const entries = groupByEntry([
      mockMeasurement('weight', 80, { entryId: 'b', measuredAt: at }),
      mockMeasurement('weight', 81, { entryId: 'a', measuredAt: at }),
    ]);
    expect(entries.map((e) => e.entryId)).toEqual(['b', 'a']);
  });
});

describe('describeEntry', () => {
  it('shows a blood-pressure pair as one line and hides the unspecified method', () => {
    const views = describeEntry(
      {
        readings: [
          mockMeasurement('bp_systolic', 128, { method: 'bp_cuff' }),
          mockMeasurement('bp_diastolic', 84, { method: 'bp_cuff' }),
          mockMeasurement('resting_hr', 58),
        ],
      },
      METRICS,
      'metric',
    );
    expect(views.map((v) => [v.label, v.text, v.methods])).toEqual([
      ['Blood pressure', '128/84 mmHg', ['bp_cuff']],
      ['Resting heart rate', '58 bpm', []],
    ]);
  });

  it('converts to the user unit through the catalog', () => {
    const [view] = describeEntry({ readings: [mockMeasurement('weight', 94.5327)] }, METRICS, 'imperial');
    expect(view.text).toBe('208.4 lb');
  });

  it('spokenList joins labels for accessible names', () => {
    expect(spokenList(['Weight'])).toBe('weight');
    expect(spokenList(['Weight', 'Body fat'])).toBe('weight and body fat');
    expect(spokenList(['Weight', 'Body fat', 'Waist'])).toBe('weight, body fat and waist');
  });
});

describe('toChartSeries', () => {
  it('makes one series per method over the sorted union of timestamps, null elsewhere', () => {
    const { xData, series } = toChartSeries(
      [
        { measuredAt: '2026-09-01T08:00:00.000Z', value: 80, method: 'scale' },
        { measuredAt: '2026-09-02T08:00:00.000Z', value: 80.5, method: 'smart_scale' },
        { measuredAt: '2026-09-03T08:00:00.000Z', value: 81, method: 'scale' },
      ],
      METHOD_LABELS,
      identity,
    );
    expect(xData.map((d) => d.toISOString().slice(0, 10))).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
    expect(series.map((s) => [s.label, s.data])).toEqual([
      ['Scale', [80, null, 81]],
      ['Smart scale', [null, 80.5, null]],
    ]);
  });

  it('plots two methods at the same instant in two series', () => {
    const at = '2026-09-01T08:00:00.000Z';
    const { xData, series } = toChartSeries(
      [
        { measuredAt: at, value: 80, method: 'smart_scale' },
        { measuredAt: at, value: 79.6, method: 'scale' },
      ],
      METHOD_LABELS,
      identity,
    );
    expect(xData).toHaveLength(1);
    expect(series.map((s) => [s.method, s.data])).toEqual([
      ['scale', [79.6]],
      ['smart_scale', [80]],
    ]);
  });

  it('dedupes a repeated instant within one method: the LAST point wins', () => {
    const at = '2026-09-01T08:00:00.000Z';
    const { xData, series } = toChartSeries(
      [
        { measuredAt: at, value: 80, method: 'scale' },
        { measuredAt: at, value: 80.4, method: 'scale' },
      ],
      METHOD_LABELS,
      identity,
    );
    expect(xData).toHaveLength(1);
    expect(series[0].data).toEqual([80.4]);
  });

  it('converts values with the given toDisplay (kg → lb from the catalog)', () => {
    const weight = catalogMetric('weight');
    const { series } = toChartSeries(
      [{ measuredAt: '2026-09-01T08:00:00.000Z', value: 94.5327, method: 'unspecified' }],
      METHOD_LABELS,
      (v) => toDisplay(weight, v, 'imperial'),
    );
    expect(series[0].data).toEqual([208.4]);
    expect(series[0].label).toBe('Not specified');
  });

  it('labels grouped series with the part and the method (blood pressure)', () => {
    const at = '2026-09-01T08:00:00.000Z';
    const { series } = toGroupedChartSeries(
      [
        { key: 'bp_systolic', label: 'Systolic', points: [{ measuredAt: at, value: 128, method: 'bp_cuff' }], toDisplay: identity },
        { key: 'bp_diastolic', label: 'Diastolic', points: [{ measuredAt: at, value: 84, method: 'bp_cuff' }], toDisplay: identity },
      ],
      METHOD_LABELS,
    );
    expect(series.map((s) => [s.id, s.label])).toEqual([
      ['bp_systolic:bp_cuff', 'Systolic (Blood-pressure cuff)'],
      ['bp_diastolic:bp_cuff', 'Diastolic (Blood-pressure cuff)'],
    ]);
  });

  it('returns nothing for no points', () => {
    expect(toChartSeries([], METHOD_LABELS, identity)).toEqual({ xData: [], series: [] });
  });
});

describe('distinctMethods', () => {
  it('lists methods in catalog order, unknown ones last', () => {
    expect(
      distinctMethods([{ method: 'smart_scale' }, { method: 'mystery' }, { method: 'scale' }, { method: 'scale' }], METHOD_LABELS),
    ).toEqual(['scale', 'smart_scale', 'mystery']);
  });
});

describe('yDomain', () => {
  it('pads 5% of the spread on each side, not forced to zero', () => {
    expect(yDomain([200, 210])).toEqual({ min: 199.5, max: 210.5 });
  });

  it('pads a flat series by one unit either side', () => {
    expect(yDomain([80, 80, null])).toEqual({ min: 79, max: 81 });
  });

  it('is null without values', () => {
    expect(yDomain([null])).toBeNull();
  });
});

describe('summaryLabel and rangeText', () => {
  it('reads metric, range, count, latest and min to max', () => {
    const weight = catalogMetric('weight');
    const range = rangeText(weight, [93, 94.5327, 96.3], 'imperial');
    expect(range).toBe('205.0 to 212.3 lb');
    expect(summaryLabel({ metric: 'Weight', days: 90, count: 12, latest: '208.4 lb', range })).toBe(
      'Weight, last 90 days, 12 readings, latest 208.4 lb, range 205.0 to 212.3 lb',
    );
  });

  it('says 1 reading and omits what is unknown', () => {
    expect(summaryLabel({ metric: 'Waist', days: 30, count: 1 })).toBe('Waist, last 30 days, 1 reading');
  });
});

describe('metricChoices', () => {
  it('groups Body, Vitals and How you feel, with blood pressure as one choice', () => {
    const choices = metricChoices(mockMetricCatalog.metrics);
    expect(choices.map((c) => [c.group, c.id])).toEqual([
      ['Body', 'weight'],
      ['Body', 'body_fat_pct'],
      ['Body', 'waist_circumference'],
      ['Vitals', 'blood_pressure'],
      ['Vitals', 'resting_hr'],
      ['How you feel', 'energy'],
    ]);
    expect(choices[3].metricKeys).toEqual(['bp_systolic', 'bp_diastolic']);
  });

  it('leaves out wellness metrics for History', () => {
    expect(metricChoices(mockMetricCatalog.metrics, { includeWellness: false }).map((c) => c.id)).not.toContain('energy');
  });
});
