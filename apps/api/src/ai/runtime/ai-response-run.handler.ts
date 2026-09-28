// =============================================================================
// `ai.response.run` job handler — one background AI response
// (issue #432, epic #419; docs/specs/ai-platform.md §2.20)
// =============================================================================
//
// Payload `{ runId }`, subjectType `'ai_run'`. Enqueued by
// `AiUserClient.startRun` in the same transaction that creates the run row.
//
// SERVER-ONLY, PERMANENTLY. No `nodeResultSchema`/`persistNodeResult`: the
// call is made with a USER'S OWN provider key (or the org key), and no AI key
// may ever reach a worker node — CLAUDE.md MANDATORY queue rule 3, and §2.20.
//
// PROFILE `{ maxRuntimeMs: 30 min, maxAttempts: 1 }`. A model call is neither
// idempotent nor free: an automatic retry is a second charge to the user's
// own provider account. A provider throttle is the exception — it DEFERS the
// job (`RateLimitError`, its own budget) rather than charging an attempt.
//
// OUTCOMES. The run row, not the job, is what the user reads:
//
//   - success                      run `succeeded` with the response
//   - owner cancelled              run stays `cancelled`; job succeeds (no-op)
//   - AI_RATE_LIMITED              run back to `pending`; job deferred
//   - a policy/request/config      run `failed` with the code; the job RETURNS
//     outcome (kill switch, key,   normally — the platform being switched off
//     model, capability, invalid   or a user's key being rejected is an
//     request, content filter,     expected outcome, not an operator's
//     bad output, storage          incident, so it must not burn an attempt
//     unavailable)                 or fire `jobs.job_failed` (§2.19); unconfigured
//                                  storage no retry can fix (#509)
//   - anything else                run `failed`; the job THROWS, so the
//     (provider down, timeout,     failure is visible in the queue dashboard
//     a bug)                       and notifies operators
//
// A stored input (#441) that is gone or no longer the owner's when the job
// runs is `AI_INVALID_REQUEST` (a request outcome); unconfigured storage is
// `AI_STORAGE_UNAVAILABLE` (an operator's to fix at /admin/settings/storage)
// — see `aiErrorFromStorage`. Both are terminal: the run fails at once and
// the job returns, because retrying cannot fix either (issue #509; before
// it, the 503 behind the storage error was deferred as a provider throttle).
//
// And a safety net: if the job settles `failed` without the handler having
// finished the run (the worker's own timeout, a rate-limit budget exhausted),
// the settle listener fails the run, so no run stays `pending` forever.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Job } from '@prisma/client';
import { z } from 'zod';

import { JOB_SETTLED_EVENT, JobSettledEvent } from '../../jobs/events/job-settled.event';
import { JobExecutionProfile } from '../../jobs/job-execution-profile';
import { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { AiError, type AiErrorCode } from '../core/ai-error';
import type { AiResponse } from '../core/types/responses.types';
import { AiOutputWriter } from '../storage/ai-output-writer';
import { aiErrorFromStorage } from '../storage/ai-storage-errors';
import { AiService } from './ai.service';
import { fromStoredRunRequest } from './ai-run-request';
import { AI_RESPONSE_RUN_TYPE, AI_RUN_SUBJECT_TYPE, AiRunsService } from './ai-runs.service';

export const aiResponseRunPayloadSchema = z.object({
  runId: z.string().uuid(),
});

/** How often a running run re-reads its row for a cancel made on another replica. */
export const AI_RUN_CANCEL_POLL_MS = 5_000;

const MAX_RUNTIME_MS = 30 * 60_000;

/** The run's own deadline: a little inside the job's, so the run records it cleanly. */
const RUN_DEADLINE_MS = MAX_RUNTIME_MS - 15_000;

/**
 * Codes that end a run as an expected outcome: recorded on the run, the job
 * returns normally (no retry, no `jobs.job_failed`). See the file header.
 */
export const AI_RUN_TERMINAL_CODES: ReadonlySet<AiErrorCode> = new Set<AiErrorCode>([
  'AI_DISABLED',
  'AI_PROVIDER_DISABLED',
  'AI_KEY_REQUIRED',
  'AI_KEY_INVALID',
  'AI_MODEL_NOT_ENABLED',
  'AI_MODEL_NOT_REACHABLE',
  'AI_CAPABILITY_UNSUPPORTED',
  'AI_TOOL_DISABLED',
  'AI_INVALID_REQUEST',
  'AI_CONTENT_FILTERED',
  'AI_STRUCTURED_OUTPUT_INVALID',
  // A deployment configuration condition, not a transient one (issue #509):
  // an administrator fixes object storage at /admin/settings/storage, and no
  // retry of this job can. It fails the run with a code that says so.
  'AI_STORAGE_UNAVAILABLE',
]);

@Injectable()
export class AiResponseRunHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(AiResponseRunHandler.name);

  readonly type = AI_RESPONSE_RUN_TYPE;

  readonly profile: JobExecutionProfile = { maxRuntimeMs: MAX_RUNTIME_MS, maxAttempts: 1 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly ai: AiService,
    private readonly runs: AiRunsService,
    private readonly outputs: AiOutputWriter,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const parsed = aiResponseRunPayloadSchema.safeParse(job.payload);

    if (!parsed.success) {
      throw new Error(`Invalid ${AI_RESPONSE_RUN_TYPE} payload: expected { runId }`);
    }

    const { runId } = parsed.data;
    const run = await this.runs.load(runId);

    if (!run) {
      this.logger.warn(`AI run ${runId} no longer exists; job ${job.id} is a no-op`);
      return;
    }

    if (run.status !== 'pending') {
      // Cancelled before it started, or already finished by an earlier claim.
      this.logger.log(`AI run ${runId} is ${run.status}; job ${job.id} is a no-op`);
      return;
    }

    if (!run.userId) {
      // The owner was deleted (`SetNull`): there is no key to call with.
      await this.runs.fail(runId, 'AI_KEY_REQUIRED', 'The user who started this run no longer exists.');
      return;
    }

    if (!(await this.runs.claim(runId, job.id))) {
      this.logger.log(`AI run ${runId} changed state before it could start; job ${job.id} is a no-op`);
      return;
    }

    const controller = new AbortController();
    const detach = this.runs.attach(runId, controller);
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('AI run timed out'));
    }, RUN_DEADLINE_MS);
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
      const request = fromStoredRunRequest(run.request);
      const response = await this.ai
        .forUser(run.userId, { jobId: job.id, runId })
        .respond(request, { signal: controller.signal });

      if (!(await this.runs.complete(runId, response))) {
        this.logger.log(`AI run ${runId} was cancelled while it ran; its result is discarded`);
        // Hosted images (#442) were already stored as the user's objects.
        await this.outputs.discard(hostedImageObjectIds(response));
      }
    } catch (err) {
      await this.settleFailure(runId, job.id, err, controller.signal.aborted, timedOut);
    } finally {
      clearTimeout(deadline);
      clearInterval(poll);
      detach();
    }
  }

  /**
   * A job that settled FAILED while its run is still active — the worker's
   * own timeout, a rate-limit budget exhausted, a crash between claim and
   * completion — would otherwise leave the run `pending`/`running` forever.
   * One conditional update; nothing to do for a run already finished.
   */
  @OnEvent(JOB_SETTLED_EVENT)
  async onJobSettled(event: JobSettledEvent): Promise<void> {
    if (event.type !== AI_RESPONSE_RUN_TYPE || event.succeeded) return;
    if (event.subjectType !== AI_RUN_SUBJECT_TYPE || !event.subjectId) return;

    try {
      await this.runs.fail(
        event.subjectId,
        'AI_PROVIDER_UNAVAILABLE',
        'The background job ended before the run completed.',
      );
    } catch (error) {
      this.logger.warn(
        `Could not mark AI run ${event.subjectId} failed after job ${event.jobId} settled: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private async settleFailure(
    runId: string,
    jobId: string,
    err: unknown,
    aborted: boolean,
    timedOut: boolean,
  ): Promise<void> {
    if (aborted && !timedOut && (await this.runs.isCancelled(runId))) {
      this.logger.log(`AI run ${runId} cancelled by its owner (job ${jobId})`);
      return;
    }

    if (timedOut) {
      await this.runs.fail(runId, 'AI_PROVIDER_UNAVAILABLE', 'The AI run timed out.');
      throw new Error(`AI run ${runId} exceeded its ${RUN_DEADLINE_MS}ms deadline`);
    }

    // A stored input that vanished or is no longer the owner's (#441) is the
    // request's problem (`AI_INVALID_REQUEST`), unconfigured storage the
    // deployment's (`AI_STORAGE_UNAVAILABLE`) — never "the provider failed".
    const error = aiErrorFromStorage(err) ?? AiError.wrap(err);
    const rateLimit = error.toRateLimitError();

    if (rateLimit) {
      await this.runs.release(runId);
      throw rateLimit;
    }

    await this.runs.fail(runId, error.code, error.message);

    if (AI_RUN_TERMINAL_CODES.has(error.code)) {
      this.logger.log(`AI run ${runId} ended with ${error.code} (job ${jobId})`);
      return;
    }

    // The original error, so the job's `lastError` says what really happened.
    throw err;
  }
}

/** Storage objects a response's hosted `image_generation` calls were stored as (#442). */
export function hostedImageObjectIds(response: AiResponse): string[] {
  return response.output.flatMap((item) =>
    item.type === 'hosted_tool_call' && item.tool === 'image_generation' && item.result?.storageObjectId
      ? [item.result.storageObjectId]
      : [],
  );
}
