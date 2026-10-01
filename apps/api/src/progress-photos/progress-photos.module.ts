import { Module } from '@nestjs/common';

import { IntakeModule } from '../intake/intake.module';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { StorageModule } from '../storage/storage.module';
import { ProgressPhotoObjectReferences } from './progress-photo-references';
import { ProgressPhotoSummaryService } from './progress-photo-summary.service';
import { ProgressPhotosController } from './progress-photos.controller';
import { ProgressPhotosService } from './progress-photos.service';

/**
 * Progress photos (E7.9, #249): `/api/progress-photos` (list, add, delete)
 * under `health_data:*`, not AI-gated, plus the `progress_photos` storage
 * reference checker. `IntakeModule` supplies `StorageObjectReferences`,
 * `StorageModule` `ObjectsService` (deleting a removed photo's object) and
 * `StorageProvidersModule` the `STORAGE_PROVIDER` the magic-byte check reads
 * through. `PrismaService` comes from the global `PrismaModule`.
 *
 * Exports ONLY `ProgressPhotoSummaryService` (counts and dates): the coach's
 * photo-prompt cadence and its `get_progress_photo_summary` tool read that and
 * nothing else; photos never reach a model or a notification.
 */
@Module({
  imports: [IntakeModule, StorageModule, StorageProvidersModule],
  controllers: [ProgressPhotosController],
  providers: [ProgressPhotosService, ProgressPhotoSummaryService, ProgressPhotoObjectReferences],
  exports: [ProgressPhotoSummaryService],
})
export class ProgressPhotosModule {}
