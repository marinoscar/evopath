import { Module } from '@nestjs/common';

import { AiAssignmentsModule } from '../ai/assignments/ai-assignments.module';
import { AiConfigModule } from '../ai/config/ai-config.module';
import { AiRuntimeModule } from '../ai/runtime/ai-runtime.module';
import { JobsModule } from '../jobs/jobs.module';
import { SettingsModule } from '../settings/settings.module';
import { MemoryExtractHandler } from './extraction/memory-extract.handler';
import { MemoryExtractionScheduler } from './extraction/memory-extraction.scheduler';
import { MemoryContextService } from './memory-context.service';
import { MemoryController } from './memory.controller';
import { MemoryMetrics } from './memory.metrics';
import { MemoryService } from './memory.service';
import { MemoryPurgeHandler } from './purge/memory-purge.handler';
import { MemoryPurgeTask } from './purge/memory-purge.task';

// =============================================================================
// MemoryModule (#325; docs/specs/ai-memory.md)
// =============================================================================
//
// - `/api/memories` (`MemoryController`): the user's own management routes.
// - `MemoryService`: the one writer (validation, gates, dedup, cap).
// - `MemoryContextService`: the read path every prompt builder uses (coach
//   chat, nudges, weekly review, the training planner).
// - `MemoryExtractionScheduler` + `ai.memory.extract` (`MemoryExtractHandler`):
//   the background path, server-only.
// - `memory.purge` (`MemoryPurgeHandler`) and its daily enqueue task.
//
// Exports the service, the read path and the scheduler; imported by
// `CoachChatModule`, `CoachNudgesModule`, `CoachReviewModule` and
// `TrainingAgentsModule`, and registered in `AppModule` for its routes.
// =============================================================================

@Module({
  imports: [AiAssignmentsModule, AiConfigModule, AiRuntimeModule, JobsModule, SettingsModule],
  controllers: [MemoryController],
  providers: [
    MemoryMetrics,
    MemoryService,
    MemoryContextService,
    MemoryExtractionScheduler,
    MemoryExtractHandler,
    MemoryPurgeHandler,
    MemoryPurgeTask,
  ],
  exports: [MemoryService, MemoryContextService, MemoryExtractionScheduler],
})
export class MemoryModule {}
