// =============================================================================
// Workout auto-credit trigger (#267)
// =============================================================================
//
//   workout.finished (WorkoutsService.finish, after commit) -> syncWorkout
//
// A bounded write (at most four rows of one workout), not long-running work,
// so it runs here rather than as a job (docs/specs/job-queue.md, "All
// long-running work is a job": bounded single-workout writes are outside the
// rule). A failure is logged with ids and swallowed: finishing a workout never
// depends on goals, and the next progress read reconciles anyway.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { WORKOUT_FINISHED_EVENT, type WorkoutFinishedEvent } from '../workouts/workout-events';
import { WorkoutActivitySyncService } from './workout-activity-sync.service';

@Injectable()
export class WorkoutActivityListener {
  private readonly logger = new Logger(WorkoutActivityListener.name);

  constructor(private readonly sync: WorkoutActivitySyncService) {}

  @OnEvent(WORKOUT_FINISHED_EVENT, { async: true })
  async onWorkoutFinished(event: WorkoutFinishedEvent): Promise<void> {
    try {
      await this.sync.syncWorkout(event.userId, event.workoutId);
    } catch (error) {
      this.logger.warn(
        `Could not credit activity for workout ${event.workoutId} (user ${event.userId}): ${error instanceof Error ? error.name : 'error'}`,
      );
    }
  }
}
