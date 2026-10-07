// =============================================================================
// `health.document.purge`: erases a "delete after processing" file (H1, #185)
// =============================================================================
//
// Enqueued by `IntakeService` inside the transaction that applies or
// discards a health intake, one job per `delete_after_processing` document,
// so the intent commits with the apply (or discard) and no worker sees it
// earlier. `HealthDocumentsService.remove` (H6, #190) enqueues it with
// `reason: 'user_delete'` when the user deletes a document's file, inside
// the same transaction that soft-deletes its values when asked. The measurements the apply wrote are never touched here: a purge
// that fails is retried by the queue and the values stay.
//
// One attempt:
//   1. read the document; nothing to do when it is gone (the user was
//      deleted), already purged (`file_deleted_at`), or, for the default
//      reason `delete_after_processing`, no longer marked so. A
//      `user_delete` purge erases the file whatever the retention: the user
//      asked for exactly that;
//   2. hard-delete the storage object through `ObjectsService.delete` (the
//      provider's bytes, then the row; the row's delete sets the document's
//      `storage_object_id` to NULL). An object that is already gone counts as
//      deleted;
//   3. stamp `file_deleted_at` and null `storage_object_id`, conditional on
//      `file_deleted_at IS NULL`, so a duplicate run changes nothing;
//   4. audit `health:document:delete` (ids, counts and the reason only) and
//      count it.
// A throw in 2 or 3 counts a failure and is rethrown: the queue retries.
//
// SERVER-ONLY (no `nodeResultSchema`/`persistNodeResult`), deliberately:
// deleting objects from this deployment's storage provider is a privilege a
// remote machine must never hold, and the work is one delete plus one update,
// with nothing to offload (CLAUDE.md queue rule 2).
//
// ⚠ Never log a file name: ids only.
// =============================================================================

import { Injectable, Logger, NotFoundException, OnModuleInit, Optional } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import type { Job, Prisma } from '@prisma/client';
import { z } from 'zod';

import { EvoPathMetricsService, fallbackEvoPathMetrics } from '../../app-metrics/domain-metrics.service';
import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { ObjectsService } from '../../storage/objects/objects.service';
import {
  HEALTH_DOCUMENT_DELETE_AUDIT_ACTION,
  HEALTH_DOCUMENT_PURGE_JOB_TYPE,
  HEALTH_DOCUMENT_PURGE_REASONS,
  type HealthDocumentPurgeReason,
  HEALTH_DOCUMENT_SUBJECT_TYPE,
  RETENTION_SPAN_ATTRIBUTE,
} from '../health-document.constants';

export const healthDocumentPurgePayloadSchema = z.object({
  healthDocumentId: z.uuid(),
  /** Absent on every job enqueued before H6 (#190): those are `delete_after_processing`. */
  reason: z.enum(HEALTH_DOCUMENT_PURGE_REASONS).default('delete_after_processing'),
});

export type HealthDocumentPurgePayload = z.input<typeof healthDocumentPurgePayloadSchema>;

/** What one run did, for tests and the log line. */
export type HealthDocumentPurgeResult = 'purged' | 'already_purged' | 'missing' | 'kept';

@Injectable()
export class HealthDocumentPurgeHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(HealthDocumentPurgeHandler.name);

  /** PERMANENT once jobs of this type exist. */
  readonly type = HEALTH_DOCUMENT_PURGE_JOB_TYPE;

  /** One small delete: a short ceiling, and enough attempts to ride out a storage outage. */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 5 * 60 * 1000, maxAttempts: 8 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly objects: ObjectsService,
    @Optional() private readonly metrics: EvoPathMetricsService = fallbackEvoPathMetrics(),
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const { healthDocumentId, reason } = healthDocumentPurgePayloadSchema.parse(job.payload);
    const result = await this.purge(healthDocumentId, reason);
    this.logger.log(`Health document ${healthDocumentId}: ${result} (job ${job.id})`);
  }

  async purge(
    healthDocumentId: string,
    reason: HealthDocumentPurgeReason = 'delete_after_processing',
  ): Promise<HealthDocumentPurgeResult> {
    const span = trace.getActiveSpan();
    span?.setAttribute('health.document.id', healthDocumentId);

    const document = await this.prisma.healthDocument.findUnique({
      where: { id: healthDocumentId },
      select: { id: true, userId: true, retention: true, storageObjectId: true, intakeId: true, fileDeletedAt: true },
    });

    if (!document) return 'missing';

    span?.setAttribute(RETENTION_SPAN_ATTRIBUTE, document.retention);

    if (document.fileDeletedAt) return 'already_purged';
    if (reason === 'delete_after_processing' && document.retention !== 'delete_after_processing') return 'kept';

    try {
      if (document.storageObjectId) {
        await this.deleteObject(document.storageObjectId, document.userId);
      }

      const { count } = await this.prisma.healthDocument.updateMany({
        where: { id: document.id, fileDeletedAt: null },
        data: { fileDeletedAt: new Date(), storageObjectId: null, version: { increment: 1 } },
      });

      if (count === 0) return 'already_purged';
    } catch (error) {
      this.metrics.healthDocumentPurge('failed');
      throw error;
    }

    this.metrics.healthDocumentPurge('purged');
    await this.audit(document.userId, document.id, {
      storageObjectId: document.storageObjectId,
      intakeId: document.intakeId,
      files: 1,
      reason,
    });

    return 'purged';
  }

  /** `ObjectsService.delete`; an object that is already gone is the goal reached. */
  private async deleteObject(storageObjectId: string, userId: string): Promise<void> {
    try {
      await this.objects.delete(storageObjectId, userId);
    } catch (error) {
      if (error instanceof NotFoundException) return;
      throw error;
    }
  }

  /** Best effort: the file is gone and stamped; an audit failure must not retry that. */
  private async audit(userId: string, healthDocumentId: string, meta: Record<string, unknown>): Promise<void> {
    try {
      await this.prisma.auditEvent.create({
        data: {
          actorUserId: userId,
          action: HEALTH_DOCUMENT_DELETE_AUDIT_ACTION,
          targetType: HEALTH_DOCUMENT_SUBJECT_TYPE,
          targetId: healthDocumentId,
          meta: meta as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      this.logger.error(
        `Could not audit ${HEALTH_DOCUMENT_DELETE_AUDIT_ACTION} for health document ${healthDocumentId}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}
