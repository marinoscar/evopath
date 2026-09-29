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
// object another row still references, such as a photo intake.
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

  /** Deletes each object no gym photo or photo intake still links, best effort. */
  async deleteObjects(userId: string, storageObjectIds: readonly string[]): Promise<void> {
    for (const storageObjectId of storageObjectIds) {
      try {
        const [gymLinks, intakeLinks] = await Promise.all([
          this.prisma.gymPhoto.count({ where: { storageObjectId } }),
          this.prisma.photoIntakePhoto.count({ where: { storageObjectId } }),
        ]);

        if (gymLinks === 0 && intakeLinks === 0) {
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
