// =============================================================================
// TELEMETRY_JOBS adapter: the app's queue, as telemetry uses it
// (marinoscar/EnterpriseAppBase#703, PP-4.2)
// =============================================================================
//
// `JobsService.enqueue`, the shared `enqueueHousekeepingJob` helper (with the
// CALLER's logger, so its line is attributed as before), the handler
// registry, and the two `jobs` reads/writes the stack service and the deploy
// handler made through Prisma.
//
// The handler typing is checked at COMPILE time below: a telemetry handler
// must satisfy the app's own `JobHandler`, so the dispatcher sees exactly the
// object it always did. Neither telemetry job type is node-eligible (no
// `nodeResultSchema`, no `persistNodeResult`); see the handlers' headers.
// =============================================================================

import { Injectable, type Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { enqueueHousekeepingJob } from '../../jobs/housekeeping.enqueue';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { JobsService } from '../../jobs/jobs.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { TelemetryJobHandler, TelemetryJobRecord, TelemetryJobsPort } from '@marinoscar/platform-api/telemetry';

/** Compile-time proof that a telemetry handler IS an app job handler. */
type AssertAssignable<_From extends _To, _To> = true;
export type TelemetryJobHandlerIsJobHandler = AssertAssignable<TelemetryJobHandler, JobHandler>;

@Injectable()
export class TelemetryJobsAdapter implements TelemetryJobsPort {
  constructor(
    private readonly jobs: JobsService,
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
  ) {}

  enqueue(input: {
    type: string;
    reason: 'upload' | 'rerun' | 'backfill';
    payload?: Record<string, unknown>;
  }): Promise<{ id: string; status: string }> {
    return this.jobs.enqueue({
      type: input.type,
      reason: input.reason,
      ...(input.payload === undefined ? {} : { payload: input.payload as Prisma.InputJsonValue }),
    });
  }

  async enqueueHousekeepingJob(options: { type: string; what: string; logger: Logger }): Promise<void> {
    await enqueueHousekeepingJob({
      jobs: this.jobs,
      prisma: this.prisma,
      logger: options.logger,
      type: options.type,
      what: options.what,
    });
  }

  registerHandler(handler: TelemetryJobHandler): void {
    const appHandler: JobHandler = handler;
    this.registry.register(appHandler);
  }

  findLatest(type: string): Promise<TelemetryJobRecord | null> {
    return this.prisma.job.findFirst({ where: { type }, orderBy: { createdAt: 'desc' } });
  }

  async updatePayload(jobId: string, payload: Record<string, unknown>): Promise<void> {
    await this.prisma.job.update({ where: { id: jobId }, data: { payload: payload as Prisma.InputJsonValue } });
  }
}
