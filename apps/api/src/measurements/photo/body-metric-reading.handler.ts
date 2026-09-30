// =============================================================================
// `ai.health.body_metric_reading` job handler (E2.6, #64)
// =============================================================================
//
// Reads a scale or blood-pressure-cuff display off a `body_metric_reading`
// photo intake and hands the readings to `IntakeService.replaceAiDrafts` as
// pending AI drafts. Enqueued by `POST /api/intakes/:id/analyze` (E3.1) with
// payload `{ intakeId }`, subjectType `'photo_intake'`, in the transaction
// that flips the intake to `scanning`.
//
// SERVER-ONLY, PERMANENTLY. No `nodeResultSchema`/`persistNodeResult`: the
// call is made with the user's own provider key (or the org key), and no AI
// key may ever reach a worker node (CLAUDE.md AI rule 3).
//
// PROFILE `{ maxRuntimeMs: 3 min, maxAttempts: 1 }`. A model call is neither
// idempotent nor free, so a failure is not retried automatically; the user
// retries with "Try again". A provider throttle DEFERS the job instead.
//
// OUTCOMES (the intake, not the job, is what the user reads):
//
//   - success                        drafts stored, intake `ready`
//   - intake gone / not scanning     no-op (discarded or finished elsewhere)
//   - AI_RATE_LIMITED                job deferred; intake stays `scanning`
//   - a policy/request/config code   intake `failed` with the code; the job
//     (kill switch, key, model,      RETURNS normally: an expected outcome,
//     capability, bad output,        not an operator's incident
//     storage unavailable, ...)
//   - anything else                  intake `failed`; the job THROWS so the
//                                    failure is visible in the queue dashboard
//
// Plus a safety net: a job that settles `failed` without the handler having
// finished (the worker's timeout, a rate-limit budget exhausted) fails a
// still-`scanning` intake, so no intake spins forever.
//
// ⚠ PRIVACY. Photos are passed as storage-object inputs (the AI runtime
// resolves them under the owner's authorization; this handler never fetches
// bytes or builds URLs). Nothing here logs a value, the prompt or an image;
// log lines carry ids and codes only.
// =============================================================================

import { HttpException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { trace } from '@opentelemetry/api';
import type { Job } from '@prisma/client';
import { z } from 'zod';

import { AiError, type AiErrorCode } from '../../ai/core/ai-error';
import type { AiContentPart } from '../../ai/core/types/responses.types';
import { AI_RUN_TERMINAL_CODES } from '../../ai/runtime/ai-response-run.handler';
import { AiService } from '../../ai/runtime/ai.service';
import { aiErrorFromStorage } from '../../ai/storage/ai-storage-errors';
import { type IntakeAnalyzerInput, isPdfInput, numberedInputParts } from '../../intake/intake-analyzer';
import { INTAKE_INPUT_KIND_SPAN_ATTRIBUTE, inputKindAttribute, PDF_INPUT_UNSUPPORTED_MESSAGE } from '../../intake/intake-inputs';
import { IntakeService } from '../../intake/intake.service';
import { JOB_SETTLED_EVENT, JobSettledEvent } from '../../jobs/events/job-settled.event';
import { JobExecutionProfile } from '../../jobs/job-execution-profile';
import { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { mapBodyMetricOutput } from './body-metric-reading.mapper';
import {
  BODY_METRIC_INSTRUCTIONS,
  bodyMetricOutputSchema,
  bodyMetricUserText,
  type BodyMetricOutput,
} from './body-metric-reading.prompt';
import { BODY_METRIC_READING_JOB_TYPE, BODY_METRIC_READING_KIND } from './body-metric-reading.value';

export const bodyMetricReadingPayloadSchema = z.object({ intakeId: z.uuid() });

/** `Job.subjectType` of an analyzer job (E3.1's `analyze`). */
export const PHOTO_INTAKE_SUBJECT_TYPE = 'photo_intake';

const MAX_RUNTIME_MS = 3 * 60_000;

/** The model call's own deadline: a little inside the job's, so the intake records it cleanly. */
const CALL_DEADLINE_MS = MAX_RUNTIME_MS - 15_000;

/** A fallback code for a failure that is not an `AiError`. */
export const BODY_METRIC_READ_FAILED = 'READ_FAILED';

/** User-safe messages; an `AiError`'s own message may describe a provider. */
const FAILURE_MESSAGES: Partial<Record<AiErrorCode, string>> = {
  AI_DISABLED: 'AI is turned off.',
  AI_PROVIDER_DISABLED: 'This AI provider is turned off.',
  AI_KEY_REQUIRED: 'An AI key is needed to read photos.',
  AI_KEY_INVALID: 'The AI key was rejected by the provider.',
  AI_MODEL_NOT_ENABLED: 'The chosen AI model is not available.',
  AI_MODEL_NOT_REACHABLE: 'The chosen AI model is not available with your key.',
  AI_CAPABILITY_UNSUPPORTED: 'The chosen AI model cannot read photos.',
  AI_CONTENT_FILTERED: 'The AI provider declined to read this photo.',
  AI_STRUCTURED_OUTPUT_INVALID: 'The AI answer could not be understood.',
  AI_STORAGE_UNAVAILABLE: 'Photo storage is unavailable.',
  AI_INVALID_REQUEST: 'A photo is missing or could not be read.',
  AI_PROVIDER_UNAVAILABLE: 'The AI provider is unavailable right now.',
};

const GENERIC_FAILURE = 'Reading the photo failed.';

/** The user-safe message for a failed call; a model that cannot read the intake's PDF says so (H2, #186). */
function failureMessage(error: AiError, hasPdf: boolean): string {
  const capability = (error.getResponse() as { details?: { capability?: unknown } }).details?.capability;

  if (hasPdf && error.code === 'AI_CAPABILITY_UNSUPPORTED' && capability === 'file_input') {
    return PDF_INPUT_UNSUPPORTED_MESSAGE;
  }

  return FAILURE_MESSAGES[error.code] ?? GENERIC_FAILURE;
}

@Injectable()
export class BodyMetricReadingHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(BodyMetricReadingHandler.name);

  readonly type = BODY_METRIC_READING_JOB_TYPE;

  readonly profile: JobExecutionProfile = { maxRuntimeMs: MAX_RUNTIME_MS, maxAttempts: 1 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly intakes: IntakeService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const payload = bodyMetricReadingPayloadSchema.safeParse(job.payload);

    if (!payload.success) {
      throw new Error(`Invalid ${BODY_METRIC_READING_JOB_TYPE} payload: expected { intakeId }`);
    }

    const { intakeId } = payload.data;
    const intake = await this.prisma.photoIntake.findUnique({
      where: { id: intakeId },
      include: {
        photos: {
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          select: { storageObjectId: true, storageObject: { select: { mimeType: true } } },
        },
      },
    });

    if (!intake) {
      this.logger.log(`Photo intake ${intakeId} no longer exists; job ${job.id} is a no-op`);
      return;
    }

    if (intake.status !== 'scanning') {
      this.logger.log(`Photo intake ${intakeId} is ${intake.status}; job ${job.id} is a no-op`);
      return;
    }

    if (intake.kind !== BODY_METRIC_READING_KIND) {
      await this.intakes.failIntake(intakeId, BODY_METRIC_READ_FAILED, GENERIC_FAILURE);
      throw new Error(`Photo intake ${intakeId} is a ${intake.kind} intake, not ${BODY_METRIC_READING_KIND}`);
    }

    if (!intake.provider || !intake.modelId) {
      await this.intakes.failIntake(intakeId, 'AI_INVALID_REQUEST', 'No AI model was chosen.');
      return;
    }

    // H2 (#186): a PDF is sent as a `file` part, an image as an `image` part.
    const inputs: IntakeAnalyzerInput[] = intake.photos.map((photo) => ({
      storageObjectId: photo.storageObjectId,
      mimeType: photo.storageObject?.mimeType ?? null,
    }));
    const photoIds = inputs.map((input) => input.storageObjectId);
    const hasPdf = inputs.some((input) => isPdfInput(input));

    if (photoIds.length === 0) {
      await this.intakes.failIntake(intakeId, 'AI_INVALID_REQUEST', 'Attach a photo first.');
      return;
    }

    const inputKind = inputKindAttribute(inputs.map((input) => (isPdfInput(input) ? 'pdf' : 'image')));
    if (inputKind) trace.getActiveSpan()?.setAttribute(INTAKE_INPUT_KIND_SPAN_ATTRIBUTE, inputKind);

    // Numbered from 1, as the prompt's `sourcePhotoIndexes` are.
    const content: AiContentPart[] = [
      { type: 'text', text: bodyMetricUserText(photoIds.length, hasPdf) },
      ...numberedInputParts(inputs, 1),
    ];

    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new Error('Photo reading timed out')), CALL_DEADLINE_MS);
    deadline.unref?.();

    let output: BodyMetricOutput;

    try {
      const { parsed } = await this.ai.forUser(intake.userId, { jobId: job.id }).respondStructured(
        {
          provider: intake.provider,
          model: intake.modelId,
          schema: bodyMetricOutputSchema,
          schemaName: 'body_metric_reading',
          strict: true,
          instructions: BODY_METRIC_INSTRUCTIONS,
          input: [{ type: 'message', role: 'user', content }],
        },
        { signal: controller.signal },
      );
      output = parsed;
    } catch (err) {
      await this.settleAiFailure(intakeId, job.id, err, hasPdf);
      return;
    } finally {
      clearTimeout(deadline);
    }

    const { drafts, resultMeta } = mapBodyMetricOutput(output, photoIds);

    try {
      const stored = await this.intakes.replaceAiDrafts(intakeId, drafts, { resultMeta });

      this.logger.log(
        `Photo intake ${intakeId}: ${stored.inserted} reading(s) drafted, ${stored.invalid.length} invalid (job ${job.id})`,
      );
    } catch (err) {
      if (err instanceof HttpException) {
        // The intake was discarded (404) or is no longer scanning (409
        // NOT_SCANNING): someone else settled it; the reading is dropped.
        this.logger.log(`Photo intake ${intakeId} changed while it was read (${err.getStatus()}); result discarded`);
        return;
      }

      await this.intakes.failIntake(intakeId, BODY_METRIC_READ_FAILED, GENERIC_FAILURE);
      throw err;
    }
  }

  /**
   * A job that settled FAILED while its intake is still `scanning` (the
   * worker's own timeout, a rate-limit budget exhausted, a crash) would leave
   * the intake spinning forever. Only the intake's CURRENT job may fail it.
   */
  @OnEvent(JOB_SETTLED_EVENT)
  async onJobSettled(event: JobSettledEvent): Promise<void> {
    if (event.type !== BODY_METRIC_READING_JOB_TYPE || event.succeeded) return;
    if (event.subjectType !== PHOTO_INTAKE_SUBJECT_TYPE || !event.subjectId) return;

    try {
      const intake = await this.prisma.photoIntake.findUnique({
        where: { id: event.subjectId },
        select: { status: true, jobId: true },
      });

      if (!intake || intake.status !== 'scanning' || (intake.jobId && intake.jobId !== event.jobId)) return;

      await this.intakes.failIntake(
        event.subjectId,
        'AI_PROVIDER_UNAVAILABLE',
        'The photo reading stopped before it finished.',
      );
    } catch (error) {
      this.logger.warn(
        `Could not mark photo intake ${event.subjectId} failed after job ${event.jobId} settled: ` +
          (error instanceof Error ? error.name : 'unknown error'),
      );
    }
  }

  /** The model call failed: defer, fail quietly, or fail and throw (see the header). */
  private async settleAiFailure(intakeId: string, jobId: string, err: unknown, hasPdf = false): Promise<void> {
    const aiError = err instanceof AiError ? err : aiErrorFromStorage(err);

    if (!aiError) {
      await this.intakes.failIntake(intakeId, BODY_METRIC_READ_FAILED, GENERIC_FAILURE);
      throw err;
    }

    const rateLimit = aiError.toRateLimitError();

    if (rateLimit) {
      // Deferred, not failed: the intake stays `scanning` for the retry.
      throw rateLimit;
    }

    await this.intakes.failIntake(intakeId, aiError.code, failureMessage(aiError, hasPdf));

    if (AI_RUN_TERMINAL_CODES.has(aiError.code)) {
      this.logger.log(`Photo intake ${intakeId} ended with ${aiError.code} (job ${jobId})`);
      return;
    }

    throw err;
  }
}
