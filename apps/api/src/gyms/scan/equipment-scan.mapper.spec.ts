import { loadExpectedDrafts, loadModelOutput, seedVocabulary } from '../../../test/fixtures/gym-scan.fixtures';
import { mapScanItems, sourcePhotoIdsFor } from './equipment-scan.mapper';
import { buildEquipmentScanOutputSchema } from './equipment-scan.prompt';

// =============================================================================
// Scan output -> drafts (E3.4), against the two reference examples
// =============================================================================

const vocab = seedVocabulary();
const schema = buildEquipmentScanOutputSchema(vocab);
const PHOTO0 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PHOTO1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** The fields the mapper owns; the intake module adds origin/status/userVerified/originalAiValue. */
function mapperPart(expected: any) {
  const { kind, confidence, uncertain, uncertaintyNote, sourcePhotoIds, value } = expected;
  return { kind, confidence, uncertain, uncertaintyNote, sourcePhotoIds, value };
}

describe('mapScanItems', () => {
  it.each(['cardio-row-wide', 'leg-curl-placard'] as const)('maps %s to exactly the expected drafts', (example) => {
    const output = schema.parse(loadModelOutput(example));
    const drafts = mapScanItems(output.items, [PHOTO0], vocab);

    expect(drafts).toEqual(loadExpectedDrafts(example, [PHOTO0]).map(mapperPart));
  });

  it('keeps the low-confidence unidentified machine and never mentions ignored objects', () => {
    const output = schema.parse(loadModelOutput('cardio-row-wide'));
    const drafts = mapScanItems(output.items, [PHOTO0], vocab);

    expect(drafts).toHaveLength(4);
    expect(drafts[3]).toMatchObject({ confidence: 'low', value: { equipmentTypeSlug: null } });
    const text = JSON.stringify(drafts).toLowerCase();
    expect(text).not.toContain('extinguisher');
    expect(text).not.toContain('blinds');
  });

  it('maps a two-photo chunk to each item\'s own photo', () => {
    const output = schema.parse(loadModelOutput('both'));
    const drafts = mapScanItems(output.items, [PHOTO0, PHOTO1], vocab);

    expect(drafts.map((d) => d.sourcePhotoIds)).toEqual([[PHOTO0], [PHOTO0], [PHOTO0], [PHOTO0], [PHOTO1]]);
    expect(drafts[4].value).toMatchObject({ equipmentTypeSlug: 'leg_curl_machine', targetMuscles: ['hamstrings'] });
  });

  it("keeps an other item's capability slugs and derives its muscles", () => {
    const [draft] = mapScanItems(
      [
        {
          ...schema.parse(loadModelOutput('cardio-row-wide')).items[3],
          otherName: '  Sled  ',
          capabilitySlugs: ['leg_press', 'steady_state_cardio'],
        },
      ],
      [PHOTO0],
      vocab,
    );

    expect(draft.value).toMatchObject({
      equipmentTypeSlug: null,
      name: 'Sled',
      capabilitySlugs: ['leg_press', 'steady_state_cardio'],
      targetMuscles: ['quads', 'glutes'],
    });
  });
});

describe('sourcePhotoIdsFor', () => {
  it('drops out-of-range indexes and duplicates', () => {
    expect(sourcePhotoIdsFor([1, 5, 1], [PHOTO0, PHOTO1])).toEqual([PHOTO1]);
  });

  it('falls back to every photo of the chunk when nothing valid remains', () => {
    expect(sourcePhotoIdsFor([], [PHOTO0, PHOTO1])).toEqual([PHOTO0, PHOTO1]);
    expect(sourcePhotoIdsFor([9], [PHOTO0, PHOTO1])).toEqual([PHOTO0, PHOTO1]);
  });
});
