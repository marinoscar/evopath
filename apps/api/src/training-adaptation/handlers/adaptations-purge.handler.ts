// =============================================================================
// `training.adaptations.purge`: deletes workout adaptations past `expires_at`
// =============================================================================
//
// Enqueued once a day by `AdaptationsPurgeTask`, which only enqueues
// (CLAUDE.md, "Every Long-Running Activity Is a Queue Job"). BATCHED, oldest
// first: each batch reads at most 5,000 ids and deletes exactly those ids, so
// no single statement holds locks on a large slice of the table. A run that
// dies half way has done fewer batches; the next continues from the same
// cutoff (idempotent). `expires_at` is `created_at + 30 days`, set by the
// service. The kit's own run, event and checkpoint retention
// (`training.runs.purge`) is not touched here.
//
// Server-only by default (no node members): a table sweep of this server's
// database, and not an `ai.*` type (no model call, not gated on the kill
// switch: retention is data hygiene).
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job } from '@prisma/client';

import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ADAPTATIONS_PURGE_BATCH_SIZE,
  ADAPTATIONS_PURGE_JOB_TYPE,
  ADAPTATIONS_PURGE_MAX_BATCHES,
} from '../adaptation.constants';

@Injectable()
export class AdaptationsPurgeHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(AdaptationsPurgeHandler.name);

  /** PERMANENT once jobs of this type exist. */
  readonly type = ADAPTATIONS_PURGE_JOB_TYPE;

  /** Deletes only; retried like any housekeeping job. */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 15 * 60_000, maxAttempts: 3 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  /** Throws to fail (a database error), so the queue's retry applies. */
  async process(job: Job): Promise<void> {
    await this.purge(new Date(), job.id);
  }

  /** Deletes every adaptation with `expires_at < now`, in batches; returns the rows deleted. */
  async purge(now: Date, jobId = 'direct'): Promise<number> {
    let deleted = 0;
    let batches = 0;

    for (; batches < ADAPTATIONS_PURGE_MAX_BATCHES; batches += 1) {
      const rows = await this.prisma.workoutAdaptation.findMany({
        where: { expiresAt: { lt: now } },
        select: { id: true },
        orderBy: { expiresAt: 'asc' },
        take: ADAPTATIONS_PURGE_BATCH_SIZE,
      });
      if (rows.length === 0) break;

      // By the exact ids read, never by re-running the `where`.
      const result = await this.prisma.workoutAdaptation.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
      deleted += result.count;

      if (rows.length < ADAPTATIONS_PURGE_BATCH_SIZE) {
        batches += 1;
        break;
      }
    }

    if (batches >= ADAPTATIONS_PURGE_MAX_BATCHES) {
      this.logger.warn(
        `Adaptations purge stopped at its ${ADAPTATIONS_PURGE_MAX_BATCHES}-batch safety limit after deleting ` +
          `${deleted} row(s); the next run continues.`,
      );
    }

    this.logger.log(`Adaptations purge removed ${deleted} expired adaptation(s) in ${batches} batch(es) (job ${jobId})`);
    return deleted;
  }
}
