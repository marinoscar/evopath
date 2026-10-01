import { Module } from '@nestjs/common';

import { SleepController } from './sleep.controller';
import { SleepService } from './sleep.service';

/**
 * The caller's sleep sessions (epic #276, #278): `/api/sleep` under
 * `health_data:*`. Rows are written by the Health Connect sync
 * (`HealthSyncModule`); `PrismaService` comes from the global `PrismaModule`.
 */
@Module({
  controllers: [SleepController],
  providers: [SleepService],
})
export class SleepModule {}
