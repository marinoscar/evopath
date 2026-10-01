import { Module } from '@nestjs/common';

import { CheckInsModule } from '../check-ins/check-ins.module';
import { ActivityEntriesController } from './activity-entries.controller';
import { ActivityEntriesService } from './activity-entries.service';
import { GoalProgressService } from './goal-progress.service';
import { GoalsController } from './goals.controller';
import { GoalsService } from './goals.service';
import { WorkoutActivityListener } from './workout-activity.listener';
import { WorkoutActivitySyncService } from './workout-activity-sync.service';

/**
 * Activity goals, activity entries and goal progress (epic #260: #266, #267,
 * #268). `CheckInsModule` supplies the user's local "today" (Health Profile
 * time zone); `PrismaService` comes from the global `PrismaModule`; the
 * `workout.finished` listener needs only the global `EventEmitterModule`.
 * `GoalProgressService` is exported for the AI Coach (goal moments, weekly
 * review).
 */
@Module({
  imports: [CheckInsModule],
  controllers: [GoalsController, ActivityEntriesController],
  providers: [
    GoalsService,
    ActivityEntriesService,
    GoalProgressService,
    WorkoutActivitySyncService,
    WorkoutActivityListener,
  ],
  exports: [GoalProgressService, WorkoutActivitySyncService],
})
export class ActivityModule {}
