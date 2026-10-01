// =============================================================================
// `job.settled` -> `coach.audio.settle` (E7.6, #246; spec §2.7 step 4)
// =============================================================================
//
// ENQUEUE ONLY. EventEmitter2 dispatches synchronously inside the worker's
// terminal write, so this listener does one indexed read (`coach_messages`
// by `audio_run_id`) and, for a message still waiting on that run, one
// enqueue. Classification, the row update and delivery happen in the queued
// `coach.audio.settle` job (CLAUDE.md queue rule 1;
// `test/jobs/on-event-no-io.spec.ts`).
//
// Ignored: any other job type, a run no coach message waits on (a voice
// preview, the AI playground), and a message no longer `pending` (a repeated
// event). A repeated event for a pending message collapses onto the queued
// settle job (per-message dedup). Never throws.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { AI_AUDIO_SPEECH_TYPE, AI_RUN_SUBJECT_TYPE } from '../../ai/runtime/ai-runs.service';
import { JOB_SETTLED_EVENT, JobSettledEvent } from '../../jobs/events/job-settled.event';
import { PrismaService } from '../../prisma/prisma.service';
import { CoachAudioService } from './coach-audio.service';

@Injectable()
export class CoachAudioSettledListener {
  private readonly logger = new Logger(CoachAudioSettledListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audio: CoachAudioService,
  ) {}

  @OnEvent(JOB_SETTLED_EVENT)
  async onJobSettled(event: JobSettledEvent): Promise<void> {
    if (event.type !== AI_AUDIO_SPEECH_TYPE || event.subjectType !== AI_RUN_SUBJECT_TYPE || !event.subjectId) return;

    try {
      const message = await this.prisma.coachMessage.findFirst({
        where: { audioRunId: event.subjectId },
        select: { id: true, audioStatus: true },
      });
      if (!message || message.audioStatus !== 'pending') return;

      await this.audio.enqueueSettle(message.id, 'settled', undefined, event.succeeded, event.subjectId);
    } catch (error) {
      this.logger.warn(
        `Could not queue the coach audio settle for speech run ${event.subjectId}: ` +
          (error instanceof Error ? error.name : 'error'),
      );
    }
  }
}
