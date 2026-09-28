// =============================================================================
// AiMediaRunHandler — the lifecycle every media run job shares
// (issues #437, #438; docs/specs/ai-platform.md §2.12, §2.20)
// =============================================================================
//
// `ai.image.generate`, `ai.audio.transcribe` (and every later media job) do
// the same thing around ONE facade call: load the `ai_runs` row, claim it,
// run the call under an abort signal (the owner's cancel, the run's own
// deadline), then complete or fail the run. This base class is that
// lifecycle; a subclass supplies only `execute` — the facade call and what
// to keep of its result — plus its type, profile and operations.
//
// Payload `{ runId }`, subjectType `'ai_run'`, enqueued by `AiRunsService
// .create` in the transaction that creates the row.
//
// SERVER-ONLY, PERMANENTLY — no `nodeResultSchema`/`persistNodeResult`
// (CLAUDE.md AI rule 3): the call spends a user's own key, or the org key,
// and neither may reach a worker node.
//
// OUTCOMES follow `ai.response.run` (`AI_RUN_TERMINAL_CODES`: an expected
// refusal fails the run and the job RETURNS; anything else fails the run and
// the job THROWS), plus:
//
//   - storage unconfigured / unwritable    run `failed` AI_STORAGE_UNAVAILABLE
//                                          at once, job returns — an operator
//                                          must act at /admin/settings/storage,
//                                          and no retry (nor rate-limit
//                                          deferral) can fix it (issue #509)
//   - an input deleted or no longer the    run `failed` AI_INVALID_REQUEST,
//     user's since the run was queued       job returns (the user's own doing)
//   - AI_RATE_LIMITED                      run back to `pending`; job deferred
//
// RETRIES. A type whose profile allows more than one attempt (transcription:
// the call is idempotent) gets them for an unexpected failure: while the
// job has attempts left the run goes back to `pending` and the job throws,
// so the queue's retry claims it again; only the last attempt fails the run.
// And a run left `running` under THIS job by a process that died mid-call is
// resumed by the job's next attempt rather than ignored.
//
// CANCELLATION. The owner cancels through `AiRunsService.cancel`: a pending
// run is never started; a running one has its provider call aborted (this
// process at once, another replica on its next poll). Whatever `execute`
// already stored when the cancel won is discarded (`AiMediaRunResult.discard`).
//
// SAFETY NET. A subclass's `@OnEvent(JOB_SETTLED_EVENT)` listener calls
// `failOrphanedRun`: a job that settled FAILED while its run is still active
// (the worker's own timeout, a rate-limit budget exhausted, a crash) must not
// leave the run `pending`/`running` forever.
// =============================================================================

import { Logger, OnModuleInit } from '@nestjs/common';
import type { Job, Prisma } from '@prisma/client';
import { z } from 'zod';

import { JobSettledEvent } from '../../jobs/events/job-settled.event';
import { JobExecutionProfile } from '../../jobs/job-execution-profile';
import { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { AiError } from '../core/ai-error';
import { aiErrorFromStorage } from '../storage/ai-storage-errors';
import { AI_RUN_CANCEL_POLL_MS, AI_RUN_TERMINAL_CODES } from './ai-response-run.handler';
import { aiRunOperation, type AiRunOperation } from './ai-run-operation';
import { AI_RUN_SUBJECT_TYPE, AiRunsService } from './ai-runs.service';
import type { AiRunOutput } from './ai-runtime.types';

export const aiMediaRunPayloadSchema = z.object({
  runId: z.string().uuid(),
});

/** What `execute` is handed for one claimed run. */
export interface AiMediaRunContext {
  job: Job;
  runId: string;
  userId: string;
  /** The stored request, still unparsed (`execute` validates it). */
  request: Prisma.JsonValue;
  /** Aborted by the owner's cancel or the run's deadline. */
  signal: AbortSignal;
  /**
   * Whether the owner cancelled while the call ran — asked AFTER the call,
   * BEFORE keeping its output (nothing is stored for a cancelled run).
   */
  cancelledWhileRunning(): Promise<boolean>;
}

/** What a finished `execute` keeps. */
export interface AiMediaRunResult {
  output: AiRunOutput;
  /** Undo what `execute` stored, for a run cancelled before it could complete. */
  discard?(): Promise<void>;
}

export abstract class AiMediaRunHandler implements JobHandler, OnModuleInit {
  protected readonly logger: Logger;

  abstract readonly type: string;
  abstract readonly profile: JobExecutionProfile;

  /** The `request.operation`s this job executes. */
  protected abstract readonly operations: readonly AiRunOperation[];

  /** What the run is called in logs and messages: `'image'`, `'transcription'`. */
  protected abstract readonly noun: string;

  protected constructor(
    private readonly registry: JobHandlerRegistry,
    protected readonly runs: AiRunsService,
  ) {
    this.logger = new Logger(new.target.name);
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  /**
   * The facade call and what to keep of it. `null` means "cancelled while it
   * ran, nothing kept". Throw to fail (storage errors are mapped for you).
   */
  protected abstract execute(ctx: AiMediaRunContext): Promise<AiMediaRunResult | null>;

  async process(job: Job): Promise<void> {
    const parsed = aiMediaRunPayloadSchema.safeParse(job.payload);

    if (!parsed.success) {
      throw new Error(`Invalid ${this.type} payload: expected { runId }`);
    }

    const { runId } = parsed.data;
    const noun = this.noun;
    const run = await this.runs.load(runId);

    if (!run) {
      this.logger.warn(`AI ${noun} run ${runId} no longer exists; job ${job.id} is a no-op`);
      return;
    }

    // A run this very job left `running` (its process died mid-call) is
    // resumed by the job's next attempt — only for a type that retries.
    const resuming = run.status === 'running' && run.jobId === job.id && this.profile.maxAttempts > 1;

    if (run.status !== 'pending' && !resuming) {
      this.logger.log(`AI ${noun} run ${runId} is ${run.status}; job ${job.id} is a no-op`);
      return;
    }

    if (!run.userId) {
      await this.runs.fail(runId, 'AI_KEY_REQUIRED', 'The user who started this run no longer exists.');
      return;
    }

    if (!this.operations.includes(aiRunOperation(run.request))) {
      await this.runs.fail(runId, 'AI_INVALID_REQUEST', `This run is not a ${noun} run.`);
      return;
    }

    if (!resuming && !(await this.runs.claim(runId, job.id))) {
      this.logger.log(`AI ${noun} run ${runId} changed state before it could start; job ${job.id} is a no-op`);
      return;
    }

    const deadlineMs = this.profile.maxRuntimeMs - 15_000;
    const controller = new AbortController();
    const detach = this.runs.attach(runId, controller);
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`AI ${noun} run timed out`));
    }, deadlineMs);
    const poll = setInterval(() => {
      void this.runs
        .isCancelled(runId)
        .then((cancelled) => {
          if (cancelled) controller.abort(new Error('AI run cancelled'));
        })
        .catch(() => undefined);
    }, AI_RUN_CANCEL_POLL_MS);

    deadline.unref?.();
    poll.unref?.();

    try {
      let result: AiMediaRunResult | null;

      try {
        result = await this.execute({
          job,
          runId,
          userId: run.userId,
          request: run.request,
          signal: controller.signal,
          cancelledWhileRunning: async () =>
            controller.signal.aborted && !timedOut && (await this.runs.isCancelled(runId)),
        });
      } catch (err) {
        throw aiErrorFromStorage(err) ?? err;
      }

      if (!result) {
        this.logger.log(`AI ${noun} run ${runId} was cancelled while it ran; nothing is kept`);
        return;
      }

      if (!(await this.runs.complete(runId, result.output))) {
        this.logger.log(`AI ${noun} run ${runId} was cancelled while it ran; its output is discarded`);
        await result.discard?.();
      }
    } catch (err) {
      await this.settleFailure(job, runId, err, controller.signal.aborted, timedOut, deadlineMs);
    } finally {
      clearTimeout(deadline);
      clearInterval(poll);
      detach();
    }
  }

  /** The settle-listener body — see the file header's SAFETY NET. */
  protected async failOrphanedRun(event: JobSettledEvent): Promise<void> {
    if (event.type !== this.type || event.succeeded) return;
    if (event.subjectType !== AI_RUN_SUBJECT_TYPE || !event.subjectId) return;

    try {
      await this.runs.fail(
        event.subjectId,
        'AI_PROVIDER_UNAVAILABLE',
        `The background job ended before the ${this.noun} run completed.`,
      );
    } catch (error) {
      this.logger.warn(
        `Could not mark AI ${this.noun} run ${event.subjectId} failed after job ${event.jobId} settled: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private async settleFailure(
    job: Job,
    runId: string,
    err: unknown,
    aborted: boolean,
    timedOut: boolean,
    deadlineMs: number,
  ): Promise<void> {
    if (aborted && !timedOut && (await this.runs.isCancelled(runId))) {
      this.logger.log(`AI ${this.noun} run ${runId} cancelled by its owner (job ${job.id})`);
      return;
    }

    if (timedOut) {
      await this.runs.fail(runId, 'AI_PROVIDER_UNAVAILABLE', `The AI ${this.noun} run timed out.`);
      throw new Error(`AI ${this.noun} run ${runId} exceeded its ${deadlineMs}ms deadline`);
    }

    const error = AiError.wrap(err);
    const rateLimit = error.toRateLimitError();

    if (rateLimit) {
      await this.runs.release(runId);
      throw rateLimit;
    }

    if (AI_RUN_TERMINAL_CODES.has(error.code)) {
      await this.runs.fail(runId, error.code, error.message);
      this.logger.log(`AI ${this.noun} run ${runId} ended with ${error.code} (job ${job.id})`);
      return;
    }

    // `attempts` is charged at claim time, so it already counts this one. A
    // job whose count is unknown is treated as on its last attempt.
    const attempt = typeof job.attempts === 'number' ? job.attempts : this.profile.maxAttempts;

    if (attempt < this.profile.maxAttempts) {
      await this.runs.release(runId);
      this.logger.warn(
        `AI ${this.noun} run ${runId} failed with ${error.code} on attempt ${attempt}/${this.profile.maxAttempts}; ` +
          'the job will retry it',
      );
    } else {
      await this.runs.fail(runId, error.code, error.message);
    }

    // The error that says what really happened, for the job's `lastError`.
    throw err;
  }
}
