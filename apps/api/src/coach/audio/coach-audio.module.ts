import { Module } from '@nestjs/common';

import { AiAssignmentsModule } from '../../ai/assignments/ai-assignments.module';
import { AiConfigModule } from '../../ai/config/ai-config.module';
import { AiRuntimeModule } from '../../ai/runtime/ai-runtime.module';
import { IntakeModule } from '../../intake/intake.module';
import { JobsModule } from '../../jobs/jobs.module';
import { SettingsModule } from '../../settings/settings.module';
import { StorageModule } from '../../storage/storage.module';
import { CoachAudioSettledListener } from './coach-audio-settled.listener';
import { CoachAudioService } from './coach-audio.service';
import { CoachPreviewRateLimiter } from './coach-preview-rate-limiter';
import { CoachVoicePreviewService } from './coach-voice-preview.service';
import { CoachVoiceController } from './coach-voice.controller';
import { CoachAudioPurgeHandler } from './handlers/coach-audio-purge.handler';
import { CoachAudioSettleHandler } from './handlers/coach-audio-settle.handler';
import { CoachAudioPurgeTask } from './tasks/coach-audio-purge.task';

// =============================================================================
// CoachAudioModule (E7.6, #246): the coach's voice
// =============================================================================
//
// - `CoachAudioService`: `coach.voice` resolution, `speak()` for a pending
//   message, settle and the text fallback. Exported for `ai.coach.nudge` and
//   `coach.message.deliver` (`CoachNudgesModule`).
// - `CoachAudioSettledListener` (`job.settled` of `ai.audio.speech`, enqueue
//   only) and `coach.audio.settle`.
// - `coach.audio.purge` and its daily cron (enqueue only).
// - `POST /api/coach/voice-preview` (`ai:use`, `AiEnabledGuard`, rate limit).
//
// Every job here is server-only. `IntakeModule` supplies
// `StorageObjectReferences`, `StorageModule` `ObjectsService` (the purge's
// deletion path). Imported by `CoachNudgesModule`.
// =============================================================================

@Module({
  imports: [
    AiAssignmentsModule,
    AiConfigModule,
    AiRuntimeModule,
    IntakeModule,
    JobsModule,
    SettingsModule,
    StorageModule,
  ],
  controllers: [CoachVoiceController],
  providers: [
    CoachAudioService,
    CoachAudioSettledListener,
    CoachAudioSettleHandler,
    CoachAudioPurgeHandler,
    CoachAudioPurgeTask,
    CoachPreviewRateLimiter,
    CoachVoicePreviewService,
  ],
  exports: [CoachAudioService],
})
export class CoachAudioModule {}
