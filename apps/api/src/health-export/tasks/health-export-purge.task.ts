// =============================================================================
// HealthExportPurgeTask: queues the daily expiry of export files (H7, #191)
// =============================================================================
//
// A `@Cron` decides and enqueues, nothing more (CLAUDE.md queue rule 1;
// `test/jobs/cron-enqueue-only.spec.ts`). The deleting is
// `health.export.purge`'s work, on a worker slot, retried by the queue.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { enqueueHousekeepingJob } from '../../jobs/housekeeping.enqueue';
import { JobsService } from '../../jobs/jobs.service';
import { PrismaService } from '../../prisma/prisma.service';
import { HEALTH_EXPORT_PURGE_JOB_TYPE } from '../health-export.constants';

@Injectable()
export class HealthExportPurgeTask {
  private readonly logger = new Logger(HealthExportPurgeTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async handleCron(): Promise<void> {
    await enqueueHousekeepingJob({
      jobs: this.jobs,
      prisma: this.prisma,
      logger: this.logger,
      type: HEALTH_EXPORT_PURGE_JOB_TYPE,
      what: 'health export expiry',
    });
  }
}
