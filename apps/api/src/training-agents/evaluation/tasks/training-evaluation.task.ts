// =============================================================================
// Hourly continuous-evaluation scheduler
// =============================================================================
//
// THIS TASK EVALUATES NOTHING. While `ai.enabled` (the kill switch stays with
// scheduling), it enqueues one global `training.evaluation.sweep` job through
// the shared housekeeping helper; `TrainingEvaluationSweepHandler` decides
// what is due and creates the runs on a worker slot. Pinned by
// `apps/api/test/jobs/cron-enqueue-only.spec.ts`. Minute 7, so it does not
// share the top of the hour with the other hourly tasks.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { AiConfigService } from '../../../ai/config/ai-config.service';
import { enqueueHousekeepingJob } from '../../../jobs/housekeeping.enqueue';
import { JobsService } from '../../../jobs/jobs.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { TRAINING_EVALUATION_SWEEP_TYPE } from '../handlers/training-evaluation-sweep.handler';

export const TRAINING_EVALUATION_SWEEP_CRON = '7 * * * *';

@Injectable()
export class TrainingEvaluationTask {
  private readonly logger = new Logger(TrainingEvaluationTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
    private readonly aiConfig: AiConfigService,
  ) {}

  @Cron(TRAINING_EVALUATION_SWEEP_CRON)
  async handleCron(): Promise<void> {
    let enabled: boolean;
    try {
      enabled = await this.aiConfig.isEnabled();
    } catch (error) {
      // Swallowed: a throw out of a cron is an unhandled rejection; next hour runs anyway.
      this.logger.error(`Could not read ai.enabled: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!enabled) {
      this.logger.debug('AI is disabled; no evaluation sweep queued');
      return;
    }

    await enqueueHousekeepingJob({
      jobs: this.jobs,
      prisma: this.prisma,
      logger: this.logger,
      type: TRAINING_EVALUATION_SWEEP_TYPE,
      what: 'training evaluation sweep',
    });
  }
}
