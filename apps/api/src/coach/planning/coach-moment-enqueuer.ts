import { Injectable, Logger } from '@nestjs/common';

import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { JobsService } from '../../jobs/jobs.service';
import {
  AI_COACH_NUDGE_JOB_TYPE,
  AI_COACH_WEEKLY_REVIEW_JOB_TYPE,
  COACH_PROGRAM_SUBJECT_TYPE,
  COACH_USER_SUBJECT_TYPE,
} from '../coach-job-types';
import { CoachPlanningMetrics } from './coach-planning.metrics';
import type { PlannedMoment } from './plan-coach-moments';

// =============================================================================
// The port to the coach's AI jobs (E7.4)
// =============================================================================
//
// The planner decides; `ai.coach.nudge` (E7.5) and `ai.coach.weekly_review`
// (E7.10) generate. This is the one place that enqueues them, with the user as
// the subject, so the queue's active-dedup index keeps at most one pending or
// running job of each type per user.
//
// ONLY A REGISTERED TYPE IS ENQUEUED. `JobsService.enqueue` accepts any type
// string, and a row nothing can run would sit in the queue until it fails. So
// while a downstream handler is not registered in this process (its story not
// shipped, or a fork removed it) the moment is counted
// `coach.nudge.suppressed{reason: handler_missing}` and nothing is queued; the
// caller then leaves `CoachState` unchanged, so the moment is planned again on
// a later pass.
// =============================================================================

/** `ai.coach.nudge` payload: ids and closed enums only, never content. */
export interface CoachNudgeJobPayload {
  userId: string;
  moment: string;
  /** `<moment>:<localDate>`: the same moment is never sent twice on one local day. */
  momentKey: string;
  /** Every eligible nudge-lane moment of this pass, ranked (the first is `moment`). */
  candidates: Array<{ moment: string; priority: number; reason: string }>;
  trigger: 'sweep' | 'workout_finished';
}

/** `momentKey` of a program's kickoff: one kickoff message per program, ever (E7.12). */
export function kickoffMomentKey(programId: string): string {
  return `kickoff:${programId}`;
}

/** `ai.coach.nudge` payload of a program-activation kickoff (E7.12). Ids only. */
export interface CoachKickoffJobPayload {
  userId: string;
  moment: 'kickoff';
  momentKey: string;
  trigger: 'program_activated';
  programId: string;
}

/** `ai.coach.weekly_review` payload. */
export interface CoachWeeklyReviewJobPayload {
  userId: string;
  isoWeek: string;
}

export type CoachEnqueueOutcome = { status: 'enqueued'; jobId: string } | { status: 'handler_missing' };

@Injectable()
export class CoachMomentEnqueuer {
  private readonly logger = new Logger(CoachMomentEnqueuer.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly registry: JobHandlerRegistry,
    private readonly metrics: CoachPlanningMetrics,
  ) {}

  /** Queues `ai.coach.nudge` for `top`. Throws on a database error. */
  async enqueueNudge(
    userId: string,
    top: PlannedMoment,
    ranked: readonly PlannedMoment[],
    localDate: string,
    trigger: CoachNudgeJobPayload['trigger'],
  ): Promise<CoachEnqueueOutcome> {
    if (!this.registry.get(AI_COACH_NUDGE_JOB_TYPE)) {
      this.metrics.suppressed('handler_missing', top.moment);
      this.logger.debug(`No ${AI_COACH_NUDGE_JOB_TYPE} handler registered; moment not queued for user ${userId}`);
      return { status: 'handler_missing' };
    }
    const payload: CoachNudgeJobPayload = {
      userId,
      moment: top.moment,
      momentKey: `${top.moment}:${localDate}`,
      candidates: ranked.map((m) => ({ moment: m.moment, priority: m.priority, reason: m.reason })),
      trigger,
    };
    const job = await this.jobs.enqueue({
      type: AI_COACH_NUDGE_JOB_TYPE,
      reason: 'backfill',
      subjectType: COACH_USER_SUBJECT_TYPE,
      subjectId: userId,
      payload: { ...payload },
    });
    this.metrics.momentPlanned(top.moment);
    return { status: 'enqueued', jobId: job.id };
  }

  /**
   * Queues the `kickoff` nudge for a just-activated program (E7.12). Subject
   * (`program`, programId): one pending kickoff per program, never collapsed
   * onto a sweep nudge for the same user. The nudge job applies the gates
   * (coach off, pause, quiet hours, cap, spacing) and DEFERS rather than
   * drops; its `momentKey` check makes it one message per program. Throws on
   * a database error.
   */
  async enqueueKickoff(userId: string, programId: string): Promise<CoachEnqueueOutcome> {
    if (!this.registry.get(AI_COACH_NUDGE_JOB_TYPE)) {
      this.metrics.suppressed('handler_missing', 'kickoff');
      this.logger.debug(`No ${AI_COACH_NUDGE_JOB_TYPE} handler registered; kickoff not queued for user ${userId}`);
      return { status: 'handler_missing' };
    }
    const payload: CoachKickoffJobPayload = {
      userId,
      moment: 'kickoff',
      momentKey: kickoffMomentKey(programId),
      trigger: 'program_activated',
      programId,
    };
    const job = await this.jobs.enqueue({
      type: AI_COACH_NUDGE_JOB_TYPE,
      reason: 'upload',
      subjectType: COACH_PROGRAM_SUBJECT_TYPE,
      subjectId: programId,
      payload: { ...payload },
    });
    this.metrics.momentPlanned('kickoff');
    return { status: 'enqueued', jobId: job.id };
  }

  /** Queues `ai.coach.weekly_review` for `isoWeek`. Throws on a database error. */
  async enqueueWeeklyReview(userId: string, isoWeek: string): Promise<CoachEnqueueOutcome> {
    if (!this.registry.get(AI_COACH_WEEKLY_REVIEW_JOB_TYPE)) {
      this.metrics.suppressed('handler_missing', 'weekly_review');
      this.logger.debug(`No ${AI_COACH_WEEKLY_REVIEW_JOB_TYPE} handler registered; review not queued for user ${userId}`);
      return { status: 'handler_missing' };
    }
    const payload: CoachWeeklyReviewJobPayload = { userId, isoWeek };
    const job = await this.jobs.enqueue({
      type: AI_COACH_WEEKLY_REVIEW_JOB_TYPE,
      reason: 'backfill',
      subjectType: COACH_USER_SUBJECT_TYPE,
      subjectId: userId,
      payload: { ...payload },
    });
    this.metrics.momentPlanned('weekly_review');
    return { status: 'enqueued', jobId: job.id };
  }
}
