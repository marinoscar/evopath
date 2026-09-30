// =============================================================================
// Daily temporary gym purge scheduler (E6.2)
// =============================================================================
//
// THIS TASK DELETES NOTHING. It enqueues one global `gyms.temporary.purge`
// job through the shared housekeeping helper; `TemporaryGymPurgeHandler` does
// the deleting on a worker slot. Pinned by
// `apps/api/test/jobs/cron-enqueue-only.spec.ts`.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { enqueueHousekeepingJob } from '../../jobs/housekeeping.enqueue';
import { JobsService } from '../../jobs/jobs.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TEMPORARY_GYM_PURGE_CRON, TEMPORARY_GYM_PURGE_JOB_TYPE } from '../gyms.constants';

@Injectable()
export class TemporaryGymPurgeTask {
  private readonly logger = new Logger(TemporaryGymPurgeTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron(TEMPORARY_GYM_PURGE_CRON) // '30 3 * * *'
  async handleCron(): Promise<void> {
    await enqueueHousekeepingJob({
      jobs: this.jobs,
      prisma: this.prisma,
      logger: this.logger,
      type: TEMPORARY_GYM_PURGE_JOB_TYPE,
      what: 'temporary gym purge',
    });
  }
}
