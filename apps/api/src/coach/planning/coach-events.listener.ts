// =============================================================================
// The coach's event triggers (E7.4; docs/specs/ai-coach.md §2.5)
// =============================================================================
//
//   workout.finished  (WorkoutsService.finish, after commit) -> coach.workout_finished job
//
// THE BODY ONLY ENQUEUES (the queue rule; `apps/api/test/jobs/on-event-no-io.spec.ts`
// scans it): no read, no state write, no planning. The job plans the
// `comeback`, `pr` and `weekly_target_hit` moments through the same gates as
// the sweep and clears `silencedAt`. Subject = the user, so a burst collapses
// onto one pending job. `async: true` keeps EventEmitter2's synchronous
// dispatch from waiting on it; nothing escapes, and the hourly sweep is the
// safety net.
//
// `health.data.changed` needs no listener: the safety gate reads readiness
// from the signals service, which computes it on read in every pass.
// Program activation (`kickoff`) belongs to E7.12.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { JobsService } from '../../jobs/jobs.service';
import { WORKOUT_FINISHED_EVENT, type WorkoutFinishedEvent } from '../../workouts/workout-events';
import { COACH_USER_SUBJECT_TYPE, COACH_WORKOUT_FINISHED_JOB_TYPE } from '../coach-job-types';

@Injectable()
export class CoachEventsListener {
  private readonly logger = new Logger(CoachEventsListener.name);

  constructor(private readonly jobs: JobsService) {}

  @OnEvent(WORKOUT_FINISHED_EVENT, { async: true })
  async onWorkoutFinished(event: WorkoutFinishedEvent): Promise<void> {
    try {
      await this.jobs.enqueue({
        type: COACH_WORKOUT_FINISHED_JOB_TYPE,
        reason: 'upload',
        subjectType: COACH_USER_SUBJECT_TYPE,
        subjectId: event.userId,
        payload: { userId: event.userId, workoutId: event.workoutId },
      });
    } catch (error) {
      this.logger.warn(
        `Could not queue coach planning after workout ${event.workoutId}: ${error instanceof Error ? error.name : 'error'}`,
      );
    }
  }
}
