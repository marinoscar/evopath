// =============================================================================
// Hourly coach sweep scheduler (E7.4; docs/specs/ai-coach.md §2.5)
// =============================================================================
//
// THIS TASK PLANS NOTHING. While `ai.enabled` and the system `coach.enabled`
// are both on, it enqueues one global `coach.sweep` job through the shared
// housekeeping helper; `CoachSweepHandler` does the work on a worker slot.
// Pinned by `apps/api/test/jobs/cron-enqueue-only.spec.ts`. Minute 17, so it
// does not share the top of the hour (or minute 7, the evaluation sweep) with
// the other hourly tasks. It never throws: a throw out of a cron is an
// unhandled rejection, and the next hour runs anyway.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { AiConfigService } from '../../../ai/config/ai-config.service';
import { enqueueHousekeepingJob } from '../../../jobs/housekeeping.enqueue';
import { JobsService } from '../../../jobs/jobs.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { SystemSettingsService } from '../../../settings/system-settings/system-settings.service';
import { COACH_SWEEP_JOB_TYPE } from '../../coach-job-types';

export const COACH_SWEEP_CRON = '17 * * * *';

@Injectable()
export class CoachSweepTask {
  private readonly logger = new Logger(CoachSweepTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
    private readonly aiConfig: AiConfigService,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  @Cron(COACH_SWEEP_CRON)
  async handleCron(): Promise<void> {
    if (!(await this.isDue())) return;

    await enqueueHousekeepingJob({
      jobs: this.jobs,
      prisma: this.prisma,
      logger: this.logger,
      type: COACH_SWEEP_JOB_TYPE,
      what: 'coach sweep',
    });
  }

  /** Whether AI and the coach are both on. False (with a log line) when either cannot be read. */
  private async isDue(): Promise<boolean> {
    try {
      if (!(await this.aiConfig.isEnabled())) {
        this.logger.debug('AI is disabled; no coach sweep queued');
        return false;
      }
      if (!(await this.systemSettings.getCoachPolicy()).enabled) {
        this.logger.debug('The coach is disabled; no coach sweep queued');
        return false;
      }
      return true;
    } catch (error) {
      this.logger.error(`Could not read the AI or coach switch: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
}
