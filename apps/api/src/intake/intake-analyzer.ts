import type { Logger } from '@nestjs/common';
import { z } from 'zod';

import { AiError, type AiContentPart, type AiErrorCode } from '../ai/core';
import { AI_STORAGE_INPUTS_MAX } from '../ai/core/types/file-inputs.types';
import { AI_RUN_TERMINAL_CODES } from '../ai/runtime/ai-response-run.handler';
import { aiErrorFromStorage } from '../ai/storage/ai-storage-errors';
import { declaredInputKind } from './intake-inputs';

// =============================================================================
// Shared helpers for chunked photo-intake analyzer jobs (E3.4, E4.5)
// =============================================================================
//
// An analyzer job (`ai.equipment.scan`, `ai.workout.prefill`) sends an
// intake's photos to a vision model in chunks of 16 (the platform's cap on
// stored inputs per request), one chunk after the other, and turns each
// chunk's structured output into draft items. The chunk loop, its deadline and
// its error handling are the same for every kind, so they live here:
//
//   - AI_RATE_LIMITED                      the deferral error is THROWN (nothing
//                                          was written; the re-run is clean)
//   - a terminal code on the first chunk   intake `failed` with that code; the
//     (AI_RUN_TERMINAL_CODES)              run ends as `stopped` (the job returns)
//   - a terminal code on a later chunk     recorded in `failedChunks`; the other
//                                          chunks' outputs are kept
//   - anything else                        intake `failed`; the error is THROWN
//   - the deadline                         intake `failed` (AI_PROVIDER_UNAVAILABLE);
//                                          an error is THROWN
//   - the intake stops scanning between    the run ends as `stopped`
//     chunks (discarded, settled)
//
// INPUTS (H2, #186). An attached file is an image or, for a kind that accepts
// them, a PDF. `intakeInputPart` maps each to its content part: an image to
// `{ type: 'image', storageObjectId, detail: 'high' }`, a PDF to
// `{ type: 'file', storageObjectId }` (the runtime resolves both under the
// owner's authorization and hands the provider what its delivery strategy
// needs). A PDF counts as ONE input towards the 16-per-request chunk, however
// many pages it has; the attach already capped its pages.
//
// A model output that does not match the handler's schema (a `ZodError` from
// the `call`) is AI_STRUCTURED_OUTPUT_INVALID, terminal.
//
// LOGGING. Ids, counts and codes only; never prompt text, URLs, bytes or keys.
// =============================================================================

/** `Job.subjectType` of an analyzer job: the intake it analyzes. */
export const PHOTO_INTAKE_SUBJECT_TYPE = 'photo_intake';

/** The most photos one analyzer request carries. */
export const INTAKE_ANALYZER_CHUNK_SIZE = AI_STORAGE_INPUTS_MAX;

/** The payload every analyzer job is enqueued with by `IntakeService.analyze`. */
export const intakeAnalyzerPayloadSchema = z.object({
  intakeId: z.string().uuid(),
});

/** A chunk that could not be analyzed; the other chunks' drafts were kept. */
export interface FailedAnalyzerChunk {
  /** 0-based chunk number. */
  index: number;
  code: AiErrorCode;
  /** 0-based photo positions (intake `sortOrder` order) the chunk covered, inclusive. */
  firstPhotoIndex: number;
  lastPhotoIndex: number;
}

export function chunkPhotos<T>(items: readonly T[], size = INTAKE_ANALYZER_CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

/** One attached file as the analyzer sees it: its storage object and declared MIME type. */
export interface IntakeAnalyzerInput {
  storageObjectId: string;
  /** The storage object's MIME type; omitted or unknown = an image, as before H2. */
  mimeType?: string | null;
}

/** Whether an input is a PDF (by its declared MIME type, which the attach verified against the bytes). */
export function isPdfInput(input: IntakeAnalyzerInput | string): boolean {
  return typeof input !== 'string' && declaredInputKind(input.mimeType) === 'pdf';
}

/** The content part for one input: a `file` part for a PDF, a high-detail `image` part otherwise. */
export function intakeInputPart(input: IntakeAnalyzerInput | string): AiContentPart {
  const storageObjectId = typeof input === 'string' ? input : input.storageObjectId;

  return isPdfInput(input)
    ? { type: 'file', storageObjectId }
    : { type: 'image', storageObjectId, detail: 'high' };
}

/**
 * A text label then the input's part, per input: `Photo <n>:` for an image,
 * `Photo <n> (PDF document):` for a PDF, numbered from `first`.
 */
export function numberedInputParts(inputs: readonly (IntakeAnalyzerInput | string)[], first = 0): AiContentPart[] {
  return inputs.flatMap((input, index): AiContentPart[] => {
    const n = index + first;
    return [
      { type: 'text', text: isPdfInput(input) ? `Photo ${n} (PDF document):` : `Photo ${n}:` },
      intakeInputPart(input),
    ];
  });
}

/**
 * `Photo 0:`, image, `Photo 1 (PDF document):`, file, ..., then the closing
 * reminder. A bare string is a storage object id of an image.
 */
export function buildPhotoContent(
  inputs: readonly (IntakeAnalyzerInput | string)[],
  reminder: string,
): AiContentPart[] {
  const content = numberedInputParts(inputs);

  content.push({ type: 'text', text: reminder });

  return content;
}

/**
 * The chunk's storage object ids an item names by 0-based index. Out-of-range
 * indexes are dropped, and an item with none left points at every photo of
 * the chunk.
 */
export function sourcePhotoIdsFor(indexes: readonly number[], chunkPhotoIds: readonly string[]): string[] {
  const ids: string[] = [];

  for (const index of indexes) {
    const id = Number.isInteger(index) ? chunkPhotoIds[index] : undefined;
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }

  return ids.length > 0 ? ids : [...chunkPhotoIds];
}

/** Any failure of one analyzer call as an `AiError`. */
export function toAnalyzerError(err: unknown): AiError {
  if (err instanceof z.ZodError) {
    return new AiError('AI_STRUCTURED_OUTPUT_INVALID', 'The model output does not match the requested schema.');
  }
  return aiErrorFromStorage(err) ?? AiError.wrap(err);
}

export interface ChunkedAnalysisOptions<TOutput> {
  intakeId: string;
  jobId: string;
  /** For log lines and the deadline error, e.g. `'Equipment scan'`. */
  label: string;
  /** The photos (storage object ids) in chunks, from `chunkPhotos`. */
  chunks: readonly (readonly string[])[];
  /** The run's own deadline; keep it a little inside the job's `maxRuntimeMs`. */
  deadlineMs: number;
  logger: Logger;
  /** One model request for one chunk; returns the schema-checked output. */
  call(chunk: readonly string[], index: number, signal: AbortSignal): Promise<TOutput>;
  /** Whether the intake is still `scanning` (checked before every chunk after the first). */
  stillScanning(): Promise<boolean>;
  /** `IntakeService.failIntake` for this intake. */
  failIntake(code: string, message: string): Promise<unknown>;
}

export interface ChunkOutput<TOutput> {
  index: number;
  chunk: readonly string[];
  output: TOutput;
}

export type ChunkedAnalysisResult<TOutput> =
  | { stopped: false; outputs: ChunkOutput<TOutput>[]; failedChunks: FailedAnalyzerChunk[] }
  | { stopped: true };

/** Runs the chunks one after the other; see the file header for the outcomes. */
export async function runChunkedAnalysis<TOutput>(
  options: ChunkedAnalysisOptions<TOutput>,
): Promise<ChunkedAnalysisResult<TOutput>> {
  const { intakeId, jobId, label, chunks, logger } = options;
  const controller = new AbortController();
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`${label} timed out`));
  }, options.deadlineMs);
  deadline.unref?.();

  const outputs: ChunkOutput<TOutput>[] = [];
  const failedChunks: FailedAnalyzerChunk[] = [];
  let firstPhotoIndex = 0;

  try {
    for (const [index, chunk] of chunks.entries()) {
      const chunkStart = firstPhotoIndex;
      firstPhotoIndex += chunk.length;

      if (index > 0 && !(await options.stillScanning())) {
        logger.log(`Intake ${intakeId} stopped scanning before chunk ${index}; job ${jobId} ends`);
        return { stopped: true };
      }

      try {
        outputs.push({ index, chunk, output: await options.call(chunk, index, controller.signal) });
      } catch (err) {
        if (timedOut) {
          await options.failIntake('AI_PROVIDER_UNAVAILABLE', 'The scan timed out.');
          throw new Error(`${label} of intake ${intakeId} exceeded its ${options.deadlineMs}ms deadline`);
        }

        const error = toAnalyzerError(err);
        const rateLimit = error.toRateLimitError();

        if (rateLimit) {
          logger.log(`Intake ${intakeId} ${label.toLowerCase()} rate limited at chunk ${index}; job ${jobId} is deferred`);
          throw rateLimit;
        }

        if (AI_RUN_TERMINAL_CODES.has(error.code) && index > 0) {
          logger.log(`Intake ${intakeId} chunk ${index}/${chunks.length} ended with ${error.code}; kept the rest`);
          failedChunks.push({
            index,
            code: error.code,
            firstPhotoIndex: chunkStart,
            lastPhotoIndex: chunkStart + chunk.length - 1,
          });
          continue;
        }

        await options.failIntake(error.code, error.message);

        if (AI_RUN_TERMINAL_CODES.has(error.code)) {
          logger.log(`Intake ${intakeId} ${label.toLowerCase()} ended with ${error.code} (job ${jobId})`);
          return { stopped: true };
        }

        // The original error, so the job's `lastError` says what really happened.
        throw err;
      }
    }
  } finally {
    clearTimeout(deadline);
  }

  return { stopped: false, outputs, failedChunks };
}
