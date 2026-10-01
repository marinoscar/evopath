// =============================================================================
// `coach.audio.settle`: map a finished speech run to its message (E7.6, #246)
// =============================================================================
//
// docs/specs/ai-coach.md §2.7. Two producers, one handler:
//
//   - `CoachAudioSettledListener` (an `ai.audio.speech` job settled):
//     `{ messageId, cause: 'settled', jobSucceeded }`, deduplicated per
//     message, so a repeated event collapses onto one job;
//   - `CoachAudioService.start` (the WAIT CAP): `{ messageId, cause:
//     'timeout' }`, scheduled 2 minutes out, never deduplicated;
//   - the `coach.audio.purge` safety net re-queues a `timeout` settle for a
//     message stuck `pending` for more than 10 minutes.
//
// The first to run moves the message `pending -> ready | failed`; later ones
// find nothing pending. When the message is no longer waiting and not yet
// delivered, `coach.message.deliver` is enqueued (deduplicated per message;
// the delivery job skips a delivered message), so delivery happens at most
// once and ALWAYS happens: text plus audio, or text with a recorded fallback.
//
// SERVER-ONLY: bounded row reads and writes, no provider call. PROFILE
// `{ maxRuntimeMs: 30 s, maxAttempts: 3 }`.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job } from '@prisma/client';
import { z } from 'zod';

import type { JobExecutionProfile } from '../../../jobs/job-execution-profile';
import type { JobHandler } from '../../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../../jobs/job-handler.registry';
import { COACH_AUDIO_SETTLE_JOB_TYPE } from '../../coach-job-types';
import { CoachAudioService, type CoachAudioSettleOutcome } from '../coach-audio.service';

export const coachAudioSettlePayloadSchema = z
  .object({
    messageId: z.uuid(),
    cause: z.enum(['settled', 'timeout']),
    jobSucceeded: z.boolean().optional(),
  })
  .passthrough();

@Injectable()
export class CoachAudioSettleHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(CoachAudioSettleHandler.name);

  readonly type = COACH_AUDIO_SETTLE_JOB_TYPE;

  readonly profile: JobExecutionProfile = { maxRuntimeMs: 30_000, maxAttempts: 3 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly audio: CoachAudioService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const parsed = coachAudioSettlePayloadSchema.safeParse(job.payload ?? {});
    if (!parsed.success) {
      this.logger.warn(`Coach audio settle job ${job.id} carries no valid payload; nothing to do`);
      return;
    }
    const { messageId, cause, jobSucceeded } = parsed.data;
    await this.run(messageId, cause, new Date(), jobSucceeded ?? null);
  }

  async run(
    messageId: string,
    cause: 'settled' | 'timeout',
    now: Date,
    jobSucceeded: boolean | null = null,
  ): Promise<CoachAudioSettleOutcome> {
    const outcome = await this.audio.settle(messageId, cause, now, jobSucceeded);
    if (outcome.deliver) await this.audio.enqueueDelivery(messageId);
    this.logger.debug(`Coach audio settle (${cause}) for message ${messageId}: ${outcome.status}`);
    return outcome;
  }
}
