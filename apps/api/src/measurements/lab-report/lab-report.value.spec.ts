import {
  effectiveCollectionDate,
  isCollectionDate,
  labReportContextSchema,
  labReportValueSchema,
  labResultProblems,
  matchOf,
  measuredAtFor,
  sameLabResult,
  toCanonicalLabValue,
  utcDay,
  type LabReportValue,
} from './lab-report.value';

const value = (overrides: Partial<LabReportValue> = {}): LabReportValue =>
  labReportValueSchema.parse({ analyteKey: 'fasting_glucose', nameAsPrinted: 'Glucose', value: 97, unit: 'mg/dL', match: 'matched', ...overrides });

describe('lab_report value (H4, #188)', () => {
  describe('labReportValueSchema', () => {
    it('defaults every optional field to null and match to unmatched', () => {
      expect(labReportValueSchema.parse({ nameAsPrinted: 'Lipoprotein (a)' })).toEqual({
        analyteKey: null,
        nameAsPrinted: 'Lipoprotein (a)',
        value: null,
        valueText: null,
        unit: null,
        originalValue: null,
        originalUnit: null,
        referenceLow: null,
        referenceHigh: null,
        referenceText: null,
        flag: null,
        panel: null,
        match: 'unmatched',
        collectionDate: null,
      });
    });

    it('carries a per-result collection date, validated like the report date; old drafts parse without it (#305)', () => {
      expect(labReportValueSchema.parse({ analyteKey: 'albumin', collectionDate: '2025-11-19' }).collectionDate).toBe('2025-11-19');
      expect(labReportValueSchema.parse({ analyteKey: 'albumin', collectionDate: null }).collectionDate).toBeNull();
      expect(labReportValueSchema.parse({ analyteKey: 'albumin' }).collectionDate).toBeNull();
      expect(labReportValueSchema.safeParse({ collectionDate: '2025-02-30' }).success).toBe(false);
      expect(labReportValueSchema.safeParse({ collectionDate: '1899-12-31' }).success).toBe(false);
      expect(labReportValueSchema.safeParse({ collectionDate: '2999-01-01' }).success).toBe(false);
      expect(labReportValueSchema.safeParse({ collectionDate: 'Nov 19, 2025' }).success).toBe(false);
    });

    it('effectiveCollectionDate: own date, else the report date, else null', () => {
      expect(effectiveCollectionDate({ collectionDate: '2025-11-19' }, { collectionDate: '2026-01-01' })).toBe('2025-11-19');
      expect(effectiveCollectionDate({ collectionDate: null }, { collectionDate: '2026-01-01' })).toBe('2026-01-01');
      expect(effectiveCollectionDate({ collectionDate: null }, {})).toBeNull();
      expect(effectiveCollectionDate({ collectionDate: null }, undefined)).toBeNull();
    });

    it('accepts only lab analyte keys, known flags and panels, and no extra key', () => {
      expect(labReportValueSchema.safeParse({ analyteKey: 'ldl_cholesterol' }).success).toBe(true);
      expect(labReportValueSchema.safeParse({ analyteKey: 'weight' }).success).toBe(false);
      expect(labReportValueSchema.safeParse({ analyteKey: 'nope' }).success).toBe(false);
      expect(labReportValueSchema.safeParse({ flag: 'weird' }).success).toBe(false);
      expect(labReportValueSchema.safeParse({ panel: 'lipids' }).success).toBe(true);
      expect(labReportValueSchema.safeParse({ panel: 'Lipid Panel' }).success).toBe(false);
      expect(labReportValueSchema.safeParse({ extra: 1 }).success).toBe(false);
      expect(labReportValueSchema.safeParse({ value: Number.POSITIVE_INFINITY }).success).toBe(false);
    });
  });

  describe('context', () => {
    const now = new Date('2026-09-30T08:00:00.000Z');

    it('accepts real past dates up to tomorrow (UTC), refuses the rest', () => {
      expect(isCollectionDate('2026-09-15', now)).toBe(true);
      expect(isCollectionDate('2026-10-01', now)).toBe(true);
      expect(isCollectionDate('2026-10-02', now)).toBe(false);
      expect(isCollectionDate('2026-02-30', now)).toBe(false);
      expect(isCollectionDate('1899-12-31', now)).toBe(false);
      expect(isCollectionDate('15/09/2026', now)).toBe(false);
    });

    it('is optional, strict, and stores an empty lab name as null', () => {
      expect(labReportContextSchema.safeParse(undefined).success).toBe(true);
      expect(labReportContextSchema.parse({ collectionDate: null, labName: '  ' })).toEqual({ collectionDate: null, labName: null });
      expect(labReportContextSchema.safeParse({ collectionDate: 'yesterday' }).success).toBe(false);
      expect(labReportContextSchema.safeParse({ gymId: 'x' }).success).toBe(false);
    });

    it('dates results at noon UTC of the collection day, never after now', () => {
      expect(measuredAtFor('2026-09-15', now).toISOString()).toBe('2026-09-15T12:00:00.000Z');
      expect(measuredAtFor('2026-09-30', now)).toBe(now);
      expect(utcDay('2026-09-15')).toEqual({
        start: new Date('2026-09-15T00:00:00.000Z'),
        end: new Date('2026-09-16T00:00:00.000Z'),
      });
    });
  });

  describe('toCanonicalLabValue', () => {
    it('converts glucose in mmol/L to mg/dL with its range, keeping what was printed', () => {
      const converted = toCanonicalLabValue(
        value({ value: 5.4, unit: 'mmol/L', referenceLow: 3.9, referenceHigh: 5.5, originalValue: 5.4, originalUnit: 'mmol/L' }),
      );

      expect(converted).toMatchObject({
        value: 97.2973,
        unit: 'mg/dL',
        referenceLow: 70.2703,
        referenceHigh: 99.0991,
        originalValue: 5.4,
        originalUnit: 'mmol/L',
        panel: 'glycemic',
      });
      // Idempotent.
      expect(toCanonicalLabValue(converted)).toEqual(converted);
    });

    it('records the printed value when a user write converts and none was recorded', () => {
      expect(toCanonicalLabValue(value({ value: 5.4, unit: 'MMOL/L' }))).toMatchObject({
        unit: 'mg/dL',
        originalValue: 5.4,
        originalUnit: 'MMOL/L',
      });
    });

    it('spells the canonical unit canonically, leaves unmatched or unknown units alone', () => {
      expect(toCanonicalLabValue(value({ unit: 'MG/DL' })).unit).toBe('mg/dL');
      const unmatched = value({ analyteKey: null, unit: 'nmol/L', value: 32, panel: null });
      expect(toCanonicalLabValue(unmatched)).toEqual(unmatched);
      expect(toCanonicalLabValue(value({ unit: 'furlongs' }))).toMatchObject({ unit: 'furlongs', value: 97 });
    });
  });

  describe('labResultProblems', () => {
    it('names the unit, the missing number, the bounds and the range order, never the value', () => {
      expect(labResultProblems(value(), { requireValue: true })).toEqual([]);
      expect(labResultProblems(value({ unit: 'furlongs' }), { requireValue: true }).map((p) => p.field)).toEqual(['unit']);
      expect(labResultProblems(value({ value: null }), { requireValue: true }).map((p) => p.field)).toEqual(['value']);
      expect(labResultProblems(value({ value: null }), { requireValue: false })).toEqual([]);
      expect(labResultProblems(value({ value: 99999 }), { requireValue: true })[0]).toMatchObject({ code: 'OUT_OF_RANGE', field: 'value' });
      expect(labResultProblems(value({ unit: 'furlongs' }), { requireValue: true })[0].code).toBe('UNIT_NOT_ALLOWED');
      expect(labResultProblems(value({ value: null }), { requireValue: true })[0].code).toBe('NO_VALUE');
      expect(labResultProblems(value({ value: 99999 }), { requireValue: true })[0].message).not.toContain('99999');
      expect(labResultProblems(value({ referenceLow: 100, referenceHigh: 70 }), { requireValue: true })).toEqual([
        { code: 'REFERENCE_ORDER', field: 'referenceLow', message: 'referenceLow must not be higher than referenceHigh' },
      ]);
      expect(labResultProblems(value({ analyteKey: null }), { requireValue: true })).toEqual([]);
    });
  });

  it('matchOf: the printed name decides, never the key alone', () => {
    expect(matchOf('ldl_cholesterol', 'LDL-C')).toBe('matched');
    expect(matchOf('ldl_cholesterol', 'Lipoprotein (a)')).toBe('user_mapped');
    expect(matchOf(null, 'LDL-C')).toBe('unmatched');
  });

  it('sameLabResult compares analyte, collection date, canonical value, range and flag', () => {
    const a = value({ referenceLow: 70, referenceHigh: 99 });
    expect(sameLabResult(a, { ...a })).toBe(true);
    expect(sameLabResult(a, { ...a, value: 5.3827, unit: 'mmol/L', referenceLow: 3.885, referenceHigh: 5.4945 })).toBe(false);
    expect(sameLabResult(a, { ...a, value: 98 })).toBe(false);
    expect(sameLabResult(a, { ...a, flag: 'high' })).toBe(false);
    expect(sameLabResult(a, { ...a, analyteKey: 'hba1c' })).toBe(false);
    expect(sameLabResult(a, { ...a, collectionDate: '2025-11-19' })).toBe(false);
    expect(sameLabResult({ ...a, collectionDate: '2025-11-19' }, { ...a, collectionDate: '2025-11-19' })).toBe(true);
  });
});
