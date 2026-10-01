import { Module } from '@nestjs/common';

import { AiAssignmentsModule } from '../../ai/assignments/ai-assignments.module';
import { AiConfigModule } from '../../ai/config/ai-config.module';
import { AiRuntimeModule } from '../../ai/runtime/ai-runtime.module';
import { JobsModule } from '../../jobs/jobs.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { ProgramsModule } from '../../programs/programs.module';
import { SettingsModule } from '../../settings/settings.module';
import { CoachContentGuard } from '../guard/coach-content-guard.service';
import { CoachPlanningModule } from '../planning/coach-planning.module';
import { COACH_ANGLE_PICKER, DefaultAnglePicker } from './angle-picker';
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
// - `POST /api/coach/messages/:id/{opened,feedback}` and the conversion
//   listener.
// - `COACH_ANGLE_PICKER`: the angle seam; E7.11 provides `pickAngle` here.
//
// Imported by `CoachModule`, never by `AppModule` directly. `CoachContentGuard`
// is stateless, so this module provides its own instance rather than importing
// its parent.
// =============================================================================

@Module({
  imports: [
    AiAssignmentsModule,
    AiConfigModule,
    AiRuntimeModule,
    JobsModule,
    NotificationsModule,
    ProgramsModule,
    SettingsModule,
    CoachPlanningModule,
  ],
  controllers: [CoachMessagesController],
  providers: [
    CoachContentGuard,
    CoachMessagesService,
    CoachNudgeHandler,
    CoachMessageDeliverHandler,
    CoachConversionListener,
    { provide: COACH_ANGLE_PICKER, useClass: DefaultAnglePicker },
  ],
  exports: [CoachMessagesService],
})
export class CoachNudgesModule {}
