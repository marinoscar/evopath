// =============================================================================
// `ai.health.lab_report` job handler (H4, #188)
// =============================================================================
//
// Transcribes a lab report (a PDF, or photos of its pages) attached to a
// `lab_report` intake into pending AI drafts, one per printed result, and the
// report's collection date and lab name into the intake's context. Enqueued
// by `POST /api/intakes/:id/analyze` with payload `{ intakeId }`, subjectType
// `'photo_intake'`, in the transaction that flips the intake to `scanning`.
//
// SERVER-ONLY, PERMANENTLY. No `nodeResultSchema`/`persistNodeResult`: the
// call is made with the user's own provider key (or the org key), and no AI
// key may ever reach a worker node (CLAUDE.md AI rule 3).
//
// PROFILE `{ maxRuntimeMs: 5 min, maxAttempts: 1 }`. A report of several
// pages takes longer than one display photo; a model call is neither
// idempotent nor free, so a failure is not retried (the user retries). A
// provider throttle DEFERS the job instead.
//
// MATCHING is the server's (`lab-report.mapper.ts`): the printed name is
// resolved against the lab catalog, the model's key is only a fallback hint,
// and every result, an unmatched one included, becomes a draft.
//
// OUTCOMES: as `ai.health.body_metric_reading` (success -> `ready`; gone or
// not scanning -> no-op; rate limit -> deferred; a policy/request/config code
// -> intake `failed`, job returns; anything else -> intake `failed`, job
// throws), plus the same settle safety net.
//
// OBSERVABILITY. The job's span carries `lab_report.input_count`,
// `lab_report.draft_count`, `lab_report.unmatched_count` and
// `intake.input_kind`; the analyze request's span carries `intake.page_count`.
// The AI run is recorded by the gateway (`ai_runs`, `ai_usage_events`) with no
// document content of ours.
//
// ⚠ PRIVACY. Inputs are passed as storage-object references (the AI runtime
// resolves them under the owner's authorization). The document content goes
// to this one extraction call only, never to a training agent. Nothing here
// logs a value, a name, the prompt or a byte; log lines carry ids and counts.
// =============================================================================

import { HttpException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { trace } from '@opentelemetry/api';
import type { Job } from '@prisma/client';
import { z } from 'zod';

import { AiError, aiErrorLogDetails, type AiErrorCode } from '../../ai/core/ai-error';
import type { AiContentPart } from '../../ai/core/types/responses.types';
import { AI_RUN_TERMINAL_CODES } from '../../ai/runtime/ai-response-run.handler';
import { AiService } from '../../ai/runtime/ai.service';
import { aiErrorFromStorage } from '../../ai/storage/ai-storage-errors';
import { type IntakeAnalyzerInput, isPdfInput, numberedInputParts, PHOTO_INTAKE_SUBJECT_TYPE } from '../../intake/intake-analyzer';
import { INTAKE_INPUT_KIND_SPAN_ATTRIBUTE, inputKindAttribute, PDF_INPUT_UNSUPPORTED_MESSAGE } from '../../intake/intake-inputs';
import { IntakeService } from '../../intake/intake.service';
import { JOB_SETTLED_EVENT, JobSettledEvent } from '../../jobs/events/job-settled.event';
import { JobExecutionProfile } from '../../jobs/job-execution-profile';
import { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { mapLabReportOutput } from './lab-report.mapper';
import { LAB_REPORT_INSTRUCTIONS, labReportOutputSchema, labReportUserText, type LabReportOutput } from './lab-report.prompt';
import { LAB_REPORT_JOB_TYPE, LAB_REPORT_KIND } from './lab-report.value';

export const labReportPayloadSchema = z.object({ intakeId: z.uuid() });

/** The structured-output name; the fake vision server routes on it. */
export const LAB_REPORT_SCHEMA_NAME = 'lab_report';

export const LAB_REPORT_SPAN_ATTRIBUTES = {
  inputCount: 'lab_report.input_count',
  draftCount: 'lab_report.draft_count',
  unmatchedCount: 'lab_report.unmatched_count',
} as const;

const MAX_RUNTIME_MS = 5 * 60_000;

/** The model call's own deadline: a little inside the job's, so the intake records it cleanly. */
const CALL_DEADLINE_MS = MAX_RUNTIME_MS - 15_000;

/** A fallback code for a failure that is not an `AiError`. */
export const LAB_REPORT_READ_FAILED = 'READ_FAILED';

/** User-safe messages; an `AiError`'s own message may describe a provider. */
const FAILURE_MESSAGES: Partial<Record<AiErrorCode, string>> = {
  AI_DISABLED: 'AI is turned off.',
  AI_PROVIDER_DISABLED: 'This AI provider is turned off.',
  AI_KEY_REQUIRED: 'An AI key is needed to read lab reports.',
  AI_KEY_INVALID: 'The AI key was rejected by the provider.',
  AI_MODEL_NOT_ENABLED: 'The chosen AI model is not available.',
  AI_MODEL_NOT_REACHABLE: 'The chosen AI model is not available with your key.',
  AI_CAPABILITY_UNSUPPORTED: 'The chosen AI model cannot read this report.',
  AI_CONTENT_FILTERED: 'The AI provider declined to read this report.',
  AI_STRUCTURED_OUTPUT_INVALID: 'The AI answer could not be understood.',
  AI_STORAGE_UNAVAILABLE: 'File storage is unavailable.',
  AI_INVALID_REQUEST: 'A file is missing or could not be read.',
  AI_PROVIDER_UNAVAILABLE: 'The AI provider is unavailable right now.',
};

const GENERIC_FAILURE = 'Reading the lab report failed.';

function failureMessage(error: AiError, hasPdf: boolean): string {
  const capability = (error.getResponse() as { details?: { capability?: unknown } }).details?.capability;

  if (hasPdf && error.code === 'AI_CAPABILITY_UNSUPPORTED' && capability === 'file_input') {
    return PDF_INPUT_UNSUPPORTED_MESSAGE;
  }

  return FAILURE_MESSAGES[error.code] ?? GENERIC_FAILURE;
}

@Injectable()
export class LabReportHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(LabReportHandler.name);

  readonly type = LAB_REPORT_JOB_TYPE;

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
    const payload = labReportPayloadSchema.safeParse(job.payload);

    if (!payload.success) {
      throw new Error(`Invalid ${LAB_REPORT_JOB_TYPE} payload: expected { intakeId }`);
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
      this.logger.log(`Lab report intake ${intakeId} no longer exists; job ${job.id} is a no-op`);
      return;
    }

    if (intake.status !== 'scanning') {
      this.logger.log(`Lab report intake ${intakeId} is ${intake.status}; job ${job.id} is a no-op`);
      return;
    }

    if (intake.kind !== LAB_REPORT_KIND) {
      await this.intakes.failIntake(intakeId, LAB_REPORT_READ_FAILED, GENERIC_FAILURE);
      throw new Error(`Photo intake ${intakeId} is a ${intake.kind} intake, not ${LAB_REPORT_KIND}`);
    }

    if (!intake.provider || !intake.modelId) {
      await this.intakes.failIntake(intakeId, 'AI_INVALID_REQUEST', 'No AI model was chosen.');
      return;
    }

    const inputs: IntakeAnalyzerInput[] = intake.photos.map((photo) => ({
      storageObjectId: photo.storageObjectId,
      mimeType: photo.storageObject?.mimeType ?? null,
    }));
    const photoIds = inputs.map((input) => input.storageObjectId);
    const hasPdf = inputs.some((input) => isPdfInput(input));

    if (photoIds.length === 0) {
      await this.intakes.failIntake(intakeId, 'AI_INVALID_REQUEST', 'Attach a lab report first.');
      return;
    }

    const span = trace.getActiveSpan();
    const inputKind = inputKindAttribute(inputs.map((input) => (isPdfInput(input) ? 'pdf' : 'image')));
    if (inputKind) span?.setAttribute(INTAKE_INPUT_KIND_SPAN_ATTRIBUTE, inputKind);
    span?.setAttribute(LAB_REPORT_SPAN_ATTRIBUTES.inputCount, photoIds.length);

    // One request: at most LAB_REPORT_MAX_PHOTOS (10) inputs, inside the 16-input cap.
    const content: AiContentPart[] = [
      { type: 'text', text: labReportUserText(photoIds.length, hasPdf) },
      ...numberedInputParts(inputs, 1),
    ];

    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new Error('Lab report reading timed out')), CALL_DEADLINE_MS);
    deadline.unref?.();

    let output: LabReportOutput;

    try {
      const { parsed } = await this.ai.forUser(intake.userId, { jobId: job.id }).respondStructured(
        {
          provider: intake.provider,
          model: intake.modelId,
          schema: labReportOutputSchema,
          schemaName: LAB_REPORT_SCHEMA_NAME,
          strict: true,
          instructions: LAB_REPORT_INSTRUCTIONS,
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

    const { drafts, document, resultMeta } = mapLabReportOutput(output, photoIds);
    span?.setAttribute(LAB_REPORT_SPAN_ATTRIBUTES.draftCount, drafts.length);
    span?.setAttribute(LAB_REPORT_SPAN_ATTRIBUTES.unmatchedCount, resultMeta.unmatched);

    // The report's date and lab fill the context; a field the model could not
    // read keeps what the intake had (the user may have typed it).
    const previous = (intake.context ?? {}) as Record<string, unknown>;
    const context = {
      ...previous,
      ...(document.collectionDate ? { collectionDate: document.collectionDate } : {}),
      ...(document.labName ? { labName: document.labName } : {}),
    };

    try {
      const stored = await this.intakes.replaceAiDrafts(intakeId, drafts, { resultMeta, context });

      this.logger.log(
        `Lab report intake ${intakeId}: ${stored.inserted} result(s) drafted, ${resultMeta.unmatched} unmatched, ` +
          `${stored.invalid.length} invalid (job ${job.id})`,
      );
    } catch (err) {
      if (err instanceof HttpException) {
        this.logger.log(`Lab report intake ${intakeId} changed while it was read (${err.getStatus()}); result discarded`);
        return;
      }

      await this.intakes.failIntake(intakeId, LAB_REPORT_READ_FAILED, GENERIC_FAILURE);
      throw err;
    }
  }

  /** A job that settled FAILED while its intake is still `scanning` fails the intake (only its current job may). */
  @OnEvent(JOB_SETTLED_EVENT)
  async onJobSettled(event: JobSettledEvent): Promise<void> {
    if (event.type !== LAB_REPORT_JOB_TYPE || event.succeeded) return;
    if (event.subjectType !== PHOTO_INTAKE_SUBJECT_TYPE || !event.subjectId) return;

    try {
      const intake = await this.prisma.photoIntake.findUnique({
        where: { id: event.subjectId },
        select: { status: true, jobId: true },
      });

      if (!intake || intake.status !== 'scanning' || (intake.jobId && intake.jobId !== event.jobId)) return;

      await this.intakes.failIntake(event.subjectId, 'AI_PROVIDER_UNAVAILABLE', 'The lab report reading stopped before it finished.');
    } catch (error) {
      this.logger.warn(
        `Could not mark lab report intake ${event.subjectId} failed after job ${event.jobId} settled: ` +
          (error instanceof Error ? error.name : 'unknown error'),
      );
    }
  }

  /** The model call failed: defer, fail quietly, or fail and throw (see the header). */
  private async settleAiFailure(intakeId: string, jobId: string, err: unknown, hasPdf: boolean): Promise<void> {
    const aiError = err instanceof AiError ? err : aiErrorFromStorage(err);

    if (!aiError) {
      await this.intakes.failIntake(intakeId, LAB_REPORT_READ_FAILED, GENERIC_FAILURE);
      throw err;
    }

    const rateLimit = aiError.toRateLimitError();

    if (rateLimit) {
      throw rateLimit;
    }

    await this.intakes.failIntake(intakeId, aiError.code, failureMessage(aiError, hasPdf));

    if (AI_RUN_TERMINAL_CODES.has(aiError.code)) {
      const details = aiErrorLogDetails(aiError);
      const line = `Lab report intake ${intakeId} ended with ${aiError.code} (job ${jobId})${details ? ` ${details}` : ''}`;

      // A provider refusing the request is worth an operator's look (#301).
      if (aiError.code === 'AI_INVALID_REQUEST') this.logger.warn(line);
      else this.logger.log(line);

      return;
    }

    throw err;
  }
}
