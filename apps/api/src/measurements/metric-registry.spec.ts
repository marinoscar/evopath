import {
  catalogView,
  fromCanonical,
  getMetric,
  isMeasurementMetric,
  isMethodAllowed,
  isWithinBounds,
  MEASUREMENT_METHODS,
  MEASUREMENT_METRIC_KEYS,
  methodsFor,
  MetricRegistryError,
  METRICS,
  roundCanonical,
  toCanonical,
} from './metric-registry';

describe('metric registry', () => {
  describe('catalog matches the epic table', () => {
    // metricKey | label | canonical | units (factor) | bounds | decimals | category | daily
    const EPIC_TABLE = [
      ['weight', 'Weight', 'kg', { kg: 1, lb: 0.45359237 }, 20, 500, 1, 'body', false],
      ['body_fat_pct', 'Body fat', '%', { '%': 1 }, 2, 70, 1, 'body', false],
      ['waist_circumference', 'Waist', 'cm', { cm: 1, in: 2.54 }, 30, 250, 1, 'body', false],
      ['bp_systolic', 'Systolic pressure', 'mmHg', { mmHg: 1 }, 60, 260, 0, 'vital', false],
      ['bp_diastolic', 'Diastolic pressure', 'mmHg', { mmHg: 1 }, 30, 160, 0, 'vital', false],
      ['resting_hr', 'Resting heart rate', 'bpm', { bpm: 1 }, 25, 220, 0, 'vital', false],
      ['energy', 'Energy', 'score', { score: 1 }, 1, 5, 0, 'wellness', true],
      ['sleep_quality', 'Sleep quality', 'score', { score: 1 }, 1, 5, 0, 'wellness', true],
      ['muscle_soreness', 'Muscle soreness', 'score', { score: 1 }, 1, 5, 0, 'wellness', true],
      ['stress', 'Stress', 'score', { score: 1 }, 1, 5, 0, 'wellness', true],
    ] as const;

    it('has exactly the ten metrics, in order, before the lab catalog', () => {
      expect(
        catalogView()
          .metrics.filter((m) => m.category !== 'lab')
          .map((m) => m.key),
      ).toEqual(EPIC_TABLE.map((row) => row[0]));
      expect(catalogView().metrics.slice(0, 10).map((m) => m.key)).toEqual(
        EPIC_TABLE.map((row) => row[0]),
      );
    });

    it.each(EPIC_TABLE)(
      '%s',
      (key, label, canonicalUnit, factors, min, max, decimals, category, daily) => {
        const metric = catalogView().metrics.find((m) => m.key === key)!;

        expect(metric).toMatchObject({ label, canonicalUnit, min, max, decimals, category, daily });
        expect(Object.fromEntries(metric.units.map((u) => [u.unit, u.factor]))).toEqual(factors);
      },
    );

    it('publishes scale labels for the wellness scores only', () => {
      const scales = Object.fromEntries(catalogView().metrics.map((m) => [m.key, m.scale]));

      expect(scales).toMatchObject({
        energy: { min: 1, max: 5, lowLabel: 'Drained', highLabel: 'Energised' },
        sleep_quality: { min: 1, max: 5, lowLabel: 'Poor', highLabel: 'Great' },
        muscle_soreness: { min: 1, max: 5, lowLabel: 'None', highLabel: 'Severe' },
        stress: { min: 1, max: 5, lowLabel: 'Calm', highLabel: 'Overwhelmed' },
        weight: null,
        resting_hr: null,
      });
    });

    it('publishes display units per unit system', () => {
      expect(getMetric('weight')?.displayUnit).toEqual({ metric: 'kg', imperial: 'lb' });
      expect(getMetric('waist_circumference')?.displayUnit).toEqual({ metric: 'cm', imperial: 'in' });
      expect(getMetric('bp_systolic')?.displayUnit).toEqual({ metric: 'mmHg', imperial: 'mmHg' });
    });

    it('publishes the shared method vocabulary with labels', () => {
      expect(catalogView().methods.map((m) => m.key)).toEqual([
        'unspecified',
        'scale',
        'smart_scale',
        'bia',
        'dexa',
        'air_displacement',
        'skinfold',
        'hydrostatic',
        'tape',
        'bp_cuff',
        'manual_pulse',
        'wearable',
        'clinical',
        'self_report',
        'other',
        'lab',
        'point_of_care',
      ]);
      expect(catalogView().methods.every((m) => m.label.length > 0)).toBe(true);
    });

    it('returns copies, so a caller cannot mutate the registry', () => {
      const view = catalogView();
      view.metrics[0].units.push({ unit: 'stone', factor: 6.35, offset: 0, label: 'st' });
      view.metrics[0].methods.push('dexa');

      expect(getMetric('weight')!.units).toHaveLength(2);
      expect(isMethodAllowed('weight', 'dexa')).toBe(false);
    });
  });

  describe('methods', () => {
    it.each([
      ['weight', ['unspecified', 'scale', 'smart_scale', 'clinical', 'other']],
      [
        'body_fat_pct',
        ['unspecified', 'smart_scale', 'bia', 'skinfold', 'dexa', 'air_displacement', 'hydrostatic', 'other'],
      ],
      ['waist_circumference', ['unspecified', 'tape', 'other']],
      ['bp_systolic', ['unspecified', 'bp_cuff', 'clinical', 'wearable', 'other']],
      ['bp_diastolic', ['unspecified', 'bp_cuff', 'clinical', 'wearable', 'other']],
      ['resting_hr', ['unspecified', 'wearable', 'bp_cuff', 'manual_pulse', 'other']],
      ['energy', ['self_report']],
      ['stress', ['self_report']],
    ])('%s allows exactly its subset', (key, methods) => {
      expect([...methodsFor(key)]).toEqual(methods);
    });

    it('only uses methods from the shared vocabulary', () => {
      const vocabulary = new Set<string>(MEASUREMENT_METHODS.map((m) => m.key));

      for (const metric of METRICS) {
        for (const method of metric.methods) {
          expect(vocabulary.has(method)).toBe(true);
        }
      }
    });

    it('refuses dexa for weight and an unknown metric', () => {
      expect(isMethodAllowed('weight', 'dexa')).toBe(false);
      expect(methodsFor('nope')).toEqual([]);
    });
  });

  describe('categories', () => {
    it('treats body and vital metrics as measurements, not wellness', () => {
      expect(MEASUREMENT_METRIC_KEYS).toEqual([
        'weight',
        'body_fat_pct',
        'waist_circumference',
        'bp_systolic',
        'bp_diastolic',
        'resting_hr',
      ]);
      expect(isMeasurementMetric('ldl_cholesterol')).toBe(true);
      expect(isMeasurementMetric('energy')).toBe(false);
      expect(isMeasurementMetric('nope')).toBe(false);
    });
  });

  describe('toCanonical', () => {
    it('converts 208.4 lb to kg rounded to 4 decimals', () => {
      expect(toCanonical('weight', 208.4, 'lb')).toBe(94.5286);
    });

    it('treats an omitted unit as canonical', () => {
      expect(toCanonical('weight', 80)).toBe(80);
      expect(toCanonical('waist_circumference', 34, 'in')).toBe(86.36);
    });

    it('throws a typed error for an unknown unit or metric', () => {
      expect(() => toCanonical('weight', 30, 'stone')).toThrow(MetricRegistryError);
      expect(() => toCanonical('weight', 30, 'stone')).toThrow(
        expect.objectContaining({ reason: 'unknown_unit' }),
      );
      expect(() => toCanonical('nope', 1)).toThrow(
        expect.objectContaining({ reason: 'unknown_metric' }),
      );
      expect(() => toCanonical('weight', Number.NaN)).toThrow(
        expect.objectContaining({ reason: 'not_finite' }),
      );
    });

    it('normalises negative zero', () => {
      expect(Object.is(roundCanonical(-0.00001), 0)).toBe(true);
    });

    it('round-trips every 0.1 lb from 100 to 400 at display precision', () => {
      const drift: number[] = [];

      for (let tenths = 1000; tenths <= 4000; tenths += 1) {
        const lb = tenths / 10;
        const back = fromCanonical('weight', toCanonical('weight', lb, 'lb'), 'lb');

        if (back.toFixed(1) !== lb.toFixed(1)) drift.push(lb);
      }

      expect(drift).toEqual([]);
    });

    it('round-trips every 0.1 in from 12 to 98 at display precision', () => {
      for (let tenths = 120; tenths <= 980; tenths += 1) {
        const inches = tenths / 10;
        const back = fromCanonical(
          'waist_circumference',
          toCanonical('waist_circumference', inches, 'in'),
          'in',
        );
        expect(back.toFixed(1)).toBe(inches.toFixed(1));
      }
    });
  });

  describe('bounds', () => {
    it('is inclusive at both ends, in canonical units', () => {
      expect(isWithinBounds('weight', 20)).toBe(true);
      expect(isWithinBounds('weight', 500)).toBe(true);
      expect(isWithinBounds('weight', 19.9999)).toBe(false);
      expect(isWithinBounds('weight', 5)).toBe(false);
      expect(isWithinBounds('bp_systolic', 261)).toBe(false);
      expect(isWithinBounds('nope', 1)).toBe(false);
      expect(isWithinBounds('weight', Number.POSITIVE_INFINITY)).toBe(false);
    });

    it('checks bounds after conversion (1200 lb is over 500 kg)', () => {
      expect(isWithinBounds('weight', toCanonical('weight', 1200, 'lb'))).toBe(false);
      expect(isWithinBounds('weight', toCanonical('weight', 1000, 'lb'))).toBe(true);
    });
  });
});
