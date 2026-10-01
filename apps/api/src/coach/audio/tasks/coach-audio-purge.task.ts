// =============================================================================
// Daily coach audio purge scheduler (E7.6, #246; docs/specs/ai-coach.md §3.4)
// =============================================================================
//
// THIS TASK DELETES NOTHING. Once a day it enqueues one global
// `coach.audio.purge` job through the shared housekeeping helper;
// `CoachAudioPurgeHandler` does the work on a worker slot. Pinned by
// `apps/api/test/jobs/cron-enqueue-only.spec.ts`.
//
// Not gated on the AI or coach switches: retention applies to audio already
// stored, whether or not the coach still speaks. 03:23 UTC, off the top of
// the hour and away from the midnight housekeeping. Never throws (the helper
// swallows and logs an enqueue failure; tomorrow runs anyway).
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { enqueueHousekeepingJob } from '../../../jobs/housekeeping.enqueue';
import { JobsService } from '../../../jobs/jobs.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { COACH_AUDIO_PURGE_JOB_TYPE } from '../../coach-job-types';

export const COACH_AUDIO_PURGE_CRON = '23 3 * * *';

@Injectable()
export class CoachAudioPurgeTask {
  private readonly logger = new Logger(CoachAudioPurgeTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron(COACH_AUDIO_PURGE_CRON)
  async handleCron(): Promise<void> {
    await enqueueHousekeepingJob({
      jobs: this.jobs,
      prisma: this.prisma,
      logger: this.logger,
      type: COACH_AUDIO_PURGE_JOB_TYPE,
      what: 'coach audio purge',
    });
  }
}
