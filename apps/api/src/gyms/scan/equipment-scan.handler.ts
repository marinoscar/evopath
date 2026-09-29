// =============================================================================
// `ai.equipment.scan` job handler — "Scan gym" (E3.4)
// =============================================================================
//
// Payload `{ intakeId }`, subjectType `'photo_intake'`. Enqueued by
// `IntakeService.analyze` for a `gym_equipment` intake, in the transaction
// that flips it to `scanning`.
//
// SERVER-ONLY, PERMANENTLY. No `nodeResultSchema`/`persistNodeResult`: the
// call spends the user's own provider key (or the org key), and no AI key may
// ever reach a worker node (CLAUDE.md AI rule 3).
//
// PROFILE `{ maxRuntimeMs: 10 min, maxAttempts: 1 }`: a model call is billed,
// so it is never retried blindly. A provider throttle DEFERS the job instead
// (nothing is written before the last request returns, so the re-run is clean).
//
// STEPS. Load the intake and its photos (sortOrder), load the vocabulary, send
// the photos in chunks of 16 (the platform's cap on stored inputs per request)
// one after the other, map each chunk's items to drafts, merge across chunks,
// and hand every draft to `IntakeService.replaceAiDrafts` (intake -> `ready`).
// The runtime resolves each `storageObjectId` (ownership, readiness, size) and
// delivers it the adapter's way; this handler never reads bytes or builds URLs.
//
// OUTCOMES (the idioms of `ai-response-run.handler.ts`):
//
//   - intake gone or no longer `scanning`   no-op (discarded, or settled)
//   - AI_RATE_LIMITED                        job deferred, nothing written
//   - a terminal code on the first chunk     intake `failed` with that code;
//     (AI_RUN_TERMINAL_CODES: kill switch,   the job RETURNS (no retry, no
//     key, model, bad output, a photo        `jobs.job_failed`)
//     deleted since analyze, ...)
//   - a terminal code on a later chunk       the earlier chunks' drafts are
//                                            kept; `resultMeta.failedChunks`
//                                            names the chunk; intake `ready`
//   - anything else (provider down, a bug)   intake `failed`; the job THROWS
//
// SAFETY NET. A job that settles FAILED while its intake is still `scanning`
// (the worker's own timeout, a rate-limit budget exhausted, a crash) fails the
// intake from the `JOB_SETTLED_EVENT` listener, so no scan spins forever.
//
// LOGGING. Ids, counts and durations only; never prompt text, URLs, bytes or keys.
// =============================================================================

import { ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { Job } from '@prisma/client';
import { z } from 'zod';

import { AiError, type AiContentPart, type AiErrorCode } from '../../ai/core';
import { AI_RUN_TERMINAL_CODES } from '../../ai/runtime/ai-response-run.handler';
import { AiService } from '../../ai/runtime/ai.service';
import { aiErrorFromStorage } from '../../ai/storage/ai-storage-errors';
import { IntakeService } from '../../intake/intake.service';
import { JOB_SETTLED_EVENT, JobSettledEvent } from '../../jobs/events/job-settled.event';
import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { EQUIPMENT_SCAN_JOB_TYPE } from '../intake/gym-equipment.intake-kind';
import { mapScanItems, type EquipmentScanDraft } from './equipment-scan.mapper';
import { mergeChunkDrafts } from './equipment-scan.merge';
import {
  EQUIPMENT_SCAN_CHUNK_SIZE,
  EQUIPMENT_SCAN_PROMPT_VERSION,
  EQUIPMENT_SCAN_REMINDER,
  EQUIPMENT_SCAN_SCHEMA_NAME,
  buildEquipmentScanInstructions,
  buildEquipmentScanOutputSchema,
  type EquipmentScanOutput,
} from './equipment-scan.prompt';
import { EquipmentVocabularyService } from './equipment-vocabulary';

export const equipmentScanPayloadSchema = z.object({
  intakeId: z.string().uuid(),
});

export const PHOTO_INTAKE_SUBJECT_TYPE = 'photo_intake';

const MAX_RUNTIME_MS = 10 * 60_000;
/** The scan's own deadline: a little inside the job's, so the intake records it cleanly. */
const SCAN_DEADLINE_MS = MAX_RUNTIME_MS - 15_000;
/** The most ignored-object names kept in `resultMeta` across chunks. */
const IGNORED_OBJECTS_MAX = 20;

/** A chunk that could not be analyzed; the other chunks' drafts were kept. */
export interface FailedScanChunk {
  /** 0-based chunk number. */
  index: number;
  code: AiErrorCode;
  /** 0-based photo positions (intake `sortOrder` order) the chunk covered, inclusive. */
  firstPhotoIndex: number;
  lastPhotoIndex: number;
}

/** What `PhotoIntake.resultMeta` records for a scan (diagnostics only). */
export interface EquipmentScanResultMeta {
  promptVersion: number;
  chunks: number;
  photoCount: number;
  ignoredObjects: string[];
  failedChunks: FailedScanChunk[];
}

export function chunkPhotos<T>(items: readonly T[], size = EQUIPMENT_SCAN_CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

/** `Photo 0:`, image, `Photo 1:`, image, ..., the reminder. */
export function buildScanContent(storageObjectIds: readonly string[]): AiContentPart[] {
  const content: AiContentPart[] = [];

  storageObjectIds.forEach((storageObjectId, index) => {
    content.push({ type: 'text', text: `Photo ${index}:` });
    content.push({ type: 'image', storageObjectId, detail: 'high' });
  });

  content.push({ type: 'text', text: EQUIPMENT_SCAN_REMINDER });

  return content;
}

function addIgnored(target: string[], names: readonly string[]): void {
  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed || target.length >= IGNORED_OBJECTS_MAX) continue;
    if (!target.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) target.push(trimmed);
  }
}

@Injectable()
export class EquipmentScanHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(EquipmentScanHandler.name);

  readonly type = EQUIPMENT_SCAN_JOB_TYPE;

  readonly profile: JobExecutionProfile = { maxRuntimeMs: MAX_RUNTIME_MS, maxAttempts: 1 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly ai: AiService,
    private readonly intakes: IntakeService,
    private readonly vocabulary: EquipmentVocabularyService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const parsed = equipmentScanPayloadSchema.safeParse(job.payload);

    if (!parsed.success) {
      throw new Error(`Invalid ${EQUIPMENT_SCAN_JOB_TYPE} payload: expected { intakeId }`);
    }

    const { intakeId } = parsed.data;
    const intake = await this.prisma.photoIntake.findUnique({
      where: { id: intakeId },
      select: {
        id: true,
        userId: true,
        status: true,
        provider: true,
        modelId: true,
        photos: {
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          select: { storageObjectId: true },
        },
      },
    });

    if (!intake) {
      this.logger.log(`Intake ${intakeId} no longer exists; job ${job.id} is a no-op`);
      return;
    }

    if (intake.status !== 'scanning') {
      this.logger.log(`Intake ${intakeId} is ${intake.status}; job ${job.id} is a no-op`);
      return;
    }

    const photoIds = intake.photos.map((photo) => photo.storageObjectId);

    if (photoIds.length === 0) {
      await this.intakes.failIntake(intakeId, 'AI_INVALID_REQUEST', 'The intake has no photos to analyze.');
      return;
    }

    const started = Date.now();
    const vocab = await this.vocabulary.load();
    const schema = buildEquipmentScanOutputSchema(vocab);
    const instructions = buildEquipmentScanInstructions(vocab);
    const chunks = chunkPhotos(photoIds);
    const client = this.ai.forUser(intake.userId, { jobId: job.id });

    const controller = new AbortController();
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('Equipment scan timed out'));
    }, SCAN_DEADLINE_MS);
    deadline.unref?.();

    const drafts: EquipmentScanDraft[][] = [];
    const ignoredObjects: string[] = [];
    const failedChunks: FailedScanChunk[] = [];

    try {
      for (const [index, chunk] of chunks.entries()) {
        if (index > 0 && !(await this.stillScanning(intakeId))) {
          this.logger.log(`Intake ${intakeId} stopped scanning before chunk ${index}; job ${job.id} ends`);
          return;
        }

        let output: EquipmentScanOutput;

        try {
          const response = await client.respondStructured(
            {
              provider: intake.provider ?? undefined,
              model: intake.modelId ?? undefined,
              schema,
              schemaName: EQUIPMENT_SCAN_SCHEMA_NAME,
              strict: true,
              instructions,
              input: [{ type: 'message', role: 'user', content: buildScanContent(chunk) }],
            },
            { signal: controller.signal },
          );
          // `parsed` is always present on success; the schema re-check is the
          // handler's own guarantee, whatever the adapter did.
          output = schema.parse(response.parsed);
        } catch (err) {
          if (timedOut) {
            await this.intakes.failIntake(intakeId, 'AI_PROVIDER_UNAVAILABLE', 'The scan timed out.');
            throw new Error(`Equipment scan of intake ${intakeId} exceeded its ${SCAN_DEADLINE_MS}ms deadline`);
          }

          const error =
            err instanceof z.ZodError
              ? new AiError('AI_STRUCTURED_OUTPUT_INVALID', 'The model output does not match the requested schema.')
              : (aiErrorFromStorage(err) ?? AiError.wrap(err));
          const rateLimit = error.toRateLimitError();

          if (rateLimit) {
            this.logger.log(`Intake ${intakeId} scan rate limited at chunk ${index}; job ${job.id} is deferred`);
            throw rateLimit;
          }

          if (AI_RUN_TERMINAL_CODES.has(error.code) && index > 0) {
            this.logger.log(`Intake ${intakeId} chunk ${index}/${chunks.length} ended with ${error.code}; kept the rest`);
            failedChunks.push({
              index,
              code: error.code,
              firstPhotoIndex: index * EQUIPMENT_SCAN_CHUNK_SIZE,
              lastPhotoIndex: index * EQUIPMENT_SCAN_CHUNK_SIZE + chunk.length - 1,
            });
            continue;
          }

          await this.intakes.failIntake(intakeId, error.code, error.message);

          if (AI_RUN_TERMINAL_CODES.has(error.code)) {
            this.logger.log(`Intake ${intakeId} scan ended with ${error.code} (job ${job.id})`);
            return;
          }

          // The original error, so the job's `lastError` says what really happened.
          throw err;
        }

        drafts.push(mapScanItems(output.items, chunk, vocab));
        addIgnored(ignoredObjects, output.ignoredObjects);
      }
    } finally {
      clearTimeout(deadline);
    }

    const items = mergeChunkDrafts(drafts);
    const resultMeta: EquipmentScanResultMeta = {
      promptVersion: EQUIPMENT_SCAN_PROMPT_VERSION,
      chunks: chunks.length,
      photoCount: photoIds.length,
      ignoredObjects,
      failedChunks,
    };

    try {
      const result = await this.intakes.replaceAiDrafts(intakeId, items, {
        resultMeta: resultMeta as unknown as Record<string, unknown>,
      });
      this.logger.log(
        `Intake ${intakeId} scanned: ${photoIds.length} photos in ${chunks.length} request(s), ` +
          `${result.inserted} drafts stored, ${result.invalid.length} invalid, ${failedChunks.length} chunk(s) failed, ` +
          `${Date.now() - started}ms (job ${job.id})`,
      );
    } catch (error) {
      // Discarded mid-scan (404), or another writer settled it (409): the result is dropped.
      if (error instanceof NotFoundException || error instanceof ConflictException) {
        this.logger.log(`Intake ${intakeId} changed while it was scanned; the scan result is discarded`);
        return;
      }
      throw error;
    }
  }

  /** See the file header's SAFETY NET. One conditional update; a no-op for a settled intake. */
  @OnEvent(JOB_SETTLED_EVENT)
  async onJobSettled(event: JobSettledEvent): Promise<void> {
    if (event.type !== EQUIPMENT_SCAN_JOB_TYPE || event.succeeded) return;
    if (event.subjectType !== PHOTO_INTAKE_SUBJECT_TYPE || !event.subjectId) return;

    try {
      await this.intakes.failIntake(
        event.subjectId,
        'AI_PROVIDER_UNAVAILABLE',
        'The background job ended before the scan completed.',
      );
    } catch (error) {
      this.logger.warn(
        `Could not mark intake ${event.subjectId} failed after job ${event.jobId} settled: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private async stillScanning(intakeId: string): Promise<boolean> {
    const row = await this.prisma.photoIntake.findUnique({ where: { id: intakeId }, select: { status: true } });
    return row?.status === 'scanning';
  }
}
