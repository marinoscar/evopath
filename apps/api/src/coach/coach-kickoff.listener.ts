// =============================================================================
// The coach's kickoff trigger (E7.12; docs/specs/ai-coach.md §2.5, §2.13)
// =============================================================================
//
//   program.activated  (ProgramsService.activate, after commit) -> ai.coach.nudge (moment `kickoff`)
//
// THE BODY ONLY ENQUEUES (the queue rule; `apps/api/test/jobs/on-event-no-io.spec.ts`
// scans it): no read, no state write, no AI. The nudge job applies every gate
// (coach off -> nothing; pause, quiet hours, cap, spacing -> deferred, not
// dropped) and its `momentKey` (`kickoff:<programId>`) makes it ONE kickoff
// per program, however often the program is re-activated. Subject = the
// program, so a burst of events collapses onto one pending job. A failure is
// logged with ids and swallowed: activation never depends on the coach.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { PROGRAM_ACTIVATED_EVENT, type ProgramActivatedEvent } from '../programs/program-events';
import { CoachMomentEnqueuer } from './planning/coach-moment-enqueuer';

@Injectable()
export class CoachKickoffListener {
  private readonly logger = new Logger(CoachKickoffListener.name);

  constructor(private readonly enqueuer: CoachMomentEnqueuer) {}

  @OnEvent(PROGRAM_ACTIVATED_EVENT, { async: true })
  async onProgramActivated(event: ProgramActivatedEvent): Promise<void> {
    try {
      await this.enqueuer.enqueueKickoff(event.userId, event.programId);
    } catch (error) {
      this.logger.warn(
        `Could not queue the coach kickoff for program ${event.programId} (user ${event.userId}): ${error instanceof Error ? error.name : 'error'}`,
      );
    }
  }
}
