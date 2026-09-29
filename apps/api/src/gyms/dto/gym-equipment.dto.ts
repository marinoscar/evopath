import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  EQUIPMENT_BRAND_MAX,
  EQUIPMENT_CATEGORIES,
  EQUIPMENT_CONFIDENCES,
  EQUIPMENT_MODEL_MAX,
  EQUIPMENT_NOTES_MAX,
  EQUIPMENT_ORIGINS,
  EQUIPMENT_QUANTITY_MAX,
  EQUIPMENT_QUANTITY_MIN,
} from '../gyms.constants';
import { capabilityRefSchema } from './equipment-type.dto';
import { optionalText } from './fields';

// =============================================================================
// /api/gyms/:id/equipment — schemas (E3.3)
// =============================================================================
//
// Write bodies are `.strict()`: provenance (`origin`, `confidence`,
// `userVerified`, `originalAiValue`) is server-owned and a client sending it is
// refused with a 400.
// =============================================================================

const quantity = z
  .number()
  .int({ message: 'Must be a whole number' })
  .min(EQUIPMENT_QUANTITY_MIN, { message: `Must be at least ${EQUIPMENT_QUANTITY_MIN}` })
  .max(EQUIPMENT_QUANTITY_MAX, { message: `Must be at most ${EQUIPMENT_QUANTITY_MAX}` });

export const createGymEquipmentSchema = z
  .object({
    equipmentTypeId: z.uuid().meta({ description: 'A catalog type or one of the caller\'s custom types.' }),
    quantity: quantity.default(1),
    brand: optionalText(EQUIPMENT_BRAND_MAX),
    model: optionalText(EQUIPMENT_MODEL_MAX),
    notes: optionalText(EQUIPMENT_NOTES_MAX),
  })
  .strict();

export class CreateGymEquipmentDto extends createZodDto(createGymEquipmentSchema) {}
export type CreateGymEquipmentInput = z.output<typeof createGymEquipmentSchema>;

export const updateGymEquipmentSchema = z
  .object({
    equipmentTypeId: z.uuid().optional(),
    quantity: quantity.optional(),
    brand: optionalText(EQUIPMENT_BRAND_MAX),
    model: optionalText(EQUIPMENT_MODEL_MAX),
    notes: optionalText(EQUIPMENT_NOTES_MAX),
  })
  .strict()
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'At least one of equipmentTypeId, quantity, brand, model or notes is required',
  });

export class UpdateGymEquipmentDto extends createZodDto(updateGymEquipmentSchema) {}
export type UpdateGymEquipmentInput = z.output<typeof updateGymEquipmentSchema>;

// -----------------------------------------------------------------------------
// Responses
// -----------------------------------------------------------------------------

export const gymEquipmentTypeRefSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  category: z.enum(EQUIPMENT_CATEGORIES),
  isCustom: z.boolean(),
  capabilities: z.array(capabilityRefSchema),
});

export const gymEquipmentViewSchema = z.object({
  id: z.uuid(),
  gymId: z.uuid(),
  equipmentTypeId: z.uuid(),
  equipmentType: gymEquipmentTypeRefSchema,
  quantity: z.number().int(),
  brand: z.string().nullable(),
  model: z.string().nullable(),
  notes: z.string().nullable(),
  origin: z.enum(EQUIPMENT_ORIGINS).meta({ description: '`manual` (added by the user) or `ai` (from a scan).' }),
  confidence: z.enum(EQUIPMENT_CONFIDENCES).nullable().meta({ description: 'The AI\'s confidence; null for manual rows.' }),
  userVerified: z.boolean().meta({ description: 'True for manual rows and for AI rows the user edited or confirmed.' }),
  originalAiValue: z
    .unknown()
    .meta({ description: 'For an AI row: `{ equipmentTypeId, quantity, brand, model, notes }` as the AI proposed it, set on the first edit; null otherwise.' }),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export class GymEquipmentView extends createZodDto(gymEquipmentViewSchema) {}
export type GymEquipmentViewData = z.infer<typeof gymEquipmentViewSchema>;
