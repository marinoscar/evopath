import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Job, Prisma } from '@prisma/client';

import { JobsService } from '../jobs/jobs.service';
import { ACTIVE } from '../measurements/measurement-active';
import { PrismaService } from '../prisma/prisma.service';
import {
  type UserDataResetResult,
  type UserDataResetStarted,
  type UserDataResetStatus,
  type UserDataSummary,
  userDataResetResultSchema,
} from './dto/user-data.dto';
import {
  USER_DATA_RESET_REQUESTED_ACTION,
  USER_DATA_RESET_SUBJECT_TYPE,
  USER_DATA_RESET_TYPE,
} from './user-data.constants';

// =============================================================================
// UserDataService — the caller's own data reset (issue #202)
// =============================================================================
//
// The request half of the factory reset: a summary of what the caller owns,
// the enqueue (the deletion itself is the `user.data_reset` job — it deletes
// storage objects one network round trip at a time, so it is queue work,
// CLAUDE.md queue rule 1), and the job's status.
//
// EVERY READ IS SCOPED TO THE CALLER. The status lookup matches type, subject
// type AND subject id in one query, so another user's job id is a 404 exactly
// like an unknown one: the answer never says whether the id exists.
// =============================================================================

export const USER_DATA_RESET_JOB_NOT_FOUND = 'Data reset job not found';

@Injectable()
export class UserDataService {
  private readonly logger = new Logger(UserDataService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
  ) {}

  /** Counts of what the caller owns, so the UI can say what a reset loses. */
  async getSummary(userId: string): Promise<UserDataSummary> {
    const [
      workouts,
      gyms,
      measurements,
      programs,
      trainingRuns,
      customExercises,
      photos,
      aiKeys,
      accessTokens,
      notifications,
      customEquipment,
      photoIntakes,
      workoutAdaptations,
      userCredentials,
      healthDocuments,
    ] = await Promise.all([
      this.prisma.workout.count({ where: { userId } }),
      this.prisma.gym.count({ where: { userId } }),
      this.prisma.measurement.count({ where: { userId, ...ACTIVE } }),
      this.prisma.program.count({ where: { userId } }),
      this.prisma.trainingPlanRun.count({ where: { userId } }),
      this.prisma.exercise.count({ where: { ownerUserId: userId } }),
      this.prisma.storageObject.count({ where: { uploadedById: userId } }),
      this.prisma.userAiKey.count({ where: { userId } }),
      this.prisma.personalAccessToken.count({ where: { userId, revokedAt: null } }),
      this.prisma.notification.count({ where: { userId } }),
      this.prisma.equipmentType.count({ where: { ownerUserId: userId } }),
      this.prisma.photoIntake.count({ where: { userId } }),
      this.prisma.workoutAdaptation.count({ where: { userId } }),
      this.prisma.userCredential.count({ where: { userId } }),
      this.prisma.healthDocument.count({ where: { userId } }),
    ]);

    return {
      workouts,
      gyms,
      measurements,
      programs,
      trainingRuns,
      customExercises,
      photos,
      aiKeys,
      accessTokens,
      notifications,
      customEquipment,
      photoIntakes,
      workoutAdaptations,
      userCredentials,
      healthDocuments,
    };
  }

  /**
   * Queues the caller's reset, or returns the one already pending/running.
   *
   * Dedup is the queue's own (`jobs_active_dedup_uniq_idx` over
   * `user.data_reset:user:<userId>`), never a `findFirst` pre-check: two
   * concurrent clicks both land on one job.
   */
  async requestReset(userId: string): Promise<UserDataResetStarted> {
    const job = await this.jobs.enqueue({
      type: USER_DATA_RESET_TYPE,
      // A person asking for work to be done now.
      reason: 'rerun',
      subjectType: USER_DATA_RESET_SUBJECT_TYPE,
      subjectId: userId,
      payload: { userId },
    });

    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action: USER_DATA_RESET_REQUESTED_ACTION,
        targetType: 'user',
        targetId: userId,
        meta: { jobId: job.id, status: job.status } as Prisma.InputJsonValue,
      },
    });

    this.logger.log(`Data reset requested by user ${userId} (job ${job.id}, ${job.status})`);

    return { jobId: job.id, status: job.status };
  }

  /** The caller's reset job. 404 for any other job, including another user's reset. */
  async getResetStatus(userId: string, jobId: string): Promise<UserDataResetStatus> {
    const job = await this.prisma.job.findFirst({
      where: {
        id: jobId,
        type: USER_DATA_RESET_TYPE,
        subjectType: USER_DATA_RESET_SUBJECT_TYPE,
        subjectId: userId,
      },
      select: { id: true, status: true, lastError: true, payload: true },
    });

    if (!job) {
      throw new NotFoundException(USER_DATA_RESET_JOB_NOT_FOUND);
    }

    return toResetStatus(job);
  }
}

/** The API shape of one reset job. `result` comes from the handler's `payload.result`. */
export function toResetStatus(
  job: Pick<Job, 'id' | 'status' | 'lastError' | 'payload'>,
): UserDataResetStatus {
  const status: UserDataResetStatus = { jobId: job.id, status: job.status };

  if (job.status === 'succeeded') {
    const result = readResult(job.payload);
    if (result) status.result = result;
  }

  if (job.status === 'failed') {
    status.error = job.lastError ?? 'The data reset failed';
  }

  return status;
}

function readResult(payload: Prisma.JsonValue | null): UserDataResetResult | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const parsed = userDataResetResultSchema.safeParse((payload as Prisma.JsonObject).result);
  return parsed.success ? parsed.data : undefined;
}
