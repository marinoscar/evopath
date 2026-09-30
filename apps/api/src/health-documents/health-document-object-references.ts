import { Injectable, OnModuleInit } from '@nestjs/common';

import { type StorageObjectReferenceChecker, StorageObjectReferences } from '../intake/storage-object-references';
import { PrismaService } from '../prisma/prisma.service';

// =============================================================================
// `health_documents`: the storage objects a health document still holds (H1)
// =============================================================================
//
// Registered with the intake module's `StorageObjectReferences`, so
// `IntakeService.deleteUnreferencedObjects` (after a discard or a detach)
// never deletes a health document's file:
//
//   - a `keep` document holds its object for as long as it exists: a kept
//     file survives the intake's discard;
//   - a `delete_after_processing` document ALSO holds it until the purge job
//     has erased it (`file_deleted_at` set). Its deletion belongs to
//     `health.document.purge` alone, which is retried, audited and counted;
//     the intake's best-effort cleanup must not race it and leave a document
//     whose file vanished without `file_deleted_at`.
//
// Once `file_deleted_at` is set the document holds nothing. A detached file
// has no document any more (detach deletes it with the link).
// =============================================================================

@Injectable()
export class HealthDocumentObjectReferences implements StorageObjectReferenceChecker, OnModuleInit {
  readonly name = 'health_documents';

  constructor(
    private readonly references: StorageObjectReferences,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.references.register(this);
  }

  async isReferenced(storageObjectId: string): Promise<boolean> {
    const held = await this.prisma.healthDocument.count({
      where: { storageObjectId, fileDeletedAt: null },
    });
    return held > 0;
  }
}
