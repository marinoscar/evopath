// =============================================================================
// The evaluation triggers that arrive as events
// =============================================================================
//
//   workout.finished  (WorkoutsService.finish, after commit)  -> requestEvaluation(workout_finished)
//   job.settled       (an `ai.training.plan.run` job ended)   -> onRunSettled (the follow-up rule)
//
// EACH BODY ONLY CALLS THE SCHEDULER, which reads a bounded set of small rows
// and at most inserts one run and enqueues its job (no provider call, no
// storage, no long-running work; `apps/api/test/jobs/on-event-no-io.spec.ts`
// scans these bodies and `workout-finished.listener.spec.ts` pins them).
// `async: true` keeps EventEmitter2's synchronous dispatch from waiting on it,
// and nothing escapes: a failed request costs one log line, and the hourly
// sweep is the safety net.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { JOB_SETTLED_EVENT, type JobSettledEvent } from '../../jobs/events/job-settled.event';
import { WORKOUT_FINISHED_EVENT, type WorkoutFinishedEvent } from '../../workouts/workout-events';
import { TRAINING_RUN_JOB_TYPE, TRAINING_RUN_SUBJECT_TYPE } from '../runtime/training-runs.constants';
import { TrainingEvaluationScheduler } from './training-evaluation.scheduler';

@Injectable()
export class TrainingEvaluationListener {
  private readonly logger = new Logger(TrainingEvaluationListener.name);

  constructor(private readonly scheduler: TrainingEvaluationScheduler) {}

  @OnEvent(WORKOUT_FINISHED_EVENT, { async: true })
  async onWorkoutFinished(event: WorkoutFinishedEvent): Promise<void> {
    try {
      await this.scheduler.requestEvaluation(event.userId, 'workout_finished');
    } catch (error) {
      this.logger.warn(`Could not request an evaluation after workout ${event.workoutId}: ${messageOf(error)}`);
    }
  }

  @OnEvent(JOB_SETTLED_EVENT, { async: true })
  async onRunJobSettled(event: JobSettledEvent): Promise<void> {
    if (event.type !== TRAINING_RUN_JOB_TYPE || event.subjectType !== TRAINING_RUN_SUBJECT_TYPE || !event.subjectId) {
      return;
    }
    try {
      await this.scheduler.onRunSettled(event.subjectId);
    } catch (error) {
      this.logger.warn(`Could not apply the evaluation follow-up after run ${event.subjectId}: ${messageOf(error)}`);
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
