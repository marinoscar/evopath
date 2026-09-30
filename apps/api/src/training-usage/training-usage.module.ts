import { Module } from '@nestjs/common';

import { AiConfigModule } from '../ai/config/ai-config.module';
import { SettingsModule } from '../settings/settings.module';
import { TrainingUsageController } from './training-usage.controller';
import { TrainingUsageService } from './training-usage.service';

/**
 * Training agent usage (E6.3): tokens, requests, model and key source per run
 * (by node and role, with the token cap) and per month (by role, model, key
 * source and run kind), read from `ai_usage_events` joined to the caller's
 * `training_plan_runs`. Read-only; no currency (there is no price catalog).
 * `AiConfigModule` provides `AiEnabledGuard`; `SettingsModule` the usage
 * retention (`ai.usageRetentionDays`).
 */
@Module({
  imports: [AiConfigModule, SettingsModule],
  controllers: [TrainingUsageController],
  providers: [TrainingUsageService],
})
export class TrainingUsageModule {}
