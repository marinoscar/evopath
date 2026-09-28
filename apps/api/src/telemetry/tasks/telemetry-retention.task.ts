// =============================================================================
// Daily telemetry retention scheduler (issue #534, epic #528)
// =============================================================================
//
// ⚠ THIS TASK TOUCHES NO DATABASE BUT ITS OWN QUEUE. It enqueues one global
// `telemetry.retention.apply` job through the shared housekeeping helper, and
// `TelemetryRetentionHandler` runs the `ALTER DATABASE` on a worker slot.
// Pinned by `apps/api/test/jobs/cron-enqueue-only.spec.ts`.
//
// Daily re-assertion, not just on save: GreptimeDB may have been recreated
// (a fresh volume starts with no TTL), or the save-time job may have been
// skipped because GreptimeDB was down at that moment. The statement is
// idempotent, so running it every night costs one metadata write.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { enqueueHousekeepingJob } from '../../jobs/housekeeping.enqueue';
import { JobsService } from '../../jobs/jobs.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TELEMETRY_RETENTION_TYPE } from '../handlers/telemetry-retention.handler';

@Injectable()
export class TelemetryRetentionTask {
  private readonly logger = new Logger(TelemetryRetentionTask.name);

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
      type: TELEMETRY_RETENTION_TYPE,
      what: 'telemetry retention',
    });
  }
}
