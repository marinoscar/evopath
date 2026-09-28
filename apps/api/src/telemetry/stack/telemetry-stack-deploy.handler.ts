// =============================================================================
// `telemetry.stack.deploy` job handler (issue #567, epic #528)
// =============================================================================
//
// Asks the VPS `stack-agent` sidecar to start the telemetry services
// (GreptimeDB and the OTel collector) — `POST /v1/telemetry/up` — and records
// what it said. Enqueued only by `POST /api/admin/telemetry/stack/deploy`
// ("Deploy GreptimeDB" on /admin/settings/telemetry).
//
// A JOB, NOT AN HTTP CALL: the agent may pull images, which can take up to
// ten minutes — far longer than an admin request may stay open (CLAUDE.md,
// queue rule 1). The admin page polls `GET /api/admin/telemetry/stack`, which
// reads this job's row.
//
// SINGLE-FLIGHT: enqueued with no subject, so its dedup key is constant for the
// type and `jobs_active_dedup_uniq_idx` guarantees at most one pending/running
// deploy; a second click returns the job already in flight.
//
// THE RESULT is written onto the job's own `payload.result` as
// `{ ok, exitCode, output }` — `output` capped at `STACK_DEPLOY_OUTPUT_MAX_BYTES`,
// keeping the TAIL (where compose prints what went wrong). A failure is also
// thrown, so the row ends `failed` with the reason in `lastError`.
//
// NEVER AUTO-RETRIED (`maxAttempts: 1`): a failed `up` is a deployment problem
// an administrator must read, and re-running a ten-minute pull on the queue's
// retry budget would only hide it.
//
// SERVER-ONLY, PERMANENTLY: no `nodeResultSchema`/`persistNodeResult`. The
// stack-agent listens only on the deployment's internal network, which a
// worker node cannot reach, and its bearer token controls the host's Docker
// daemon — a node must never hold it (CLAUDE.md, queue rule 3). Do not add a
// `nodeSecretBroker` either.
//
// AFTER A SUCCESSFUL DEPLOY the telemetry connection is nudged so the admin
// page turns green on its next poll: the connection snapshot is re-read, the
// export gate re-applied, and a `telemetry.retention.apply` job queued (a new
// GreptimeDB has no TTL yet). All best effort — none can fail the deploy.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job, Prisma } from '@prisma/client';

import { enqueueHousekeepingJob } from '../../jobs/housekeeping.enqueue';
import { JobExecutionProfile } from '../../jobs/job-execution-profile';
import { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { JobsService } from '../../jobs/jobs.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TelemetryConnectionService } from '../connection/telemetry-connection.service';
import { TELEMETRY_RETENTION_TYPE } from '../handlers/telemetry-retention.handler';
import { TelemetrySettingsService } from '../telemetry-settings.service';
import { StackAgentClient } from './stack-agent.client';

/** The job type. PERMANENT once rows of it exist. */
export const TELEMETRY_STACK_DEPLOY_TYPE = 'telemetry.stack.deploy';

/** Cap on the stored agent output, in UTF-8 bytes. */
export const STACK_DEPLOY_OUTPUT_MAX_BYTES = 4096;

/** What a deploy job records on `payload.result`. */
export interface TelemetryStackDeployResult {
  ok: boolean;
  exitCode: number | null;
  output: string;
}

/**
 * The last `maxBytes` bytes of `output` (UTF-8), prefixed with an ellipsis
 * line when anything was cut. Never splits a multi-byte character.
 */
export function capOutput(output: string, maxBytes = STACK_DEPLOY_OUTPUT_MAX_BYTES): string {
  const bytes = Buffer.from(output, 'utf8');
  if (bytes.length <= maxBytes) return output;

  const marker = '…(truncated)\n';
  const budget = maxBytes - Buffer.byteLength(marker, 'utf8');
  let tail = bytes.subarray(bytes.length - budget);

  // Skip UTF-8 continuation bytes (10xxxxxx) so the tail starts on a character.
  let skip = 0;
  while (skip < tail.length && (tail[skip] & 0xc0) === 0x80) skip += 1;
  tail = tail.subarray(skip);

  return marker + tail.toString('utf8');
}

@Injectable()
export class TelemetryStackDeployHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(TelemetryStackDeployHandler.name);

  readonly type = TELEMETRY_STACK_DEPLOY_TYPE;

  /** An image pull can take ten minutes; never retried automatically. */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 15 * 60 * 1000, maxAttempts: 1 };

  // Deliberately NO `nodeResultSchema` / `persistNodeResult` — see the header.

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly agent: StackAgentClient,
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly connection: TelemetryConnectionService,
    private readonly settings: TelemetrySettingsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  /** Throws to fail; the row's `payload.result` is written either way when the agent answered. */
  async process(job: Job): Promise<void> {
    const outcome = await this.agent.telemetryUp();

    if (!outcome.ok) {
      if (outcome.error === 'failed') {
        await this.recordResult(job, {
          ok: false,
          exitCode: outcome.exitCode ?? null,
          output: capOutput(outcome.output ?? ''),
        });
      }

      throw new Error(`Deploying the telemetry services failed (${outcome.error}): ${outcome.message}`);
    }

    await this.recordResult(job, { ok: true, exitCode: outcome.exitCode, output: capOutput(outcome.output) });

    this.logger.log(`Telemetry services started by stack-agent (job ${job.id})`);

    await this.nudgeTelemetry();
  }

  /** Merges `result` into the job's own payload. Best effort: never fails the job by itself. */
  private async recordResult(job: Job, result: TelemetryStackDeployResult): Promise<void> {
    const base =
      job.payload && typeof job.payload === 'object' && !Array.isArray(job.payload)
        ? (job.payload as Prisma.JsonObject)
        : {};

    try {
      await this.prisma.job.update({
        where: { id: job.id },
        data: { payload: { ...base, result: { ...result } } as Prisma.InputJsonValue },
      });
    } catch (error) {
      this.logger.warn(
        `Could not record the deploy result on job ${job.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** So the admin page turns green quickly. See the header; nothing here may throw. */
  private async nudgeTelemetry(): Promise<void> {
    try {
      await this.connection.refreshSafely();
      await this.settings.refreshGate();
    } catch (error) {
      this.logger.warn(
        `Telemetry refresh after deploy failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    await enqueueHousekeepingJob({
      jobs: this.jobs,
      prisma: this.prisma,
      logger: this.logger,
      type: TELEMETRY_RETENTION_TYPE,
      what: 'telemetry retention',
    });
  }
}
