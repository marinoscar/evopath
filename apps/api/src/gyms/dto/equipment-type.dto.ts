import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  EQUIPMENT_CATEGORIES,
  EQUIPMENT_TYPE_CAPABILITIES_MAX,
  EQUIPMENT_TYPE_LIST_LIMIT_DEFAULT,
  EQUIPMENT_TYPE_LIST_LIMIT_MAX,
  EQUIPMENT_TYPE_NAME_MAX,
  EQUIPMENT_TYPE_QUERY_MAX,
} from '../gyms.constants';
import { requiredName, uuidSet } from './fields';

// =============================================================================
// /api/equipment-types and /api/capabilities — schemas (E3.3)
// =============================================================================

// -----------------------------------------------------------------------------
// GET /api/equipment-types
// -----------------------------------------------------------------------------

export const listEquipmentTypesQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .min(1)
    .max(EQUIPMENT_TYPE_QUERY_MAX)
    .optional()
    .meta({ description: 'Case-insensitive substring of the name or of any alias.' }),
  category: z.enum(EQUIPMENT_CATEGORIES).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(EQUIPMENT_TYPE_LIST_LIMIT_MAX)
    .default(EQUIPMENT_TYPE_LIST_LIMIT_DEFAULT),
});

export class ListEquipmentTypesQueryDto extends createZodDto(listEquipmentTypesQuerySchema) {}
export type ListEquipmentTypesQuery = z.output<typeof listEquipmentTypesQuerySchema>;

// -----------------------------------------------------------------------------
// POST / PATCH /api/equipment-types
// -----------------------------------------------------------------------------

const capabilityIds = uuidSet(EQUIPMENT_TYPE_CAPABILITIES_MAX).meta({
  description: `Capability ids (from \`GET /api/capabilities\`), at most ${EQUIPMENT_TYPE_CAPABILITIES_MAX}.`,
});

export const createEquipmentTypeSchema = z
  .object({
    name: requiredName(EQUIPMENT_TYPE_NAME_MAX),
    category: z.enum(EQUIPMENT_CATEGORIES),
    capabilityIds: capabilityIds.optional(),
  })
  .strict();

export class CreateEquipmentTypeDto extends createZodDto(createEquipmentTypeSchema) {}
export type CreateEquipmentTypeInput = z.output<typeof createEquipmentTypeSchema>;

export const updateEquipmentTypeSchema = z
  .object({
    name: requiredName(EQUIPMENT_TYPE_NAME_MAX).optional(),
    category: z.enum(EQUIPMENT_CATEGORIES).optional(),
    capabilityIds: capabilityIds.optional().meta({ description: 'Replaces the whole set when given.' }),
  })
  .strict()
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'At least one of name, category or capabilityIds is required',
  });

export class UpdateEquipmentTypeDto extends createZodDto(updateEquipmentTypeSchema) {}
export type UpdateEquipmentTypeInput = z.output<typeof updateEquipmentTypeSchema>;

// -----------------------------------------------------------------------------
// Responses
// -----------------------------------------------------------------------------

export const capabilityRefSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
});

export class CapabilityRef extends createZodDto(capabilityRefSchema) {}
export type CapabilityRefData = z.infer<typeof capabilityRefSchema>;

export const capabilityViewSchema = z.object({
  id: z.uuid(),
  slug: z.string().meta({ description: 'Permanent identifier, e.g. `back_squat`.' }),
  name: z.string(),
  movementPattern: z.string().meta({ description: 'e.g. `squat`, `hinge`, `cardio`.' }),
  primaryMuscles: z.array(z.string()),
  description: z.string().nullable(),
});

export class CapabilityView extends createZodDto(capabilityViewSchema) {}
export type CapabilityViewData = z.infer<typeof capabilityViewSchema>;

export const equipmentTypeViewSchema = z.object({
  id: z.uuid(),
  slug: z.string().meta({ description: 'Permanent; `custom-<8 chars>` for a custom type.' }),
  name: z.string(),
  category: z.enum(EQUIPMENT_CATEGORIES),
  aliases: z.array(z.string()),
  description: z.string().nullable(),
  isCustom: z.boolean().meta({ description: 'True for the caller\'s own custom type; false for a catalog type.' }),
  capabilities: z.array(capabilityRefSchema).meta({ description: 'What the equipment lets you train, by capability sort order.' }),
});

export class EquipmentTypeView extends createZodDto(equipmentTypeViewSchema) {}
export type EquipmentTypeViewData = z.infer<typeof equipmentTypeViewSchema>;
