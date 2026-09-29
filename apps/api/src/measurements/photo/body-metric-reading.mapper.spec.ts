import { bodyMetricFixture, type BodyMetricFixture } from '../../../test/fixtures/body-metric/load';
import { mapBodyMetricOutput } from './body-metric-reading.mapper';
import { bodyMetricOutputSchema, CUFF_PULSE_NOTE, type BodyMetricOutput } from './body-metric-reading.prompt';

const PHOTO_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PHOTO_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const fixture = (name: BodyMetricFixture): BodyMetricOutput => bodyMetricOutputSchema.parse(bodyMetricFixture(name));

function reading(overrides: Partial<BodyMetricOutput['readings'][number]> = {}): BodyMetricOutput['readings'][number] {
  return {
    metricKey: 'weight',
    value: 80,
    unit: 'kg',
    confidence: 'high',
    uncertain: false,
    note: null,
    sourcePhotoIndexes: [1],
    ...overrides,
  };
}

describe('mapBodyMetricOutput (E2.6)', () => {
  it('scale display: one pending-shaped AI draft, unit as displayed, method from the device', () => {
    const { drafts, resultMeta } = mapBodyMetricOutput(fixture('scale-display'), [PHOTO_A]);

    expect(drafts).toEqual([
      {
        kind: 'reading',
        value: { metricKey: 'weight', value: 208.4, unit: 'lb', method: 'scale' },
        confidence: 'high',
        uncertain: false,
        uncertaintyNote: null,
        sourcePhotoIds: [PHOTO_A],
      },
    ]);
    expect(resultMeta).toEqual({
      promptVersion: 1,
      deviceKind: 'scale',
      unreadable: false,
      readingsFlagged: 0,
      readingsTruncated: 0,
    });
  });

  it('bp cuff: systolic, diastolic and an uncertain pulse; unit spelling normalised; method bp_cuff', () => {
    const { drafts } = mapBodyMetricOutput(fixture('bp-cuff'), [PHOTO_A]);

    expect(drafts.map((d) => d.value)).toEqual([
      { metricKey: 'bp_systolic', value: 128, unit: 'mmHg', method: 'bp_cuff' },
      { metricKey: 'bp_diastolic', value: 82, unit: 'mmHg', method: 'bp_cuff' },
      { metricKey: 'resting_hr', value: 71, unit: 'bpm', method: 'bp_cuff' },
    ]);
    expect(drafts.slice(0, 2).every((d) => d.uncertain === false)).toBe(true);
    expect(drafts[2]).toMatchObject({ uncertain: true, uncertaintyNote: CUFF_PULSE_NOTE, confidence: 'medium' });
  });

  it('does not repeat the cuff note when the model already gave it', () => {
    const { drafts } = mapBodyMetricOutput(
      {
        readable: true,
        deviceKind: 'bp_cuff',
        readings: [reading({ metricKey: 'resting_hr', unit: 'bpm', value: 70, uncertain: true, note: CUFF_PULSE_NOTE })],
      },
      [PHOTO_A],
    );

    expect(drafts[0].uncertaintyNote).toBe(CUFF_PULSE_NOTE);
  });

  it('unreadable: no items and resultMeta.unreadable', () => {
    const { drafts, resultMeta } = mapBodyMetricOutput(fixture('unreadable'), [PHOTO_A]);

    expect(drafts).toEqual([]);
    expect(resultMeta).toMatchObject({ unreadable: true, deviceKind: null });
  });

  it('readable: false drops readings the model returned anyway', () => {
    const { drafts } = mapBodyMetricOutput({ readable: false, deviceKind: null, readings: [reading()] }, [PHOTO_A]);
    expect(drafts).toEqual([]);
  });

  it('out of range: KEPT, flagged low and uncertain with the range note', () => {
    const { drafts, resultMeta } = mapBodyMetricOutput(fixture('out-of-range'), [PHOTO_A]);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      value: { metricKey: 'weight', value: 9999, unit: 'kg' },
      confidence: 'low',
      uncertain: true,
      uncertaintyNote: 'Outside the usual range for weight',
    });
    expect(resultMeta.readingsFlagged).toBe(1);
  });

  it('an unknown unit is kept and flagged; the model note comes first', () => {
    const { drafts } = mapBodyMetricOutput(
      { readable: true, deviceKind: 'scale', readings: [reading({ unit: 'st', value: 14, note: 'Glare' })] },
      [PHOTO_A],
    );

    expect(drafts[0]).toMatchObject({
      value: { unit: 'st' },
      confidence: 'low',
      uncertain: true,
      uncertaintyNote: 'Glare. Unit not recognised for weight',
    });
  });

  it('suggests a method only when the metric allows it', () => {
    const { drafts } = mapBodyMetricOutput(
      {
        readable: true,
        deviceKind: 'scale',
        readings: [reading(), reading({ metricKey: 'body_fat_pct', unit: '%', value: 22 })],
      },
      [PHOTO_A],
    );

    expect(drafts[0].value).toMatchObject({ method: 'scale' });
    expect(drafts[1].value).not.toHaveProperty('method'); // body fat has no plain `scale` method
  });

  it('omits the method for an unknown or other device', () => {
    for (const deviceKind of [null, 'other'] as const) {
      const { drafts } = mapBodyMetricOutput({ readable: true, deviceKind, readings: [reading()] }, [PHOTO_A]);
      expect(drafts[0].value).not.toHaveProperty('method');
    }
  });

  it('maps 1-based photo numbers to storage ids; a reading naming no valid photo is attributed to all', () => {
    const { drafts } = mapBodyMetricOutput(
      {
        readable: true,
        deviceKind: null,
        readings: [
          reading({ sourcePhotoIndexes: [2, 2] }),
          reading({ metricKey: 'bp_systolic', unit: 'mmHg', value: 120, sourcePhotoIndexes: [0, 7] }),
        ],
      },
      [PHOTO_A, PHOTO_B],
    );

    expect(drafts[0].sourcePhotoIds).toEqual([PHOTO_B]);
    expect(drafts[1].sourcePhotoIds).toEqual([PHOTO_A, PHOTO_B]);
  });

  it('never auto-accepts and never drops a reading: two drafts for the same metric are both kept', () => {
    const { drafts } = mapBodyMetricOutput(
      { readable: true, deviceKind: 'scale', readings: [reading({ sourcePhotoIndexes: [1] }), reading({ value: 81, sourcePhotoIndexes: [2] })] },
      [PHOTO_A, PHOTO_B],
    );

    expect(drafts).toHaveLength(2);
    expect(drafts.every((d) => !('status' in d))).toBe(true);
  });

  it('resultMeta never carries a value', () => {
    const { resultMeta } = mapBodyMetricOutput(fixture('scale-display'), [PHOTO_A]);
    expect(JSON.stringify(resultMeta)).not.toContain('208.4');
  });
});
