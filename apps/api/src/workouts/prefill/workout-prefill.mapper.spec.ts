import {
  loadPlacardExpectedDrafts,
  loadPrefillModelOutput,
  notebookExpectedDrafts,
  seedExerciseVocabulary,
} from '../../../test/fixtures/workout-prefill.fixtures';
import {
  KG_PER_LB,
  mapPrefillItem,
  mapPrefillItems,
  mergePrefillChunks,
  toKilograms,
  weightUnitFor,
  type WorkoutPrefillDraft,
} from './workout-prefill.mapper';
import type { WorkoutPrefillOutputItem } from './workout-prefill.prompt';

// =============================================================================
// Model output -> draft items (E4.5)
// =============================================================================

const vocab = seedExerciseVocabulary();
const P0 = '11111111-1111-4111-8111-111111111111';
const P1 = '22222222-2222-4222-8222-222222222222';

/** What `replaceAiDrafts` stores for an AI draft (provenance defaults added). */
function stored(draft: WorkoutPrefillDraft) {
  return {
    kind: draft.kind,
    origin: 'ai',
    status: 'pending',
    confidence: draft.confidence,
    uncertain: draft.uncertain,
    uncertaintyNote: draft.uncertaintyNote,
    sourcePhotoIds: draft.sourcePhotoIds,
    userVerified: false,
    originalAiValue: null,
    value: draft.value,
  };
}

function item(overrides: Partial<WorkoutPrefillOutputItem> = {}): WorkoutPrefillOutputItem {
  return { ...loadPrefillModelOutput('notebook').items[0], ...overrides };
}

const set = (overrides: Record<string, unknown> = {}) => ({
  reps: 5,
  weight: null,
  weightUnit: null,
  durationSeconds: null,
  distanceMeters: null,
  ...overrides,
});

describe('workout prefill mapper', () => {
  it('weightUnitFor: imperial is lb; metric and no profile are kg', () => {
    expect(weightUnitFor('imperial')).toBe('lb');
    expect(weightUnitFor('metric')).toBe('kg');
    expect(weightUnitFor(null)).toBe('kg');
    expect(weightUnitFor(undefined)).toBe('kg');
  });

  it('converts pounds exactly and rounds to 3 decimals', () => {
    expect(KG_PER_LB).toBe(0.45359237);
    expect(toKilograms(135, 'lb')).toBe(61.235);
    expect(toKilograms(50, 'lb')).toBe(22.68);
    expect(toKilograms(135, 'kg')).toBe(135);
    expect(toKilograms(22.5, 'kg')).toBe(22.5);
  });

  it('Example A (placard) yields exactly the expected drafts, whatever the unit', () => {
    const output = loadPrefillModelOutput('placard');

    for (const unit of ['lb', 'kg'] as const) {
      expect(mapPrefillItems(output.items, [P0], vocab, unit).map(stored)).toEqual(loadPlacardExpectedDrafts([P0]));
    }
  });

  it('Example B (notebook) for an Imperial user yields the story table: five drafts, nothing dropped', () => {
    const drafts = mapPrefillItems(loadPrefillModelOutput('notebook').items, [P0], vocab, 'lb');

    expect(drafts.map(stored)).toEqual(notebookExpectedDrafts('lb', [P0]));
    expect(drafts).toHaveLength(5);
    expect(drafts[4]).toMatchObject({ confidence: 'low', value: { exerciseSlug: null, name: 'Unreadable cable exercise' } });
  });

  it('Example B for a Metric user reads 135 as 135.000 kg', () => {
    const drafts = mapPrefillItems(loadPrefillModelOutput('notebook').items, [P0], vocab, 'kg');

    expect(drafts.map(stored)).toEqual(notebookExpectedDrafts('kg', [P0]));
    expect(drafts[0].value.sets[0].weightKg).toBe(135);
    expect(drafts[0].uncertaintyNote).toContain('Unit not written; assumed kg.');
  });

  it('a written unit always wins over the profile unit and adds no unit note', () => {
    const draft = mapPrefillItem(
      item({ confidence: 'high', uncertain: false, note: null, sets: [set({ weight: 60, weightUnit: 'kg' })] }),
      [P0],
      vocab,
      'lb',
    );

    expect(draft.value.sets[0].weightKg).toBe(60);
    expect(draft).toMatchObject({ confidence: 'high', uncertain: false, uncertaintyNote: null });

    const pounds = mapPrefillItem(item({ sets: [set({ weight: 100, weightUnit: 'lb' })] }), [P0], vocab, 'kg');
    expect(pounds.value.sets[0].weightKg).toBe(45.359);
  });

  it('a weight past 1000 kg is left empty and flagged; the item is kept', () => {
    const draft = mapPrefillItem(
      item({ confidence: 'high', uncertain: false, note: null, sets: [set({ weight: 1500, weightUnit: 'kg', reps: 3 })] }),
      [P0],
      vocab,
      'kg',
    );

    expect(draft.value.sets).toEqual([{ reps: 3, weightKg: null, durationSeconds: null, distanceMeters: null }]);
    expect(draft.uncertain).toBe(true);
    expect(draft.uncertaintyNote).toContain('above 1000 kg');
  });

  it('keeps durations and rounds distances to centimetres', () => {
    const draft = mapPrefillItem(
      item({ sets: [set({ reps: null, durationSeconds: 90, distanceMeters: 3218.6881 })] }),
      [P0],
      vocab,
      'kg',
    );

    expect(draft.value.sets).toEqual([{ reps: null, weightKg: null, durationSeconds: 90, distanceMeters: 3218.69 }]);
  });

  it('an "other" item takes otherName, else rawText, else a placeholder; its slug is null', () => {
    const base = { exerciseSlug: 'other', sets: [] } as Partial<WorkoutPrefillOutputItem>;

    expect(mapPrefillItem(item({ ...base, otherName: ' Cable row ' }), [P0], vocab, 'kg').value).toMatchObject({
      exerciseSlug: null,
      name: 'Cable row',
    });
    expect(mapPrefillItem(item({ ...base, otherName: null, rawText: 'Cbl r?' }), [P0], vocab, 'kg').value.name).toBe('Cbl r?');
    expect(mapPrefillItem(item({ ...base, otherName: '  ', rawText: null }), [P0], vocab, 'kg').value).toMatchObject({
      name: 'Unidentified exercise',
      rawText: null,
    });
  });

  it('maps photo indexes to the chunk ids; none left means every photo of the chunk', () => {
    expect(mapPrefillItem(item({ sourcePhotoIndexes: [1] }), [P0, P1], vocab, 'kg').sourcePhotoIds).toEqual([P1]);
    expect(mapPrefillItem(item({ sourcePhotoIndexes: [7] }), [P0, P1], vocab, 'kg').sourcePhotoIds).toEqual([P0, P1]);
  });

  describe('mergePrefillChunks', () => {
    const placard = (photo: string, confidence: 'high' | 'medium' = 'high', uncertain = false) =>
      mapPrefillItem(
        item({ exerciseSlug: 'leg_curl', rawText: 'LEG CURL', sets: [], confidence, uncertain, note: `seen on ${photo}` }),
        [photo],
        vocab,
        'kg',
      );

    it('merges a set-less library item seen again in a later chunk (a placard photographed twice)', () => {
      const merged = mergePrefillChunks([[placard(P0, 'medium', true)], [placard(P1, 'high', false)]]);

      expect(merged).toHaveLength(1);
      expect(merged[0]).toMatchObject({
        confidence: 'high',
        uncertain: false,
        uncertaintyNote: `seen on ${P1}`,
        sourcePhotoIds: [P0, P1],
      });
    });

    it('never merges within a chunk, items with sets, or "other" items', () => {
      const withSets = mapPrefillItems(loadPrefillModelOutput('notebook').items, [P0], vocab, 'lb');

      expect(mergePrefillChunks([[placard(P0), placard(P0)]])).toHaveLength(2);
      expect(mergePrefillChunks([withSets, withSets])).toHaveLength(10);
    });
  });
});
