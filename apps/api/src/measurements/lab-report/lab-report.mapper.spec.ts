import { labReportFixture } from '../../../test/fixtures/lab-report/load';
import { DATE_NOT_READ_NOTE, mapLabReportOutput, SUGGESTED_NOTE, UNMATCHED_NOTE } from './lab-report.mapper';
import { labReportOutputSchema, type LabReportOutput, type LabReportOutputResult } from './lab-report.prompt';
import { labReportValueSchema } from './lab-report.value';

const DOC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PAGE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const NOW = new Date('2026-09-30T08:00:00.000Z');

const panel = (): LabReportOutput => labReportOutputSchema.parse(labReportFixture('lipid-glucose-panel'));

function result(overrides: Partial<LabReportOutputResult> = {}): LabReportOutputResult {
  return {
    nameAsPrinted: 'LDL-C',
    matchedKey: null,
    value: 120,
    valueText: null,
    unit: 'mg/dL',
    referenceText: null,
    referenceLow: null,
    referenceHigh: null,
    labFlag: null,
    panelHint: null,
    collectionDate: null,
    confidence: 'high',
    uncertain: false,
    note: null,
    sourcePhotoIndexes: [1],
    ...overrides,
  };
}

const one = (r: LabReportOutputResult) =>
  mapLabReportOutput({ readable: true, collectionDate: null, labName: null, results: [r] }, [DOC], NOW);

describe('mapLabReportOutput (H4, #188)', () => {
  it('maps the fixture panel: seven pending drafts, one unmatched, glucose converted, document fields read', () => {
    const { drafts, document, resultMeta } = mapLabReportOutput(panel(), [DOC], NOW);

    expect(drafts).toHaveLength(7);
    expect(drafts.map((d) => (d.value as any).analyteKey)).toEqual([
      'total_cholesterol',
      'hdl_cholesterol',
      'ldl_cholesterol',
      'triglycerides',
      null,
      'fasting_glucose',
      'hba1c',
    ]);
    for (const draft of drafts) {
      expect(draft.kind).toBe('result');
      expect(labReportValueSchema.safeParse(draft.value).success).toBe(true);
      expect(draft.sourcePhotoIds).toEqual([DOC]);
    }

    expect(drafts[0]).toMatchObject({
      confidence: 'high',
      uncertain: false,
      uncertaintyNote: null,
      value: {
        nameAsPrinted: 'Cholesterol, Total',
        value: 212,
        unit: 'mg/dL',
        referenceText: '<200',
        referenceLow: null,
        referenceHigh: 200,
        flag: 'high',
        panel: 'lipids',
        match: 'matched',
        originalValue: 212,
        originalUnit: 'mg/dL',
        collectionDate: '2026-09-15',
      },
    });

    // The unmatched analyte is kept, flagged, with what was printed.
    expect(drafts[4]).toMatchObject({
      uncertain: true,
      uncertaintyNote: UNMATCHED_NOTE,
      value: { analyteKey: null, nameAsPrinted: 'Lipoprotein (a)', value: 32, unit: 'nmol/L', match: 'unmatched', panel: null },
    });

    // Glucose printed in mmol/L is drafted in mg/dL, the printed pair kept.
    expect(drafts[5].value).toMatchObject({
      value: 97.2973,
      unit: 'mg/dL',
      referenceLow: 70.2703,
      referenceHigh: 99.0991,
      originalValue: 5.4,
      originalUnit: 'mmol/L',
      panel: 'glycemic',
    });

    expect(document).toEqual({ collectionDate: '2026-09-15', labName: 'Acme Clinical Laboratories' });
    expect(resultMeta).toEqual({
      promptVersion: 2,
      unreadable: false,
      resultsReturned: 7,
      resultsTruncated: 0,
      unmatched: 1,
      suggested: 0,
      flagged: 0,
      hintsIgnored: 0,
      converted: 1,
      collectionDateRead: true,
      collectionDateDiscarded: false,
      distinctDates: 1,
      resultDatesDiscarded: 0,
    });
    // Diagnostics only: no printed name or value.
    expect(JSON.stringify(resultMeta)).not.toMatch(/Lipoprotein|Acme|212/);
  });

  it('resolves from the printed name and ignores a disagreeing model key', () => {
    const { drafts, resultMeta } = one(result({ nameAsPrinted: 'LDL-C', matchedKey: 'hdl_cholesterol' }));
    expect(drafts[0].value).toMatchObject({ analyteKey: 'ldl_cholesterol', match: 'matched' });
    expect(resultMeta.hintsIgnored).toBe(1);
  });

  it("uses a valid model key only when the name resolves to nothing, as an uncertain suggestion", () => {
    const { drafts, resultMeta } = one(result({ nameAsPrinted: 'Vit. D 25-OH', matchedKey: 'vitamin_d_25oh', unit: 'ng/mL', value: 31 }));
    expect(drafts[0]).toMatchObject({
      uncertain: true,
      uncertaintyNote: SUGGESTED_NOTE,
      value: { analyteKey: 'vitamin_d_25oh', match: 'suggested', panel: 'other' },
    });
    expect(resultMeta.suggested).toBe(1);

    // An invented key is not trusted: unmatched.
    expect(one(result({ nameAsPrinted: 'Lp(a)', matchedKey: 'lipoprotein_a' })).drafts[0].value).toMatchObject({
      analyteKey: null,
      match: 'unmatched',
    });
    // A non-lab key is not trusted either.
    expect(one(result({ nameAsPrinted: 'Body mass', matchedKey: 'weight' })).drafts[0].value).toMatchObject({ analyteKey: null });
  });

  it('keeps a non-numeric result, an unknown unit or an out-of-range value, flagged low', () => {
    const text = one(result({ value: null, valueText: '<0.5', nameAsPrinted: 'hsCRP', unit: 'mg/L' }));
    expect(text.drafts[0]).toMatchObject({ confidence: 'low', uncertain: true, value: { value: null, valueText: '<0.5' } });
    expect(text.drafts[0].uncertaintyNote).toContain('No numeric value');

    const unit = one(result({ unit: 'furlongs' }));
    expect(unit.drafts[0]).toMatchObject({ confidence: 'low', uncertain: true });
    expect(unit.drafts[0].uncertaintyNote).toContain('Unit not recognised');

    const bounds = one(result({ value: 99999 }));
    expect(bounds.drafts[0].uncertaintyNote).toContain('Outside the usual range');
    expect(bounds.resultMeta.flagged).toBe(1);
  });

  it('drafts a unitless ratio printed without a unit as a clean, saveable result (#305)', () => {
    const { drafts, resultMeta } = one(
      result({ nameAsPrinted: 'Albumin/Globulin Ratio', value: 1.8, unit: null, note: '(CALC)', collectionDate: '2025-11-19' }),
    );
    expect(drafts[0]).toMatchObject({
      confidence: 'high',
      uncertain: false,
      uncertaintyNote: '(CALC)',
      value: { analyteKey: 'albumin_globulin_ratio', value: 1.8, unit: 'ratio', originalUnit: null, panel: 'cmp', match: 'matched' },
    });
    expect(resultMeta.flagged).toBe(0);

    // A CMP trend row printed in "mMol/L" is recognised as-is.
    expect(one(result({ nameAsPrinted: 'Chloride Lvl', value: 103, unit: 'mMol/L' })).drafts[0]).toMatchObject({
      uncertain: false,
      value: { analyteKey: 'chloride', value: 103, unit: 'mmol/L' },
    });
  });

  it('attributes a result with no valid input number to every input', () => {
    const { drafts } = mapLabReportOutput(
      { readable: true, collectionDate: null, labName: null, results: [result({ sourcePhotoIndexes: [9] })] },
      [DOC, PAGE],
      NOW,
    );
    expect(drafts[0].sourcePhotoIds).toEqual([DOC, PAGE]);
  });

  it('discards an impossible or future collection date, and reads nothing from an unreadable report', () => {
    const future = mapLabReportOutput({ readable: true, collectionDate: '2027-01-01', labName: ' ', results: [] }, [DOC], NOW);
    expect(future.document).toEqual({ collectionDate: null, labName: null });
    expect(future.resultMeta).toMatchObject({ collectionDateRead: false, collectionDateDiscarded: true });

    const unreadable = mapLabReportOutput(
      { readable: false, collectionDate: '2026-09-15', labName: 'Acme', results: [result()] },
      [DOC],
      NOW,
    );
    expect(unreadable.drafts).toEqual([]);
    expect(unreadable.document).toEqual({ collectionDate: null, labName: null });
    expect(unreadable.resultMeta).toMatchObject({ unreadable: true, resultsReturned: 0 });
  });

  describe('per-result dates (#305)', () => {
    const trend = (reportDate: string | null, results: LabReportOutputResult[]) =>
      mapLabReportOutput({ readable: true, collectionDate: reportDate, labName: null, results }, [DOC], NOW);

    it('keeps each cell of a trend table on its own date and counts the distinct dates', () => {
      const { drafts, document, resultMeta } = trend('2025-11-19', [
        result({ nameAsPrinted: 'Albumin Lvl', value: 4.6, unit: 'g/dL', collectionDate: '2025-11-19' }),
        result({ nameAsPrinted: 'Albumin Lvl', value: 4.4, unit: 'g/dL', collectionDate: '2024-05-02' }),
        result({ nameAsPrinted: 'Glucose Lvl', value: 92, unit: 'mg/dL', collectionDate: '2023-04-06' }),
      ]);

      expect(drafts.map((d) => (d.value as any).collectionDate)).toEqual(['2025-11-19', '2024-05-02', '2023-04-06']);
      expect(drafts.map((d) => (d.value as any).analyteKey)).toEqual(['albumin', 'albumin', 'fasting_glucose']);
      expect(drafts.every((d) => !d.uncertain)).toBe(true);
      expect(document.collectionDate).toBe('2025-11-19');
      expect(resultMeta).toMatchObject({ distinctDates: 3, resultDatesDiscarded: 0 });
    });

    it('takes the report date from the results only when every dated result shares one date', () => {
      expect(trend(null, [result({ collectionDate: '2025-11-19' }), result({ collectionDate: '2025-11-19' }), result()]).document.collectionDate).toBe(
        '2025-11-19',
      );
      expect(trend(null, [result({ collectionDate: '2025-11-19' }), result({ collectionDate: '2024-05-02' })]).document.collectionDate).toBeNull();
      expect(trend(null, [result()]).document.collectionDate).toBeNull();
    });

    it('discards an impossible or future result date to null, flagged "Date not read"', () => {
      const { drafts, resultMeta } = trend('2025-11-19', [
        result({ collectionDate: '2027-03-01' }),
        result({ collectionDate: '1983-02-30' }),
        result({ collectionDate: '19/11/2025', note: '(CALC)' }),
      ]);

      for (const draft of drafts) {
        expect((draft.value as any).collectionDate).toBeNull();
        expect(draft.uncertain).toBe(true);
        expect(draft.uncertaintyNote).toContain(DATE_NOT_READ_NOTE);
        expect(labReportValueSchema.safeParse(draft.value).success).toBe(true);
      }
      expect(drafts[2].uncertaintyNote).toBe(`(CALC). ${DATE_NOT_READ_NOTE}`);
      expect(resultMeta).toMatchObject({ distinctDates: 0, resultDatesDiscarded: 3 });
    });
  });
});
