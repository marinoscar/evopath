import { Module } from '@nestjs/common';

import { JobsModule } from '../jobs/jobs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { HealthExportPurgeHandler } from './handlers/health-export-purge.handler';
import { HealthExportHandler } from './handlers/health-export.handler';
import { HealthExportController } from './health-export.controller';
import { HealthExportService } from './health-export.service';
import { HealthExportPurgeTask } from './tasks/health-export-purge.task';

/**
 * Health data export (H7, #191): `/api/health/exports` under
 * `health_data:read`, the server-only `health.export` job that writes the file
 * to `exports/<userId>/<exportId>.<ext>`, and the daily `health.export.purge`
 * (queued by a cron that only enqueues) that removes files after 7 days.
 */
@Module({
  imports: [JobsModule, StorageProvidersModule, NotificationsModule],
  controllers: [HealthExportController],
  providers: [HealthExportService, HealthExportHandler, HealthExportPurgeHandler, HealthExportPurgeTask],
})
export class HealthExportModule {}
