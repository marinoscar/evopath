import { Injectable, OnModuleInit } from '@nestjs/common';

import { StorageObjectReferences, type StorageObjectReferenceChecker } from '../../intake/storage-object-references';
import { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// Gym photos hold their storage objects against intake cleanup (E3.4)
// =============================================================================
//
// A gym photo and a photo intake can link the same storage object (a scan's
// photos become gym photos on apply). Discarding the intake, or detaching the
// photo from it, must not delete an object that is still a gym photo: the
// `gym_photos` row would go with it by cascade. This checker tells the intake
// module so, without the intake module importing anything of gyms.
// =============================================================================

export const GYM_PHOTOS_REFERENCE = 'gym_photos';

@Injectable()
export class GymPhotoObjectReferences implements StorageObjectReferenceChecker, OnModuleInit {
  readonly name = GYM_PHOTOS_REFERENCE;

  constructor(
    private readonly references: StorageObjectReferences,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.references.register(this);
  }

  async isReferenced(storageObjectId: string): Promise<boolean> {
    return (await this.prisma.gymPhoto.count({ where: { storageObjectId } })) > 0;
  }
}
