import { Module } from '@nestjs/common';

import { AiConfigModule } from '../ai/config/ai-config.module';
import { SettingsModule } from '../settings/settings.module';
import { OnboardingAdminController } from './onboarding-admin.controller';
import { OnboardingMetricsService } from './onboarding-metrics.service';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

/**
 * First-run onboarding (#203): `GET /api/onboarding`; activation metrics
 * (#212): `GET /api/admin/onboarding/metrics`. `PrismaService` comes
 * from the global `PrismaModule`, `DoctorService` from the global
 * `DoctorModule`, `ConfigService` from the global `ConfigModule`; only the AI
 * policy (`AiConfigService.isEnabled`) and the coach switch
 * (`SystemSettingsService.getCoachPolicy`, E7.12) need an import.
 */
@Module({
  imports: [AiConfigModule, SettingsModule],
  controllers: [OnboardingController, OnboardingAdminController],
  providers: [OnboardingService, OnboardingMetricsService],
})
export class OnboardingModule {}
