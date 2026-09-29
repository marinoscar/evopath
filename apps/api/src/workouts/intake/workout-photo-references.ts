import { Injectable, OnModuleInit } from '@nestjs/common';

import { StorageObjectReferences, type StorageObjectReferenceChecker } from '../../intake/storage-object-references';
import { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// Workout photos hold their storage objects against intake cleanup (E4.5)
// =============================================================================
//
// A workout photo and a photo intake link the same storage object ("Prefill
// from photo" turns the intake's photos into workout photos on apply).
// Discarding an intake, or detaching a photo from it, must not delete an
// object that is still a workout photo: the `workout_photos` row would go with
// it by cascade. This checker tells the intake module so, without the intake
// module importing anything of workouts.
// =============================================================================

export const WORKOUT_PHOTOS_REFERENCE = 'workout_photos';

@Injectable()
export class WorkoutPhotoObjectReferences implements StorageObjectReferenceChecker, OnModuleInit {
  readonly name = WORKOUT_PHOTOS_REFERENCE;

  constructor(
    private readonly references: StorageObjectReferences,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.references.register(this);
  }

  async isReferenced(storageObjectId: string): Promise<boolean> {
    return (await this.prisma.workoutPhoto.count({ where: { storageObjectId } })) > 0;
  }
}
