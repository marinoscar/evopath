import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { CheckInsModule } from '../check-ins/check-ins.module';
import { GymsModule } from '../gyms/gyms.module';
import { IntakeModule } from '../intake/intake.module';
import { JobsModule } from '../jobs/jobs.module';
import { StorageModule } from '../storage/storage.module';
import { WorkoutPhotoObjectReferences } from './intake/workout-photo-references';
import { WorkoutPrefillIntakeKind } from './intake/workout-prefill.intake-kind';
import { ExerciseVocabularyService } from './prefill/exercise-vocabulary';
import { WorkoutPrefillHandler } from './prefill/workout-prefill.handler';
import { QuickCardioService } from './quick-cardio.service';
import { WorkoutEntriesService } from './workout-entries.service';
import { WorkoutHistoryService } from './workout-history.service';
import { WorkoutPhotoStorageService } from './workout-photo-storage.service';
import { WorkoutsController } from './workouts.controller';
import { WorkoutsService } from './workouts.service';

/**
 * Workout logging (E4.2): workouts, their exercises and sets under
 * `workouts:read`/`workouts:write`. Weights are stored and served in
 * kilograms, distances in metres.
 *
 * `CheckInsModule` supplies `CheckInsService` (today's date in the profile
 * time zone and the readiness snapshot taken at start); `GymsModule` supplies
 * `GymsService` (the owner check on a gym); `StorageModule` supplies
 * `ObjectsService` (deleting a removed workout's photos). `PrismaService`
 * comes from the global `PrismaModule`. The services are exported for
 * progress tracking and programs (E4.4+, E5): `WorkoutHistoryService` (last
 * time, records, PRs) backs `GET /api/exercises/:id/history`, so
 * `ExercisesModule` imports this module; this module never imports
 * `ExercisesModule` (exercises are read with Prisma directly).
 *
 * "Prefill from photo" (E4.5): the `workout_prefill` intake kind
 * (`IntakeModule`) and its server-only analyzer job `ai.workout.prefill`
 * (`JobsModule` for the registry, `AiModule` for `AiService`), plus a
 * `StorageObjectReferences` checker so discarding an intake never deletes an
 * object that is a workout photo. The manual routes never touch AI and work
 * with AI off.
 *
 * Quick cardio (E8 F4): `QuickCardioService` logs a finished gym-free walk,
 * run or hike and links it to the active plan's planned workout of that day.
 * It reads the plan with the pure helpers of `programs/` (rows, live tree,
 * `resolveToday`) and never injects a programs provider, so this module still
 * does not import `ProgramsModule` (which imports this one).
 */
@Module({
  imports: [CheckInsModule, GymsModule, StorageModule, AiModule, JobsModule, IntakeModule],
  controllers: [WorkoutsController],
  providers: [
    WorkoutsService,
    WorkoutEntriesService,
    WorkoutHistoryService,
    WorkoutPhotoStorageService,
    QuickCardioService,
    ExerciseVocabularyService,
    WorkoutPrefillIntakeKind,
    WorkoutPhotoObjectReferences,
    WorkoutPrefillHandler,
  ],
  exports: [WorkoutsService, WorkoutEntriesService, WorkoutHistoryService],
})
export class WorkoutsModule {}
