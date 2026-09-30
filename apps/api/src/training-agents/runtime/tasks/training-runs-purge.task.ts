// =============================================================================
// Daily training runs retention scheduler
// =============================================================================
//
// THIS TASK DELETES NOTHING. It enqueues one global `training.runs.purge` job
// through the shared housekeeping helper; `TrainingRunsPurgeHandler` does the
// deleting on a worker slot. Pinned by `apps/api/test/jobs/cron-enqueue-only.spec.ts`.
// 05:30: after `ai.usage.purge` at 05:00, so the purges never share a minute.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { enqueueHousekeepingJob } from '../../../jobs/housekeeping.enqueue';
import { JobsService } from '../../../jobs/jobs.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { TRAINING_RUNS_PURGE_TYPE } from '../handlers/training-runs-purge.handler';
import { TRAINING_RUNS_PURGE_CRON } from '../training-retention';

@Injectable()
export class TrainingRunsPurgeTask {
  private readonly logger = new Logger(TrainingRunsPurgeTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron(TRAINING_RUNS_PURGE_CRON)
  async handleCron(): Promise<void> {
    await enqueueHousekeepingJob({
      jobs: this.jobs,
      prisma: this.prisma,
      logger: this.logger,
      type: TRAINING_RUNS_PURGE_TYPE,
      what: 'training runs purge',
    });
  }
}
