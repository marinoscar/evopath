import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { DoctorCheck, DoctorCheckOutcome } from '@marinoscar/platform-api/doctor';
import { DoctorCheckRegistry } from '@marinoscar/platform-api/doctor';
import { JobWorkerMode, parseWorkerMode, resolveWorkerConcurrency } from '../job.worker';

export const JOBS_SETTINGS_PATH = '/admin/settings/jobs';

/** Pure: judges this process's worker configuration. */
export function decideJobsWorker(input: { rawMode: unknown; mode: JobWorkerMode | null; concurrency: number }): DoctorCheckOutcome {
  const data = { mode: input.mode ?? String(input.rawMode), concurrency: input.concurrency };

  if (input.mode === null) {
    return {
      status: 'warn',
      detail: `JOBS_WORKER_MODE "${String(input.rawMode)}" is not recognised; the worker falls back to "all"`,
      remedy: 'Set JOBS_WORKER_MODE to all, system or off and restart the API.',
      data,
    };
  }

  if (input.mode === 'off') {
    return {
      status: 'warn',
      detail: 'This API process runs no background jobs (JOBS_WORKER_MODE=off); jobs queue until another executor claims them',
      remedy:
        'Make sure another API instance with JOBS_WORKER_MODE=all or system, or enrolled worker nodes ' +
        '(/admin/settings/workers), are running — or set JOBS_WORKER_MODE=all here.',
      data,
    };
  }

  if (input.concurrency <= 0) {
    return {
      status: 'warn',
      detail: `JOBS_WORKER_CONCURRENCY is ${input.concurrency}; the worker pool runs no slot`,
      remedy: 'Set JOBS_WORKER_CONCURRENCY above zero (default 2), or JOBS_WORKER_MODE=off to say so deliberately.',
      data,
    };
  }

  const scope = input.mode === 'system' ? 'server-only job types' : 'every job type';

  return {
    status: 'pass',
    detail: `Worker "${input.mode}" with ${input.concurrency} slot(s), claiming ${scope}`,
    data,
  };
}

/**
 * `jobs` / `jobs.worker` — this process executes background work.
 *
 * Reads the configuration through `parseWorkerMode` / `resolveWorkerConcurrency`
 * — the one parse of each setting, shared with `JobWorker.mode()` — rather than
 * injecting the worker pool itself: a diagnostic needs the ANSWER, and anything
 * holding the pool could stop it (the same reasoning the janitor task gives).
 */
@Injectable()
export class JobsWorkerDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'jobs.worker';
  readonly category = 'jobs';
  readonly label = 'Background job worker';
  readonly settingsPath = JOBS_SETTINGS_PATH;

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    const rawMode = this.config.get<string>('jobs.workerMode');

    return decideJobsWorker({
      rawMode,
      mode: parseWorkerMode(rawMode),
      concurrency: resolveWorkerConcurrency(this.config),
    });
  }
}
