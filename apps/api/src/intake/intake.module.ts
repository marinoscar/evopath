import { Module } from '@nestjs/common';

import { AiAssignmentsModule } from '../ai/assignments/ai-assignments.module';
import { AiConfigModule } from '../ai/config/ai-config.module';
import { AiKeysModule } from '../ai/keys/ai-keys.module';
import { JobsModule } from '../jobs/jobs.module';
import { StorageModule } from '../storage/storage.module';
import { IntakeAnalyzeController, IntakesController } from './intake.controller';
import { IntakeKindRegistry } from './intake-kind.registry';
import { IntakeService } from './intake.service';
import { StorageObjectReferences } from './storage-object-references';

/**
 * Photo intakes (E3.1): the kind-agnostic staging area for "share a picture
 * instead of typing" flows. A feature adds one `IntakeKind` (registered with
 * `IntakeKindRegistry.register(this)` in its `onModuleInit`) and one
 * server-only `ai.*` analyzer job that writes drafts through
 * `IntakeService.replaceAiDrafts`; it imports this module for both. A
 * feature that keeps using intake photos registers a checker with
 * `StorageObjectReferences`, so discarding an intake never deletes them.
 *
 * `AiConfigModule` supplies `AiEnabledGuard` (the analyze route's kill
 * switch), `AiKeysModule` supplies `UsableModelsService` (the analyze
 * route's model gate), `AiAssignmentsModule` `AiFeatureModelResolver` (the
 * administrator-assigned model the analyzer uses, #173), `JobsModule` the enqueue and `StorageModule`
 * `ObjectsService` (deleting a discarded photo). `PrismaService` comes from
 * the global `PrismaModule`.
 */
@Module({
  imports: [AiAssignmentsModule, AiConfigModule, AiKeysModule, JobsModule, StorageModule],
  controllers: [IntakesController, IntakeAnalyzeController],
  providers: [IntakeKindRegistry, IntakeService, StorageObjectReferences],
  exports: [IntakeKindRegistry, IntakeService, StorageObjectReferences],
})
export class IntakeModule {}
