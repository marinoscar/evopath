import { Injectable, OnModuleInit } from '@nestjs/common';

import { DoctorCheck, DoctorCheckOutcome } from '@marinoscar/platform-api/doctor';
import { DoctorCheckRegistry } from '@marinoscar/platform-api/doctor';
import { PrismaService } from '../../prisma/prisma.service';
import { JobAdminService } from '../job-admin.service';
import { JOBS_SETTINGS_PATH } from './jobs-worker.doctor-check';

/** A due pending job older than this means nothing is draining the queue. */
export const JOBS_OLDEST_PENDING_WARN_MINUTES = 15;

const DAY_MS = 24 * 60 * 60_000;

export interface JobsBacklogFacts {
  pending: number;
  running: number;
  stuckRunning: number;
  stuckThresholdMinutes: number;
  failedLast24h: number;
  /** Minutes the oldest DUE pending job has waited, or null when none is due. */
  oldestPendingMinutes: number | null;
}

/** Pure: judges the queue's backlog. */
export function decideJobsBacklog(facts: JobsBacklogFacts): DoctorCheckOutcome {
  const data = { ...facts };
  const problems: string[] = [];

  if (facts.stuckRunning > 0) {
    problems.push(`${facts.stuckRunning} job(s) running for over ${facts.stuckThresholdMinutes} min with no live lease`);
  }

  if (facts.oldestPendingMinutes !== null && facts.oldestPendingMinutes > JOBS_OLDEST_PENDING_WARN_MINUTES) {
    problems.push(`the oldest due job has waited ${facts.oldestPendingMinutes} min`);
  }

  if (problems.length > 0) {
    return {
      status: 'warn',
      detail: `Queue needs attention: ${problems.join('; ')}`,
      remedy:
        `Check a worker is running (the jobs.worker check), then review or reset stuck jobs at ${JOBS_SETTINGS_PATH}.`,
      data,
    };
  }

  return {
    status: 'pass',
    detail: `${facts.pending} pending, ${facts.running} running, ${facts.failedLast24h} failed in the last 24 h`,
    data,
  };
}

/**
 * `jobs` / `jobs.backlog` — the queue is draining.
 *
 * `JobAdminService.stats()` supplies the counts and the stuck predicate (the
 * reaper's own, called rather than copied); two extra `SELECT`s add the
 * failures of the last day and the age of the oldest due pending job.
 */
@Injectable()
export class JobsBacklogDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'jobs.backlog';
  readonly category = 'jobs';
  readonly label = 'Job queue backlog';
  readonly settingsPath = JOBS_SETTINGS_PATH;
  readonly dependsOn = ['db.connection'];

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly jobAdmin: JobAdminService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    const now = new Date();

    const [stats, failedLast24h, oldest] = await Promise.all([
      this.jobAdmin.stats(),
      this.prisma.job.count({ where: { status: 'failed', finishedAt: { gte: new Date(now.getTime() - DAY_MS) } } }),
      this.prisma.job.findFirst({
        where: { status: 'pending', OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }] },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true, scheduledFor: true },
      }),
    ]);

    let oldestPendingMinutes: number | null = null;

    if (oldest) {
      const dueAt = Math.max(oldest.createdAt.getTime(), oldest.scheduledFor?.getTime() ?? 0);
      oldestPendingMinutes = Math.max(0, Math.floor((now.getTime() - dueAt) / 60_000));
    }

    return decideJobsBacklog({
      pending: stats.byStatus.pending ?? 0,
      running: stats.byStatus.running ?? 0,
      stuckRunning: stats.stuckRunning,
      stuckThresholdMinutes: stats.stuckThresholdMinutes,
      failedLast24h: Number(failedLast24h ?? 0),
      oldestPendingMinutes,
    });
  }
}
