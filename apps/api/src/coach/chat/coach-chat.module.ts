import { Module } from '@nestjs/common';

import { ActivityModule } from '../../activity/activity.module';
import { AiAssignmentsModule } from '../../ai/assignments/ai-assignments.module';
import { AiConfigModule } from '../../ai/config/ai-config.module';
import { AiRuntimeModule } from '../../ai/runtime/ai-runtime.module';
import { CheckInsModule } from '../../check-ins/check-ins.module';
import { HealthProfileModule } from '../../health-profile/health-profile.module';
import { HealthSummaryModule } from '../../health-summary/health-summary.module';
import { BiomarkersService } from '../../measurements/biomarkers/biomarkers.service';
import { MemoryModule } from '../../memory/memory.module';
import { ProgramsModule } from '../../programs/programs.module';
import { ProgressPhotosModule } from '../../progress-photos/progress-photos.module';
import { SettingsModule } from '../../settings/settings.module';
import { WorkoutsModule } from '../../workouts/workouts.module';
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
    // `get_health_summary` (#327): the consent-gated `HealthSummaryReader`.
    HealthSummaryModule,
    // User memory (#325): the memory block, the memory tools and the extraction enqueue.
    MemoryModule,
    ProgramsModule,
    ProgressPhotosModule,
    SettingsModule,
    // The workout tools' PRs and exercise records (#338): `WorkoutHistoryService`.
    WorkoutsModule,
  ],
  controllers: [CoachChatController],
  // `CoachSettingsService` (stateless) backs the `save_commitment` tool (E7.12).
  // `BiomarkersService` (stateless, Prisma only) backs `list_biomarkers` (#327); provided here
  // rather than importing `MeasurementsModule`, which would pull in the intake and lab-report jobs.
  providers: [CoachChatService, CoachChatMetrics, CoachTimelineService, CoachSettingsService, BiomarkersService],
})
export class CoachChatModule {}
