// =============================================================================
// `ai.image.generate` job handler — one image generation or edit
// (issue #437, epic #420; docs/specs/ai-platform.md §2.12, §2.20)
// =============================================================================
//
// Payload `{ runId }`, subjectType `'ai_run'`. Enqueued by
// `AiUserClient.generateImage`/`editImage` in the same transaction that
// creates the run row; `request.operation` says which of the two it is.
// The run lifecycle — claim, cancel, deadline, outcomes, the settle safety
// net, server-only — is `AiMediaRunHandler`'s; this file is the image part.
//
// PROFILE `{ maxRuntimeMs: 10 min, maxAttempts: 1 }`. An image call is billed
// per image and is not idempotent: an automatic retry is a second charge. A
// provider throttle still DEFERS the job (its own budget) instead.
//
// ORDER, and why:
//
//   1. the gates (inside `executeImageRun`)   a switched-off platform, a
//                                             revoked key, an input that is no
//                                             longer the user's: no call
//   2. `AiOutputWriter.assertWritable()`       no storage -> no call: images
//                                             that cannot be kept are never
//                                             paid for (AI_STORAGE_UNAVAILABLE)
//   3. the provider call (one usage row, `units: { images: n }`)
//   4. write every image as a storage object the user owns, under
//      `ai-outputs/<userId>/<runId>/`, then `complete` the run with
//      `{ type: 'images', storageObjectIds, images, … }`
//
// CANCELLATION. Images that were already written when the owner's cancel won
// are discarded, so a cancelled run leaves no objects behind.
// =============================================================================

import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { JOB_SETTLED_EVENT, JobSettledEvent } from '../../jobs/events/job-settled.event';
import { JobExecutionProfile } from '../../jobs/job-execution-profile';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { AiError } from '../core/ai-error';
import type { AiImageResult } from '../core/types/media.types';
import { AiOutputWriter, type AiStoredOutput } from '../storage/ai-output-writer';
import { aiErrorFromStorage } from '../storage/ai-storage-errors';
import { AiService } from './ai.service';
import { AI_IMAGE_OPERATIONS, parseStoredImageRunRequest } from './ai-image-run-request';
import {
  AiMediaRunHandler,
  type AiMediaRunContext,
  type AiMediaRunResult,
} from './ai-media-run.handler';
import { AI_IMAGE_GENERATE_TYPE, AiRunsService } from './ai-runs.service';
import type { AiImageRunOutput } from './ai-runtime.types';

@Injectable()
export class AiImageGenerateHandler extends AiMediaRunHandler {
  readonly type = AI_IMAGE_GENERATE_TYPE;

  readonly profile: JobExecutionProfile = { maxRuntimeMs: 10 * 60_000, maxAttempts: 1 };

  protected readonly operations = AI_IMAGE_OPERATIONS;

  protected readonly noun = 'image';

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
    const stored = parseStoredImageRunRequest(ctx.request);
    const result = await this.ai.executeImageRun(ctx.userId, stored, {
      jobId: ctx.job.id,
      signal: ctx.signal,
      beforeCall: () => this.outputs.assertWritable(),
    });

    if (await ctx.cancelledWhileRunning()) return null;

    const files = await this.store(ctx.userId, ctx.runId, result);
    const output = toRunOutput(result, files);

    return { output, discard: () => this.outputs.discard(output.storageObjectIds) };
  }

  /** Every image as a storage object the user owns. Any failure here is a storage outcome. */
  private async store(userId: string, runId: string, result: AiImageResult): Promise<AiStoredOutput[]> {
    try {
      return await this.outputs.write({
        userId,
        runId,
        files: result.images.map((image) => ({ data: image.data, mimeType: image.mimeType })),
        namePrefix: 'ai-image',
        metadata: { provider: result.provider, model: result.model },
      });
    } catch (err) {
      throw (
        aiErrorFromStorage(err) ??
        new AiError('AI_STORAGE_UNAVAILABLE', 'The generated images could not be stored.', { cause: err })
      );
    }
  }
}

function toRunOutput(result: AiImageResult, stored: AiStoredOutput[]): AiImageRunOutput {
  return {
    type: 'images',
    provider: result.provider,
    model: result.model,
    storageObjectIds: stored.map((file) => file.storageObjectId),
    images: stored.map((file, index) => ({
      storageObjectId: file.storageObjectId,
      mimeType: file.mimeType,
      size: file.size,
      ...(result.images[index]?.revisedPrompt ? { revisedPrompt: result.images[index].revisedPrompt } : {}),
    })),
    usage: result.usage,
  };
}
