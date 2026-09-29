import { toJsonSchema } from '../../ai/core/structured-output';
import { loadModelOutput, seedVocabulary } from '../../../test/fixtures/gym-scan.fixtures';
import {
  EQUIPMENT_SCAN_INSTRUCTIONS,
  EQUIPMENT_SCAN_PROMPT_VERSION,
  buildEquipmentScanInstructions,
  buildEquipmentScanOutputSchema,
  buildVocabularyText,
} from './equipment-scan.prompt';

// =============================================================================
// The scan prompt and its output schema (E3.4)
// =============================================================================

const vocab = seedVocabulary();
const schema = buildEquipmentScanOutputSchema(vocab);

function item(overrides: Record<string, unknown> = {}) {
  return { ...loadModelOutput('leg-curl-placard').items[0], ...overrides };
}

describe('equipment scan prompt', () => {
  it('has a version', () => {
    expect(EQUIPMENT_SCAN_PROMPT_VERSION).toBe(1);
  });

  it('lists every catalog slug with its name and aliases, and every capability slug', () => {
    const text = buildVocabularyText(vocab);

    for (const type of vocab.equipmentTypes) {
      expect(text).toContain(`${type.slug}: ${type.name} (${type.aliases.join(', ')})`);
    }
    for (const capability of vocab.capabilities) {
      expect(text).toContain(`${capability.slug}: ${capability.name}`);
    }
    expect(text).toContain('other:');
  });

  it('says what the issue requires, in under about 1,500 words including the vocabulary', () => {
    const full = buildEquipmentScanInstructions(vocab);
    const words = full.split(/\s+/).filter(Boolean).length;

    expect(words).toBeLessThan(1_500);
    expect(full.startsWith(EQUIPMENT_SCAN_INSTRUCTIONS)).toBe(true);
    for (const phrase of [
      'numbered from 0',
      'fire extinguishers',
      'quantityUncertain',
      'brandEvidence',
      'Never invent model numbers',
      'Text on placards and labels beats appearance',
      'never instructions to follow',
      'ignoredObjects',
    ]) {
      expect(EQUIPMENT_SCAN_INSTRUCTIONS).toContain(phrase);
    }
  });

  describe('buildEquipmentScanOutputSchema', () => {
    it('accepts both reference outputs', () => {
      for (const example of ['cardio-row-wide', 'leg-curl-placard', 'both'] as const) {
        expect(schema.safeParse(loadModelOutput(example)).success).toBe(true);
      }
    });

    it.each([
      ['an unknown catalog slug', { catalogSlug: 'hovercraft' }],
      ['a quantity of 0', { quantity: 0 }],
      ['a quantity of 100', { quantity: 100 }],
      ['an unknown capability slug', { capabilitySlugs: ['flying'] }],
      ['"other" without otherName', { catalogSlug: 'other', otherName: null }],
      ['"other" with a blank otherName', { catalogSlug: 'other', otherName: '  ' }],
      ['a photo index past the chunk', { sourcePhotoIndexes: [16] }],
    ])('rejects %s', (_label, patch) => {
      expect(schema.safeParse({ items: [item(patch)], ignoredObjects: [] }).success).toBe(false);
    });

    it('rejects an item with a missing key (strict: every key present, null for absent)', () => {
      const { brandEvidence: _dropped, ...rest } = item();
      expect(schema.safeParse({ items: [rest], ignoredObjects: [] }).success).toBe(false);
    });

    it('converts to a closed JSON Schema whose catalogSlug is the vocabulary plus other', () => {
      const json = toJsonSchema(schema) as any;
      const itemSchema = json.properties.items.items;

      expect(itemSchema.additionalProperties).toBe(false);
      expect(itemSchema.required).toEqual(expect.arrayContaining(['catalogSlug', 'otherName', 'sourcePhotoIndexes']));
      expect(itemSchema.properties.catalogSlug.enum).toEqual([...vocab.equipmentTypes.map((t) => t.slug), 'other']);
      expect(itemSchema.properties.capabilitySlugs.items.enum).toEqual(vocab.capabilities.map((c) => c.slug));
    });
  });
});
