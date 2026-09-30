import { Module } from '@nestjs/common';

import { AiConfigModule } from '../ai/config/ai-config.module';
import { AiCoreModule } from '../ai/core/ai-core.module';
import { AiKeysModule } from '../ai/keys/ai-keys.module';
import { AiRuntimeModule } from '../ai/runtime/ai-runtime.module';
import { JobsModule } from '../jobs/jobs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ProgramsModule } from '../programs/programs.module';
import { PlannerContextLoader } from './context/planner-context.loader';
import { GraphRuntimeInfo } from './graph-runtime-info';
import { TrainingModelResolver } from './models/training-model-resolver.service';
import { TrainingModelsController } from './models/training-models.controller';
import { TrainingModelsService } from './models/training-models.service';
import { TrainingRunsPurgeHandler } from './runtime/handlers/training-runs-purge.handler';
import { RunEventsService } from './runtime/run-events.service';
import { FreeTextSafetyScreen, TRAINING_SAFETY_SCREEN } from './runtime/safety-screen';
import { TrainingRunsPurgeTask } from './runtime/tasks/training-runs-purge.task';
import { TrainingPlanRunHandler } from './runtime/training-plan-run.handler';
import { TrainingRunsController } from './runtime/training-runs.controller';
import { TrainingProgramsPort } from './runtime/training-programs.port';
import { TrainingRunsService } from './runtime/training-runs.service';

/**
 * Training agents: the orchestration layer above `AiService`.
 *
 * `@langchain/langgraph` and `@langchain/core` may be imported only under this
 * folder; every model call still goes through `AiService.forUser` (via
 * `AgentCaller`). `GraphRuntimeInfo` loads the runtime at boot and logs its
 * version.
 *
 * - Models: `TrainingModelResolver` turns the caller's per-role model
 *   preferences, usable models and the AI policy into a state per agent role,
 *   through read-only seams, and never sees key material;
 *   `TrainingModelsController` serves `/api/ai/training/models` and
 *   `/api/ai/training/estimate`.
 * - Runtime kit: `TrainingRunsService` and `TrainingRunsController`
 *   (`/api/ai/training/runs`, `/api/ai/training/stream/:runId`),
 *   `RunEventsService` (the sequenced event log), the `ai.training.plan.run`
 *   handler (the graph inside the queue, server-only), and the
 *   `training.runs.purge` handler with its enqueue-only daily task.
 * - Context: `PlannerContextLoader` reads the caller's minimised context
 *   for `prepare_context` (bound as a node port by the run handler).
 * - Plans: `TrainingProgramsPort` binds `ProgramsService` (the chokepoint)
 *   for `finalize`, and `NotificationsService` raises `training.plan_ready`;
 *   both are node ports bound by the run handler.
 * - `TRAINING_SAFETY_SCREEN`: the pre-run safety screen (guardrail G0,
 *   `FreeTextSafetyScreen`): urgent-symptom text stops a run before any job.
 */
@Module({
  imports: [AiConfigModule, AiCoreModule, AiKeysModule, AiRuntimeModule, JobsModule, ProgramsModule, NotificationsModule],
  controllers: [TrainingModelsController, TrainingRunsController],
  providers: [
    GraphRuntimeInfo,
    TrainingModelResolver,
    TrainingModelsService,
    RunEventsService,
    TrainingRunsService,
    TrainingPlanRunHandler,
    TrainingRunsPurgeHandler,
    TrainingRunsPurgeTask,
    PlannerContextLoader,
    TrainingProgramsPort,
    { provide: TRAINING_SAFETY_SCREEN, useClass: FreeTextSafetyScreen },
  ],
  exports: [GraphRuntimeInfo, TrainingModelResolver, TrainingRunsService, RunEventsService],
})
export class TrainingAgentsModule {}
