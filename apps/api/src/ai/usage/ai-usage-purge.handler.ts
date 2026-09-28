// =============================================================================
// `ai.usage.purge` job handler (issue #443, epic #420)
// =============================================================================
//
// Deletes `ai_usage_events` rows older than `ai.usageRetentionDays` (default
// 180), in batches. Enqueued once a day by `AiUsagePurgeTask`, which only
// enqueues (CLAUDE.md, "Every Long-Running Activity Is a Queue Job").
//
// BATCHED, oldest first: each batch reads at most `AI_USAGE_PURGE_BATCH_SIZE`
// ids and deletes exactly those ids, so no single statement holds locks on a
// large slice of a table the runtime inserts into on every provider call. A run
// that dies half way has simply done fewer batches; the next run continues
// from the same cutoff, so the handler is idempotent.
//
// NOT GATED ON THE KILL SWITCH. Retention is a data-hygiene policy, not AI
// usage: a deployment that switched AI off still wants old accounting rows to
// age out. The job makes no provider call and reads no key.
//
// SERVER-ONLY, like every `ai.*` type (docs/specs/ai-platform.md §2.20): no
// `nodeResultSchema`/`persistNodeResult`.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job } from '@prisma/client';

import { JobExecutionProfile } from '../../jobs/job-execution-profile';
import { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';

/** The job type. PERMANENT once rows of it exist. */
export const AI_USAGE_PURGE_TYPE = 'ai.usage.purge';

/** Rows per batch — a lock-duration bound, not a throughput knob. */
export const AI_USAGE_PURGE_BATCH_SIZE = 5000;

/**
 * Safety stop on the batch loop (5 million rows a run). The loop's exit
 * depends on rows disappearing; a bounded loop stops having done real work if
 * that ever stops being true, and the next day's run continues.
 */
export const AI_USAGE_PURGE_MAX_BATCHES = 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class AiUsagePurgeHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(AiUsagePurgeHandler.name);

  readonly type = AI_USAGE_PURGE_TYPE;

  /** Deletes only; thirty minutes covers millions of rows. Retried like any housekeeping job. */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 30 * 60_000, maxAttempts: 3 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  /** Throws to fail (a database error), so the queue's retry applies. */
  async process(job: Job): Promise<void> {
    const { usageRetentionDays } = await this.systemSettings.getAiPolicy();
    const cutoff = new Date(Date.now() - usageRetentionDays * DAY_MS);

    let deleted = 0;
    let batches = 0;

    for (; batches < AI_USAGE_PURGE_MAX_BATCHES; batches += 1) {
      const rows = await this.prisma.aiUsageEvent.findMany({
        where: { createdAt: { lt: cutoff } },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: AI_USAGE_PURGE_BATCH_SIZE,
      });

      if (rows.length === 0) break;

      // By the exact ids read, never by re-running the `where`.
      const result = await this.prisma.aiUsageEvent.deleteMany({
        where: { id: { in: rows.map((row) => row.id) } },
      });

      deleted += result.count;

      if (rows.length < AI_USAGE_PURGE_BATCH_SIZE) {
        batches += 1;
        break;
      }
    }

    if (batches >= AI_USAGE_PURGE_MAX_BATCHES) {
      this.logger.warn(
        `AI usage purge stopped at its ${AI_USAGE_PURGE_MAX_BATCHES}-batch safety limit after ` +
          `deleting ${deleted} row(s); the next run continues from the same cutoff.`,
      );
    }

    this.logger.log(
      `AI usage purge removed ${deleted} event(s) recorded before ${cutoff.toISOString()} ` +
        `(retention ${usageRetentionDays} day(s)) in ${batches} batch(es) (job ${job.id})`,
    );
  }
}
