import { Module } from '@nestjs/common';

import { ActivityModule } from '../../activity/activity.module';
import { AiAssignmentsModule } from '../../ai/assignments/ai-assignments.module';
import { AiConfigModule } from '../../ai/config/ai-config.module';
import { AiRuntimeModule } from '../../ai/runtime/ai-runtime.module';
import { CheckInsModule } from '../../check-ins/check-ins.module';
import { JobsModule } from '../../jobs/jobs.module';
import { MemoryModule } from '../../memory/memory.module';
import { ProgramsModule } from '../../programs/programs.module';
import { ProgressPhotosModule } from '../../progress-photos/progress-photos.module';
import { SettingsModule } from '../../settings/settings.module';
import { CoachContentGuard } from '../guard/coach-content-guard.service';
import { CoachReviewMetrics } from './coach-review.metrics';
import { CoachWeeklyReviewHandler } from './handlers/coach-weekly-review.handler';

// =============================================================================
// CoachReviewModule (E7.10, #250): the weekly review and the weekly streak
// =============================================================================
//
// `ai.coach.weekly_review` (`CoachWeeklyReviewHandler`). Its registration is
// what turns on the planner's weekly-review lane: `CoachMomentEnqueuer`
// (E7.4) only enqueues a type a handler is registered for. Delivery is the
// shared `coach.message.deliver` job (`CoachNudgesModule`), enqueued by type
// string, so this module does not import it.
//
// Imported by `CoachModule`. `CoachContentGuard` is stateless, so this module
// provides its own instance.
// =============================================================================

@Module({
  imports: [
    ActivityModule,
    AiAssignmentsModule,
    AiConfigModule,
    AiRuntimeModule,
    CheckInsModule,
    JobsModule,
    // User memory (#325): the memory block in the prompt.
    MemoryModule,
    ProgramsModule,
    ProgressPhotosModule,
    SettingsModule,
  ],
  providers: [CoachContentGuard, CoachReviewMetrics, CoachWeeklyReviewHandler],
})
export class CoachReviewModule {}
