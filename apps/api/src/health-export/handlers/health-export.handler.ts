// =============================================================================
// `health.export`: one user's health data as a file (H7, #191)
// =============================================================================
//
// Enqueued by `HealthExportService.request` (`POST /api/health/exports`) with
// `subjectType: 'user'`, `subjectId: <userId>` and the request on the payload.
// The export id IS the job id: there is no export table. One attempt:
//
//   1. parse the payload (the subject is authoritative for the owner);
//   2. read the selected datasets (`collectHealthExport`): several tables,
//      read-only, no row is ever written by the read;
//   3. stream the rendered file to `exports/<userId>/<jobId>.<ext>`, counting
//      the bytes on the way (the file is never buffered whole);
//   4. in ONE transaction: upsert the `storage_objects` row (owned by the
//      user, so a data reset or factory reset deletes it with the rest of
//      their files) and write `payload.result` on the job (object id, size,
//      row counts, expiry). The status route reads both;
//   5. after commit: audit `health:export:create` (format, datasets, row
//      counts; never a value), record the metrics, notify the user.
//
// IDEMPOTENT. The key is derived from the job id, so a retry overwrites the
// same object and upserts the same row. A failure deletes whatever bytes were
// written (best effort) and rethrows for the queue to retry; on the LAST
// attempt the user is told it failed.
//
// SERVER-ONLY (no `nodeResultSchema`/`persistNodeResult`), deliberately: it
// reads several tables mid-computation, and its input is a user's health
// record, which a worker node must not receive (CLAUDE.md queue rule 2).
//
// ⚠ Never log a value, a file name or a URL: ids, formats and counts only.
// =============================================================================

import { PassThrough, Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import type { Job, Prisma } from '@prisma/client';
import { z } from 'zod';

import { AppMetricsService, fallbackAppMetrics } from '../../common/otel/app-metrics.service';
import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { NotificationsService } from '../../notifications/notifications.service';
import type { HealthExportNotificationData } from '../../notifications/channels/browser-notification.channel';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageConfigService } from '../../storage/config/storage-config.service';
import { STORAGE_PROVIDER, type StorageProvider } from '../../storage/providers/storage-provider.interface';
import { collectHealthExport } from '../health-export-data';
import {
  HEALTH_EXPORT_AUDIT_ACTION,
  HEALTH_EXPORT_AUDIT_TARGET,
  HEALTH_EXPORT_FAILED_EVENT,
  HEALTH_EXPORT_FILE_TYPES,
  HEALTH_EXPORT_JOB_TYPE,
  HEALTH_EXPORT_OBJECT_SOURCE,
  HEALTH_EXPORT_READY_EVENT,
  HEALTH_EXPORT_RETENTION_MS,
  healthExportFileName,
  healthExportKey,
} from '../health-export.constants';
import { healthExportJobPayloadSchema, type HealthExportResult } from '../dto/health-export.dto';
import { renderHealthExport } from '../writers';

/** The handler's own view of the payload: the request plus, once done, `result`. */
type Payload = z.infer<typeof healthExportJobPayloadSchema>;

@Injectable()
export class HealthExportHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(HealthExportHandler.name);

  /** PERMANENT once jobs of this type exist. */
  readonly type = HEALTH_EXPORT_JOB_TYPE;

  /** A long history is a few hundred thousand rows; two tries, then tell the user. */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 15 * 60 * 1000, maxAttempts: 2 };

  /** Overridable clock, for tests. */
  now: () => Date = () => new Date();

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    private readonly storageConfig: StorageConfigService,
    private readonly notifications: NotificationsService,
    @Optional() private readonly metrics: AppMetricsService = fallbackAppMetrics(),
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const startedAt = Date.now();
    const payload = this.parse(job);
    const span = trace.getActiveSpan();
    span?.setAttribute('health.export.format', payload.format);
    span?.setAttribute('health.export.datasets', payload.datasets.join(','));

    if (payload.result) {
      // An earlier attempt committed the file but the job did not settle.
      this.logger.log(`Health export ${job.id} already produced; nothing to do`);
      return;
    }

    let result: HealthExportResult;
    try {
      result = await this.produce(job, payload);
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      this.metrics.healthExportSettled(payload.format, 'failed', durationMs);
      this.logger.error(
        `Health export ${job.id} (${payload.format}) failed on attempt ${job.attempts}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      if (job.attempts >= this.profile.maxAttempts) {
        this.notify(HEALTH_EXPORT_FAILED_EVENT, payload.userId, job.id, payload.format);
      }
      throw error;
    }

    const durationMs = Date.now() - startedAt;
    span?.setAttribute('health.export.size_bytes', result.sizeBytes);
    this.metrics.healthExportSettled(payload.format, 'completed', durationMs, result.sizeBytes);
    await this.audit(payload, job.id, result);
    this.notify(HEALTH_EXPORT_READY_EVENT, payload.userId, job.id, payload.format);
    this.logger.log(
      `Health export ${job.id} (${payload.format}) ready: ${result.sizeBytes} byte(s), ` +
        `${Object.values(result.rowCounts).reduce((sum, n) => sum + n, 0)} row(s) in ${durationMs} ms`,
    );
  }

  /** Steps 2 to 4. Returns the committed result. */
  async produce(job: Job, payload: Payload): Promise<HealthExportResult> {
    const now = this.now();
    const data = await collectHealthExport(
      this.prisma,
      {
        userId: payload.userId,
        from: payload.from,
        to: payload.to,
        datasets: payload.datasets,
        includeHistory: payload.includeHistory,
        labUnits: payload.labUnits,
      },
      now,
    );

    const { ext, mimeType } = HEALTH_EXPORT_FILE_TYPES[payload.format];
    const storageKey = healthExportKey(payload.userId, job.id, ext);
    const fileName = healthExportFileName(payload.from, payload.to, payload.format);

    let sizeBytes: number;
    let bucket: string;
    try {
      ({ sizeBytes, bucket } = await this.upload(storageKey, renderHealthExport(data, payload.format), mimeType));
    } catch (error) {
      await this.deleteQuietly(storageKey);
      throw error;
    }

    const expiresAt = new Date(now.getTime() + HEALTH_EXPORT_RETENTION_MS);
    const storageProvider = await this.storageConfig.activeProvider();

    try {
      return await this.prisma.$transaction(async (tx) => {
        const object = await tx.storageObject.upsert({
          where: { storageKey },
          create: {
            name: fileName,
            size: BigInt(sizeBytes),
            mimeType,
            storageKey,
            storageProvider,
            bucket,
            status: 'ready',
            uploadedById: payload.userId,
            metadata: { source: HEALTH_EXPORT_OBJECT_SOURCE, exportId: job.id, format: payload.format },
          },
          update: { size: BigInt(sizeBytes), status: 'ready', bucket, storageProvider },
          select: { id: true },
        });

        const result: HealthExportResult = {
          storageObjectId: object.id,
          fileName,
          mimeType,
          sizeBytes,
          rowCounts: data.rowCounts,
          completedAt: now.toISOString(),
          expiresAt: expiresAt.toISOString(),
        };

        await tx.job.update({
          where: { id: job.id },
          data: { payload: { ...stripResult(job.payload), result } as Prisma.InputJsonValue },
        });

        return result;
      });
    } catch (error) {
      await this.deleteQuietly(storageKey);
      throw error;
    }
  }

  private parse(job: Job): Payload {
    const payload = healthExportJobPayloadSchema.parse(job.payload);
    if (job.subjectId !== payload.userId) {
      throw new Error(`Invalid ${HEALTH_EXPORT_JOB_TYPE} job ${job.id}: payload userId does not match the subject`);
    }
    return payload;
  }

  /** Streams `source` to `key`, counting bytes; rejects if either side fails. */
  private async upload(key: string, source: Readable, mimeType: string): Promise<{ sizeBytes: number; bucket: string }> {
    let sizeBytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sizeBytes += chunk.length;
        callback(null, chunk);
      },
    });
    const body = new PassThrough();

    const [, uploaded] = await Promise.all([
      pipeline(source, counter, body),
      this.storage.upload(key, body, { mimeType }).catch((error: unknown) => {
        // The provider gave up: stop the producer instead of letting it stall.
        source.destroy(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }),
    ]);

    return { sizeBytes, bucket: uploaded.bucket };
  }

  private async deleteQuietly(key: string): Promise<void> {
    try {
      await this.storage.delete(key);
    } catch (error) {
      this.logger.warn(
        `Could not delete a partial health export object: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Best effort: the file is committed; an audit failure must not fail it. */
  private async audit(payload: Payload, exportId: string, result: HealthExportResult): Promise<void> {
    try {
      await this.prisma.auditEvent.create({
        data: {
          actorUserId: payload.userId,
          action: HEALTH_EXPORT_AUDIT_ACTION,
          targetType: HEALTH_EXPORT_AUDIT_TARGET,
          targetId: exportId,
          meta: {
            format: payload.format,
            datasets: payload.datasets,
            includeHistory: payload.includeHistory,
            rowCounts: result.rowCounts,
            sizeBytes: result.sizeBytes,
          } as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      this.logger.error(
        `Could not audit ${HEALTH_EXPORT_AUDIT_ACTION} for export ${exportId}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  /** Detached and never rejects (`NotificationsService.notify`); outside any transaction. */
  private notify(eventKey: string, userId: string, exportId: string, format: string): void {
    const data: HealthExportNotificationData = { exportId, format };
    void this.notifications.notify(eventKey, userId, data);
  }
}

/** The payload without an earlier `result` (a stale one never survives a rewrite). */
function stripResult(payload: Prisma.JsonValue | null): Prisma.JsonObject {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const { result: _result, ...rest } = payload as Prisma.JsonObject;
  return rest;
}
