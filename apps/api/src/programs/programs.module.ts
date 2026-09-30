import { Module } from '@nestjs/common';

import { CheckInsModule } from '../check-ins/check-ins.module';
import { ExercisesModule } from '../exercises/exercises.module';
import { ProgramVersionsController } from './program-versions.controller';
import { ProgramsController } from './programs.controller';
import { ProgramsService } from './programs.service';
import { TrainingTodayController } from './today/training-today.controller';
import { TrainingTodayService } from './today/training-today.service';

/**
 * Training programs (E5.1): the plan tree, immutable versions, the change log
 * and `/api/programs`. `ProgramsService.applyChange` is the single writer of
 * plan content; the plan agents call it rather than writing the tables.
 * Manual only: no AI import, no `AiEnabledGuard`. `PrismaService` comes from
 * the global `PrismaModule`.
 *
 * Today's planned workout (E5.7): `GET /api/training/today`. `CheckInsModule`
 * supplies the server's today in the Health Profile time zone (the window the
 * client's `date` is checked against); `ExercisesModule` supplies gym
 * availability.
 */
@Module({
  imports: [CheckInsModule, ExercisesModule],
  controllers: [ProgramsController, ProgramVersionsController, TrainingTodayController],
  providers: [ProgramsService, TrainingTodayService],
  exports: [ProgramsService],
})
export class ProgramsModule {}
