import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job } from '@prisma/client';

import type { JobExecutionProfile } from '../../../jobs/job-execution-profile';
import type { JobHandler } from '../../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../../jobs/job-handler.registry';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  TRAINING_RUN_CHECKPOINT_RETENTION_DAYS,
  TRAINING_RUN_EVENT_RETENTION_DAYS,
  TRAINING_RUN_RETENTION_DAYS,
  TRAINING_RUNS_PURGE_BATCH_SIZE,
  TRAINING_RUNS_PURGE_MAX_BATCHES,
  daysAgo,
} from '../training-retention';
import { TERMINAL_RUN_STATUSES } from '../training-runs.constants';

// =============================================================================
// `training.runs.purge`: deletes finished training runs' detail past retention
// =============================================================================
//
// Global housekeeping, enqueued daily by `TrainingRunsPurgeTask` through
// `enqueueHousekeepingJob`. Server-only (it reads several tables). In batches
// of 5,000 ids, by the exact ids read:
//
//   1. `training_run_events` of runs finished more than 30 days ago;
//   2. checkpoint rows of runs finished more than 30 days ago, and of runs
//      that no longer exist (older than 30 days);
//   3. `training_plan_runs` rows finished more than 365 days ago.
//
// Only FINISHED runs are touched: a queued, running, paused or interrupted run
// keeps everything it needs to continue.
// =============================================================================

/** The job type. PERMANENT once rows of it exist. */
export const TRAINING_RUNS_PURGE_TYPE = 'training.runs.purge';

@Injectable()
export class TrainingRunsPurgeHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(TrainingRunsPurgeHandler.name);

  readonly type = TRAINING_RUNS_PURGE_TYPE;

  readonly profile: JobExecutionProfile = { maxRuntimeMs: 30 * 60_000, maxAttempts: 3 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  /** Throws to fail (a database error), so the queue's retry applies. */
  async process(job: Job, now: Date = new Date()): Promise<void> {
    const events = await this.purgeEvents(daysAgo(TRAINING_RUN_EVENT_RETENTION_DAYS, now));
    const checkpoints = await this.purgeCheckpoints(daysAgo(TRAINING_RUN_CHECKPOINT_RETENTION_DAYS, now));
    const runs = await this.purgeRuns(daysAgo(TRAINING_RUN_RETENTION_DAYS, now));

    this.logger.log(
      `Training runs purge removed ${events} event(s), the checkpoints of ${checkpoints} run(s) ` +
        `and ${runs} run(s) (job ${job.id})`,
    );
  }

  private finishedBefore(cutoff: Date) {
    return { status: { in: [...TERMINAL_RUN_STATUSES] }, completedAt: { lt: cutoff } };
  }

  private async purgeEvents(cutoff: Date): Promise<number> {
    let deleted = 0;

    for (let batch = 0; batch < TRAINING_RUNS_PURGE_MAX_BATCHES; batch += 1) {
      const rows = await this.prisma.trainingRunEvent.findMany({
        where: { run: this.finishedBefore(cutoff) },
        select: { id: true },
        take: TRAINING_RUNS_PURGE_BATCH_SIZE,
      });
      if (rows.length === 0) break;

      const result = await this.prisma.trainingRunEvent.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
      deleted += result.count;

      if (rows.length < TRAINING_RUNS_PURGE_BATCH_SIZE) break;
    }

    return deleted;
  }

  private async purgeCheckpoints(cutoff: Date): Promise<number> {
    let threads = 0;
    const terminal = [...TERMINAL_RUN_STATUSES];

    for (let batch = 0; batch < TRAINING_RUNS_PURGE_MAX_BATCHES; batch += 1) {
      // Threads (run ids) with checkpoints whose run finished before the
      // cutoff, or whose run is gone and whose checkpoints are that old.
      const rows = await this.prisma.$queryRaw<Array<{ thread_id: string }>>`
        SELECT DISTINCT c.thread_id
          FROM training_run_checkpoints c
          LEFT JOIN training_plan_runs r ON r.id::text = c.thread_id
         WHERE (r.id IS NULL AND c.created_at < ${cutoff})
            OR (r.status = ANY(${terminal}::text[]) AND r.completed_at < ${cutoff})
         LIMIT ${TRAINING_RUNS_PURGE_BATCH_SIZE}`;
      if (rows.length === 0) break;

      const ids = rows.map((row) => row.thread_id);
      await this.prisma.$transaction([
        this.prisma.trainingRunCheckpointWrite.deleteMany({ where: { threadId: { in: ids } } }),
        this.prisma.trainingRunCheckpoint.deleteMany({ where: { threadId: { in: ids } } }),
      ]);
      threads += ids.length;

      if (rows.length < TRAINING_RUNS_PURGE_BATCH_SIZE) break;
    }

    return threads;
  }

  private async purgeRuns(cutoff: Date): Promise<number> {
    let deleted = 0;

    for (let batch = 0; batch < TRAINING_RUNS_PURGE_MAX_BATCHES; batch += 1) {
      const rows = await this.prisma.trainingPlanRun.findMany({
        where: this.finishedBefore(cutoff),
        select: { id: true },
        take: TRAINING_RUNS_PURGE_BATCH_SIZE,
      });
      if (rows.length === 0) break;

      const result = await this.prisma.trainingPlanRun.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
      deleted += result.count;

      if (rows.length < TRAINING_RUNS_PURGE_BATCH_SIZE) break;
    }

    return deleted;
  }
}
