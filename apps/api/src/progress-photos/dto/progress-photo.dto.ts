import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { addDays, isRealDate } from '../../check-ins/local-date';
import { optionalText } from '../../gyms/dto/fields';
import {
  PROGRESS_PHOTO_MAX_BYTES,
  PROGRESS_PHOTO_NOTE_MAX,
  PROGRESS_PHOTO_PAGE_SIZE_DEFAULT,
  PROGRESS_PHOTO_PAGE_SIZE_MAX,
  PROGRESS_PHOTO_POSES,
} from '../progress-photos.constants';

// =============================================================================
// /api/progress-photos — schemas (E7.9, #249)
// =============================================================================
//
// Photo bytes never pass through these routes: the browser uploads the
// (downscaled) image to `POST /api/storage/objects` and then adds the object
// here by id. Bytes are read back through the owner-checked, short-lived
// signed download of `GET /api/storage/objects/{id}/download`.
// =============================================================================

const poseSchema = z.enum(PROGRESS_PHOTO_POSES).meta({
  description: 'The pose the photo shows; the gallery pairs photos of one pose for the ghost overlay.',
});

/** A real `YYYY-MM-DD` day, at most one day after today in UTC (the caller's zone may be ahead). */
const localDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Must be a date in YYYY-MM-DD format' })
  .refine(isRealDate, { message: 'Must be a real calendar date' })
  .refine((value) => value <= addDays(new Date().toISOString().slice(0, 10), 1), {
    message: 'Must not be in the future',
  })
  .meta({ description: 'The caller\'s local calendar day the photo represents.', format: 'date' });

export const createProgressPhotoSchema = z
  .object({
    storageObjectId: z.uuid().meta({
      description:
        'A `ready` image storage object the caller uploaded (JPEG, PNG or WebP by content, at most ' +
        `${PROGRESS_PHOTO_MAX_BYTES / (1024 * 1024)} MiB).`,
    }),
    localDate: localDateSchema,
    pose: poseSchema,
    note: optionalText(PROGRESS_PHOTO_NOTE_MAX).meta({
      description: `Free text, at most ${PROGRESS_PHOTO_NOTE_MAX} characters. Never read by any model.`,
    }),
  })
  .strict();

export class CreateProgressPhotoDto extends createZodDto(createProgressPhotoSchema) {}
export type CreateProgressPhotoInput = z.output<typeof createProgressPhotoSchema>;

export const listProgressPhotosQuerySchema = z.object({
  pose: poseSchema.optional(),
  limit: z.coerce.number().int().min(1).max(PROGRESS_PHOTO_PAGE_SIZE_MAX).default(PROGRESS_PHOTO_PAGE_SIZE_DEFAULT),
  cursor: z.string().max(200).optional().meta({ description: 'The `nextCursor` of the previous page. Opaque.' }),
});

export class ListProgressPhotosQueryDto extends createZodDto(listProgressPhotosQuerySchema) {}
export type ListProgressPhotosQuery = z.output<typeof listProgressPhotosQuerySchema>;

export const progressPhotoIdParamSchema = z.object({ id: z.uuid() });

// -----------------------------------------------------------------------------
// Responses
// -----------------------------------------------------------------------------

export const progressPhotoViewSchema = z.object({
  id: z.uuid(),
  storageObjectId: z.uuid().meta({
    description: 'View it through `GET /api/storage/objects/{id}/download` (a short-lived signed URL).',
  }),
  localDate: z.string().meta({ format: 'date' }),
  pose: z.enum(PROGRESS_PHOTO_POSES),
  note: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export class ProgressPhotoView extends createZodDto(progressPhotoViewSchema) {}
export type ProgressPhotoViewData = z.infer<typeof progressPhotoViewSchema>;

export const progressPhotoPageSchema = z.object({
  items: z.array(progressPhotoViewSchema),
  nextCursor: z.string().nullable().meta({ description: 'Pass as `cursor` for the next page; null on the last page.' }),
});

export class ProgressPhotoPageView extends createZodDto(progressPhotoPageSchema) {}
export type ProgressPhotoPage = z.infer<typeof progressPhotoPageSchema>;
