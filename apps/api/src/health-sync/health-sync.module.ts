import { Module } from '@nestjs/common';

import { HealthProfileModule } from '../health-profile/health-profile.module';
import { HealthSyncController } from './health-sync.controller';
import { HealthSyncService } from './health-sync.service';

/**
 * Android Health Connect sync (epic #276, #278): `/api/health-sync` under
 * `goals:*` (measurements and sleep also `health_data:write`).
 * `HealthProfileModule` supplies the user's time zone; `PrismaService` comes
 * from the global `PrismaModule`; events need only the global
 * `EventEmitterModule`.
 */
@Module({
  imports: [HealthProfileModule],
  controllers: [HealthSyncController],
  providers: [HealthSyncService],
})
export class HealthSyncModule {}
