import { Module } from '@nestjs/common';

import { ActivityModule } from '../../activity/activity.module';
import { AiConfigModule } from '../../ai/config/ai-config.module';
import { CheckInsModule } from '../../check-ins/check-ins.module';
import { JobsModule } from '../../jobs/jobs.module';
import { ProgramsModule } from '../../programs/programs.module';
import { ProgressPhotosModule } from '../../progress-photos/progress-photos.module';
import { SettingsModule } from '../../settings/settings.module';
import { CoachKickoffListener } from '../coach-kickoff.listener';
import { CoachEventsListener } from './coach-events.listener';
import { CoachMomentEnqueuer } from './coach-moment-enqueuer';
import { CoachPlannerService } from './coach-planner.service';
import { CoachPlanningMetrics } from './coach-planning.metrics';
import { CoachStateController } from './coach-state.controller';
import { CoachStateService } from './coach-state.service';
import { CoachActivityRecordedHandler } from './handlers/coach-activity-recorded.handler';
import { CoachSweepHandler } from './handlers/coach-sweep.handler';
import { CoachWorkoutFinishedHandler } from './handlers/coach-workout-finished.handler';
import { CoachSweepTask } from './tasks/coach-sweep.task';

// =============================================================================
// CoachPlanningModule (E7.4): the coach's decision engine
// =============================================================================
//
// The pure planner (`plan-coach-moments.ts`), the hourly `coach.sweep` (cron
// enqueues, handler plans), the `coach.workout_finished` and
// `coach.activity_recorded` jobs and their enqueue-only listener, and `GET /api/coach/state`. No AI call lives here:
// eligible moments are handed to `ai.coach.nudge` / `ai.coach.weekly_review`
// through `CoachMomentEnqueuer`. `CoachStateService` is exported for the
// delivery step (`recordNudgeSent`).
// =============================================================================

@Module({
  imports: [ActivityModule, AiConfigModule, CheckInsModule, JobsModule, ProgramsModule, ProgressPhotosModule, SettingsModule],
  controllers: [CoachStateController],
  providers: [
    CoachPlanningMetrics,
    CoachMomentEnqueuer,
    CoachPlannerService,
    CoachStateService,
    CoachSweepHandler,
    CoachWorkoutFinishedHandler,
    CoachActivityRecordedHandler,
    CoachSweepTask,
    CoachEventsListener,
    CoachKickoffListener,
  ],
  exports: [CoachStateService, CoachMomentEnqueuer],
})
export class CoachPlanningModule {}
