import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job } from '@prisma/client';

import { AiConfigService } from '../../../ai/config/ai-config.service';
import { fromDbDate } from '../../../check-ins/local-date';
import type { JobExecutionProfile } from '../../../jobs/job-execution-profile';
import type { JobHandler } from '../../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../../jobs/job-handler.registry';
import { PrismaService } from '../../../prisma/prisma.service';
import { TrainingSignalsService } from '../../../programs/signals/signals.service';
import { RunEventsService } from '../../runtime/run-events.service';
import { EVALUATION_SWEEP } from '../evaluation.constants';
import {
  isLastWeekOfBlock,
  isMissedSessionsCandidate,
  isMissedSessionsDue,
  isWeeklyDue,
  localWallTime,
} from '../evaluation-due';
import { type EvaluationRequestOutcome, TrainingEvaluationScheduler } from '../training-evaluation.scheduler';

// =============================================================================
// `training.evaluation.sweep`: the hourly safety net of continuous evaluation
// =============================================================================
//
// Enqueued by `TrainingEvaluationTask` (hourly, only while `ai.enabled`)
// through `enqueueHousekeepingJob`. Server-only (it reads several tables and
// creates runs); profile 10 minutes, 3 attempts. One pass:
//
//   1. EXPIRES PROPOSALS. A run `awaiting_approval` past its `expiresAt`
//      becomes `cancelled` (`TRAINING_APPROVAL_EXPIRED`) and its `proposed`
//      change log rows `expired`.
//   2. FINDS DUE PLANS. Pages through active, unpaused programs (keyset on
//      id) and keeps those with something due, in the user's time zone: a
//      weekly review, a deferred `workout_finished` request (the coalescing
//      flag), or a missed-sessions check (once a day per plan, local 06:00).
//      The due plans are served oldest-evaluated first (never evaluated
//      first), at most 200 users and 500 runs (created plus expired) a pass;
//      the rest are first in line next hour.
//   3. ASKS THE SCHEDULER for each: every gate and per-user limit applies,
//      exactly as for a finished workout. Every run it creates is an
//      ordinary `ai.training.plan.run` job.
//
// With AI off the pass does nothing (the task does not even enqueue it).
// =============================================================================

/** The job type. PERMANENT once rows of it exist. */
export const TRAINING_EVALUATION_SWEEP_TYPE = 'training.evaluation.sweep';

/** `training_plan_runs.error_code` of a proposal that expired unanswered. */
export const APPROVAL_EXPIRED_CODE = 'TRAINING_APPROVAL_EXPIRED';

export interface EvaluationSweepSummary {
  aiEnabled: boolean;
  expiredProposals: number;
  scanned: number;
  due: number;
  considered: number;
  created: number;
  deferred: number;
  skipped: number;
  failed: number;
}

interface SweepProgram {
  id: string;
  userId: string;
  startDate: Date | null;
  lastEvaluatedAt: Date | null;
  lastWeeklyEvaluationAt: Date | null;
  evaluationRequestedAt: Date | null;
  user: { healthProfile: { timeZone: string | null } | null };
}

interface DueProgram {
  program: SweepProgram;
  timeZone: string | null;
  weekly: boolean;
  pending: boolean;
  missedCandidate: boolean;
}

@Injectable()
export class TrainingEvaluationSweepHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(TrainingEvaluationSweepHandler.name);

  readonly type = TRAINING_EVALUATION_SWEEP_TYPE;

  readonly profile: JobExecutionProfile = { maxRuntimeMs: 10 * 60_000, maxAttempts: 3 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly aiConfig: AiConfigService,
    private readonly scheduler: TrainingEvaluationScheduler,
    private readonly signals: TrainingSignalsService,
    private readonly events: RunEventsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  /** Throws on a database error so the queue's retry applies; one user's failure only counts. */
  async process(job: Job): Promise<void> {
    await this.sweep(job.id, new Date());
  }

  /** One pass (see the header), as of `now`. */
  async sweep(jobId: string, now: Date): Promise<EvaluationSweepSummary> {
    const summary: EvaluationSweepSummary = {
      aiEnabled: await this.aiConfig.isEnabled(),
      expiredProposals: 0,
      scanned: 0,
      due: 0,
      considered: 0,
      created: 0,
      deferred: 0,
      skipped: 0,
      failed: 0,
    };

    if (!summary.aiEnabled) {
      this.logger.log(`AI is disabled; evaluation sweep ${jobId} did nothing`);
      return summary;
    }

    summary.expiredProposals = await this.expireProposals(now, EVALUATION_SWEEP.maxRuns);

    const { due, scanned } = await this.findDue(now);
    summary.scanned = scanned;
    summary.due = due.length;

    for (const candidate of due.slice(0, EVALUATION_SWEEP.maxUsers)) {
      if (summary.expiredProposals + summary.created >= EVALUATION_SWEEP.maxRuns) break;
      summary.considered += 1;

      try {
        const outcome = await this.evaluate(candidate, now);
        if (!outcome) summary.skipped += 1;
        else if (outcome.status === 'created') summary.created += 1;
        else if (outcome.status === 'deferred') summary.deferred += 1;
        else summary.skipped += 1;
      } catch (error) {
        summary.failed += 1;
        this.logger.warn(
          `Evaluation sweep could not serve program ${candidate.program.id}: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }

    this.logger.log(
      `Evaluation sweep ${jobId}: ${summary.created} run(s) created, ${summary.deferred} deferred, ` +
        `${summary.skipped} skipped, ${summary.failed} failed of ${summary.due} due plan(s) ` +
        `(${summary.scanned} scanned); ${summary.expiredProposals} proposal(s) expired`,
    );
    return summary;
  }

  /** Runs waiting for a decision past `expiresAt`: cancelled, their proposals expired. */
  private async expireProposals(now: Date, limit: number): Promise<number> {
    const runs = await this.prisma.trainingPlanRun.findMany({
      where: { status: 'awaiting_approval', expiresAt: { lt: now } },
      orderBy: { expiresAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    let expired = 0;

    for (const run of runs) {
      const moved = await this.prisma.trainingPlanRun.updateMany({
        where: { id: run.id, status: 'awaiting_approval', expiresAt: { lt: now } },
        data: { status: 'cancelled', completedAt: now, stage: null, errorCode: APPROVAL_EXPIRED_CODE },
      });
      if (moved.count === 0) continue;

      await this.prisma.programChangeLog.updateMany({
        where: { runId: run.id, status: 'proposed' },
        data: { status: 'expired', decidedAt: now },
      });
      await this.events.emit(run.id, 'run.cancelled', {});
      expired += 1;
    }

    return expired;
  }

  /** Active, unpaused plans with something due, oldest-evaluated first. */
  private async findDue(now: Date): Promise<{ due: DueProgram[]; scanned: number }> {
    const due: DueProgram[] = [];
    let scanned = 0;
    let cursor: string | undefined;

    for (let page = 0; page < EVALUATION_SWEEP.maxPages; page += 1) {
      const rows: SweepProgram[] = await this.prisma.program.findMany({
        where: { status: 'active', autonomyPausedAt: null, ...(cursor ? { id: { gt: cursor } } : {}) },
        orderBy: { id: 'asc' },
        take: EVALUATION_SWEEP.pageSize,
        select: {
          id: true,
          userId: true,
          startDate: true,
          lastEvaluatedAt: true,
          lastWeeklyEvaluationAt: true,
          evaluationRequestedAt: true,
          user: { select: { healthProfile: { select: { timeZone: true } } } },
        },
      });
      scanned += rows.length;

      for (const program of rows) {
        const timeZone = program.user.healthProfile?.timeZone ?? null;
        const weekly = isWeeklyDue({
          now,
          timeZone,
          startDate: program.startDate ? fromDbDate(program.startDate) : null,
          lastWeeklyEvaluationAt: program.lastWeeklyEvaluationAt,
        });
        const pending = program.evaluationRequestedAt !== null;
        const missedCandidate = isMissedSessionsCandidate({ now, timeZone, lastEvaluatedAt: program.lastEvaluatedAt });
        if (weekly || pending || missedCandidate) due.push({ program, timeZone, weekly, pending, missedCandidate });
      }

      if (rows.length < EVALUATION_SWEEP.pageSize) break;
      cursor = rows[rows.length - 1].id;
    }

    due.sort((a, b) => {
      const at = a.program.lastEvaluatedAt?.getTime() ?? -Infinity;
      const bt = b.program.lastEvaluatedAt?.getTime() ?? -Infinity;
      return at !== bt ? at - bt : a.program.id < b.program.id ? -1 : 1;
    });

    return { due, scanned };
  }

  /** Weekly first, then a deferred request, then the missed-sessions rule. `null`: nothing was due after all. */
  private async evaluate(candidate: DueProgram, now: Date): Promise<EvaluationRequestOutcome | null> {
    const { program, timeZone } = candidate;

    if (candidate.weekly) {
      const weeks = await this.prisma.programWeek.findMany({
        where: { programId: program.id, archivedAt: null },
        select: { weekNumber: true, blockId: true },
      });
      const today = localWallTime(now, timeZone).date;
      const deep = isLastWeekOfBlock(program.startDate ? fromDbDate(program.startDate) : null, today, weeks);
      return this.scheduler.requestEvaluation(program.userId, 'weekly', { deep, now });
    }

    if (candidate.pending) {
      return this.scheduler.requestEvaluation(program.userId, 'workout_finished', { now });
    }

    const signals = await this.signals.forEvaluator(program.userId, program.id, now);
    if (!isMissedSessionsDue(signals.adherence.missedStreak)) return null;
    return this.scheduler.requestEvaluation(program.userId, 'missed_sessions', { now });
  }
}
