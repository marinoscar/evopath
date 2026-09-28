// =============================================================================
// `ai.audio.speech` job handler — one text-to-speech synthesis
// (issue #439, epic #420; docs/specs/ai-platform.md §2.14, §2.20)
// =============================================================================
//
// Payload `{ runId }`, subjectType `'ai_run'`. Enqueued by
// `AiUserClient.speak` in the same transaction that creates the run row. The
// run lifecycle — claim, cancel, deadline, outcomes, retries, the settle
// safety net, server-only — is `AiMediaRunHandler`'s; this file is the
// speech part, the image job's shape with one output:
//
//   1. the gates (inside `executeSpeechRun`)    no call when AI is off, the
//                                               key is gone, the voice is
//                                               not the model's
//   2. `AiOutputWriter.assertWritable()`        no storage -> no call: audio
//                                               that cannot be kept is never
//                                               paid for (AI_STORAGE_UNAVAILABLE)
//   3. the provider call (one usage row, `units: { characters }`)
//   4. the audio written as ONE `ready` storage object the user owns, at
//      `ai-outputs/<userId>/<runId>/speech.<ext>`, then `complete` with
//      `{ type: 'speech', storageObjectId, mimeType, aiGenerated: true, … }`
//
// DISCLOSURE. Provider usage policies (OpenAI's among them) require making
// clear to listeners that a voice is AI-generated. The run output says
// `aiGenerated: true`, and so does the stored object's metadata, so the
// fact travels with the file.
//
// PROFILE `{ maxRuntimeMs: 5 min, maxAttempts: 2 }`. At most 4096
// characters, so a call is short; synthesising the same text again yields
// equivalent audio at the same key, so one automatic retry of an unexpected
// failure is safe. A cancelled run's audio is discarded.
// =============================================================================

import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { JOB_SETTLED_EVENT, JobSettledEvent } from '../../jobs/events/job-settled.event';
import { JobExecutionProfile } from '../../jobs/job-execution-profile';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { AiError } from '../core/ai-error';
import type { AiSpeechResult } from '../core/types/media.types';
import { AiOutputWriter, extensionForMime, type AiStoredOutput } from '../storage/ai-output-writer';
import { aiErrorFromStorage } from '../storage/ai-storage-errors';
import { AiService } from './ai.service';
import { AI_SPEECH_OPERATION, parseStoredSpeechRunRequest, type StoredAiSpeechRunRequest } from './ai-audio-run-request';
import { AiMediaRunHandler, type AiMediaRunContext, type AiMediaRunResult } from './ai-media-run.handler';
import { AI_AUDIO_SPEECH_TYPE, AiRunsService } from './ai-runs.service';
import type { AiSpeechRunOutput } from './ai-runtime.types';

@Injectable()
export class AiAudioSpeechHandler extends AiMediaRunHandler {
  readonly type = AI_AUDIO_SPEECH_TYPE;

  readonly profile: JobExecutionProfile = { maxRuntimeMs: 5 * 60_000, maxAttempts: 2 };

  protected readonly operations = [AI_SPEECH_OPERATION] as const;

  protected readonly noun = 'speech';

  constructor(
    registry: JobHandlerRegistry,
    private readonly ai: AiService,
    runs: AiRunsService,
    private readonly outputs: AiOutputWriter,
  ) {
    super(registry, runs);
  }

  @OnEvent(JOB_SETTLED_EVENT)
  async onJobSettled(event: JobSettledEvent): Promise<void> {
    await this.failOrphanedRun(event);
  }

  protected async execute(ctx: AiMediaRunContext): Promise<AiMediaRunResult | null> {
    const stored = parseStoredSpeechRunRequest(ctx.request);
    const result = await this.ai.executeSpeechRun(ctx.userId, stored, {
      jobId: ctx.job.id,
      signal: ctx.signal,
      beforeCall: () => this.outputs.assertWritable(),
    });

    if (await ctx.cancelledWhileRunning()) return null;

    const file = await this.store(ctx.userId, ctx.runId, stored, result);
    const output = toRunOutput(stored, result, file);

    return { output, discard: () => this.outputs.discard([file.storageObjectId]) };
  }

  /** The audio as one storage object the user owns. Any failure here is a storage outcome. */
  private async store(
    userId: string,
    runId: string,
    stored: StoredAiSpeechRunRequest,
    result: AiSpeechResult,
  ): Promise<AiStoredOutput> {
    const ext = extensionForMime(result.audio.mimeType);

    try {
      const [file] = await this.outputs.write({
        userId,
        runId,
        files: [
          {
            data: result.audio.data,
            mimeType: result.audio.mimeType,
            keyName: `speech.${ext}`,
            name: `ai-speech.${ext}`,
          },
        ],
        metadata: { provider: result.provider, model: result.model, voice: stored.voice, aiGenerated: 'true' },
      });

      return file;
    } catch (err) {
      throw (
        aiErrorFromStorage(err) ??
        new AiError('AI_STORAGE_UNAVAILABLE', 'The synthesized speech could not be stored.', { cause: err })
      );
    }
  }
}

function toRunOutput(stored: StoredAiSpeechRunRequest, result: AiSpeechResult, file: AiStoredOutput): AiSpeechRunOutput {
  return {
    type: 'speech',
    provider: result.provider,
    model: result.model,
    storageObjectId: file.storageObjectId,
    mimeType: file.mimeType,
    size: file.size,
    format: stored.format,
    voice: stored.voice,
    characters: stored.input.length,
    aiGenerated: true,
    usage: result.usage,
  };
}
