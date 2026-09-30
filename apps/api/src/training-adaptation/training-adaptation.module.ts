import { Module } from '@nestjs/common';

import { AiConfigModule } from '../ai/config/ai-config.module';
import { AiRuntimeModule } from '../ai/runtime/ai-runtime.module';
import { CheckInsModule } from '../check-ins/check-ins.module';
import { JobsModule } from '../jobs/jobs.module';
import { ProgramsModule } from '../programs/programs.module';
import { TrainingAgentsModule } from '../training-agents/training-agents.module';
import { WorkoutsModule } from '../workouts/workouts.module';
import { AdaptationController } from './adaptation.controller';
import { AdaptationService } from './adaptation.service';
import { AdaptationContextBuilder } from './context/adaptation-context.builder';
import { AdaptationRunHandler } from './handlers/adaptation-run.handler';
import { AdaptationsPurgeHandler } from './handlers/adaptations-purge.handler';
import { AdaptationsPurgeTask } from './tasks/adaptations-purge.task';

/**
 * Quick workout adaptation (E6.1): "I have 30 minutes", "I'm sore", "only
 * dumbbells".
 *
 * - `AdaptationController` (`/api/ai/training/adaptations`, behind
 *   `AiEnabledGuard` plus `ai:use`; the apply routes add `workouts:write` /
 *   `programs:write`) and `AdaptationService`.
 * - `AdaptationContextBuilder`: the minimised context (preview == sent),
 *   reading today's planned workout through E5.7 (`ProgramsModule` exports
 *   `TrainingTodayService`), the check-in (`CheckInsModule`) and the library
 *   (`TrainingAgentsModule` exports `PlannerContextLoader`).
 * - `ai.training.adapt.run` (`AdaptationRunHandler`): the graph on the E5.3
 *   kit (`TrainingAgentsModule`: `RunEventsService`, `TrainingRunsService`,
 *   `TrainingModelResolver`; `AiRuntimeModule`: `AiService`). Server-only.
 * - `training.adaptations.purge` and its enqueue-only daily task.
 *
 * This module never imports LangGraph (CLAUDE.md AI rule 6): the graph's
 * wiring lives in `training-agents/graph/adapt-graph.ts`.
 */
@Module({
  imports: [AiConfigModule, AiRuntimeModule, JobsModule, CheckInsModule, ProgramsModule, WorkoutsModule, TrainingAgentsModule],
  controllers: [AdaptationController],
  providers: [
    AdaptationService,
    AdaptationContextBuilder,
    AdaptationRunHandler,
    AdaptationsPurgeHandler,
    AdaptationsPurgeTask,
  ],
  exports: [AdaptationService, AdaptationContextBuilder],
})
export class TrainingAdaptationModule {}
