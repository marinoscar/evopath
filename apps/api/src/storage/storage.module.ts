import { Module } from '@nestjs/common';
import { StorageProvidersModule } from './providers/storage-providers.module';
import { ObjectProcessingModule } from './processing/object-processing.module';
import { CommonModule } from '../common/common.module';
import { ObjectsController } from './objects/objects.controller';
import { ObjectsService } from './objects/objects.service';
import { StorageStatusController } from './status/storage-status.controller';
import { StorageCleanupTask } from './tasks/storage-cleanup.task';
import { StorageCleanupHandler } from './handlers/storage-cleanup.handler';
import { StorageObjectProcessHandler } from './handlers/storage-object-process.handler';
import { JobsModule } from '../jobs/jobs.module';

@Module({
  imports: [
    StorageProvidersModule,
    // #353: the stale-upload sweep is a queue job now, so this module needs
    // `JobsService` to enqueue it and `JobHandlerRegistry` for the handler to
    // register itself with. One-way — nothing in `JobsModule` imports storage.
    JobsModule,
    // #520: the processor registry/runner. `ObjectsService` asks it whether an
    // upload needs processing at all; `StorageObjectProcessHandler` runs it.
    ObjectProcessingModule,
    CommonModule,
  ],
  controllers: [ObjectsController, StorageStatusController],
  providers: [
    ObjectsService,
    StorageCleanupTask,
    StorageCleanupHandler,
    StorageObjectProcessHandler,
  ],
  exports: [ObjectsService],
})
export class StorageModule {}
