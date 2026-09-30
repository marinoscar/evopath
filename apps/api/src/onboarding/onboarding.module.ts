import { Module } from '@nestjs/common';

import { AiConfigModule } from '../ai/config/ai-config.module';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

/**
 * First-run onboarding (#203): `GET /api/onboarding`. `PrismaService` comes
 * from the global `PrismaModule`, `DoctorService` from the global
 * `DoctorModule`, `ConfigService` from the global `ConfigModule`; only the AI
 * policy (`AiConfigService.isEnabled`) needs an import.
 */
@Module({
  imports: [AiConfigModule],
  controllers: [OnboardingController],
  providers: [OnboardingService],
})
export class OnboardingModule {}
