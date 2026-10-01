import { postCheckHealthSummary, wordCount } from './health-summary.post-check';
import type { HealthSummaryOutput } from './health-summary.prompt';

function answer(narrative: string, considerations: string[] = []): HealthSummaryOutput {
  return {
    narrative,
    trainingConsiderations: considerations.map((text) => ({ text, severity: 'info', conservative: false })),
    dataAsOf: '2026-09-30',
  };
}

const CLEAN =
  'Blood pressure has been above the usual range over the last month and should be discussed with a clinician. ' +
  'Ferritin is below the reference range; recommend a clinician follow-up. Wellness scores have been low for several days in a row. ' +
  'Prefer moderate intensity and longer rests; avoid maximal efforts until reviewed. This is not a diagnosis.';

describe('postCheckHealthSummary (H8, #192)', () => {
  it('passes a training-relevant summary with a clinician follow-up and a disclaimer', () => {
    expect(postCheckHealthSummary(answer(CLEAN, ['Keep sessions moderate while blood pressure is reviewed.']))).toEqual([]);
  });

  it.each([
    ['dosing', 'Take 65 mg of iron daily.'],
    ['dosing', 'Consider 1.5 mg before training.'],
    ['dosing', 'The usual dosage is enough.'],
    ['medication', 'Ask about a statin.'],
    ['medication', 'Metformin could help with glucose.'],
    ['medication', 'Continue your blood pressure medication.'],
    ['supplement', 'An iron supplement would help.'],
    ['supplement', 'Add vitamin D in winter.'],
    ['diagnosis', 'You have anemia.'],
    ['diagnosis', 'These values indicate diabetes.'.replace('indicate', 'indicates')],
    ['diagnosis', 'This is consistent with hypothyroidism.'],
    ['diagnosis', 'You were diagnosed with hypertension.'],
    ['raw_value', 'LDL is 162 mg/dL.'],
    ['raw_value', 'HbA1c reached 48 mmol/mol.'],
    ['raw_value', 'Blood pressure averaged 150/95 this month.'],
    ['raw_value', 'Resting heart rate is 92 bpm.'],
  ])('rejects %s: %s', (rule, text) => {
    expect(postCheckHealthSummary(answer(text))).toContain(rule);
    // The same text inside a consideration is caught too.
    expect(postCheckHealthSummary(answer('Moderate training is fine.', [text]))).toContain(rule);
  });

  it('rejects a narrative over the word budget (300 plus a little slack)', () => {
    expect(postCheckHealthSummary(answer('word '.repeat(330)))).toEqual([]);
    expect(postCheckHealthSummary(answer('word '.repeat(331)))).toEqual(['length']);
    expect(wordCount('  a  b\nc ')).toBe(3);
  });

  it('returns rule codes only, sorted in the documented order', () => {
    expect(postCheckHealthSummary(answer('You have anemia; take 65 mg of an iron supplement and a statin. LDL 162 mg/dL.'))).toEqual([
      'dosing',
      'medication',
      'supplement',
      'diagnosis',
      'raw_value',
    ]);
  });
});
