import type { DraftItemConfidence } from '../../intake/intake-kind.interface';
import { EQUIPMENT_SCAN_NOTE_MAX } from './equipment-scan.prompt';
import type { EquipmentScanDraft } from './equipment-scan.mapper';

// =============================================================================
// Merging the drafts of several photo batches (E3.4)
// =============================================================================
//
// More than 16 photos are sent in batches of 16, and the batches may show the
// same machines (overlapping photos of one row). Drafts from different batches
// with the same key, `(catalog slug or lower(name), lower(brand))`, become one:
//
//   - quantity: the MAXIMUM across batches (summing would double count);
//   - quantityUncertain: true when the counts differ or any batch flagged it;
//   - uncertain: true when any batch was, or the counts differ;
//   - sourcePhotoIds: the union, in first-seen order;
//   - confidence: the lowest;
//   - uncertaintyNote: the distinct notes joined (at most 300 characters),
//     plus a sentence when the counts differed;
//   - other text fields: the first batch's non-null value.
//
// Drafts of the SAME batch are never merged with each other: the model was
// asked for one item per distinct (equipment, brand), so two items there are
// two things it saw. Order: the first appearance of each key.
// =============================================================================

const CONFIDENCE_RANK: Record<DraftItemConfidence, number> = { low: 0, medium: 1, high: 2 };

export function mergeKey(draft: EquipmentScanDraft): string {
  const type = draft.value.equipmentTypeSlug ?? `name:${draft.value.name.trim().toLowerCase()}`;
  const brand = (draft.value.brand ?? '').trim().toLowerCase();
  return `${type}\u0000${brand}`;
}

function joinNotes(notes: readonly string[]): string | null {
  const distinct: string[] = [];

  for (const note of notes) {
    const trimmed = note.trim();
    if (trimmed && !distinct.includes(trimmed)) distinct.push(trimmed);
  }

  if (distinct.length === 0) return null;

  const joined = distinct.join(' ');
  return joined.length > EQUIPMENT_SCAN_NOTE_MAX ? `${joined.slice(0, EQUIPMENT_SCAN_NOTE_MAX - 1)}…` : joined;
}

interface Group {
  drafts: EquipmentScanDraft[];
  /** Batches that already contributed a draft to this group. */
  batches: Set<number>;
}

function mergeGroup(drafts: readonly EquipmentScanDraft[]): EquipmentScanDraft {
  if (drafts.length === 1) return drafts[0];

  const [first] = drafts;
  const quantities = drafts.map((draft) => draft.value.quantity);
  const countsDiffer = new Set(quantities).size > 1;
  const quantity = Math.max(...quantities);

  const sourcePhotoIds: string[] = [];
  for (const draft of drafts) {
    for (const id of draft.sourcePhotoIds) {
      if (!sourcePhotoIds.includes(id)) sourcePhotoIds.push(id);
    }
  }

  const confidence = drafts
    .map((draft) => draft.confidence)
    .reduce((lowest, next) => (CONFIDENCE_RANK[next] < CONFIDENCE_RANK[lowest] ? next : lowest));

  const firstOf = <K extends 'brandEvidence' | 'model' | 'configuration' | 'notes'>(key: K) =>
    drafts.map((draft) => draft.value[key]).find((value) => value !== null) ?? null;

  const notes = drafts.map((draft) => draft.uncertaintyNote ?? '');
  if (countsDiffer) {
    notes.unshift(`Photo batches counted different numbers (${[...new Set(quantities)].join(', ')}); the highest is used.`);
  }

  const capabilitySlugs: string[] = [];
  for (const draft of drafts) {
    for (const slug of draft.value.capabilitySlugs) {
      if (!capabilitySlugs.includes(slug)) capabilitySlugs.push(slug);
    }
  }

  return {
    kind: first.kind,
    confidence,
    uncertain: countsDiffer || drafts.some((draft) => draft.uncertain),
    uncertaintyNote: joinNotes(notes),
    sourcePhotoIds,
    value: {
      ...first.value,
      quantity,
      quantityUncertain: countsDiffer || drafts.some((draft) => draft.value.quantityUncertain),
      brandEvidence: firstOf('brandEvidence'),
      model: firstOf('model'),
      configuration: firstOf('configuration'),
      notes: firstOf('notes'),
      // A catalog item's lists are the catalog's in every batch; an `other`
      // item's are unioned (and re-derived by the kind's normalizeValue).
      capabilitySlugs: first.value.equipmentTypeSlug ? first.value.capabilitySlugs : capabilitySlugs.slice(0, 12),
    },
  };
}

/** One list of drafts per batch, in batch order -> the merged list. */
export function mergeChunkDrafts(batches: readonly (readonly EquipmentScanDraft[])[]): EquipmentScanDraft[] {
  if (batches.length === 1) return [...batches[0]];

  const groups: Group[] = [];
  const open = new Map<string, Group[]>();

  batches.forEach((drafts, batch) => {
    for (const draft of drafts) {
      const key = mergeKey(draft);
      const candidates = open.get(key) ?? [];
      // The first group with this key this batch has not contributed to yet.
      let group = candidates.find((candidate) => !candidate.batches.has(batch));

      if (!group) {
        group = { drafts: [], batches: new Set() };
        candidates.push(group);
        open.set(key, candidates);
        groups.push(group);
      }

      group.drafts.push(draft);
      group.batches.add(batch);
    }
  });

  return groups.map((group) => mergeGroup(group.drafts));
}
