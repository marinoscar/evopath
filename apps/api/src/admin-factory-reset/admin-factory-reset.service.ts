import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Job, Prisma } from '@prisma/client';

import { JobsService } from '../jobs/jobs.service';
import { ACTIVE } from '../measurements/measurement-active';
import { PrismaService } from '../prisma/prisma.service';
import {
  type AdminFactoryResetResult,
  type AdminFactoryResetStarted,
  type AdminFactoryResetStatus,
  type AdminFactoryResetSummary,
  adminFactoryResetResultSchema,
} from './dto/admin-factory-reset.dto';
import {
  ADMIN_FACTORY_RESET_REQUESTED_ACTION,
  ADMIN_FACTORY_RESET_TYPE,
} from './admin-factory-reset.constants';

// =============================================================================
// AdminFactoryResetService — the request half of a factory reset (issue #211)
// =============================================================================
//
// A deployment-wide summary of what a factory reset deletes, the enqueue (the
// deletion itself is the server-only `admin.factory_reset` job, CLAUDE.md
// queue rule 1), and the job's status.
//
// ONE ACTIVE FACTORY RESET PER DEPLOYMENT. The job carries no subject, so its
// dedup key is `admin.factory_reset::` for every caller and the queue's
// `jobs_active_dedup_uniq_idx` collapses a second request (from any admin)
// onto the one in flight. Never a `findFirst` pre-check.
// =============================================================================

export const ADMIN_FACTORY_RESET_JOB_NOT_FOUND = 'Factory reset job not found';

/** Job statuses a factory reset deletes (running jobs are left alone). */
export const DELETABLE_JOB_STATUSES = ['pending', 'succeeded', 'failed'] as const;

/**
 * Allowlist rows a factory reset deletes: every entry but the actor's own
 * (matched by email, case-insensitively, or claimed by the actor).
 *
 * Spelled out rather than `NOT: [emailIs, claimedByActor]`: for an unclaimed
 * row `claimed_by_id = actor` is NULL, so `NOT (...)` is NULL too and SQL
 * would silently keep every unclaimed entry.
 */
export function allowlistEntriesToDelete(actor: { id: string; email: string }): Prisma.AllowedEmailWhereInput {
  return {
    NOT: { email: { equals: actor.email, mode: 'insensitive' } },
    OR: [{ claimedById: null }, { claimedById: { not: actor.id } }],
  };
}

@Injectable()
export class AdminFactoryResetService {
  private readonly logger = new Logger(AdminFactoryResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
  ) {}

  /** Deployment-wide counts, so the UI can say what a factory reset loses. */
  async getSummary(actorUserId: string): Promise<AdminFactoryResetSummary> {
    const [actor, backups] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: actorUserId }, select: { id: true, email: true } }),
      this.prisma.databaseBackupRun.findMany({ select: { storageKey: true } }),
    ]);
    const backupKeys = backups.map((row) => row.storageKey);

    const [
      otherUsers,
      workouts,
      gyms,
      measurements,
      healthDocuments,
      programs,
      trainingRuns,
      storageObjects,
      jobs,
      notifications,
      allowlistEntries,
      broadcasts,
      aiRuns,
      customExercises,
      customEquipment,
    ] = await Promise.all([
      this.prisma.user.count({ where: { id: { not: actorUserId } } }),
      this.prisma.workout.count(),
      this.prisma.gym.count(),
      this.prisma.measurement.count({ where: { ...ACTIVE } }),
      this.prisma.healthDocument.count(),
      this.prisma.program.count(),
      this.prisma.trainingPlanRun.count(),
      this.prisma.storageObject.count({ where: { storageKey: { notIn: backupKeys } } }),
      this.prisma.job.count({
        where: { status: { in: [...DELETABLE_JOB_STATUSES] }, backupRun: { is: null } },
      }),
      this.prisma.notification.count(),
      this.prisma.allowedEmail.count(actor ? { where: allowlistEntriesToDelete(actor) } : undefined),
      this.prisma.notificationBroadcast.count(),
      this.prisma.aiRun.count(),
      this.prisma.exercise.count({ where: { ownerUserId: { not: null } } }),
      this.prisma.equipmentType.count({ where: { ownerUserId: { not: null } } }),
    ]);

    return {
      otherUsers,
      workouts,
      gyms,
      measurements,
      healthDocuments,
      programs,
      trainingRuns,
      storageObjects,
      jobs,
      notifications,
      allowlistEntries,
      broadcasts,
      aiRuns,
      customExercises,
      customEquipment,
    };
  }

  /** Queues the factory reset, or returns the one already pending/running. */
  async requestReset(actorUserId: string): Promise<AdminFactoryResetStarted> {
    const job = await this.jobs.enqueue({
      type: ADMIN_FACTORY_RESET_TYPE,
      // A person asking for work to be done now.
      reason: 'rerun',
      payload: { actorUserId },
    });

    await this.prisma.auditEvent.create({
      data: {
        actorUserId,
        action: ADMIN_FACTORY_RESET_REQUESTED_ACTION,
        targetType: 'job',
        targetId: job.id,
        meta: { jobId: job.id, status: job.status } as Prisma.InputJsonValue,
      },
    });

    this.logger.warn(`Factory reset requested by user ${actorUserId} (job ${job.id}, ${job.status})`);

    return { jobId: job.id, status: job.status };
  }

  /** A factory reset job's status. 404 for a job of any other type. */
  async getResetStatus(jobId: string): Promise<AdminFactoryResetStatus> {
    const job = await this.prisma.job.findFirst({
      where: { id: jobId, type: ADMIN_FACTORY_RESET_TYPE },
      select: { id: true, status: true, lastError: true, payload: true },
    });

    if (!job) {
      throw new NotFoundException(ADMIN_FACTORY_RESET_JOB_NOT_FOUND);
    }

    return toFactoryResetStatus(job);
  }
}

/** The API shape of one factory reset job. `result` comes from the handler's `payload.result`. */
export function toFactoryResetStatus(
  job: Pick<Job, 'id' | 'status' | 'lastError' | 'payload'>,
): AdminFactoryResetStatus {
  const status: AdminFactoryResetStatus = { jobId: job.id, status: job.status };

  if (job.status === 'succeeded') {
    const result = readResult(job.payload);
    if (result) status.result = result;
  }

  if (job.status === 'failed') {
    status.error = job.lastError ?? 'The factory reset failed';
  }

  return status;
}

function readResult(payload: Prisma.JsonValue | null): AdminFactoryResetResult | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const parsed = adminFactoryResetResultSchema.safeParse((payload as Prisma.JsonObject).result);
  return parsed.success ? parsed.data : undefined;
}
