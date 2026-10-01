import { Injectable, OnModuleInit } from '@nestjs/common';

import { StorageObjectReferences, type StorageObjectReferenceChecker } from '../intake/storage-object-references';
import { PrismaService } from '../prisma/prisma.service';
import { PROGRESS_PHOTOS_REFERENCE } from './progress-photos.constants';

// =============================================================================
// Progress photos hold their storage objects (E7.9, #249)
// =============================================================================
//
// A progress photo's object is an ordinary upload, and a user may hand the
// same object to another feature (a photo intake, a gym photo). Whoever
// cleans up after that other feature asks `StorageObjectReferences` before
// deleting; this checker answers "still a progress photo", so the object (and
// with it, by cascade, the `progress_photos` row) is never deleted from under
// the gallery. Registered in `onModuleInit`, so the intake module imports
// nothing of progress photos.
// =============================================================================

export { PROGRESS_PHOTOS_REFERENCE };

@Injectable()
export class ProgressPhotoObjectReferences implements StorageObjectReferenceChecker, OnModuleInit {
  readonly name = PROGRESS_PHOTOS_REFERENCE;

  constructor(
    private readonly references: StorageObjectReferences,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.references.register(this);
  }

  async isReferenced(storageObjectId: string): Promise<boolean> {
    return (await this.prisma.progressPhoto.count({ where: { storageObjectId } })) > 0;
  }
}
