import { Module } from '@nestjs/common';

import { CheckInsModule } from '../check-ins/check-ins.module';
import { GymsModule } from '../gyms/gyms.module';
import { WorkoutEntriesService } from './workout-entries.service';
import { WorkoutHistoryService } from './workout-history.service';
import { WorkoutsController } from './workouts.controller';
import { WorkoutsService } from './workouts.service';

/**
 * Workout logging (E4.2): workouts, their exercises and sets under
 * `workouts:read`/`workouts:write`. Weights are stored and served in
 * kilograms, distances in metres.
 *
 * `CheckInsModule` supplies `CheckInsService` (today's date in the profile
 * time zone and the readiness snapshot taken at start); `GymsModule` supplies
 * `GymsService` (the owner check on a gym). `PrismaService` comes from the
 * global `PrismaModule`. Manual only; no AI import. The services are exported
 * for progress tracking and programs (E4.4+, E5): `WorkoutHistoryService`
 * (last time, records, PRs) backs `GET /api/exercises/:id/history`, so
 * `ExercisesModule` imports this module; this module never imports
 * `ExercisesModule`.
 */
@Module({
  imports: [CheckInsModule, GymsModule],
  controllers: [WorkoutsController],
  providers: [WorkoutsService, WorkoutEntriesService, WorkoutHistoryService],
  exports: [WorkoutsService, WorkoutEntriesService, WorkoutHistoryService],
})
export class WorkoutsModule {}
