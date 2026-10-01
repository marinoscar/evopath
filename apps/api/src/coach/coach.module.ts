import { Module, OnModuleInit } from '@nestjs/common';

import { AiConfigModule } from '../ai/config/ai-config.module';
import { HealthProfileModule } from '../health-profile/health-profile.module';
import { SettingsModule } from '../settings/settings.module';
import { CoachAdminSettingsController } from './admin/coach-admin-settings.controller';
import { CoachSettingsController } from './coach-settings.controller';
import { CoachSettingsService } from './coach-settings.service';
import { CoachContentGuard } from './guard/coach-content-guard.service';
import { assertCoachRegistryComplete } from './personas';

/**
 * The AI Coach (epic E7; docs/specs/ai-coach.md). The root module: later
 * stories add their sub-modules as imports here.
 *
 * E7.2 (#242):
 * - the persona registry (`personas/`) and `resolveRegister`, the single
 *   answer to "is profanity allowed";
 * - `CoachContentGuard`, the content guard every coach-written string passes;
 * - `/api/coach/personas` and `/api/coach/settings` (`ai:use`, behind
 *   `AiEnabledGuard`) and `/api/admin/coach/settings` (`ai_config:*`, not
 *   behind it).
 *
 * The registry is checked at init: a persona missing a moment or an intensity
 * fails the boot, not a request.
 */
@Module({
  imports: [SettingsModule, HealthProfileModule, AiConfigModule],
  controllers: [CoachSettingsController, CoachAdminSettingsController],
  providers: [CoachSettingsService, CoachContentGuard],
  exports: [CoachSettingsService, CoachContentGuard],
})
export class CoachModule implements OnModuleInit {
  onModuleInit(): void {
    assertCoachRegistryComplete();
  }
}
