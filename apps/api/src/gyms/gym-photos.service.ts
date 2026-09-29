import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { mimeTypeMatches } from '../storage/mime-type-match';
import type { AttachGymPhotoInput, GymPhotoViewData, UpdateGymPhotoInput } from './dto/gym-photo.dto';
import {
  GYM_PHOTO_MAX_BYTES,
  GYM_PHOTO_MIME_TYPES,
  GYM_REFUSALS,
  MAX_PHOTOS_PER_GYM,
} from './gyms.constants';
import { GymsService } from './gyms.service';
import { GymStorageService } from './gym-storage.service';
import {
  GYM_PHOTO_INCLUDE,
  OLDEST_FIRST,
  isUniqueViolation,
  photoNotFound,
  refuse,
  toGymPhotoView,
} from './gym-views';

// =============================================================================
// GymPhotosService — photos of the caller's gyms (E3.3)
// =============================================================================
//
// Bytes never pass through here: the browser uploads the image to
// `POST /api/storage/objects` and attaches the resulting object by id. The
// object must be the caller's (another user's object is a 404), `ready`, an
// image a browser can display, and at most 20 MiB. One object is one photo:
// `gym_photos.storage_object_id` is unique, and a second attach is a 409
// `PHOTO_ALREADY_ATTACHED` (decided by the index, not a pre-check).
//
// Removing a photo deletes its storage object after the row is gone.
// =============================================================================

@Injectable()
export class GymPhotosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gyms: GymsService,
    private readonly storage: GymStorageService,
  ) {}

  async list(userId: string, gymId: string): Promise<GymPhotoViewData[]> {
    await this.gyms.findOwned(userId, gymId);

    const photos = await this.prisma.gymPhoto.findMany({
      where: { gymId },
      orderBy: OLDEST_FIRST,
      include: GYM_PHOTO_INCLUDE,
    });

    return photos.map(toGymPhotoView);
  }

  async attach(userId: string, gymId: string, input: AttachGymPhotoInput): Promise<GymPhotoViewData> {
    await this.gyms.findOwned(userId, gymId);

    const { storageObjectId } = input;
    const object = await this.storage.findOwnedObject(userId, storageObjectId);

    if (!object) {
      throw new NotFoundException({ message: 'Storage object not found', details: { storageObjectId } });
    }

    if (object.status !== 'ready') {
      throw refuse(400, GYM_REFUSALS.OBJECT_NOT_READY, 'The storage object is not ready yet', { storageObjectId });
    }

    if (!mimeTypeMatches(object.mimeType, GYM_PHOTO_MIME_TYPES)) {
      throw refuse(400, GYM_REFUSALS.UNSUPPORTED_MEDIA_TYPE, 'Only PNG, JPEG, GIF and WebP images can be attached', {
        storageObjectId,
        allowed: [...GYM_PHOTO_MIME_TYPES],
      });
    }

    if (Number(object.size) > GYM_PHOTO_MAX_BYTES) {
      throw refuse(400, GYM_REFUSALS.OBJECT_TOO_LARGE, 'The image is larger than 20 MiB', {
        storageObjectId,
        maxBytes: GYM_PHOTO_MAX_BYTES,
      });
    }

    const attached = await this.prisma.gymPhoto.count({ where: { gymId } });

    if (attached >= MAX_PHOTOS_PER_GYM) {
      throw refuse(400, GYM_REFUSALS.PHOTO_LIMIT, `A gym holds at most ${MAX_PHOTOS_PER_GYM} photos`, {
        max: MAX_PHOTOS_PER_GYM,
      });
    }

    const equipmentIds = input.equipmentIds ?? [];
    await this.assertEquipmentInGym(gymId, equipmentIds);

    try {
      const photo = await this.prisma.gymPhoto.create({
        data: {
          gymId,
          storageObjectId,
          caption: input.caption ?? null,
          takenAt: input.takenAt ? new Date(input.takenAt) : null,
          equipment: { create: equipmentIds.map((gymEquipmentId) => ({ gymEquipmentId })) },
        },
        include: GYM_PHOTO_INCLUDE,
      });

      return toGymPhotoView(photo);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw refuse(409, GYM_REFUSALS.PHOTO_ALREADY_ATTACHED, 'This storage object is already attached as a gym photo', {
          storageObjectId,
        });
      }
      throw error;
    }
  }

  async update(userId: string, gymId: string, photoId: string, input: UpdateGymPhotoInput): Promise<GymPhotoViewData> {
    await this.gyms.findOwned(userId, gymId);
    await this.findInGym(gymId, photoId);

    if (input.equipmentIds) {
      await this.assertEquipmentInGym(gymId, input.equipmentIds);
    }

    await this.prisma.$transaction(async (tx) => {
      const data: { caption?: string | null; takenAt?: Date | null } = {};
      if (input.caption !== undefined) data.caption = input.caption;
      if (input.takenAt !== undefined) data.takenAt = input.takenAt ? new Date(input.takenAt) : null;

      const { count } = await tx.gymPhoto.updateMany({ where: { id: photoId, gymId }, data });

      if (count === 0) {
        throw photoNotFound();
      }

      if (input.equipmentIds) {
        await tx.gymEquipmentPhoto.deleteMany({ where: { gymPhotoId: photoId } });

        if (input.equipmentIds.length > 0) {
          await tx.gymEquipmentPhoto.createMany({
            data: input.equipmentIds.map((gymEquipmentId) => ({ gymEquipmentId, gymPhotoId: photoId })),
          });
        }
      }
    });

    return toGymPhotoView(await this.findInGym(gymId, photoId));
  }

  /** Removes the photo and then deletes its storage object. */
  async remove(userId: string, gymId: string, photoId: string): Promise<void> {
    await this.gyms.findOwned(userId, gymId);
    const photo = await this.findInGym(gymId, photoId);

    const { count } = await this.prisma.gymPhoto.deleteMany({ where: { id: photoId, gymId } });

    if (count === 0) {
      throw photoNotFound();
    }

    await this.storage.deleteObjects(userId, [photo.storageObjectId]);
  }

  // ---------------------------------------------------------------------------

  private async findInGym(gymId: string, photoId: string) {
    const photo = await this.prisma.gymPhoto.findFirst({ where: { id: photoId, gymId }, include: GYM_PHOTO_INCLUDE });

    if (!photo) {
      throw photoNotFound();
    }

    return photo;
  }

  /** Every id must be an equipment row of this gym (400 `EQUIPMENT_NOT_IN_GYM`). */
  private async assertEquipmentInGym(gymId: string, equipmentIds: readonly string[]): Promise<void> {
    if (equipmentIds.length === 0) {
      return;
    }

    const found = await this.prisma.gymEquipment.findMany({
      where: { gymId, id: { in: [...equipmentIds] } },
      select: { id: true },
    });

    if (found.length !== equipmentIds.length) {
      const known = new Set(found.map((row) => row.id));
      throw refuse(400, GYM_REFUSALS.EQUIPMENT_NOT_IN_GYM, 'Every equipmentId must be equipment of this gym', {
        equipmentIds: equipmentIds.filter((id) => !known.has(id)),
      });
    }
  }
}
