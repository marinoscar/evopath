import { Module } from '@nestjs/common';

import { HealthProfileModule } from '../health-profile/health-profile.module';
import { CheckInsController } from './check-ins.controller';
import { CheckInsService } from './check-ins.service';

/**
 * The daily readiness check-in (E2.4, #56), stored on the `measurements`
 * table. `HealthProfileModule` supplies the time zone that decides "today";
 * `PrismaService` comes from the global `PrismaModule`. `CheckInsService` is
 * exported so later features (E5, today's workout) read readiness with
 * `getToday(userId)` / `getForDate(userId, date)` without HTTP.
 */
@Module({
  imports: [HealthProfileModule],
  controllers: [CheckInsController],
  providers: [CheckInsService],
  exports: [CheckInsService],
})
export class CheckInsModule {}
