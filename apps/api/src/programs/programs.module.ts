import { Module } from '@nestjs/common';

import { ProgramVersionsController } from './program-versions.controller';
import { ProgramsController } from './programs.controller';
import { ProgramsService } from './programs.service';

/**
 * Training programs (E5.1): the plan tree, immutable versions, the change log
 * and `/api/programs`. `ProgramsService.applyChange` is the single writer of
 * plan content; the plan agents call it rather than writing the tables.
 * Manual only: no AI import, no `AiEnabledGuard`. `PrismaService` comes from
 * the global `PrismaModule`.
 */
@Module({
  controllers: [ProgramsController, ProgramVersionsController],
  providers: [ProgramsService],
  exports: [ProgramsService],
})
export class ProgramsModule {}
