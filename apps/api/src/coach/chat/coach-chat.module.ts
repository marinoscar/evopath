import { Module } from '@nestjs/common';

import { ActivityModule } from '../../activity/activity.module';
import { AiAssignmentsModule } from '../../ai/assignments/ai-assignments.module';
import { AiConfigModule } from '../../ai/config/ai-config.module';
import { AiRuntimeModule } from '../../ai/runtime/ai-runtime.module';
import { CheckInsModule } from '../../check-ins/check-ins.module';
import { HealthProfileModule } from '../../health-profile/health-profile.module';
import { ProgramsModule } from '../../programs/programs.module';
import { ProgressPhotosModule } from '../../progress-photos/progress-photos.module';
import { SettingsModule } from '../../settings/settings.module';
import { CoachSettingsService } from '../coach-settings.service';
import { CoachChatController } from './coach-chat.controller';
import { CoachChatMetrics } from './coach-chat.metrics';
import { CoachChatService } from './coach-chat.service';
import { CoachTimelineService } from './coach-timeline.service';

// =============================================================================
// CoachChatModule (E7.7, #247): the coach chat and the timeline read
// =============================================================================
//
// `POST /api/coach/chat/stream` and `GET /api/coach/messages`. Every model
// call goes through `AiService.forUser` (AI rule 1); the model comes from
// `AiFeatureModelResolver` for `coach.chat`. Imported by `CoachModule`.
// =============================================================================

@Module({
  imports: [
    ActivityModule,
    AiAssignmentsModule,
    AiConfigModule,
    AiRuntimeModule,
    CheckInsModule,
    HealthProfileModule,
    ProgramsModule,
    ProgressPhotosModule,
    SettingsModule,
  ],
  controllers: [CoachChatController],
  // `CoachSettingsService` (stateless) backs the `save_commitment` tool (E7.12).
  providers: [CoachChatService, CoachChatMetrics, CoachTimelineService, CoachSettingsService],
})
export class CoachChatModule {}
