// =============================================================================
// `storage.object.process` — post-upload object processing, as a queue job
// (issue #520)
// =============================================================================
//
// Before #520 an upload emitted `storage.object.uploaded` and
// `ObjectProcessingService` did the processing inside an `@OnEvent(..., {
// async: true })` listener: it downloaded the object and ran every applicable
// processor on the event loop, holding no worker slot, bounded by no timeout,
// retried by nothing, visible nowhere, and — if the process died half way —
// leaving the object `processing` for ever. CLAUDE.md's "every long-running
// activity is a queue job" names that exact shape ("an `@OnEvent` body that
// downloads") as a violation.
//
// WHAT CHANGED IS THE EXECUTOR, NOT THE PROCESSING. `ObjectsService` decides at
// upload time whether any processor applies; only then is this job enqueued,
// and `process` below runs `ObjectProcessingService.run` — the same loop, the
// same metadata merge, the same `ready`/`failed` outcome the listener wrote.
//
// -----------------------------------------------------------------------------
// FAILURE: WHAT RETRIES, AND WHAT ENDS THE OBJECT
// -----------------------------------------------------------------------------
//
//   * A PROCESSOR reporting failure, or throwing, is recorded on the row and
//     the object is marked `failed` — exactly as before. The job succeeds: the
//     processing ran to a verdict, and that verdict is on the row.
//   * Anything OUTSIDE the processors (reading or writing the row) throws, and
//     the queue retries it with backoff.
//   * When the job GIVES UP — its attempt budget spent, its timeout hit, or its
//     executor dead and the lease reaper out of patience — `onJobSettled`
//     below marks a still-`processing` object `failed`. That is a
//     `job.settled` listener rather than an "is this my last attempt?" check
//     inside `process`, because two of those three endings never return into
//     `process` at all. `BroadcastFailureListener` and the AI media handlers'
//     `failOrphanedRun` are the precedents.
//   * An object DELETED before its job ran is not a failure: there is nothing
//     left to process, and retrying a missing row to exhaustion would only
//     page an administrator about a user tidying up. The job succeeds and says
//     so in the log.
//
// SERVER-ONLY BY DERIVATION: neither `nodeResultSchema` nor `persistNodeResult`.
// Processors are in-process DI classes registered under `OBJECT_PROCESSOR`; a
// worker node cannot construct them, and the run writes the row as it goes.
//
// NO PROFILE: a processor run is short and idempotent (it rewrites the same
// row from the same bytes), so the deployment-wide ceiling and attempt budget
// fit it.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { Job, StorageObject } from '@prisma/client';

import { JOB_SETTLED_EVENT, type JobSettledEvent } from '../../jobs/events/job-settled.event';
import { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { ObjectProcessingService } from '../processing/object-processing.service';
import {
  JobInputResolutionError,
  resolveStorageObjectInput,
  STORAGE_OBJECT_SUBJECT_TYPE,
} from '../storage-job-input';

/**
 * The handler key, and therefore the `Job.type` every object-processing row
 * carries. PERMANENT — rows outlive handlers. Exported so `ObjectsService`
 * enqueues the same string this handler registers.
 */
export const STORAGE_OBJECT_PROCESS_TYPE = 'storage.object.process';

/**
 * Cap on the job error quoted into the object's metadata on give-up. The full
 * message stays on the job row.
 */
const MAX_QUOTED_ERROR_LENGTH = 500;

@Injectable()
export class StorageObjectProcessHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(StorageObjectProcessHandler.name);

  readonly type = STORAGE_OBJECT_PROCESS_TYPE;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly processing: ObjectProcessingService,
  ) {}

  /** Self-registration — the only wiring a handler needs. */
  onModuleInit(): void {
    this.registry.register(this);
  }

  /**
   * Runs the applicable processors against the job's object and writes the
   * outcome to its row. Throws (so the queue retries) only for failures
   * outside the processors — see the file header.
   */
  async process(job: Job): Promise<void> {
    let object: StorageObject;

    try {
      object = await resolveStorageObjectInput(this.prisma, job);
    } catch (error) {
      if (error instanceof JobInputResolutionError && error.reason === 'input_object_not_found') {
        this.logger.warn(
          `Object processing job ${job.id}: storage object ${error.subjectId} no longer ` +
            'exists (deleted after upload); nothing to process'
        );

        return;
      }

      throw error;
    }

    const outcome = await this.processing.run(object);

    this.logger.log(`Object processing job ${job.id}: object ${object.id} is ${outcome}`);
  }

  /**
   * A job settled. If it was one of ours and it GAVE UP, fail its object when
   * the object still reads `processing`, so it never stays there for ever.
   *
   * One bounded row (see `ObjectProcessingService.markAbandoned`), and it
   * never throws back into the emitter: a listener must not affect the job row
   * that was just written.
   */
  @OnEvent(JOB_SETTLED_EVENT)
  async onJobSettled(event: JobSettledEvent): Promise<void> {
    if (event.type !== this.type || event.succeeded) return;
    if (event.subjectType !== STORAGE_OBJECT_SUBJECT_TYPE || !event.subjectId) return;

    const cause = truncate(event.lastError ?? 'no error recorded', MAX_QUOTED_ERROR_LENGTH);

    try {
      await this.processing.markAbandoned(
        event.subjectId,
        `Processing job ${event.jobId} failed permanently: ${cause}`
      );
    } catch (error) {
      this.logger.error(
        `Could not mark storage object ${event.subjectId} failed after processing job ` +
          `${event.jobId} gave up; it may still read 'processing': ` +
          (error instanceof Error ? error.message : String(error))
      );
    }
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
