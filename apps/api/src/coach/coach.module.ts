import { Module, OnModuleInit } from '@nestjs/common';

import { AiConfigModule } from '../ai/config/ai-config.module';
import { HealthProfileModule } from '../health-profile/health-profile.module';
import { SettingsModule } from '../settings/settings.module';
import { CoachAdminSettingsController } from './admin/coach-admin-settings.controller';
import { CoachAdminStatsController } from './admin/coach-admin-stats.controller';
import { CoachAdminStatsService } from './admin/coach-admin-stats.service';
import { CoachChatModule } from './chat/coach-chat.module';
import { CoachSettingsController } from './coach-settings.controller';
import { CoachSettingsService } from './coach-settings.service';
import { CoachContentGuard } from './guard/coach-content-guard.service';
import { CoachNudgesModule } from './nudges/coach-nudges.module';
import { CoachReviewModule } from './review/coach-review.module';
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
 * E7.7 (#247): `CoachChatModule` — `POST /api/coach/chat/stream` and
 * `GET /api/coach/messages`.
 * E7.5 (#245): `CoachNudgesModule` (`nudges/`): `ai.coach.nudge`,
 * `coach.message.deliver`, the opened/feedback routes and conversion.
 * E7.11 (#251): the angle bandit (`learning/`, bound in `CoachNudgesModule`)
 * and `GET /api/admin/coach/stats` (`ai_config:read`, not behind
 * `AiEnabledGuard`).
 * E7.10 (#250): `CoachReviewModule` (`review/`): `ai.coach.weekly_review`
 * and the weekly streak.
 *
 * The registry is checked at init: a persona missing a moment or an intensity
 * fails the boot, not a request.
 */
@Module({
  imports: [SettingsModule, HealthProfileModule, AiConfigModule, CoachChatModule, CoachNudgesModule, CoachReviewModule],
  controllers: [CoachSettingsController, CoachAdminSettingsController, CoachAdminStatsController],
  providers: [CoachSettingsService, CoachContentGuard, CoachAdminStatsService],
  exports: [CoachSettingsService, CoachContentGuard],
})
export class CoachModule implements OnModuleInit {
  onModuleInit(): void {
    assertCoachRegistryComplete();
  }
}
