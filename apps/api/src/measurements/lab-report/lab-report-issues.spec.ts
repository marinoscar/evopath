import { labApplyIssues, UNMATCHED_ISSUE_MESSAGE } from './lab-report-issues';
import { labReportValueSchema, type LabReportValue } from './lab-report.value';

let seq = 0;
const item = (value: Partial<LabReportValue> | unknown, kind = 'result') => {
  seq += 1;
  return {
    id: `item-${seq}`,
    kind,
    value: value && typeof value === 'object' && !('bogus' in value) ? labReportValueSchema.parse(value) : value,
  };
};

const albumin = (overrides: Partial<LabReportValue> = {}): Partial<LabReportValue> => ({
  analyteKey: 'albumin',
  nameAsPrinted: 'Albumin',
  value: 4.4,
  unit: 'g/dL',
  match: 'matched',
  collectionDate: '2025-11-19',
  ...overrides,
});

describe('labApplyIssues (#317)', () => {
  it('finds nothing in a clean set and groups it newest date first', () => {
    const { issues, groups } = labApplyIssues([item(albumin({ collectionDate: '2024-01-02' })), item(albumin())], null);
    expect(issues).toEqual([]);
    expect(groups.map((g) => g.collectionDate)).toEqual(['2025-11-19', '2024-01-02']);
  });

  it('codes every kind of problem, with the field, and never the value', () => {
    const unmatched = item({ nameAsPrinted: 'BUN/Creatinine Ratio', value: 17.3 });
    const badUnit = item(albumin({ unit: 'furlongs', collectionDate: '2025-01-01' }));
    const noValue = item(albumin({ value: null, valueText: 'see note', collectionDate: '2025-01-02' }));
    const outOfRange = item(albumin({ value: 98765, collectionDate: '2025-01-03' }));
    const reversed = item(albumin({ referenceLow: 5, referenceHigh: 3, collectionDate: '2025-01-04' }));
    const invalid = item({ bogus: true });
    const notResult = item(albumin(), 'note');

    const { issues } = labApplyIssues([unmatched, badUnit, noValue, outOfRange, reversed, invalid, notResult], null);

    expect(issues.map(({ code, itemIds, field }) => ({ code, itemIds, field }))).toEqual([
      { code: 'UNMATCHED', itemIds: [unmatched.id], field: 'analyteKey' },
      { code: 'UNIT_NOT_ALLOWED', itemIds: [badUnit.id], field: 'unit' },
      { code: 'NO_VALUE', itemIds: [noValue.id], field: 'value' },
      { code: 'OUT_OF_RANGE', itemIds: [outOfRange.id], field: 'value' },
      { code: 'REFERENCE_ORDER', itemIds: [reversed.id], field: 'referenceLow' },
      { code: 'INVALID_RESULT', itemIds: [invalid.id], field: null },
      { code: 'INVALID_RESULT', itemIds: [notResult.id], field: null },
    ]);
    expect(issues[0].message).toBe(UNMATCHED_ISSUE_MESSAGE);
    expect(issues[2].message).toBe('Albumin has no numeric value; enter one or reject it');
    expect(issues[3].message).toMatch(/^Albumin: value is outside the allowed range for Albumin .*; edit or reject it$/);
    expect(JSON.stringify(issues)).not.toMatch(/98765|17\.3/);
  });

  it('reports a repeated analyte on each of its results, per effective date (the context date included)', () => {
    const own = item(albumin({ collectionDate: '2026-01-05' }));
    const reportDated = item(albumin({ collectionDate: null, value: 4.1 }));
    const otherDate = item(albumin({ collectionDate: '2024-03-03' }));

    const { issues } = labApplyIssues([own, reportDated, otherDate], { collectionDate: '2026-01-05' });

    expect(issues).toEqual(
      [own, reportDated].map(({ id }) => ({
        code: 'DUPLICATE_ON_DATE',
        itemIds: [id],
        field: 'analyteKey',
        message: 'Albumin appears more than once on 2026-01-05; reject one of them or change its date',
      })),
    );
  });

  it('leaves unmatched results out of the per-date checks', () => {
    const { issues, groups } = labApplyIssues([item({ nameAsPrinted: 'X' }), item({ nameAsPrinted: 'X' })], null);
    expect(issues.map((i) => i.code)).toEqual(['UNMATCHED', 'UNMATCHED']);
    expect(groups).toEqual([]);
  });

  it('names every result of an over-full date in one DATE_CAP issue', () => {
    const keys = ['albumin', 'total_cholesterol'];
    const crowded = Array.from({ length: 151 }, (_, i) =>
      item({ analyteKey: keys[i % 2], value: 4, unit: keys[i % 2] === 'albumin' ? 'g/dL' : 'mg/dL', collectionDate: '2025-11-19' }),
    );
    const cap = labApplyIssues(crowded, null).issues.filter((i) => i.code === 'DATE_CAP');
    expect(cap).toEqual([
      {
        code: 'DATE_CAP',
        itemIds: crowded.map((c) => c.id),
        field: null,
        message: 'One collection date saves at most 150 results; 151 are listed on 2025-11-19, reject 1 of them',
      },
    ]);
  });
});
