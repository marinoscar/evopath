// =============================================================================
// `ai.health.summary` job handler (H8, #192)
// =============================================================================
//
// Writes the user's AI health summary: the server-built digest
// (`health-digest.ts`) in, a structured summary out, appended to
// `health_summaries` as the next version. Enqueued by `HealthSummaryService`
// (debounced after a health write, at once on "Refresh summary" or when the
// consent is turned on), payload `{ force?: boolean }`, subject
// (`health_summary`, userId).
//
// SERVER-ONLY, PERMANENTLY. No `nodeResultSchema`/`persistNodeResult`: the
// call is made with the user's own provider key (or the org key), and no AI
// key may ever reach a worker node (CLAUDE.md AI rule 3).
//
// PROFILE `{ maxRuntimeMs: 4 min, maxAttempts: 1 }`: at most two model calls
// (the answer and one regeneration), neither idempotent nor free, so a
// failure is not retried (the next health write or a refresh retries). A
// provider throttle DEFERS the job instead.
//
// STEPS
//   1. Consent off -> no-op (turning it off stops generation, even for a job
//      already queued).
//   2. No digest data -> no-op. Same digest hash as the newest ready summary
//      and not forced -> no-op (nothing changed).
//   3. The `health_summary` feature's model (`AiFeatureModelResolver`); a
//      blocking state appends a `failed` row with the matching AI code.
//   4. `AiService.forUser(userId).respondStructured`, then the post-check. A
//      rejected answer is regenerated ONCE with a nudge naming the rule
//      codes; a second rejection appends `failed`
//      (`HEALTH_SUMMARY_POST_CHECK_REJECTED`).
//   5. A passing answer appends `ready`, with the digest's own `asOf` (never
//      the model's) and hash.
//
// OBSERVABILITY. Metrics: `app.health.summary.generations` (outcome),
// `.duration`, `.regenerations`, `.post_check_rejections`, `.tokens`. The
// span carries the outcome, counts and token totals. ⚠ PRIVACY: no digest,
// prompt, answer or summary text in any log line, span, metric or error;
// log lines carry ids, versions and rule codes.
// =============================================================================

import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { Prisma, type Job } from '@prisma/client';
import { z } from 'zod';

import { AiFeatureModelResolver } from '../ai/assignments/ai-feature-model-resolver.service';
import { RUNNABLE_FEATURE_STATES, type FeatureResolutionState } from '../ai/assignments/dto/ai-feature-resolution.dto';
import { AiError, type AiErrorCode } from '../ai/core/ai-error';
import { AI_RUN_TERMINAL_CODES } from '../ai/runtime/ai-response-run.handler';
import { AiService } from '../ai/runtime/ai.service';
import { toDbDate } from '../check-ins/local-date';
import { EvoPathMetricsService, fallbackEvoPathMetrics, type HealthSummaryOutcome } from '../app-metrics/evopath-metrics.service';
import { JobExecutionProfile } from '../jobs/job-execution-profile';
import { JobHandler } from '../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../jobs/job-handler.registry';
import { PrismaService } from '../prisma/prisma.service';
import { buildHealthDigest, digestHasData, digestHash, type HealthDigest } from './health-digest';
import {
  HEALTH_SUMMARY_FAILURES,
  HEALTH_SUMMARY_FEATURE_ID,
  HEALTH_SUMMARY_JOB_TYPE,
  HEALTH_SUMMARY_SPAN_ATTRIBUTES,
} from './health-summary.constants';
import { postCheckHealthSummary, type PostCheckRule } from './health-summary.post-check';
import {
  HEALTH_SUMMARY_INSTRUCTIONS,
  HEALTH_SUMMARY_SCHEMA_NAME,
  healthSummaryOutputSchema,
  healthSummaryUserText,
  regenerationNudge,
  type HealthSummaryOutput,
} from './health-summary.prompt';
import { HealthSummaryReader } from './health-summary.reader';

export const healthSummaryPayloadSchema = z.object({ force: z.boolean().optional() }).passthrough();

const MAX_RUNTIME_MS = 4 * 60_000;

/** Each model call's own deadline; two fit inside the job's. */
const CALL_DEADLINE_MS = 100_000;

/** Output tokens one answer may use. */
export const HEALTH_SUMMARY_MAX_OUTPUT_TOKENS = 4_000;

/** How many times an append retries a lost version race. */
const APPEND_ATTEMPTS = 3;

/** The AI code a blocking feature state is recorded as. */
const STATE_CODES: Record<Exclude<FeatureResolutionState, 'ready' | 'auto'>, AiErrorCode> = {
  ai_disabled: 'AI_DISABLED',
  no_key: 'AI_KEY_REQUIRED',
  no_models: 'AI_MODEL_NOT_ENABLED',
  missing_capability: 'AI_CAPABILITY_UNSUPPORTED',
  web_search_disabled: 'AI_TOOL_DISABLED',
};

interface Attempted {
  output: HealthSummaryOutput | null;
  regenerations: number;
  rejections: number;
  inputTokens: number;
  outputTokens: number;
}

@Injectable()
export class HealthSummaryHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(HealthSummaryHandler.name);

  readonly type = HEALTH_SUMMARY_JOB_TYPE;

  readonly profile: JobExecutionProfile = { maxRuntimeMs: MAX_RUNTIME_MS, maxAttempts: 1 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly features: AiFeatureModelResolver,
    private readonly reader: HealthSummaryReader,
    @Optional() private readonly metrics: EvoPathMetricsService = fallbackEvoPathMetrics(),
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const started = Date.now();
    const userId = job.subjectId;
    const payload = healthSummaryPayloadSchema.safeParse(job.payload ?? {});

    if (!userId || !payload.success) {
      throw new Error(`Invalid ${HEALTH_SUMMARY_JOB_TYPE} job: expected a user subject and { force? }`);
    }

    const span = trace.getActiveSpan();
    const finish = (outcome: HealthSummaryOutcome, attempted?: Attempted) => {
      span?.setAttribute(HEALTH_SUMMARY_SPAN_ATTRIBUTES.outcome, outcome);
      if (attempted) {
        span?.setAttribute(HEALTH_SUMMARY_SPAN_ATTRIBUTES.regenerations, attempted.regenerations);
        span?.setAttribute(HEALTH_SUMMARY_SPAN_ATTRIBUTES.postCheckRejections, attempted.rejections);
        span?.setAttribute(HEALTH_SUMMARY_SPAN_ATTRIBUTES.inputTokens, attempted.inputTokens);
        span?.setAttribute(HEALTH_SUMMARY_SPAN_ATTRIBUTES.outputTokens, attempted.outputTokens);
      }
      this.metrics.healthSummaryGenerated(
        outcome,
        Date.now() - started,
        attempted
          ? {
              regenerations: attempted.regenerations,
              rejections: attempted.rejections,
              inputTokens: attempted.inputTokens,
              outputTokens: attempted.outputTokens,
            }
          : undefined,
      );
    };

    if (!(await this.reader.consentOn(userId))) {
      this.logger.log(`Health summary job ${job.id}: consent is off for user ${userId}; no-op`);
      finish('skipped');
      return;
    }

    const digest = buildHealthDigest(await this.reader.digestSource(userId));
    if (!digestHasData(digest)) {
      this.logger.log(`Health summary job ${job.id}: no health data for user ${userId}; no-op`);
      finish('skipped');
      return;
    }

    const hash = digestHash(digest);
    const latest = await this.reader.latestReady(userId);
    if (!payload.data.force && latest?.inputsHash === hash) {
      this.logger.log(`Health summary job ${job.id}: inputs unchanged since version ${latest.version}; no-op`);
      finish('skipped');
      return;
    }

    const resolution = await this.features.resolve(userId, HEALTH_SUMMARY_FEATURE_ID);
    if (!RUNNABLE_FEATURE_STATES.includes(resolution.state) || !resolution.model) {
      const code = STATE_CODES[resolution.state as keyof typeof STATE_CODES] ?? 'AI_MODEL_NOT_ENABLED';
      await this.append(userId, job.id, digest, hash, { status: 'failed', errorCode: code });
      this.logger.log(`Health summary job ${job.id}: no model (${resolution.state}); recorded ${code}`);
      finish('failed');
      return;
    }

    const model = { provider: resolution.model.provider, modelId: resolution.model.modelId };
    let attempted: Attempted;

    try {
      attempted = await this.generate(userId, job.id, digest, model);
    } catch (err) {
      const aiError = err instanceof AiError ? err : null;
      const rateLimit = aiError?.toRateLimitError();
      if (rateLimit) {
        finish('deferred');
        throw rateLimit;
      }
      const code = aiError?.code ?? HEALTH_SUMMARY_FAILURES.GENERATION_FAILED;
      await this.append(userId, job.id, digest, hash, { status: 'failed', errorCode: code, ...model });
      finish('failed');
      if (aiError && AI_RUN_TERMINAL_CODES.has(aiError.code)) {
        this.logger.log(`Health summary job ${job.id} ended with ${aiError.code}`);
        return;
      }
      throw err;
    }

    if (!attempted.output) {
      const version = await this.append(userId, job.id, digest, hash, {
        status: 'failed',
        errorCode: HEALTH_SUMMARY_FAILURES.POST_CHECK_REJECTED,
        regenerations: attempted.regenerations,
        ...model,
      });
      this.logger.warn(`Health summary job ${job.id}: rejected twice by the post-check; version ${version} recorded failed`);
      finish('rejected', attempted);
      return;
    }

    const version = await this.append(userId, job.id, digest, hash, {
      status: 'ready',
      narrative: attempted.output.narrative,
      trainingConsiderations: attempted.output.trainingConsiderations,
      regenerations: attempted.regenerations,
      ...model,
    });
    this.logger.log(
      `Health summary job ${job.id}: version ${version} ready for user ${userId} ` +
        `(${attempted.output.trainingConsiderations.length} consideration(s), ${attempted.regenerations} regeneration(s))`,
    );
    finish('ready', attempted);
  }

  /** One answer, post-checked; one regeneration on a rejection. `output` is null after two rejections. */
  private async generate(
    userId: string,
    jobId: string,
    digest: HealthDigest,
    model: { provider: string; modelId: string },
  ): Promise<Attempted> {
    const result: Attempted = { output: null, regenerations: 0, rejections: 0, inputTokens: 0, outputTokens: 0 };
    let rejected: PostCheckRule[] = [];

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (attempt === 2) result.regenerations += 1;

      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(new Error('Health summary timed out')), CALL_DEADLINE_MS);
      deadline.unref?.();

      try {
        const response = await this.ai.forUser(userId, { jobId }).respondStructured(
          {
            provider: model.provider,
            model: model.modelId,
            schema: healthSummaryOutputSchema,
            schemaName: HEALTH_SUMMARY_SCHEMA_NAME,
            strict: true,
            instructions: HEALTH_SUMMARY_INSTRUCTIONS,
            input: [
              {
                type: 'message',
                role: 'user',
                content: [{ type: 'text', text: healthSummaryUserText(digest, attempt === 2 ? regenerationNudge(rejected) : undefined) }],
              },
            ],
            maxOutputTokens: HEALTH_SUMMARY_MAX_OUTPUT_TOKENS,
            metadata: { feature: HEALTH_SUMMARY_FEATURE_ID },
          },
          { signal: controller.signal },
        );
        result.inputTokens += response.usage?.inputTokens ?? 0;
        result.outputTokens += response.usage?.outputTokens ?? 0;

        rejected = postCheckHealthSummary(response.parsed);
        if (rejected.length === 0) {
          result.output = response.parsed;
          return result;
        }
        result.rejections += 1;
        this.logger.warn(`Health summary job ${jobId}: attempt ${attempt} rejected by the post-check (${rejected.join(', ')})`);
      } finally {
        clearTimeout(deadline);
      }
    }

    return result;
  }

  /** Appends the next version (retrying a lost version race); returns the version written. */
  private async append(
    userId: string,
    jobId: string,
    digest: HealthDigest,
    hash: string,
    row: {
      status: 'ready' | 'failed';
      narrative?: string;
      trainingConsiderations?: HealthSummaryOutput['trainingConsiderations'];
      regenerations?: number;
      errorCode?: string;
      provider?: string;
      modelId?: string;
    },
  ): Promise<number> {
    for (let attempt = 1; ; attempt += 1) {
      const last = await this.prisma.healthSummary.findFirst({
        where: { userId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const version = (last?.version ?? 0) + 1;
      try {
        await this.prisma.healthSummary.create({
          data: {
            userId,
            version,
            status: row.status,
            narrative: row.narrative ?? null,
            trainingConsiderations: row.trainingConsiderations
              ? (row.trainingConsiderations as unknown as Prisma.InputJsonValue)
              : Prisma.DbNull,
            dataAsOf: digest.asOf ? toDbDate(digest.asOf) : null,
            inputsAsOf: inputsAsOf(digest),
            inputsHash: hash,
            provider: row.provider ?? null,
            model: row.modelId ?? null,
            regenerations: row.regenerations ?? 0,
            errorCode: row.errorCode ?? null,
            jobId: isUuid(jobId) ? jobId : null,
          },
        });
        return version;
      } catch (err) {
        const lostRace = err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
        if (!lostRace || attempt >= APPEND_ATTEMPTS) throw err;
      }
    }
  }
}

/** The newest input's date as a timestamp (midnight UTC), or null. */
function inputsAsOf(digest: HealthDigest): Date | null {
  return digest.asOf ? new Date(`${digest.asOf}T00:00:00.000Z`) : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: string): boolean {
  return UUID.test(value);
}
