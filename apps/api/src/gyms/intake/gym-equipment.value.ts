import { z } from 'zod';

import {
  EQUIPMENT_BRAND_MAX,
  EQUIPMENT_MODEL_MAX,
  EQUIPMENT_NOTES_MAX,
  EQUIPMENT_QUANTITY_MAX,
  EQUIPMENT_QUANTITY_MIN,
  EQUIPMENT_TYPE_CAPABILITIES_MAX,
  EQUIPMENT_TYPE_NAME_MAX,
} from '../gyms.constants';
import {
  catalogType,
  knownCapabilitySlugs,
  targetMusclesFor,
  type EquipmentVocabulary,
} from '../scan/equipment-vocabulary';

// =============================================================================
// The `gym_equipment` draft item value (E3.4)
// =============================================================================
//
// One piece of equipment a scan (or the user) proposes for a gym. Shared by the
// intake kind (`valueSchema`, `normalizeValue`), the scan mapper and the apply.
//
// `equipmentTypeSlug` is a catalog slug, the slug of one of the caller's custom
// types, or `null` for an item nobody could identify ("other": `name` is then
// the free-text name). For a catalog or custom slug the derived fields
// (`capabilitySlugs`, `targetMuscles`) are recomputed from that type, so a
// client can never make them disagree with the catalog.
//
// BOUNDS. `capabilitySlugs` allows up to 50 and `targetMuscles` up to 20: a
// catalog type can carry more than 12 capabilities (dumbbells carry 15), and
// the derived lists must round-trip through an edit. A `null`-slug item's own
// capability list is capped at 12, the custom-type limit apply creates it with.
// =============================================================================

export const EQUIPMENT_VALUE_BRAND_EVIDENCE_MAX = 200;
export const EQUIPMENT_VALUE_CONFIGURATION_MAX = 60;
export const EQUIPMENT_VALUE_CAPABILITIES_MAX = 50;
export const EQUIPMENT_VALUE_MUSCLES_MAX = 20;
export const EQUIPMENT_VALUE_SLUG_MAX = 64;

/** Trimmed, bounded, `''` read as `null`. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .default(null)
    .transform((value) => (value ? value : null));

export const gymEquipmentValueSchema = z
  .object({
    equipmentTypeSlug: z.string().trim().min(1).max(EQUIPMENT_VALUE_SLUG_MAX).nullable(),
    /** Empty only for a slugged item: the catalog name is filled in. */
    name: z.string().trim().max(EQUIPMENT_TYPE_NAME_MAX).default(''),
    quantity: z.number().int().min(EQUIPMENT_QUANTITY_MIN).max(EQUIPMENT_QUANTITY_MAX),
    quantityUncertain: z.boolean().default(false),
    brand: optionalText(EQUIPMENT_BRAND_MAX),
    brandEvidence: optionalText(EQUIPMENT_VALUE_BRAND_EVIDENCE_MAX),
    model: optionalText(EQUIPMENT_MODEL_MAX),
    configuration: optionalText(EQUIPMENT_VALUE_CONFIGURATION_MAX),
    notes: optionalText(EQUIPMENT_NOTES_MAX),
    capabilitySlugs: z.array(z.string().trim().min(1).max(EQUIPMENT_VALUE_SLUG_MAX)).max(EQUIPMENT_VALUE_CAPABILITIES_MAX).default([]),
    targetMuscles: z.array(z.string().trim().min(1).max(40)).max(EQUIPMENT_VALUE_MUSCLES_MAX).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.equipmentTypeSlug === null) {
      if (!value.name) {
        ctx.addIssue({ code: 'custom', path: ['name'], message: 'name is required for equipment without a catalog type' });
      }
      if (value.capabilitySlugs.length > EQUIPMENT_TYPE_CAPABILITIES_MAX) {
        ctx.addIssue({
          code: 'custom',
          path: ['capabilitySlugs'],
          message: `At most ${EQUIPMENT_TYPE_CAPABILITIES_MAX} capabilities for equipment without a catalog type`,
        });
      }
    }
  });

export type GymEquipmentValue = z.output<typeof gymEquipmentValueSchema>;

/** A slugged type's name and capabilities, as `normalizeEquipmentValue` reads them. */
export interface ResolvedEquipmentType {
  name: string;
  capabilitySlugs: string[];
}

/**
 * Recomputes the derived fields. `resolved` is the type behind a non-null
 * slug (a catalog type, or the caller's custom type); the caller decides what
 * an unknown slug means. For a `null` slug, the given capability slugs are
 * kept to the seeded vocabulary.
 */
export function normalizeEquipmentValue(
  value: GymEquipmentValue,
  vocab: EquipmentVocabulary,
  resolved: ResolvedEquipmentType | null,
): GymEquipmentValue {
  const capabilitySlugs = resolved
    ? knownCapabilitySlugs(vocab, resolved.capabilitySlugs)
    : knownCapabilitySlugs(vocab, value.capabilitySlugs);

  return {
    ...value,
    name: value.name || (resolved?.name ?? ''),
    capabilitySlugs,
    targetMuscles: targetMusclesFor(vocab, capabilitySlugs),
  };
}

/** The catalog type behind `slug` as a `ResolvedEquipmentType`, or null. */
export function resolveCatalogType(vocab: EquipmentVocabulary, slug: string): ResolvedEquipmentType | null {
  const type = catalogType(vocab, slug);
  return type ? { name: type.name, capabilitySlugs: type.capabilitySlugs } : null;
}
