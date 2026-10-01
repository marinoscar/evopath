import { labReportFixture } from '../../../test/fixtures/lab-report/load';
import { mapLabReportOutput, SUGGESTED_NOTE, UNMATCHED_NOTE } from './lab-report.mapper';
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
      promptVersion: 1,
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
});
