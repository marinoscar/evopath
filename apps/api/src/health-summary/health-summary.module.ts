import { Module } from '@nestjs/common';

import { AiAssignmentsModule } from '../ai/assignments/ai-assignments.module';
import { AiRuntimeModule } from '../ai/runtime/ai-runtime.module';
import { JobsModule } from '../jobs/jobs.module';
import { HealthSummaryController } from './health-summary.controller';
import { HealthSummaryHandler } from './health-summary.handler';
import { HealthSummaryListener } from './health-summary.listener';
import { HealthSummaryReader } from './health-summary.reader';
import { HealthSummaryService } from './health-summary.service';

/**
 * The opt-in AI health summary (H8, #192).
 *
 * - `HealthSummaryReader`: the owner-scoped reads (consent, summaries, the
 *   digest's inputs) and `forTraining`, the one door through which health
 *   data reaches a training agent. Exported for the training agents.
 * - `HealthSummaryService` + `HealthSummaryController`:
 *   `/api/ai/training/health-summary` (view, consent, refresh).
 * - `HealthSummaryHandler`: the server-only `ai.health.summary` job.
 * - `HealthSummaryListener`: `health.data.changed` -> one debounced job.
 *
 * Depends on the AI platform (assignments, runtime) and the queue; it never
 * imports the training agents' module (they import this one).
 */
@Module({
  imports: [AiAssignmentsModule, AiRuntimeModule, JobsModule],
  controllers: [HealthSummaryController],
  providers: [HealthSummaryReader, HealthSummaryService, HealthSummaryHandler, HealthSummaryListener],
  exports: [HealthSummaryReader],
})
export class HealthSummaryModule {}
