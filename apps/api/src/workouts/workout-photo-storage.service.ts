import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { ObjectsService } from '../storage/objects/objects.service';

// =============================================================================
// WorkoutPhotoStorageService — storage cleanup for a deleted workout's photos
// =============================================================================
//
// Deleting a workout removes its `workout_photos` rows by cascade but never
// the storage objects they point at, so `WorkoutsService.remove` calls
// `deleteObjects` AFTER the delete commits. It is best effort (a provider
// failure is logged, the user's delete still succeeds) and skips an object
// another row still HOLDS: a workout photo, a gym photo, or a photo intake
// that can still use it (any status but `applied`).
//
// An APPLIED intake is not a holder: its links are history only (the same
// rule and reasoning as `GymStorageService.deleteObjects`); deleting the
// object removes them by cascade.
// =============================================================================

@Injectable()
export class WorkoutPhotoStorageService {
  private readonly logger = new Logger(WorkoutPhotoStorageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly objects: ObjectsService,
  ) {}

  async deleteObjects(userId: string, storageObjectIds: readonly string[]): Promise<void> {
    for (const storageObjectId of storageObjectIds) {
      try {
        const [workoutLinks, gymLinks, intakeHolders] = await Promise.all([
          this.prisma.workoutPhoto.count({ where: { storageObjectId } }),
          this.prisma.gymPhoto.count({ where: { storageObjectId } }),
          this.prisma.photoIntakePhoto.count({
            where: { storageObjectId, intake: { status: { not: 'applied' } } },
          }),
        ]);

        if (workoutLinks === 0 && gymLinks === 0 && intakeHolders === 0) {
          await this.objects.delete(storageObjectId, userId);
        }
      } catch (error) {
        this.logger.warn(
          `Could not delete storage object ${storageObjectId} of a removed workout: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }
}
