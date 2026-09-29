import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { GYM_PHOTO_MAX_BYTES, PHOTO_CAPTION_MAX, PHOTO_EQUIPMENT_LINKS_MAX } from '../gyms.constants';
import { optionalText, uuidSet } from './fields';

// =============================================================================
// /api/gyms/:id/photos — schemas (E3.3)
// =============================================================================
//
// Photo bytes never pass through these routes: the browser uploads through
// `POST /api/storage/objects` and then attaches the object here by id.
// =============================================================================

const equipmentIds = uuidSet(PHOTO_EQUIPMENT_LINKS_MAX).meta({
  description: 'Equipment rows of THIS gym the photo shows.',
});

export const attachGymPhotoSchema = z
  .object({
    storageObjectId: z.uuid().meta({
      description:
        `A \`ready\` image storage object the caller uploaded (PNG, JPEG, GIF or WebP, at most ${GYM_PHOTO_MAX_BYTES / (1024 * 1024)} MiB).`,
    }),
    caption: optionalText(PHOTO_CAPTION_MAX),
    takenAt: z.iso.datetime({ offset: true }).nullable().optional(),
    equipmentIds: equipmentIds.optional(),
  })
  .strict();

export class AttachGymPhotoDto extends createZodDto(attachGymPhotoSchema) {}
export type AttachGymPhotoInput = z.output<typeof attachGymPhotoSchema>;

export const updateGymPhotoSchema = z
  .object({
    caption: optionalText(PHOTO_CAPTION_MAX),
    takenAt: z.iso.datetime({ offset: true }).nullable().optional(),
    equipmentIds: equipmentIds.optional().meta({ description: 'Replaces the whole set of links when given.' }),
  })
  .strict()
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'At least one of caption, takenAt or equipmentIds is required',
  });

export class UpdateGymPhotoDto extends createZodDto(updateGymPhotoSchema) {}
export type UpdateGymPhotoInput = z.output<typeof updateGymPhotoSchema>;

// -----------------------------------------------------------------------------
// Responses
// -----------------------------------------------------------------------------

export const gymPhotoViewSchema = z.object({
  id: z.uuid(),
  gymId: z.uuid(),
  storageObjectId: z.uuid().meta({ description: 'View it through `GET /api/storage/objects/{id}/download`.' }),
  caption: z.string().nullable(),
  takenAt: z.iso.datetime().nullable(),
  equipmentIds: z.array(z.uuid()),
  createdAt: z.iso.datetime(),
});

export class GymPhotoView extends createZodDto(gymPhotoViewSchema) {}
export type GymPhotoViewData = z.infer<typeof gymPhotoViewSchema>;
