import { Module } from '@nestjs/common';

import { GymsModule } from '../gyms/gyms.module';
import { WorkoutsModule } from '../workouts/workouts.module';
import { ExerciseAvailabilityService } from './exercise-availability.service';
import { ExerciseUsageRepository } from './exercise-usage.repository';
import { ExercisesController } from './exercises.controller';
import { ExercisesService } from './exercises.service';

/**
 * Exercises (E4.1): the seeded exercise library plus each user's custom
 * exercises under `exercises:read`/`exercises:write`, and which of them a gym
 * supports (`ExerciseAvailabilityService`).
 *
 * `GymsModule` supplies `GymsService` (the owner check on a gym);
 * `WorkoutsModule` supplies `WorkoutHistoryService` for
 * `GET /api/exercises/:id/history` (E4.4; `workouts:read`). The dependency
 * points one way only: `WorkoutsModule` never imports this module.
 * `PrismaService` comes from the global `PrismaModule`. Manual only; no AI
 * import. Exports the services for workout logging and the planner (E4.2+, E5):
 * `ExercisesService.proposeFromAi` stores an AI-proposed draft.
 */
@Module({
  imports: [GymsModule, WorkoutsModule],
  controllers: [ExercisesController],
  providers: [ExercisesService, ExerciseAvailabilityService, ExerciseUsageRepository],
  exports: [ExercisesService, ExerciseAvailabilityService, ExerciseUsageRepository],
})
export class ExercisesModule {}
