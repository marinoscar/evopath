import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job } from '@prisma/client';

import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { MEMORY_PURGE_JOB_TYPE } from '../memory-job-types';

// =============================================================================
// memory.purge: erases deleted and replaced memories past the undo window (#325)
// =============================================================================
//
// Daily, queued by `MemoryPurgeTask` through `enqueueHousekeepingJob`.
// Hard-deletes `user_memories` rows whose status is `deleted` (by
// `deleted_at`) or `superseded` (by `updated_at`, the moment it was replaced)
// older than system `memory.purgeAfterDays`. Batched by id so no statement
// holds locks for long; bounded so a pathological loop stops.
//
// SERVER-ONLY: it writes as it goes (batched deletes against the live
// table), which is the "genuinely cannot" case of the node-eligibility
// posture (CLAUDE.md queue rule 2): there is no result to hand back for the
// server to persist. No content is read or logged, only counts.
// =============================================================================

const BATCH_SIZE = 1000;
const MAX_BATCHES = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class MemoryPurgeHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(MemoryPurgeHandler.name);

  readonly type = MEMORY_PURGE_JOB_TYPE;

  readonly profile: JobExecutionProfile = { maxRuntimeMs: 300_000, maxAttempts: 3 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const deleted = await this.purge(new Date());
    this.logger.log(`Memory purge job ${job.id}: erased ${deleted} memories`);
  }

  /** Erases every expired deleted/superseded memory. Returns how many. */
  async purge(now: Date): Promise<number> {
    const policy = await this.systemSettings.getMemoryPolicy();
    const cutoff = new Date(now.getTime() - policy.purgeAfterDays * DAY_MS);
    let total = 0;

    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const rows = await this.prisma.userMemory.findMany({
        where: {
          OR: [
            { status: 'deleted', deletedAt: { lt: cutoff } },
            { status: 'superseded', updatedAt: { lt: cutoff } },
          ],
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
      });
      if (rows.length === 0) break;
      const result = await this.prisma.userMemory.deleteMany({
        where: {
          id: { in: rows.map((r) => r.id) },
          status: { in: ['deleted', 'superseded'] },
        },
      });
      total += result.count;
      if (rows.length < BATCH_SIZE || result.count === 0) break;
    }
    return total;
  }
}
