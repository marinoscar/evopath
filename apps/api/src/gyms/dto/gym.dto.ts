import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { GYM_DESCRIPTION_MAX, GYM_NAME_MAX, GYM_NOTES_MAX, GYM_TYPES } from '../gyms.constants';
import { optionalText, queryBoolean, requiredName } from './fields';
import { gymEquipmentViewSchema } from './gym-equipment.dto';
import { gymPhotoViewSchema } from './gym-photo.dto';

// =============================================================================
// /api/gyms — request and response schemas (E3.3)
// =============================================================================
//
// Write bodies are `.strict()`: `isDefault` is not writable here (it moves only
// through `POST /api/gyms/{id}/default`, so the partial unique index
// `gyms_user_default_uniq_idx` has exactly one writer path).
// =============================================================================

const latitude = z
  .number()
  .min(-90, { message: 'Must be between -90 and 90' })
  .max(90, { message: 'Must be between -90 and 90' })
  .nullable()
  .optional();
const longitude = z
  .number()
  .min(-180, { message: 'Must be between -180 and 180' })
  .max(180, { message: 'Must be between -180 and 180' })
  .nullable()
  .optional();

/** Latitude and longitude are set together or cleared together. */
function bothOrNeither(body: { latitude?: number | null; longitude?: number | null }, ctx: z.RefinementCtx): void {
  const lat = body.latitude;
  const lng = body.longitude;
  const given = (value: number | null | undefined) => value !== undefined;
  const isSet = (value: number | null | undefined) => value !== undefined && value !== null;

  if (given(lat) !== given(lng) || isSet(lat) !== isSet(lng)) {
    const message = 'latitude and longitude must be given together (both numbers or both null)';
    ctx.addIssue({ code: 'custom', path: [isSet(lat) ? 'longitude' : 'latitude'], message });
  }
}

const gymFields = {
  name: requiredName(GYM_NAME_MAX),
  type: z.enum(GYM_TYPES),
  description: optionalText(GYM_DESCRIPTION_MAX),
  notes: optionalText(GYM_NOTES_MAX),
  isTemporary: z.boolean().optional().meta({ description: 'A place you train for a while, e.g. a hotel on a trip.' }),
  latitude,
  longitude,
};

export const createGymSchema = z
  .object(gymFields)
  .strict()
  .superRefine(bothOrNeither);

export class CreateGymDto extends createZodDto(createGymSchema) {}
export type CreateGymInput = z.output<typeof createGymSchema>;

export const updateGymSchema = z
  .object({
    name: gymFields.name.optional(),
    type: gymFields.type.optional(),
    description: gymFields.description,
    notes: gymFields.notes,
    isTemporary: gymFields.isTemporary,
    latitude,
    longitude,
  })
  .strict()
  .superRefine(bothOrNeither)
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'At least one field is required',
  });

export class UpdateGymDto extends createZodDto(updateGymSchema) {}
export type UpdateGymInput = z.output<typeof updateGymSchema>;

export const listGymsQuerySchema = z.object({
  includeTemporary: queryBoolean.default(true).meta({ description: '`false` hides temporary gyms. Default `true`.' }),
});

export class ListGymsQueryDto extends createZodDto(listGymsQuerySchema) {}
export type ListGymsQuery = z.output<typeof listGymsQuerySchema>;

// -----------------------------------------------------------------------------
// Responses
// -----------------------------------------------------------------------------

const gymViewFields = {
  id: z.uuid(),
  name: z.string(),
  type: z.enum(GYM_TYPES),
  description: z.string().nullable(),
  notes: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  isDefault: z.boolean().meta({ description: 'Exactly one of a user\'s gyms is the default while they have any.' }),
  isTemporary: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};

export const gymViewSchema = z.object(gymViewFields);
export class GymView extends createZodDto(gymViewSchema) {}
export type GymViewData = z.infer<typeof gymViewSchema>;

export const gymSummarySchema = z.object({
  ...gymViewFields,
  equipmentCount: z.number().int().meta({ description: 'Equipment rows (not the sum of quantities).' }),
  photoCount: z.number().int(),
  coverPhotoId: z.uuid().nullable().meta({ description: 'The oldest gym photo, or null.' }),
  coverStorageObjectId: z
    .uuid()
    .nullable()
    .meta({ description: 'That photo\'s storage object, for `GET /api/storage/objects/{id}/download`.' }),
});
export class GymSummary extends createZodDto(gymSummarySchema) {}
export type GymSummaryData = z.infer<typeof gymSummarySchema>;

export const gymDetailSchema = z.object({
  ...gymViewFields,
  equipment: z.array(gymEquipmentViewSchema).meta({ description: 'Oldest first.' }),
  photos: z.array(gymPhotoViewSchema).meta({ description: 'Oldest first.' }),
});
export class GymDetail extends createZodDto(gymDetailSchema) {}
export type GymDetailData = z.infer<typeof gymDetailSchema>;
