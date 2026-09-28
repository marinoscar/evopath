// =============================================================================
// Daily AI usage retention scheduler (issue #443, epic #420)
// =============================================================================
//
// ⚠ THIS TASK DELETES NOTHING. It enqueues one global `ai.usage.purge` job
// through the shared housekeeping helper, and `AiUsagePurgeHandler` does the
// deleting on a worker slot. Pinned by
// `apps/api/test/jobs/cron-enqueue-only.spec.ts`.
//
// 5am: after the 2am–4am housekeeping crons, so the purges do not queue up
// behind each other at the same minute.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { enqueueHousekeepingJob } from '../../jobs/housekeeping.enqueue';
import { JobsService } from '../../jobs/jobs.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AI_USAGE_PURGE_TYPE } from './ai-usage-purge.handler';

@Injectable()
export class AiUsagePurgeTask {
  private readonly logger = new Logger(AiUsagePurgeTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_5AM)
  async handleCron(): Promise<void> {
    await enqueueHousekeepingJob({
      jobs: this.jobs,
      prisma: this.prisma,
      logger: this.logger,
      type: AI_USAGE_PURGE_TYPE,
      what: 'AI usage purge',
    });
  }
}
