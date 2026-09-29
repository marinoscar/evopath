import type { EquipmentScanDraft } from './equipment-scan.mapper';
import { mergeChunkDrafts } from './equipment-scan.merge';

// =============================================================================
// Merging photo batches (E3.4)
// =============================================================================

type DraftPatch = Partial<Omit<EquipmentScanDraft, 'value'>> & { value?: Partial<EquipmentScanDraft['value']> };

function draft(overrides: DraftPatch = {}): EquipmentScanDraft {
  const { value, ...rest } = overrides;
  return {
    kind: 'equipment',
    confidence: 'high',
    uncertain: false,
    uncertaintyNote: null,
    sourcePhotoIds: ['p0'],
    ...rest,
    value: {
      equipmentTypeSlug: 'treadmill',
      name: 'Treadmill',
      quantity: 2,
      quantityUncertain: false,
      brand: 'Life Fitness',
      brandEvidence: 'Logo on the console.',
      model: null,
      configuration: null,
      notes: null,
      capabilitySlugs: ['steady_state_cardio', 'interval_cardio'],
      targetMuscles: ['full_body'],
      ...value,
    },
  };
}

describe('mergeChunkDrafts', () => {
  it('returns a single batch unchanged', () => {
    const batch = [draft(), draft()];
    expect(mergeChunkDrafts([batch])).toEqual(batch);
  });

  it('merges the same (type, brand) across batches: max quantity, union of photos, lowest confidence', () => {
    const merged = mergeChunkDrafts([
      [draft({ sourcePhotoIds: ['p0', 'p1'], uncertaintyNote: 'Partly hidden.' })],
      [draft({ confidence: 'medium', sourcePhotoIds: ['p1', 'p17'], value: { quantity: 3, brand: 'LIFE FITNESS ' } })],
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      confidence: 'medium',
      uncertain: true,
      sourcePhotoIds: ['p0', 'p1', 'p17'],
      value: { quantity: 3, quantityUncertain: true, brand: 'Life Fitness' },
    });
    expect(merged[0].uncertaintyNote).toContain('(2, 3)');
    expect(merged[0].uncertaintyNote).toContain('Partly hidden.');
  });

  it('equal counts stay certain unless a batch flagged them', () => {
    const [same] = mergeChunkDrafts([[draft()], [draft()]]);
    expect(same.value).toMatchObject({ quantity: 2, quantityUncertain: false });
    expect(same.uncertain).toBe(false);
    expect(same.uncertaintyNote).toBeNull();

    const [flagged] = mergeChunkDrafts([[draft()], [draft({ value: { quantityUncertain: true } })]]);
    expect(flagged.value.quantityUncertain).toBe(true);
  });

  it('keeps different brands and different other-names apart; other items key on lower(name)', () => {
    const merged = mergeChunkDrafts([
      [draft(), draft({ value: { equipmentTypeSlug: null, name: 'Sled', capabilitySlugs: [] } })],
      [
        draft({ value: { brand: 'Matrix' } }),
        draft({ value: { equipmentTypeSlug: null, name: 'SLED', quantity: 1, capabilitySlugs: [] } }),
        draft({ value: { equipmentTypeSlug: null, name: 'Tyre', capabilitySlugs: [] } }),
      ],
    ]);

    expect(merged.map((d) => [d.value.name, d.value.brand, d.value.quantity])).toEqual([
      ['Treadmill', 'Life Fitness', 2],
      ['Sled', 'Life Fitness', 2],
      ['Treadmill', 'Matrix', 2],
      ['Tyre', 'Life Fitness', 2],
    ]);
  });

  it('never merges two items of the same batch', () => {
    const merged = mergeChunkDrafts([[draft(), draft()], [draft({ value: { quantity: 5 } })]]);

    expect(merged.map((d) => d.value.quantity)).toEqual([5, 2]);
  });

  it('caps the joined note at 300 characters and deduplicates it', () => {
    const long = 'x'.repeat(200);
    const [merged] = mergeChunkDrafts([
      [draft({ uncertaintyNote: long })],
      [draft({ uncertaintyNote: long })],
      [draft({ uncertaintyNote: 'y'.repeat(200) })],
    ]);

    expect(merged.uncertaintyNote!.length).toBeLessThanOrEqual(300);
    expect(merged.uncertaintyNote!.startsWith(`${long} y`)).toBe(true);
  });
});
