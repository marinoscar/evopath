import { Module } from '@nestjs/common';

import { CredentialsModule } from '../../credentials/credentials.module';
import { JobsModule } from '../../jobs/jobs.module';
import { SettingsModule } from '../../settings/settings.module';
import { AiCoreModule } from '../core/ai-core.module';
import { AiCatalogRefreshHandler } from './ai-catalog-refresh.handler';
import { AiCatalogRefreshTask } from './ai-catalog-refresh.task';
import { AiCatalogService } from './ai-catalog.service';

/**
 * The AI model catalog (issue #427, epic #419): discovery + classification
 * into `ai_models`, the server-only `ai.catalog.refresh` job, and its daily
 * enqueue-only cron. `AiCatalogService` is exported for the admin config API
 * (#428), which queues a refresh on demand.
 */
@Module({
  imports: [AiCoreModule, JobsModule, CredentialsModule, SettingsModule],
  providers: [AiCatalogService, AiCatalogRefreshHandler, AiCatalogRefreshTask],
  exports: [AiCatalogService],
})
export class AiCatalogModule {}
