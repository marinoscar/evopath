// =============================================================================
// Weekly AI key reachability recheck scheduler (issue #431, epic #419)
// =============================================================================
//
// ENQUEUE ONLY (CLAUDE.md, "Every Long-Running Activity Is a Queue Job", rule
// 1). This cron decides WHETHER a recheck is due — one per enabled provider
// that has at least one stored user key — and queues `ai.keys.recheck`. Every
// provider round trip happens in `AiKeysRecheckHandler`, on the queue.
//
// NOT `enqueueHousekeepingJob`: that helper dedups by type alone, and this
// task queues one job PER PROVIDER. `JobsService.enqueue` dedups on type +
// subject, so a provider whose recheck is still pending is not queued twice.
//
// Pinned by `apps/api/test/jobs/cron-enqueue-only.spec.ts`.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { JobsService } from '../../jobs/jobs.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AI_CATALOG_SUBJECT_TYPE } from '../catalog/ai-catalog.service';
import { AiConfigService, providerPolicy } from '../config/ai-config.service';
import { AI_KEYS_RECHECK_TYPE } from './ai-user-key.constants';

/** Low priority (ascending is more urgent): background upkeep never outranks user work. */
export const AI_KEYS_RECHECK_PRIORITY = 100;

@Injectable()
export class AiKeysRecheckTask {
  private readonly logger = new Logger(AiKeysRecheckTask.name);

  constructor(
    private readonly aiConfig: AiConfigService,
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
  ) {}

  @Cron(CronExpression.EVERY_WEEK)
  async handleCron(): Promise<void> {
    let providers: string[];

    try {
      providers = await this.dueProviders();
    } catch (error) {
      this.logger.error(`Could not decide which AI keys are due a recheck: ${errorMessage(error)}`);

      return;
    }

    for (const provider of providers) {
      try {
        const job = await this.jobs.enqueue({
          type: AI_KEYS_RECHECK_TYPE,
          reason: 'backfill',
          subjectType: AI_CATALOG_SUBJECT_TYPE,
          subjectId: provider,
          payload: { provider },
          priority: AI_KEYS_RECHECK_PRIORITY,
        });

        this.logger.log(`Queued AI key recheck ${job.id} for "${provider}"`);
      } catch (error) {
        this.logger.error(`Could not queue the AI key recheck for "${provider}": ${errorMessage(error)}`);
      }
    }
  }

  /**
   * Every enabled, registered provider with at least one stored user key; none
   * at all while the kill switch is off. Deciding per provider is cheap (one
   * `count`); which KEYS are stale is the handler's question.
   */
  async dueProviders(): Promise<string[]> {
    const policy = await this.aiConfig.resolve({ fresh: true });

    if (!policy.enabled) {
      return [];
    }

    const due: string[] = [];

    for (const provider of Object.keys(policy.providers)) {
      if (!providerPolicy(policy, provider)?.enabled) continue;

      if ((await this.prisma.userAiKey.count({ where: { provider } })) > 0) {
        due.push(provider);
      }
    }

    return due;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
