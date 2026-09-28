import { Module } from '@nestjs/common';

import { JobsModule } from '../../jobs/jobs.module';
import { SettingsModule } from '../../settings/settings.module';
import { AiConfigModule } from '../config/ai-config.module';
import { AiCoreModule } from '../core/ai-core.module';
import { AiUsageAdminController } from './ai-usage-admin.controller';
import { AiUsageController } from './ai-usage.controller';
import { AiUsagePurgeHandler } from './ai-usage-purge.handler';
import { AiUsagePurgeTask } from './ai-usage-purge.task';
import { AiUsageService } from './ai-usage.service';

// =============================================================================
// AiUsageModule (issue #443, epic #420)
// =============================================================================
//
// Reads `ai_usage_events` (written by `AiUsageRecorder`, #432): the admin and
// per-user aggregate reports. `AiConfigModule` is here for `AiEnabledGuard`;
// `AiCoreModule` for provider display names.
//
// Also retention: the server-only `ai.usage.purge` job and its daily,
// enqueue-only cron (`ai.usageRetentionDays`, default 180).
// =============================================================================

@Module({
  imports: [AiCoreModule, AiConfigModule, JobsModule, SettingsModule],
  controllers: [AiUsageAdminController, AiUsageController],
  providers: [AiUsageService, AiUsagePurgeHandler, AiUsagePurgeTask],
  exports: [AiUsageService],
})
export class AiUsageModule {}
