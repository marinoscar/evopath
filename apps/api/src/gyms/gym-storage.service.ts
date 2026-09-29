import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { ObjectsService } from '../storage/objects/objects.service';

// =============================================================================
// GymStorageService — storage-object ownership and cleanup for gym photos
// =============================================================================
//
// A deliberately small query over `storage_objects` instead of importing the
// AI platform's input resolver: gyms are not an AI feature.
//
// Deleting a gym (or a photo) removes its `gym_photos` rows by cascade but
// never the storage objects they point at, so the services call
// `deleteObjects` AFTER the database write commits. It is best effort (a
// provider failure is logged, the user's action still succeeds) and skips an
// object another row still HOLDS: another gym photo, or a photo intake that can
// still use it (any status but `applied`).
//
// An APPLIED intake is not a holder. "Scan gym" leaves every applied intake
// linked to the photos it turned into gym photos, and those links are history
// only (nothing reads the photos of an applied intake again), so counting them
// would keep every scanned photo's object alive forever once the gym photo is
// removed. Deleting the object removes those `photo_intake_photos` rows by
// cascade, in the same statement as the object row; the draft items'
// `sourcePhotoIds` keep pointing at it ("photo removed"), as for any deleted
// photo. The links are deliberately NOT deleted beforehand: if the provider
// delete then failed, the object would be left with no row referencing it.
// =============================================================================

export interface OwnedStorageObject {
  id: string;
  status: string;
  mimeType: string;
  size: bigint;
}

@Injectable()
export class GymStorageService {
  private readonly logger = new Logger(GymStorageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly objects: ObjectsService,
  ) {}

  /** The caller's storage object, or null when it is missing or somebody else's. */
  async findOwnedObject(userId: string, storageObjectId: string): Promise<OwnedStorageObject | null> {
    return this.prisma.storageObject.findFirst({
      where: { id: storageObjectId, uploadedById: userId },
      select: { id: true, status: true, mimeType: true, size: true },
    });
  }

  /**
   * Deletes each object no gym photo and no unapplied photo intake still
   * links, best effort. Links of applied intakes go with the object (cascade).
   */
  async deleteObjects(userId: string, storageObjectIds: readonly string[]): Promise<void> {
    for (const storageObjectId of storageObjectIds) {
      try {
        const [gymLinks, workoutLinks, intakeHolders] = await Promise.all([
          this.prisma.gymPhoto.count({ where: { storageObjectId } }),
          // A workout photo (E4.5) holds its object too.
          this.prisma.workoutPhoto.count({ where: { storageObjectId } }),
          this.prisma.photoIntakePhoto.count({
            where: { storageObjectId, intake: { status: { not: 'applied' } } },
          }),
        ]);

        if (gymLinks === 0 && workoutLinks === 0 && intakeHolders === 0) {
          await this.objects.delete(storageObjectId, userId);
        }
      } catch (error) {
        this.logger.warn(
          `Could not delete storage object ${storageObjectId} of a removed gym photo: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }
}
