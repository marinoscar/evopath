// =============================================================================
// `ai.workout.prefill` job handler — "Prefill from photo" (E4.5)
// =============================================================================
//
// Payload `{ intakeId }`, subjectType `'photo_intake'`. Enqueued by
// `IntakeService.analyze` for a `workout_prefill` intake, in the transaction
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
// STEPS. Load the intake (must be `scanning`) with its photos (sortOrder) and
// its context's `sourceHint`, the user's Health Profile unit (imperial -> lb,
// otherwise kg; `metric` without a profile) and the exercise library
// vocabulary; send the photos in chunks of 16 one after the other; map each
// chunk's items to drafts (weights converted to kilograms); merge across
// chunks (a placard photographed twice); hand every draft to
// `IntakeService.replaceAiDrafts` (intake -> `ready`). The runtime resolves
// each `storageObjectId` (ownership, readiness, size) and delivers it the
// adapter's way; this handler never reads bytes or builds URLs.
//
// OUTCOMES are those of `runChunkedAnalysis` (`intake/intake-analyzer.ts`),
// the same as `ai.equipment.scan`: rate limit defers; a terminal code on the
// first chunk fails the intake and the job RETURNS; on a later chunk the
// earlier drafts are kept and `resultMeta.failedChunks` names it; anything
// else fails the intake and THROWS.
//
// SAFETY NET. A job that settles FAILED while its intake is still `scanning`
// fails the intake from the `JOB_SETTLED_EVENT` listener, so no scan spins
// forever.
//
// LOGGING. Ids, counts and durations only; never prompt text, photo content,
// URLs, bytes or keys. The Health Profile is read for its unit only.
// =============================================================================

import { ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { Job } from '@prisma/client';
import { z } from 'zod';

import type { AiContentPart } from '../../ai/core';
import { AiService } from '../../ai/runtime/ai.service';
import {
  PHOTO_INTAKE_SUBJECT_TYPE,
  buildPhotoContent,
  chunkPhotos,
  intakeAnalyzerPayloadSchema,
  runChunkedAnalysis,
  type FailedAnalyzerChunk,
} from '../../intake/intake-analyzer';
import { IntakeService } from '../../intake/intake.service';
import { JOB_SETTLED_EVENT, JobSettledEvent } from '../../jobs/events/job-settled.event';
import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { ExerciseVocabularyService } from './exercise-vocabulary';
import {
  mapPrefillItems,
  mergePrefillChunks,
  weightUnitFor,
  type WeightUnit,
  type WorkoutPrefillDraft,
} from './workout-prefill.mapper';
import {
  WORKOUT_PREFILL_CHUNK_SIZE,
  WORKOUT_PREFILL_PROMPT_VERSION,
  WORKOUT_PREFILL_SCHEMA_NAME,
  WORKOUT_PREFILL_SOURCE_HINTS,
  buildWorkoutPrefillInstructions,
  buildWorkoutPrefillOutputSchema,
  buildWorkoutPrefillReminder,
  type WorkoutPrefillOutput,
  type WorkoutPrefillSourceHint,
  type WorkoutPrefillSourceKind,
} from './workout-prefill.prompt';

/** PERMANENT once jobs of this type exist. */
export const WORKOUT_PREFILL_JOB_TYPE = 'ai.workout.prefill';

export const workoutPrefillPayloadSchema = intakeAnalyzerPayloadSchema;

const MAX_RUNTIME_MS = 10 * 60_000;
/** The analysis's own deadline: a little inside the job's, so the intake records it cleanly. */
const PREFILL_DEADLINE_MS = MAX_RUNTIME_MS - 15_000;
/** The most ignored notes kept in `resultMeta` across chunks. */
const IGNORED_NOTES_MAX = 20;

const sourceHintSchema = z.object({ sourceHint: z.enum(WORKOUT_PREFILL_SOURCE_HINTS) });

/** What `PhotoIntake.resultMeta` records for a prefill (diagnostics and review hints; never content of photos beyond these). */
export interface WorkoutPrefillResultMeta {
  promptVersion: number;
  chunks: number;
  photoCount: number;
  /** What the first analyzed chunk showed, or null when no chunk was analyzed. */
  sourceKind: WorkoutPrefillSourceKind | null;
  /** Every distinct `sourceKind` across the chunks, in order. */
  sourceKinds: WorkoutPrefillSourceKind[];
  /** The first title the model read (e.g. "Push day"); the web offers it as the workout name on click only. */
  suggestedName: string | null;
  ignoredNotes: string[];
  /** The unit a weight without a written unit was read in (from the Health Profile). */
  assumedWeightUnit: WeightUnit;
  failedChunks: FailedAnalyzerChunk[];
}

/** `Photo 0:`, image, `Photo 1:`, image, ..., the reminder (with the user's source hint). */
export function buildPrefillContent(
  storageObjectIds: readonly string[],
  sourceHint: WorkoutPrefillSourceHint | null,
): AiContentPart[] {
  return buildPhotoContent(storageObjectIds, buildWorkoutPrefillReminder(sourceHint));
}

/** The `sourceHint` of an intake's stored context, or null. */
export function sourceHintOf(context: unknown): WorkoutPrefillSourceHint | null {
  const parsed = sourceHintSchema.safeParse(context);
  return parsed.success ? parsed.data.sourceHint : null;
}

function addIgnored(target: string[], notes: readonly string[]): void {
  for (const note of notes) {
    const trimmed = note.trim();
    if (!trimmed || target.length >= IGNORED_NOTES_MAX) continue;
    if (!target.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) target.push(trimmed);
  }
}

@Injectable()
export class WorkoutPrefillHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(WorkoutPrefillHandler.name);

  readonly type = WORKOUT_PREFILL_JOB_TYPE;

  readonly profile: JobExecutionProfile = { maxRuntimeMs: MAX_RUNTIME_MS, maxAttempts: 1 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly ai: AiService,
    private readonly intakes: IntakeService,
    private readonly vocabulary: ExerciseVocabularyService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const parsed = workoutPrefillPayloadSchema.safeParse(job.payload);

    if (!parsed.success) {
      throw new Error(`Invalid ${WORKOUT_PREFILL_JOB_TYPE} payload: expected { intakeId }`);
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
        context: true,
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
    const sourceHint = sourceHintOf(intake.context);
    const profile = await this.prisma.healthProfile.findUnique({
      where: { userId: intake.userId },
      select: { unitSystem: true },
    });
    const profileUnit = weightUnitFor(profile?.unitSystem);
    const vocab = await this.vocabulary.load();
    const schema = buildWorkoutPrefillOutputSchema(vocab);
    const instructions = buildWorkoutPrefillInstructions(vocab);
    const chunks = chunkPhotos(photoIds, WORKOUT_PREFILL_CHUNK_SIZE);
    const client = this.ai.forUser(intake.userId, { jobId: job.id });

    const run = await runChunkedAnalysis<WorkoutPrefillOutput>({
      intakeId,
      jobId: job.id,
      label: 'Workout prefill',
      chunks,
      deadlineMs: PREFILL_DEADLINE_MS,
      logger: this.logger,
      stillScanning: () => this.stillScanning(intakeId),
      failIntake: (code, message) => this.intakes.failIntake(intakeId, code, message),
      call: async (chunk, _index, signal) => {
        const response = await client.respondStructured(
          {
            provider: intake.provider ?? undefined,
            model: intake.modelId ?? undefined,
            schema,
            schemaName: WORKOUT_PREFILL_SCHEMA_NAME,
            strict: true,
            instructions,
            input: [{ type: 'message', role: 'user', content: buildPrefillContent(chunk, sourceHint) }],
          },
          { signal },
        );
        // `parsed` is always present on success; the schema re-check is the
        // handler's own guarantee, whatever the adapter did.
        return schema.parse(response.parsed);
      },
    });

    if (run.stopped) {
      return;
    }

    const drafts: WorkoutPrefillDraft[][] = [];
    const ignoredNotes: string[] = [];
    const sourceKinds: WorkoutPrefillSourceKind[] = [];
    let suggestedName: string | null = null;

    for (const { chunk, output } of run.outputs) {
      drafts.push(mapPrefillItems(output.items, chunk, vocab, profileUnit));
      addIgnored(ignoredNotes, output.ignoredNotes);
      if (!sourceKinds.includes(output.sourceKind)) sourceKinds.push(output.sourceKind);
      suggestedName ??= output.suggestedName?.trim() || null;
    }

    const items = mergePrefillChunks(drafts);
    const resultMeta: WorkoutPrefillResultMeta = {
      promptVersion: WORKOUT_PREFILL_PROMPT_VERSION,
      chunks: chunks.length,
      photoCount: photoIds.length,
      sourceKind: sourceKinds[0] ?? null,
      sourceKinds,
      suggestedName,
      ignoredNotes,
      assumedWeightUnit: profileUnit,
      failedChunks: run.failedChunks,
    };

    try {
      const result = await this.intakes.replaceAiDrafts(intakeId, items, {
        resultMeta: resultMeta as unknown as Record<string, unknown>,
      });
      this.logger.log(
        `Intake ${intakeId} prefilled: ${photoIds.length} photos in ${chunks.length} request(s), ` +
          `${result.inserted} drafts stored, ${result.invalid.length} invalid, ${run.failedChunks.length} chunk(s) failed, ` +
          `${Date.now() - started}ms (job ${job.id})`,
      );
    } catch (error) {
      // Discarded mid-scan (404), or another writer settled it (409): the result is dropped.
      if (error instanceof NotFoundException || error instanceof ConflictException) {
        this.logger.log(`Intake ${intakeId} changed while it was analyzed; the prefill result is discarded`);
        return;
      }
      throw error;
    }
  }

  /** See the file header's SAFETY NET. One conditional update; a no-op for a settled intake. */
  @OnEvent(JOB_SETTLED_EVENT)
  async onJobSettled(event: JobSettledEvent): Promise<void> {
    if (event.type !== WORKOUT_PREFILL_JOB_TYPE || event.succeeded) return;
    if (event.subjectType !== PHOTO_INTAKE_SUBJECT_TYPE || !event.subjectId) return;

    try {
      await this.intakes.failIntake(
        event.subjectId,
        'AI_PROVIDER_UNAVAILABLE',
        'The background job ended before the analysis completed.',
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
