// =============================================================================
// `ai.catalog.refresh` job handler (issue #427, epic #419)
// =============================================================================
//
// Runs `AiCatalogService.sync` for the one provider named in the payload.
// Enqueued by the daily `AiCatalogRefreshTask` and by the admin "refresh
// models" route (#428), both with payload `{ providerId }`, subjectType
// `'ai_provider'`, subjectId `providerId`.
//
// SERVER-ONLY, PERMANENTLY. No `nodeResultSchema`/`persistNodeResult`: the
// sync talks to the provider with the deployment's ADMIN key, and no AI key
// may ever be brokered to a worker node (docs/specs/ai-platform.md §2.20).
//
// KILL SWITCH. When AI (or this provider) has been turned off since the job
// was queued, the sync reports `skipped` and this handler RETURNS NORMALLY:
// the platform being off is an expected outcome, not a failure, so it must
// neither burn an attempt nor fire `jobs.job_failed`.
//
// RATE LIMITS. `AiError('AI_RATE_LIMITED')` is rethrown as the queue's
// `RateLimitError`, so a provider throttle defers the job instead of charging
// one of its attempts.
// =============================================================================

import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job } from '@prisma/client';
import { z } from 'zod';

import { JobExecutionProfile } from '../../jobs/job-execution-profile';
import { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { AiError } from '../core/ai-error';
import {
  AI_CATALOG_REFRESH_TYPE,
  AiCatalogService,
  isCatalogSyncSkipped,
} from './ai-catalog.service';
import { AI_CATALOG_SYNCED_EVENT, type AiCatalogSyncedEvent } from './ai-catalog.events';

/** What a refresh job carries. `actorUserId` is present only for an admin-requested refresh. */
export const aiCatalogRefreshPayloadSchema = z.object({
  providerId: z.string().min(1),
  actorUserId: z.string().uuid().optional(),
});

export type AiCatalogRefreshPayload = z.infer<typeof aiCatalogRefreshPayloadSchema>;

@Injectable()
export class AiCatalogRefreshHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(AiCatalogRefreshHandler.name);

  readonly type = AI_CATALOG_REFRESH_TYPE;

  /** One `listModels` round trip plus one transaction: five minutes is generous. */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 5 * 60_000, maxAttempts: 3 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly catalog: AiCatalogService,
    @Optional() private readonly events?: EventEmitter2,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const parsed = aiCatalogRefreshPayloadSchema.safeParse(job.payload);

    if (!parsed.success) {
      throw new Error(`Invalid ${AI_CATALOG_REFRESH_TYPE} payload: expected { providerId }`);
    }

    const { providerId, actorUserId } = parsed.data;

    let result;

    try {
      result = await this.catalog.sync(providerId, { actorUserId, jobId: job.id });
    } catch (error) {
      if (error instanceof AiError) {
        throw error.toRateLimitError() ?? error;
      }

      throw error;
    }

    if (isCatalogSyncSkipped(result)) {
      this.logger.log(
        `Catalog refresh for "${providerId}" skipped (${result.skipped}); job ${job.id} is a no-op`,
      );

      return;
    }

    this.logger.log(
      `Catalog refresh for "${providerId}" done: ${result.total} listed, ` +
        `${result.added} added, ${result.updated} updated, ${result.deprecated} deprecated`,
    );

    this.emitSynced({
      providerId,
      added: result.added,
      updated: result.updated,
      deprecated: result.deprecated,
      jobId: job.id,
    });
  }

  /**
   * The exported hook (`ai-catalog.events.ts`). Wrapped because
   * `EventEmitter2` dispatches synchronously: a listener that throws must not
   * turn a committed sync into a failed job.
   */
  private emitSynced(event: AiCatalogSyncedEvent): void {
    try {
      this.events?.emit(AI_CATALOG_SYNCED_EVENT, event);
    } catch (error) {
      this.logger.error(
        `An ${AI_CATALOG_SYNCED_EVENT} listener threw for "${event.providerId}"; the sync is ` +
          `unaffected: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
