import { Module } from '@nestjs/common';

import { HealthProfileController } from './health-profile.controller';
import { HealthProfileService } from './health-profile.service';

/**
 * The caller's health profile (E2.1, #47). `PrismaService` comes from the
 * global `PrismaModule`. The service is exported so later health features
 * (E2.4 day boundaries) can read `getTimeZone(userId)`.
 */
@Module({
  controllers: [HealthProfileController],
  providers: [HealthProfileService],
  exports: [HealthProfileService],
})
export class HealthProfileModule {}
