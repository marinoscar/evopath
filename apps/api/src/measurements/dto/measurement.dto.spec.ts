import {
  bloodPressureProblem,
  createMeasurementEntrySchema,
  listMeasurementsQuerySchema,
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
