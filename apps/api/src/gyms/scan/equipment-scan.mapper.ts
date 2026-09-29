import { sourcePhotoIdsFor } from '../../intake/intake-analyzer';
import type { DraftItemConfidence } from '../../intake/intake-kind.interface';
import {
  normalizeEquipmentValue,
  resolveCatalogType,
  type GymEquipmentValue,
} from '../intake/gym-equipment.value';
import { OTHER_SLUG, type EquipmentScanOutputItem } from './equipment-scan.prompt';
import type { EquipmentVocabulary } from './equipment-vocabulary';

// =============================================================================
// Model output -> draft items (E3.4)
// =============================================================================
//
// One scan item becomes one draft, always: low confidence, `other` and
// uncertain items are kept (the user decides, never a filter). Catalog items
// take `name`, `capabilitySlugs` and `targetMuscles` from the catalog; `other`
// items keep `otherName` and the model's capability slugs, kept to the
// vocabulary.
//
// `sourcePhotoIndexes` are 0-based within the request's chunk; they become the
// chunk's storage object ids. Out-of-range indexes are dropped, and an item
// with none left points at every photo of the chunk.
// =============================================================================

/** The item kind every `gym_equipment` draft carries. */
export const EQUIPMENT_ITEM_KIND = 'equipment';

/** A draft as `IntakeService.replaceAiDrafts` takes it, with a typed value. */
export interface EquipmentScanDraft {
  kind: typeof EQUIPMENT_ITEM_KIND;
  confidence: DraftItemConfidence;
  uncertain: boolean;
  uncertaintyNote: string | null;
  sourcePhotoIds: string[];
  value: GymEquipmentValue;
}

function text(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export { sourcePhotoIdsFor };

export function mapScanItem(
  item: EquipmentScanOutputItem,
  chunkPhotoIds: readonly string[],
  vocab: EquipmentVocabulary,
): EquipmentScanDraft {
  const isOther = item.catalogSlug === OTHER_SLUG;
  const resolved = isOther ? null : resolveCatalogType(vocab, item.catalogSlug);
  // The schema only admits catalog slugs, so `resolved` is null only for `other`
  // (or a slug removed from the catalog mid-scan, kept as a named `other`).
  const slug = resolved ? item.catalogSlug : null;

  const value = normalizeEquipmentValue(
    {
      equipmentTypeSlug: slug,
      name: resolved ? resolved.name : (text(item.otherName) ?? item.catalogSlug).slice(0, 80),
      quantity: item.quantity,
      quantityUncertain: item.quantityUncertain,
      brand: text(item.brand),
      brandEvidence: text(item.brandEvidence),
      model: text(item.model),
      configuration: text(item.configuration),
      notes: null,
      capabilitySlugs: resolved ? [] : item.capabilitySlugs,
      targetMuscles: [],
    },
    vocab,
    resolved,
  );

  return {
    kind: EQUIPMENT_ITEM_KIND,
    confidence: item.confidence,
    uncertain: item.uncertain,
    uncertaintyNote: text(item.note),
    sourcePhotoIds: sourcePhotoIdsFor(item.sourcePhotoIndexes, chunkPhotoIds),
    value,
  };
}

export function mapScanItems(
  items: readonly EquipmentScanOutputItem[],
  chunkPhotoIds: readonly string[],
  vocab: EquipmentVocabulary,
): EquipmentScanDraft[] {
  return items.map((item) => mapScanItem(item, chunkPhotoIds, vocab));
}
