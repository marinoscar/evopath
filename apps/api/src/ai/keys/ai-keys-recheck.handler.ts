// =============================================================================
// `ai.keys.recheck` job handler (issue #431, epic #419)
// =============================================================================
//
// Re-verifies one provider's STALE user keys and refreshes the models each can
// reach (`UserAiKeysService.recheckStale`). A key is stale when its reachable
// list is older than a week, or older than the newest model the catalog has
// discovered for the provider (`staleCutoff`). Payload `{ provider }`,
// subjectType `'ai_provider'`, subjectId `provider` — enqueued weekly by
// `AiKeysRecheckTask` and whenever a catalog sync adds models
// (`AiKeysCatalogListener`).
//
// A key the provider now rejects is RECORDED (`lastErrorCode`), never deleted.
//
// SERVER-ONLY, PERMANENTLY. No `nodeResultSchema`/`persistNodeResult`: this
// job decrypts USERS' OWN provider keys, and no AI key may ever reach a worker
// node (docs/specs/ai-platform.md §2.20).
//
// KILL SWITCH. AI or the provider switched off (before or during the sweep) is
// an expected stop, not a failure: the handler returns normally, so it burns
// no attempt and fires no `jobs.job_failed`.
//
// RATE LIMITS defer the job (`RateLimitError`) instead of charging an attempt;
// keys already refreshed are no longer stale, so the retry resumes.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Job } from '@prisma/client';
import { z } from 'zod';

import { JobExecutionProfile } from '../../jobs/job-execution-profile';
import { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { AiError } from '../core/ai-error';
import { AI_KEYS_RECHECK_TYPE } from './ai-user-key.constants';
import { UserAiKeysService } from './user-ai-keys.service';

export const aiKeysRecheckPayloadSchema = z.object({
  provider: z.string().min(1).max(64),
});

export type AiKeysRecheckPayload = z.infer<typeof aiKeysRecheckPayloadSchema>;

@Injectable()
export class AiKeysRecheckHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(AiKeysRecheckHandler.name);

  readonly type = AI_KEYS_RECHECK_TYPE;

  /**
   * Two bounded provider calls per stale key, 50 keys a page: thirty minutes
   * covers thousands of keys. Three attempts, like the catalog refresh.
   */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 30 * 60_000, maxAttempts: 3 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly keys: UserAiKeysService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const parsed = aiKeysRecheckPayloadSchema.safeParse(job.payload);

    if (!parsed.success) {
      throw new Error(`Invalid ${AI_KEYS_RECHECK_TYPE} payload: expected { provider }`);
    }

    const { provider } = parsed.data;

    try {
      const cutoff = await this.keys.staleCutoff(provider);
      const counts = await this.keys.recheckStale(provider, cutoff);

      this.logger.log(
        `AI key recheck for "${provider}" done: ${counts.ok} ok, ${counts.invalid} rejected, ` +
          `${counts.failed} failed, ${counts.missing} removed meanwhile (job ${job.id})`,
      );
    } catch (error) {
      if (error instanceof AiError) {
        if (error.code === 'AI_DISABLED' || error.code === 'AI_PROVIDER_DISABLED') {
          this.logger.log(
            `AI key recheck for "${provider}" stopped: ${error.code}; job ${job.id} is a no-op`,
          );

          return;
        }

        throw error.toRateLimitError() ?? error;
      }

      throw error;
    }
  }
}
