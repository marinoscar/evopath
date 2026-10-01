import { Module } from '@nestjs/common';

import { ActivityModule } from '../../activity/activity.module';
import { AiAssignmentsModule } from '../../ai/assignments/ai-assignments.module';
import { AiConfigModule } from '../../ai/config/ai-config.module';
import { AiRuntimeModule } from '../../ai/runtime/ai-runtime.module';
import { JobsModule } from '../../jobs/jobs.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { ProgramsModule } from '../../programs/programs.module';
import { SettingsModule } from '../../settings/settings.module';
import { CoachAudioModule } from '../audio/coach-audio.module';
import { CoachContentGuard } from '../guard/coach-content-guard.service';
import { CoachPlanningModule } from '../planning/coach-planning.module';
import { AngleStatsService } from '../learning/angle-stats.service';
import { BanditAnglePicker } from '../learning/bandit-angle-picker';
import { COACH_ANGLE_PICKER } from './angle-picker';
import { CoachConversionListener } from './coach-conversion.listener';
import { CoachMessagesController } from './coach-messages.controller';
import { CoachMessagesService } from './coach-messages.service';
import { CoachMessageDeliverHandler } from './handlers/coach-message-deliver.handler';
import { CoachNudgeHandler } from './handlers/coach-nudge.handler';

// =============================================================================
// CoachNudgesModule (E7.5, #245): generation, delivery and feedback
// =============================================================================
//
// - `ai.coach.nudge` (`CoachNudgeHandler`): generate, guard, persist. Its
//   registration is what turns on `CoachMomentEnqueuer` (E7.4), which only
//   enqueues a type a handler is registered for.
// - `coach.message.deliver` (`CoachMessageDeliverHandler`): `notifyNow`,
//   `deliveredAt`, `CoachState` counters.
// - `POST /api/coach/messages/:id/{opened,feedback}`, `GET|POST
//   /api/coach/messages/:id/audio` (on-demand Listen, #259, served by
//   `CoachMessageAudioService` from `CoachAudioModule`) and the conversion
//   listener.
// - `COACH_ANGLE_PICKER`: the angle seam. E7.11 (#251) binds
//   `BanditAnglePicker` (`learning/`), which falls back to
//   `DefaultAnglePicker` when it cannot run.
// - `CoachAudioModule` (E7.6, #259): on-demand message audio, its settle and retention.
//
// Imported by `CoachModule`, never by `AppModule` directly. `CoachContentGuard`
// is stateless, so this module provides its own instance rather than importing
// its parent.
// =============================================================================

@Module({
  imports: [
    ActivityModule,
    AiAssignmentsModule,
    AiConfigModule,
    AiRuntimeModule,
    JobsModule,
    NotificationsModule,
    ProgramsModule,
    SettingsModule,
    CoachPlanningModule,
    CoachAudioModule,
  ],
  controllers: [CoachMessagesController],
  providers: [
    CoachContentGuard,
    CoachMessagesService,
    CoachNudgeHandler,
    CoachMessageDeliverHandler,
    CoachConversionListener,
    AngleStatsService,
    { provide: COACH_ANGLE_PICKER, useClass: BanditAnglePicker },
  ],
  exports: [CoachMessagesService],
})
export class CoachNudgesModule {}
