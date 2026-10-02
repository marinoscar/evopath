import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { enqueueHousekeepingJob } from '../../jobs/housekeeping.enqueue';
import { JobsService } from '../../jobs/jobs.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MEMORY_PURGE_JOB_TYPE } from '../memory-job-types';

// =============================================================================
// MemoryPurgeTask: the daily `memory.purge` enqueue (#325)
// =============================================================================
//
// Decides nothing beyond "it is time" and queues the global housekeeping job
// (CLAUDE.md: a `@Cron` only enqueues; `test/jobs/cron-enqueue-only.spec.ts`).
// =============================================================================

@Injectable()
export class MemoryPurgeTask {
  private readonly logger = new Logger(MemoryPurgeTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async handleCron(): Promise<void> {
    await enqueueHousekeepingJob({
      jobs: this.jobs,
      prisma: this.prisma,
      logger: this.logger,
      type: MEMORY_PURGE_JOB_TYPE,
      what: 'memory purge',
    });
  }
}
