// =============================================================================
// `health.export.purge`: erases export files older than 7 days (H7, #191)
// =============================================================================
//
// Queued once a day by `HealthExportPurgeTask` (a `@Cron` that only enqueues,
// through `enqueueHousekeepingJob`). One run deletes every `storage_objects`
// row under `exports/` created more than `HEALTH_EXPORT_RETENTION_DAYS` ago:
// the provider's bytes first, then the row. A provider failure keeps that row
// (so the next run retries it), is counted, and fails the run after the rest
// were processed, so the queue retries.
//
// Rows, not a bucket listing: the storage interface has no list operation,
// and the row is what makes the file findable (the export's status route
// reads it). Once the row is gone the export reads `expired`.
//
// SERVER-ONLY: deleting objects from this deployment's storage is a privilege
// a worker node must never hold.
// =============================================================================

import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job } from '@prisma/client';

import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { STORAGE_PROVIDER, type StorageProvider } from '../../storage/providers/storage-provider.interface';
import { EXPORTS_KEY_PREFIX } from '../../storage/storage-key-prefixes';
import { HEALTH_EXPORT_PURGE_JOB_TYPE, HEALTH_EXPORT_RETENTION_MS } from '../health-export.constants';

/** Rows read per batch. */
export const HEALTH_EXPORT_PURGE_BATCH = 200;

export interface HealthExportPurgeResult {
  deleted: number;
  failed: number;
}

@Injectable()
export class HealthExportPurgeHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(HealthExportPurgeHandler.name);

  /** PERMANENT once jobs of this type exist. */
  readonly type = HEALTH_EXPORT_PURGE_JOB_TYPE;

  readonly profile: JobExecutionProfile = { maxRuntimeMs: 30 * 60 * 1000, maxAttempts: 3 };

  /** Overridable clock, for tests. */
  now: () => Date = () => new Date();

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const { deleted, failed } = await this.purge();
    this.logger.log(`Health export purge ${job.id}: ${deleted} file(s) deleted, ${failed} failed`);

    if (failed > 0) {
      throw new Error(`${failed} expired health export file(s) could not be deleted; the run will be retried`);
    }
  }

  async purge(): Promise<HealthExportPurgeResult> {
    const cutoff = new Date(this.now().getTime() - HEALTH_EXPORT_RETENTION_MS);
    const failedIds: string[] = [];
    let deleted = 0;

    for (;;) {
      const batch = await this.prisma.storageObject.findMany({
        where: {
          storageKey: { startsWith: EXPORTS_KEY_PREFIX },
          createdAt: { lt: cutoff },
          ...(failedIds.length > 0 ? { id: { notIn: failedIds } } : {}),
        },
        select: { id: true, storageKey: true },
        orderBy: { createdAt: 'asc' },
        take: HEALTH_EXPORT_PURGE_BATCH,
      });

      if (batch.length === 0) break;

      for (const object of batch) {
        try {
          await this.storage.delete(object.storageKey);
          await this.prisma.storageObject.deleteMany({ where: { id: object.id } });
          deleted += 1;
        } catch (error) {
          failedIds.push(object.id);
          this.logger.warn(
            `Could not delete expired health export object ${object.id}: ` +
              (error instanceof Error ? error.message : String(error)),
          );
        }
      }
    }

    return { deleted, failed: failedIds.length };
  }
}
