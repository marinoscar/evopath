import {
  bloodPressureProblem,
  createMeasurementEntrySchema,
  listMeasurementsQuerySchema,
  listMetricKeys,
  MAX_LAB_READINGS_PER_ENTRY,
  referenceRangeProblem,
  seriesQuerySchema,
  updateMeasurementEntrySchema,
} from './measurement.dto';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The paths of the issues a failed parse reports, joined with dots. */
function issuePaths(result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[] }> } }) {
  expect(result.success).toBe(false);
  return result.error!.issues.map((issue) => issue.path.map(String).join('.'));
}

describe('createMeasurementEntrySchema', () => {
  it('converts to canonical units and leaves method unset when omitted', () => {
    const parsed = createMeasurementEntrySchema.parse({
      readings: [{ metricKey: 'weight', value: 208.4, unit: 'lb' }],
    });

    expect(parsed).toEqual({
      measuredAt: undefined,
      notes: null,
      readings: [{ metricKey: 'weight', value: 94.5286, unit: 'kg' }],
    });
  });

  it('accepts weight + body fat + waist and a blood-pressure pair', () => {
    const parsed = createMeasurementEntrySchema.parse({
      measuredAt: '2026-09-01T07:30:00+02:00',
      notes: '  after run  ',
      readings: [
        { metricKey: 'weight', value: 80, method: 'smart_scale' },
        { metricKey: 'body_fat_pct', value: 22.5, unit: '%', method: 'smart_scale' },
        { metricKey: 'waist_circumference', value: 34, unit: 'in' },
        { metricKey: 'bp_systolic', value: 128 },
        { metricKey: 'bp_diastolic', value: 84 },
        { metricKey: 'resting_hr', value: 58 },
      ],
    });

    expect(parsed.measuredAt).toEqual(new Date('2026-09-01T05:30:00.000Z'));
    expect(parsed.notes).toBe('after run');
    expect(parsed.readings.map((r) => [r.metricKey, r.value, r.unit])).toEqual([
      ['weight', 80, 'kg'],
      ['body_fat_pct', 22.5, '%'],
      ['waist_circumference', 86.36, 'cm'],
      ['bp_systolic', 128, 'mmHg'],
      ['bp_diastolic', 84, 'mmHg'],
      ['resting_hr', 58, 'bpm'],
    ]);
  });

  it('stores an empty note as null', () => {
    expect(
      createMeasurementEntrySchema.parse({ notes: '   ', readings: [{ metricKey: 'weight', value: 80 }] })
        .notes,
    ).toBeNull();
  });

  const inAnHour = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  it.each([
    ['an unknown metricKey', { readings: [{ metricKey: 'height', value: 180 }] }, 'readings.0.metricKey'],
    ['a wellness metricKey', { readings: [{ metricKey: 'energy', value: 3 }] }, 'readings.0.metricKey'],
    [
      'a duplicate metricKey',
      { readings: [{ metricKey: 'weight', value: 80 }, { metricKey: 'weight', value: 81 }] },
      'readings.1.metricKey',
    ],
    ['unit stone', { readings: [{ metricKey: 'weight', value: 13, unit: 'stone' }] }, 'readings.0.unit'],
    ['method dexa for weight', { readings: [{ metricKey: 'weight', value: 80, method: 'dexa' }] }, 'readings.0.method'],
    ['weight 5 kg', { readings: [{ metricKey: 'weight', value: 5 }] }, 'readings.0.value'],
    ['weight 1200 lb (over 500 kg after conversion)', { readings: [{ metricKey: 'weight', value: 1200, unit: 'lb' }] }, 'readings.0.value'],
    ['systolic without diastolic', { readings: [{ metricKey: 'bp_systolic', value: 120 }] }, 'readings'],
    [
      'systolic 80 with diastolic 90',
      { readings: [{ metricKey: 'bp_systolic', value: 80 }, { metricKey: 'bp_diastolic', value: 90 }] },
      'readings',
    ],
    ['measuredAt one hour in the future', { measuredAt: inAnHour, readings: [{ metricKey: 'weight', value: 80 }] }, 'measuredAt'],
    ['measuredAt before 1900', { measuredAt: '1899-12-31T23:59:59Z', readings: [{ metricKey: 'weight', value: 80 }] }, 'measuredAt'],
    ['measuredAt without an offset-aware ISO format', { measuredAt: 'yesterday', readings: [{ metricKey: 'weight', value: 80 }] }, 'measuredAt'],
    [
      'more than 6 readings',
      {
        readings: [
          { metricKey: 'weight', value: 80 },
          { metricKey: 'body_fat_pct', value: 20 },
          { metricKey: 'waist_circumference', value: 80 },
          { metricKey: 'bp_systolic', value: 120 },
          { metricKey: 'bp_diastolic', value: 80 },
          { metricKey: 'resting_hr', value: 60 },
          { metricKey: 'resting_hr', value: 61 },
        ],
      },
      'readings',
    ],
    ['no readings', { readings: [] }, 'readings'],
    ['an extra top-level property (origin)', { origin: 'ai', readings: [{ metricKey: 'weight', value: 80 }] }, ''],
    ['an extra top-level property (sourceRef)', { sourceRef: {}, readings: [{ metricKey: 'weight', value: 80 }] }, ''],
    ['an extra reading property', { readings: [{ metricKey: 'weight', value: 80, origin: 'ai' }] }, 'readings.0'],
    ['a string value', { readings: [{ metricKey: 'weight', value: '80' }] }, 'readings.0.value'],
    ['notes over 500 characters', { notes: 'n'.repeat(501), readings: [{ metricKey: 'weight', value: 80 }] }, 'notes'],
  ])('refuses %s, naming the field', (_case, body, path) => {
    expect(issuePaths(createMeasurementEntrySchema.safeParse(body))).toContain(path);
  });

  it('refuses NaN and Infinity', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        createMeasurementEntrySchema.safeParse({ readings: [{ metricKey: 'weight', value }] }).success,
      ).toBe(false);
    }
  });

  it('accepts measuredAt a minute ahead (clock skew)', () => {
    const soon = new Date(Date.now() + 60 * 1000).toISOString();
    expect(
      createMeasurementEntrySchema.safeParse({ measuredAt: soon, readings: [{ metricKey: 'weight', value: 80 }] })
        .success,
    ).toBe(true);
  });

  it('never echoes a value or a note in an issue message', () => {
    const result = createMeasurementEntrySchema.safeParse({
      notes: `secret-note-${'x'.repeat(600)}`,
      readings: [{ metricKey: 'weight', value: 4.321, unit: 'kg' }],
    });

    const messages = JSON.stringify(result.error!.issues.map((issue) => issue.message));
    expect(messages).not.toContain('secret-note');
    expect(messages).not.toContain('4.321');
  });
});

describe('lab readings (H3, #187)', () => {
  const LAB_KEYS = [
    'total_cholesterol', 'ldl_cholesterol', 'hdl_cholesterol', 'triglycerides', 'non_hdl_cholesterol', 'apob',
    'fasting_glucose', 'hba1c', 'hemoglobin', 'tsh', 'ferritin', 'creatinine',
  ];

  it('accepts a range and flag, converting value and limits to the canonical unit', () => {
    const parsed = createMeasurementEntrySchema.parse({
      readings: [
        {
          metricKey: 'fasting_glucose',
          value: 5.55,
          unit: 'mmol/L',
          referenceLow: 3.9,
          referenceHigh: 5.5,
          referenceText: '  3.9-5.5  ',
          flag: 'high',
        },
      ],
    });

    const [reading] = parsed.readings;
    expect(reading.unit).toBe('mg/dL');
    expect(Math.round(reading.value)).toBe(100);
    expect(reading.referenceLow).toBeCloseTo(70.27, 2);
    expect(reading.referenceHigh).toBeCloseTo(99.1, 1);
    expect(reading).toMatchObject({ referenceText: '3.9-5.5', flag: 'high' });
  });

  it('converts an HbA1c range given in mmol/mol with the master equation', () => {
    const [reading] = createMeasurementEntrySchema.parse({
      readings: [{ metricKey: 'hba1c', value: 53, unit: 'mmol/mol', referenceLow: 20, referenceHigh: 42 }],
    }).readings;

    expect(reading.value.toFixed(1)).toBe('7.0');
    expect(reading.referenceLow!.toFixed(1)).toBe('4.0');
    expect(reading.referenceHigh!.toFixed(1)).toBe('6.0');
  });

  it('stores an empty referenceText as null and leaves omitted context unset', () => {
    const [withText, bare] = createMeasurementEntrySchema.parse({
      readings: [
        { metricKey: 'tsh', value: 2.1, referenceText: '   ' },
        { metricKey: 'ferritin', value: 80 },
      ],
    }).readings;

    expect(withText.referenceText).toBeNull();
    expect(bare).not.toHaveProperty('referenceLow');
    expect(bare).not.toHaveProperty('flag');
  });

  it('accepts a whole report in one entry, beyond the six-reading body limit', () => {
    const readings = LAB_KEYS.map((metricKey) => ({ metricKey, value: 1 + (metricKey === 'hba1c' ? 4 : 0) + (metricKey === 'hemoglobin' ? 12 : 0) }));
    expect(createMeasurementEntrySchema.safeParse({ readings }).success).toBe(true);
    expect(MAX_LAB_READINGS_PER_ENTRY).toBe(40);
  });

  it('still refuses seven body/vital readings with the six-reading message', () => {
    const readings = ['weight', 'body_fat_pct', 'waist_circumference', 'resting_hr', 'weight', 'weight', 'weight'].map(
      (metricKey) => ({ metricKey, value: 80 }),
    );
    const result = createMeasurementEntrySchema.safeParse({ readings });
    expect(result.success).toBe(false);
    expect(result.error!.issues).toContainEqual(
      expect.objectContaining({ path: ['readings'], message: 'readings must contain at most 6 readings' }),
    );
  });

  it.each([
    ['a lab and a body metric in one entry', { readings: [{ metricKey: 'tsh', value: 2 }, { metricKey: 'weight', value: 80 }] }, 'readings'],
    ['a range on a body metric', { readings: [{ metricKey: 'weight', value: 80, referenceLow: 60 }] }, 'readings.0.referenceLow'],
    ['a flag on a vital metric', { readings: [{ metricKey: 'resting_hr', value: 60, flag: 'high' }] }, 'readings.0.flag'],
    ['referenceText on a body metric', { readings: [{ metricKey: 'weight', value: 80, referenceText: 'n' }] }, 'readings.0.referenceText'],
    ['low above high', { readings: [{ metricKey: 'tsh', value: 2, referenceLow: 4.5, referenceHigh: 0.4 }] }, 'readings.0.referenceLow'],
    ['an unknown flag', { readings: [{ metricKey: 'tsh', value: 2, flag: 'H' }] }, 'readings.0.flag'],
    ['referenceText over 100 characters', { readings: [{ metricKey: 'tsh', value: 2, referenceText: 'r'.repeat(101) }] }, 'readings.0.referenceText'],
    ['a non-numeric limit', { readings: [{ metricKey: 'tsh', value: 2, referenceHigh: '4.5' }] }, 'readings.0.referenceHigh'],
    ['a unit the analyte does not allow', { readings: [{ metricKey: 'ldl_cholesterol', value: 2, unit: 'g/L' }] }, 'readings.0.unit'],
    ['a value outside the hard bounds', { readings: [{ metricKey: 'sodium', value: 20 }] }, 'readings.0.value'],
    ['41 lab readings', { readings: Array.from({ length: 41 }, () => ({ metricKey: 'tsh', value: 2 })) }, 'readings'],
  ])('refuses %s, naming the field', (_case, body, path) => {
    expect(issuePaths(createMeasurementEntrySchema.safeParse(body))).toContain(path);
  });

  it('never echoes a limit or referenceText in an issue message', () => {
    const result = createMeasurementEntrySchema.safeParse({
      readings: [{ metricKey: 'tsh', value: 2, referenceLow: 7.654, referenceHigh: 1.234, referenceText: `secret-${'x'.repeat(200)}` }],
    });
    const messages = JSON.stringify(result.error!.issues.map((issue) => issue.message));
    expect(messages).not.toContain('7.654');
    expect(messages).not.toContain('secret-');
  });

  it('on edit: omitted context stays undefined (keep), null clears', () => {
    const [reading] = updateMeasurementEntrySchema.parse({
      readings: [{ metricKey: 'tsh', value: 2, flag: null, referenceHigh: 4.5 }],
    }).readings!;
    expect(reading).toMatchObject({ flag: null, referenceHigh: 4.5 });
    expect(reading).not.toHaveProperty('referenceLow');
    expect(reading).not.toHaveProperty('referenceText');
  });

  it('referenceRangeProblem allows open-ended and equal limits', () => {
    expect(referenceRangeProblem(undefined, 5)).toBeNull();
    expect(referenceRangeProblem(5, null)).toBeNull();
    expect(referenceRangeProblem(5, 5)).toBeNull();
    expect(referenceRangeProblem(6, 5)).toMatch(/referenceLow/);
  });
});

describe('updateMeasurementEntrySchema', () => {
  it('requires at least one property', () => {
    expect(updateMeasurementEntrySchema.safeParse({}).success).toBe(false);
  });

  it('accepts notes: null alone', () => {
    expect(updateMeasurementEntrySchema.parse({ notes: null })).toEqual({
      measuredAt: undefined,
      notes: null,
      readings: undefined,
    });
  });

  it('accepts only one half of a blood-pressure pair (checked on the merged entry)', () => {
    expect(
      updateMeasurementEntrySchema.safeParse({ readings: [{ metricKey: 'bp_systolic', value: 130 }] }).success,
    ).toBe(true);
  });

  it('keeps method undefined when omitted, so the service copies it forward', () => {
    const parsed = updateMeasurementEntrySchema.parse({ readings: [{ metricKey: 'weight', value: 81 }] });
    expect(parsed.readings).toEqual([{ metricKey: 'weight', value: 81, unit: 'kg' }]);
  });

  it.each([
    ['origin', { origin: 'manual' }, ''],
    ['a wellness key', { readings: [{ metricKey: 'stress', value: 3 }] }, 'readings.0.metricKey'],
    ['a duplicate key', { readings: [{ metricKey: 'weight', value: 80 }, { metricKey: 'weight', value: 80 }] }, 'readings.1.metricKey'],
    ['out of bounds', { readings: [{ metricKey: 'resting_hr', value: 300 }] }, 'readings.0.value'],
    ['bad unit', { readings: [{ metricKey: 'resting_hr', value: 60, unit: 'kg' }] }, 'readings.0.unit'],
  ])('refuses %s', (_case, body, path) => {
    expect(issuePaths(updateMeasurementEntrySchema.safeParse(body))).toContain(path);
  });
});

describe('listMeasurementsQuerySchema', () => {
  it('defaults page 1 and pageSize 20, coercing strings', () => {
    expect(listMeasurementsQuerySchema.parse({})).toMatchObject({ page: 1, pageSize: 20 });
    expect(listMeasurementsQuerySchema.parse({ page: '3', pageSize: '100' })).toMatchObject({
      page: 3,
      pageSize: 100,
    });
  });

  it.each([
    [{ pageSize: '101' }, 'pageSize'],
    [{ page: '0' }, 'page'],
    [{ metricKey: 'energy' }, 'metricKey'],
    [{ metricKey: 'nope' }, 'metricKey'],
    [{ from: 'x' }, 'from'],
    [{ from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }, 'from'],
  ])('refuses %j', (query, path) => {
    expect(issuePaths(listMeasurementsQuerySchema.safeParse(query))).toContain(path);
  });
});

describe('listMetricKeys', () => {
  it('defaults to body and vital, lists lab only on request', () => {
    const parse = (query: Record<string, string>) => listMetricKeys(listMeasurementsQuerySchema.parse(query));

    expect(parse({})).toEqual(['weight', 'body_fat_pct', 'waist_circumference', 'bp_systolic', 'bp_diastolic', 'resting_hr']);
    expect(parse({ category: 'lab' })).toContain('hba1c');
    expect(parse({ category: 'lab' })).not.toContain('weight');
    expect(parse({ category: 'vital' })).toEqual(['bp_systolic', 'bp_diastolic', 'resting_hr']);
    expect(parse({ metricKey: 'tsh' })).toEqual(['tsh']);
    expect(parse({ metricKey: 'tsh', category: 'body' })).toEqual([]);
  });

  it('refuses a wellness category and accepts a lab metricKey', () => {
    expect(listMeasurementsQuerySchema.safeParse({ category: 'wellness' }).success).toBe(false);
    expect(listMeasurementsQuerySchema.safeParse({ metricKey: 'ldl_cholesterol' }).success).toBe(true);
    expect(listMeasurementsQuerySchema.safeParse({ metricKey: 'energy' }).success).toBe(false);
  });
});

describe('seriesQuerySchema', () => {
  it('defaults to the last 180 days', () => {
    const before = Date.now();
    const parsed = seriesQuerySchema.parse({ metricKey: 'weight' });

    expect(parsed.to.getTime()).toBeGreaterThanOrEqual(before);
    expect(parsed.to.getTime() - parsed.from.getTime()).toBe(180 * DAY_MS);
  });

  it('accepts a wellness metric', () => {
    expect(seriesQuerySchema.safeParse({ metricKey: 'energy' }).success).toBe(true);
  });

  it.each([
    [{}, 'metricKey'],
    [{ metricKey: 'nope' }, 'metricKey'],
    [{ metricKey: 'weight', from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }, 'from'],
    [{ metricKey: 'weight', from: '2020-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }, 'from'],
  ])('refuses %j', (query, path) => {
    expect(issuePaths(seriesQuerySchema.safeParse(query))).toContain(path);
  });

  it('accepts exactly five years', () => {
    expect(
      seriesQuerySchema.safeParse({
        metricKey: 'weight',
        from: '2021-01-01T00:00:00Z',
        to: '2026-01-01T00:00:00Z',
      }).success,
    ).toBe(true);
  });
});

describe('bloodPressureProblem', () => {
  it('accepts no pair, and a proper pair', () => {
    expect(bloodPressureProblem(['weight'], undefined, undefined)).toBeNull();
    expect(bloodPressureProblem(['bp_systolic', 'bp_diastolic'], 128, 84)).toBeNull();
  });

  it('refuses half a pair and systolic not above diastolic', () => {
    expect(bloodPressureProblem(['bp_diastolic'], undefined, 80)).toMatch(/together/);
    expect(bloodPressureProblem(['bp_systolic', 'bp_diastolic'], 90, 90)).toMatch(/higher/);
  });
});
