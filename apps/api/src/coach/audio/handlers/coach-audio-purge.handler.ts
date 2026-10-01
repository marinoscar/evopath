// =============================================================================
// `coach.audio.purge`: coach voice-note retention (E7.6, #246; spec §3.2, §3.4)
// =============================================================================
//
// Enqueued once a day by `CoachAudioPurgeTask` through
// `enqueueHousekeepingJob` (global, single-flight). Two passes:
//
//   1. RETENTION. Every coach message whose audio object is older than the
//      system `coach.audioRetentionDays` (by the message's `createdAt`):
//      the storage object is deleted through `ObjectsService.delete` (bytes,
//      row and audit event) unless another feature still holds it
//      (`StorageObjectReferences`), then the message is set
//      `audioStatus = 'none'`, `audioStorageObjectId = null` and
//      `data.audioPurgedAt`. THE TEXT IS KEPT. A storage error is logged by
//      id and the row is left untouched, so the next run retries it.
//   2. SAFETY NET. A message still `pending` audio, undelivered, written more
//      than 10 minutes ago (the 2-minute wait cap job was lost) gets a
//      `timeout` settle job, which records the text fallback and delivers.
//
// SERVER-ONLY: it deletes stored objects; a worker node never holds storage
// credentials for that. PROFILE `{ maxRuntimeMs: 10 min, maxAttempts: 2 }`;
// the loop stops on a time budget below that and the next day continues.
//
// ⚠ Ids only in logs.
// =============================================================================

import { ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit, Optional } from '@nestjs/common';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Job, Prisma } from '@prisma/client';

import { AppMetricsService, fallbackAppMetrics } from '../../../common/otel/app-metrics.service';
import { resolveServiceName } from '../../../common/otel/service-name';
import { StorageObjectReferences } from '../../../intake/storage-object-references';
import type { JobExecutionProfile } from '../../../jobs/job-execution-profile';
import type { JobHandler } from '../../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../../jobs/job-handler.registry';
import { PrismaService } from '../../../prisma/prisma.service';
import { SystemSettingsService } from '../../../settings/system-settings/system-settings.service';
import { ObjectsService } from '../../../storage/objects/objects.service';
import { COACH_AUDIO_PURGE_JOB_TYPE } from '../../coach-job-types';
import { COACH_AUDIO_STALE_PENDING_MS, CoachAudioService, mergeData } from '../coach-audio.service';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Rows read per batch. */
export const COACH_AUDIO_PURGE_BATCH = 100;
/** Stop starting new batches after this long (the profile allows 10 minutes). */
const TIME_BUDGET_MS = 8 * 60_000;
/** Stuck messages re-queued per run. */
const STALE_PENDING_LIMIT = 500;

export interface CoachAudioPurgeResult {
  purged: number;
  failed: number;
  stalePending: number;
}

@Injectable()
export class CoachAudioPurgeHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(CoachAudioPurgeHandler.name);

  readonly type = COACH_AUDIO_PURGE_JOB_TYPE;

  readonly profile: JobExecutionProfile = { maxRuntimeMs: 600_000, maxAttempts: 2 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
    private readonly objects: ObjectsService,
    private readonly references: StorageObjectReferences,
    private readonly audio: CoachAudioService,
    @Optional() private readonly metrics: AppMetricsService = fallbackAppMetrics(),
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    await this.run(new Date(), job.id);
  }

  async run(now: Date, jobId = 'manual'): Promise<CoachAudioPurgeResult> {
    const tracer = trace.getTracer(resolveServiceName());
    return tracer.startActiveSpan('coach.audio.purge', async (span) => {
      try {
        const policy = await this.systemSettings.getCoachPolicy();
        const cutoff = new Date(now.getTime() - policy.audioRetentionDays * DAY_MS);
        span.setAttribute('coach.audio.retention_days', policy.audioRetentionDays);

        const { purged, failed } = await this.purgeOlderThan(cutoff, now);
        const stalePending = await this.requeueStalePending(now);

        this.metrics.coachAudioPurge(purged);
        span.setAttributes({
          'coach.audio.purged': purged,
          'coach.audio.purge_failed': failed,
          'coach.audio.stale_pending': stalePending,
        });
        this.logger.log(
          `Coach audio purge job ${jobId}: ${purged} purged, ${failed} kept after an error, ` +
            `${stalePending} stuck message(s) re-queued (retention ${policy.audioRetentionDays} day(s))`,
        );
        return { purged, failed, stalePending };
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  private async purgeOlderThan(cutoff: Date, now: Date): Promise<{ purged: number; failed: number }> {
    const started = Date.now();
    let purged = 0;
    let failed = 0;
    let cursor: { createdAt: Date; id: string } | null = null;

    while (Date.now() - started < TIME_BUDGET_MS) {
      const where: Prisma.CoachMessageWhereInput = {
        audioStorageObjectId: { not: null },
        createdAt: { lt: cutoff },
        ...(cursor
          ? {
              OR: [
                { createdAt: { gt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { gt: cursor.id } },
              ],
            }
          : {}),
      };
      const rows = await this.prisma.coachMessage.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: COACH_AUDIO_PURGE_BATCH,
        select: { id: true, userId: true, audioStorageObjectId: true, data: true, createdAt: true },
      });
      if (rows.length === 0) break;

      for (const row of rows) {
        if (await this.purgeOne(row, now)) purged += 1;
        else failed += 1;
      }

      const last = rows[rows.length - 1];
      cursor = { createdAt: last.createdAt, id: last.id };
      if (rows.length < COACH_AUDIO_PURGE_BATCH) break;
    }

    return { purged, failed };
  }

  /** One message's audio. False (row untouched) when the object could not be deleted. */
  private async purgeOne(
    row: { id: string; userId: string; audioStorageObjectId: string | null; data: Prisma.JsonValue | null },
    now: Date,
  ): Promise<boolean> {
    const objectId = row.audioStorageObjectId;
    if (!objectId) return true;

    try {
      if (!(await this.references.isReferenced(objectId))) {
        try {
          await this.objects.delete(objectId, row.userId);
        } catch (error) {
          // Already gone, or (never expected) not the message owner's: the
          // message only lets go of it.
          if (!(error instanceof NotFoundException) && !(error instanceof ForbiddenException)) throw error;
        }
      }

      // Deleting the object fires `ON DELETE SET NULL` on this very row, so by
      // now the pointer is usually already null: match it either way, still
      // refusing a row that was re-pointed at a different object meanwhile.
      await this.prisma.coachMessage.updateMany({
        where: { id: row.id, OR: [{ audioStorageObjectId: objectId }, { audioStorageObjectId: null }] },
        data: {
          audioStatus: 'none',
          audioStorageObjectId: null,
          data: mergeData(row.data, { audioPurgedAt: now.toISOString() }),
        },
      });
      return true;
    } catch (error) {
      this.logger.warn(
        `Could not purge the audio object ${objectId} of coach message ${row.id}; kept for the next run: ` +
          (error instanceof Error ? error.name : 'error'),
      );
      return false;
    }
  }

  /** Safety net: a message stuck `pending` past the wait cap gets a `timeout` settle (text fallback). */
  private async requeueStalePending(now: Date): Promise<number> {
    const stale = await this.prisma.coachMessage.findMany({
      where: {
        audioStatus: 'pending',
        deliveredAt: null,
        createdAt: { lt: new Date(now.getTime() - COACH_AUDIO_STALE_PENDING_MS) },
      },
      select: { id: true },
      take: STALE_PENDING_LIMIT,
    });

    let queued = 0;
    for (const { id } of stale) {
      try {
        await this.audio.enqueueSettle(id, 'timeout');
        queued += 1;
      } catch (error) {
        this.logger.warn(`Could not re-queue the stuck coach message ${id}: ${error instanceof Error ? error.name : 'error'}`);
      }
    }
    return queued;
  }
}
