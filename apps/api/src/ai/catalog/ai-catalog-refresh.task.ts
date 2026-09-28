// =============================================================================
// Daily AI catalog refresh scheduler (issue #427, epic #419)
// =============================================================================
//
// ENQUEUE ONLY (CLAUDE.md, "Every Long-Running Activity Is a Queue Job", rule
// 1). This cron reads the `ai` policy to decide WHETHER a refresh is due —
// one per enabled provider — and queues `ai.catalog.refresh`. The provider
// round trip and every write happen in `AiCatalogRefreshHandler`, on the
// queue, with a timeout, retries and a row in the admin job list.
//
// NOT `enqueueHousekeepingJob`: that helper dedups by type alone, and this
// task queues one job PER PROVIDER. `JobsService.enqueue` dedups on type +
// subject, so a provider whose refresh is still pending is not queued twice.
//
// Pinned by `apps/api/test/jobs/cron-enqueue-only.spec.ts`.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { JobsService } from '../../jobs/jobs.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { AI_CATALOG_REFRESH_TYPE, AI_CATALOG_SUBJECT_TYPE } from './ai-catalog.service';

/** Low priority (ascending is more urgent): a background refresh never outranks user work. */
const REFRESH_PRIORITY = 100;

@Injectable()
export class AiCatalogRefreshTask {
  private readonly logger = new Logger(AiCatalogRefreshTask.name);

  constructor(
    private readonly systemSettings: SystemSettingsService,
    private readonly jobs: JobsService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async handleCron(): Promise<void> {
    let providerIds: string[];

    try {
      providerIds = await this.dueProviders();
    } catch (error) {
      this.logger.error(`Could not read the AI policy: ${errorMessage(error)}`);

      return;
    }

    for (const providerId of providerIds) {
      try {
        const job = await this.jobs.enqueue({
          type: AI_CATALOG_REFRESH_TYPE,
          reason: 'backfill',
          subjectType: AI_CATALOG_SUBJECT_TYPE,
          subjectId: providerId,
          payload: { providerId },
          priority: REFRESH_PRIORITY,
        });

        this.logger.log(`Queued AI catalog refresh ${job.id} for "${providerId}"`);
      } catch (error) {
        this.logger.error(
          `Could not queue the AI catalog refresh for "${providerId}": ${errorMessage(error)}`,
        );
      }
    }
  }

  /**
   * The providers a refresh is due for: every enabled provider, and none at
   * all while the platform's kill switch is off (docs/specs/ai-platform.md §2.19).
   */
  async dueProviders(): Promise<string[]> {
    const policy = await this.systemSettings.getAiPolicy();

    if (!policy.enabled) {
      this.logger.debug('AI is disabled (ai.enabled); no catalog refresh queued');

      return [];
    }

    return Object.entries(policy.providers as Record<string, { enabled: boolean } | undefined>)
      .filter(([, provider]) => provider?.enabled === true)
      .map(([providerId]) => providerId);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
