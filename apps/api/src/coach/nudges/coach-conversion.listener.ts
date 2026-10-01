// =============================================================================
// Coach conversion attribution listener (E7.5, #245; spec §2.8)
// =============================================================================
//
//   workout.finished                     -> target `workout`  (24 h)
//   health.data.changed (source check_in) -> target `check_in` (24 h)
//   progress_photo.created (E7.9)         -> target `photo`    (48 h)
//
// Each body is ONE bounded write through `CoachMessagesService
// .recordConversion` (a find and a guarded single-row update): no storage
// I/O, no network (`apps/api/test/jobs/on-event-no-io.spec.ts`). Every event
// is emitted after its write committed. Nothing escapes: a failed
// attribution is a lost data point, never a failed workout.
//
// `progress_photo.created` has no emitter until E7.9 (progress photos); the
// listener is the seam that story emits into.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { HEALTH_DATA_CHANGED_EVENT, type HealthDataChangedEvent } from '../../measurements/health-data-events';
import { WORKOUT_FINISHED_EVENT, type WorkoutFinishedEvent } from '../../workouts/workout-events';
import { PROGRESS_PHOTO_CREATED_EVENT, type CoachConversionTarget, type ProgressPhotoCreatedEvent } from './coach-conversion';
import { CoachMessagesService } from './coach-messages.service';

@Injectable()
export class CoachConversionListener {
  private readonly logger = new Logger(CoachConversionListener.name);

  constructor(private readonly messages: CoachMessagesService) {}

  @OnEvent(WORKOUT_FINISHED_EVENT, { async: true })
  async onWorkoutFinished(event: WorkoutFinishedEvent): Promise<void> {
    await this.attribute(event.userId, 'workout');
  }

  @OnEvent(HEALTH_DATA_CHANGED_EVENT, { async: true })
  async onHealthDataChanged(event: HealthDataChangedEvent): Promise<void> {
    if (event.source !== 'check_in') return;
    await this.attribute(event.userId, 'check_in');
  }

  @OnEvent(PROGRESS_PHOTO_CREATED_EVENT, { async: true })
  async onProgressPhotoCreated(event: ProgressPhotoCreatedEvent): Promise<void> {
    await this.attribute(event.userId, 'photo');
  }

  private async attribute(userId: string, target: CoachConversionTarget): Promise<void> {
    try {
      await this.messages.recordConversion(userId, target, new Date());
    } catch (error) {
      this.logger.warn(`Could not attribute a coach conversion (${target}): ${error instanceof Error ? error.name : 'error'}`);
    }
  }
}
