// =============================================================================
// Daily workout adaptations retention scheduler
// =============================================================================
//
// THIS TASK DELETES NOTHING. It enqueues one global `training.adaptations.purge`
// job through the shared housekeeping helper; `AdaptationsPurgeHandler` does
// the deleting on a worker slot. Pinned by
// `apps/api/test/jobs/cron-enqueue-only.spec.ts`.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { enqueueHousekeepingJob } from '../../jobs/housekeeping.enqueue';
import { JobsService } from '../../jobs/jobs.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ADAPTATIONS_PURGE_CRON, ADAPTATIONS_PURGE_JOB_TYPE } from '../adaptation.constants';

@Injectable()
export class AdaptationsPurgeTask {
  private readonly logger = new Logger(AdaptationsPurgeTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron(ADAPTATIONS_PURGE_CRON) // '20 3 * * *'
  async handleCron(): Promise<void> {
    await enqueueHousekeepingJob({
      jobs: this.jobs,
      prisma: this.prisma,
      logger: this.logger,
      type: ADAPTATIONS_PURGE_JOB_TYPE,
      what: 'workout adaptations purge',
    });
  }
}
