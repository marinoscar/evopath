import { Module } from '@nestjs/common';

import { AiConfigModule } from '../../ai/config/ai-config.module';
import { CheckInsModule } from '../../check-ins/check-ins.module';
import { JobsModule } from '../../jobs/jobs.module';
import { ProgramsModule } from '../../programs/programs.module';
import { SettingsModule } from '../../settings/settings.module';
import { CoachEventsListener } from './coach-events.listener';
import { CoachMomentEnqueuer } from './coach-moment-enqueuer';
import { CoachPlannerService } from './coach-planner.service';
import { CoachPlanningMetrics } from './coach-planning.metrics';
import { CoachStateController } from './coach-state.controller';
import { CoachStateService } from './coach-state.service';
import { CoachSweepHandler } from './handlers/coach-sweep.handler';
import { CoachWorkoutFinishedHandler } from './handlers/coach-workout-finished.handler';
import { CoachSweepTask } from './tasks/coach-sweep.task';

// =============================================================================
// CoachPlanningModule (E7.4): the coach's decision engine
// =============================================================================
//
// The pure planner (`plan-coach-moments.ts`), the hourly `coach.sweep` (cron
// enqueues, handler plans), the `coach.workout_finished` job and its
// enqueue-only listener, and `GET /api/coach/state`. No AI call lives here:
// eligible moments are handed to `ai.coach.nudge` / `ai.coach.weekly_review`
// through `CoachMomentEnqueuer`. `CoachStateService` is exported for the
// delivery step (`recordNudgeSent`).
// =============================================================================

@Module({
  imports: [AiConfigModule, CheckInsModule, JobsModule, ProgramsModule, SettingsModule],
  controllers: [CoachStateController],
  providers: [
    CoachPlanningMetrics,
    CoachMomentEnqueuer,
    CoachPlannerService,
    CoachStateService,
    CoachSweepHandler,
    CoachWorkoutFinishedHandler,
    CoachSweepTask,
    CoachEventsListener,
  ],
  exports: [CoachStateService, CoachMomentEnqueuer],
})
export class CoachPlanningModule {}
