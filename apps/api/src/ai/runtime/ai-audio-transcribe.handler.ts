// =============================================================================
// `ai.audio.transcribe` job handler — one transcription
// (issue #438, epic #420; docs/specs/ai-platform.md §2.13, §2.20)
// =============================================================================
//
// Payload `{ runId }`, subjectType `'ai_run'`. Enqueued by
// `AiUserClient.transcribe` in the same transaction that creates the run
// row. The run lifecycle — claim, cancel, deadline, outcomes, the settle
// safety net, server-only — is `AiMediaRunHandler`'s; this file is the
// transcription part:
//
//   1. the gates (inside `executeTranscriptionRun`)  a switched-off platform,
//      a revoked key, a recording that is no longer the user's: no call
//   2. the recording is streamed to the provider (size-capped), one usage
//      row (`operation: 'audio.transcribe'`, `units: { audioSeconds }`)
//   3. the transcript is the run's output — `{ type: 'transcription', text,
//      language?, durationSeconds?, segments?, words?, … }`; nothing is
//      written to object storage
//
// PROFILE `{ maxRuntimeMs: 15 min, maxAttempts: 2 }`. Transcribing the same
// recording twice yields the same transcript and changes nothing but the
// bill, so one automatic retry of an unexpected failure (a provider 5xx, a
// dropped connection) is worth it — `AiMediaRunHandler` puts the run back to
// `pending` for it. An expected refusal (AI_RUN_TERMINAL_CODES) is never
// retried, and a provider throttle still defers rather than retries.
// =============================================================================

import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { JOB_SETTLED_EVENT, JobSettledEvent } from '../../jobs/events/job-settled.event';
import { JobExecutionProfile } from '../../jobs/job-execution-profile';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import type { AiTranscriptionResult } from '../core/types/media.types';
import { AiService } from './ai.service';
import { AI_TRANSCRIBE_OPERATION, parseStoredTranscriptionRunRequest } from './ai-audio-run-request';
import { AiMediaRunHandler, type AiMediaRunContext, type AiMediaRunResult } from './ai-media-run.handler';
import { AI_AUDIO_TRANSCRIBE_TYPE, AiRunsService } from './ai-runs.service';
import type { AiTranscriptionRunOutput } from './ai-runtime.types';

@Injectable()
export class AiAudioTranscribeHandler extends AiMediaRunHandler {
  readonly type = AI_AUDIO_TRANSCRIBE_TYPE;

  readonly profile: JobExecutionProfile = { maxRuntimeMs: 15 * 60_000, maxAttempts: 2 };

  protected readonly operations = [AI_TRANSCRIBE_OPERATION] as const;

  protected readonly noun = 'transcription';

  constructor(
    registry: JobHandlerRegistry,
    private readonly ai: AiService,
    runs: AiRunsService,
  ) {
    super(registry, runs);
  }

  @OnEvent(JOB_SETTLED_EVENT)
  async onJobSettled(event: JobSettledEvent): Promise<void> {
    await this.failOrphanedRun(event);
  }

  protected async execute(ctx: AiMediaRunContext): Promise<AiMediaRunResult | null> {
    const stored = parseStoredTranscriptionRunRequest(ctx.request);
    const result = await this.ai.executeTranscriptionRun(ctx.userId, stored, {
      jobId: ctx.job.id,
      signal: ctx.signal,
    });

    if (await ctx.cancelledWhileRunning()) return null;

    return { output: toRunOutput(stored.storageObjectId, result) };
  }
}

function toRunOutput(storageObjectId: string, result: AiTranscriptionResult): AiTranscriptionRunOutput {
  return {
    type: 'transcription',
    provider: result.provider,
    model: result.model,
    storageObjectId,
    text: result.text,
    ...(result.language !== undefined ? { language: result.language } : {}),
    ...(result.durationSeconds !== undefined ? { durationSeconds: result.durationSeconds } : {}),
    ...(result.segments !== undefined ? { segments: result.segments } : {}),
    ...(result.words !== undefined ? { words: result.words } : {}),
    usage: result.usage,
  };
}
