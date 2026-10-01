// =============================================================================
// `user.data_reset` job handler — a user's "factory reset" (issue #202)
// =============================================================================
//
// Deletes everything ONE user owns and keeps the account itself, so the user
// stays signed in and starts again from an empty app. Enqueued only by
// `POST /api/user-data/reset` (subject `user:<userId>`, so the queue's active
// dedup allows one pending/running reset per user).
//
// THREE STEPS:
//
//   1. COLLECT the storage objects to delete: every object the user uploaded
//      (`uploadedById`, which includes the avatar), every object linked through
//      the user's photo intakes, gym photos, workout photos and health
//      documents (`storageObjectId`, SET NULL on the object), and the avatar
//      named by the settings (`profile.imageObjectId`). The ids are written to
//      `payload.objectIds` BEFORE step 2, because step 2 cascades away the link
//      rows that name them: a retry after step 2 committed still knows them.
//   2. DELETE the user's rows in ONE `$transaction`, children before the
//      parents they `Restrict`, and record the counts on `payload.deleted` in
//      the same commit.
//   3. DELETE each collected object from the active storage provider, then its
//      row. A provider failure is counted (`storageObjectsFailed`), logged, and
//      KEEPS the row, so the object stays visible and a later reset retries it
//      (the same rule `ProfileImageService` applies to an avatar). It never
//      fails the job.
//
// The result is written to `payload.result` (the queue has no result column;
// `telemetry.stack.deploy` set the precedent) and `GET
// /api/user-data/reset/:jobId` reads it. An audit event
// `user.data_reset.completed` closes the run.
//
// RETRY-SAFE. Every delete is a `deleteMany` by owner, so re-running deletes
// what is left and nothing else; counts from an attempt that committed are
// carried on the payload and added to, never lost.
//
// SERVER-ONLY: neither `nodeResultSchema` nor `persistNodeResult`. It writes as
// it goes and deletes storage objects, which a node can neither do nor hold
// credentials for (CLAUDE.md queue rules 2 and 3).
//
// -----------------------------------------------------------------------------
// KEEP / DELETE, for every model with a path to a user (schema.prisma)
// -----------------------------------------------------------------------------
//
// DELETED (the user's own data):
//   HealthProfile                     userId
//   Measurement                       userId — every revision, check-ins included
//                                     (check-ins are wellness measurements).
//                                     `supersedesId` is cleared first: the
//                                     self-FK is ON DELETE RESTRICT.
//   HealthSummary,                    userId — every AI health summary version
//   HealthSummarySetting              and the opt-in consent (H8, #192), so a
//                                     reset turns the opt-in back off. Not
//                                     counted in the result (derived data).
//   PhotoIntake                       userId (cascades PhotoIntakePhoto, DraftItem)
//   HealthDocument                    userId — explicitly (it cascades only from
//                                     the User row, which is kept; the intake
//                                     link is SET NULL). Its file is collected
//                                     in step 1 and deleted in step 3: the
//                                     `health_documents` reference checker
//                                     only guards the intake's own cleanup,
//                                     and the document is gone by step 3.
//   Gym                               userId (cascades GymEquipment, GymPhoto,
//                                     GymEquipmentPhoto)
//   Workout                           userId (cascades WorkoutExercise, SetLog,
//                                     WorkoutPhoto, ProgramSession)
//   Program                           userId (cascades blocks, weeks, workouts,
//                                     exercises, versions, sessions, change log)
//   ProgramChangeLog, ProgramSession  userId — leftovers, explicitly
//   TrainingPlanRun                   userId (cascades TrainingRunEvent)
//   WorkoutAdaptation                 userId
//   TrainingRunCheckpoint(+Write)     threadId = a deleted run's or adaptation's
//                                     id. No FK, so NOT cascaded: explicit.
//   Exercise (custom)                 ownerUserId, AFTER workouts and programs
//                                     (WorkoutExercise/ProgramExercise RESTRICT);
//                                     one still used by another user's row is kept
//   EquipmentType (custom)            ownerUserId, AFTER gyms and exercises
//                                     (GymEquipment/ExerciseRequirement RESTRICT);
//                                     one still used elsewhere is kept
//   AiRun, AiUsageEvent               userId
//   UserAiKey, UserCredential         userId
//   PersonalAccessToken, DeviceCode   userId
//   PushSubscription, Notification    userId
//   NotificationDelivery              userId
//   UserSettings                      userId — `UserSettingsService.getSettings`
//                                     lazily recreates the defaults
//   StorageObject (+Chunk)            step 3
//   User.profileImageUrl/displayName  cleared (displayName mirrors a setting)
//   Job (pending, others')            a PENDING job whose subject is a deleted
//                                     row is deleted (including a
//                                     `health.document.purge` for a deleted
//                                     document: step 3 deletes its file)
//
// KEPT:
//   User, UserIdentity, UserRole      the account and its access
//   RefreshToken                      the user stays signed in
//   AllowedEmail                      who may sign in is the admin's list
//   AuditEvent                        the audit trail outlives the data
//   WorkerNode, NodeCredential        deployment infrastructure the user runs
//   SystemSettings, Credential,       deployment-level; the user is provenance
//   AiModel, NotificationBroadcast,
//   DatabaseBackupRun
//   Job (running and settled)         history; a RUNNING job of the user's
//                                     (a training run, a scan) finds its rows
//                                     gone and fails on its own, as handlers
//                                     already must tolerate
//   Seeded Exercise / EquipmentType,  catalog rows nobody owns
//   Capability, Role, Permission
//
// The raw-SQL partial unique indexes (one default gym, one in-progress
// workout, one active run/program/adaptation per user) are only ever relieved
// by these deletes, never touched.
// =============================================================================

import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job, Prisma } from '@prisma/client';

import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { STORAGE_PROVIDER, type StorageProvider } from '../../storage/providers/storage-provider.interface';
import type { UserDataResetResult } from '../dto/user-data.dto';
import {
  USER_DATA_RESET_COMPLETED_ACTION,
  USER_DATA_RESET_SUBJECT_TYPE,
  USER_DATA_RESET_TYPE,
} from '../user-data.constants';
import {
  type DeletedRowCounts,
  USER_DATA_RESET_TX_TIMEOUT_MS,
  ZERO_ROW_COUNTS,
  addCounts,
  collectUserObjectIds,
  deleteStorageObjects,
  deleteUserOwnedRows,
  payloadObject,
  readCounts,
} from '../user-data-purge';

// The deletion itself lives in `../user-data-purge.ts`, shared with the admin
// factory reset (#211); re-exported here for existing importers.
export {
  USER_DATA_RESET_CHUNK_SIZE,
  USER_DATA_RESET_TX_TIMEOUT_MS,
  chunk,
  type DeletedRowCounts,
} from '../user-data-purge';

/** What an earlier attempt of the same job left on its payload. */
interface ResetProgress {
  objectIds: string[];
  deleted: DeletedRowCounts | null;
}

function readProgress(payload: Prisma.JsonObject): ResetProgress {
  const ids = Array.isArray(payload.objectIds)
    ? payload.objectIds.filter((id): id is string => typeof id === 'string')
    : [];
  return { objectIds: ids, deleted: readCounts(payload.deleted, ZERO_ROW_COUNTS) };
}

@Injectable()
export class UserDataResetHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(UserDataResetHandler.name);

  readonly type = USER_DATA_RESET_TYPE;

  /** Retried on a database error; every step is idempotent. */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 15 * 60_000, maxAttempts: 3 };

  // Deliberately NO `nodeResultSchema` / `persistNodeResult` — see the header.

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  /** Throws to fail (a database error), so the queue's retry applies. */
  async process(job: Job): Promise<void> {
    const userId = this.resolveUserId(job);
    const base = payloadObject(job);
    const progress = readProgress(base);

    // Step 1 — collect, and remember before anything is deleted.
    const collected = await this.collectObjectIds(userId);
    const objectIds = [...new Set([...progress.objectIds, ...collected])];
    let payload: Prisma.JsonObject = { ...base, objectIds };
    await this.prisma.job.update({ where: { id: job.id }, data: { payload } });

    // Step 2 — the rows, in one transaction, counts committed with them.
    const deleted = await this.prisma.$transaction(
      async (tx) => {
        const counts = await this.deleteRows(tx, userId, job.id, objectIds);
        const total = progress.deleted ? addCounts(progress.deleted, counts) : counts;
        payload = { ...payload, deleted: total };
        await tx.job.update({ where: { id: job.id }, data: { payload } });
        return total;
      },
      { timeout: USER_DATA_RESET_TX_TIMEOUT_MS },
    );

    // Step 3 — the bytes. Never throws for a provider failure.
    const storage = await this.deleteObjects(userId, objectIds);

    const result: UserDataResetResult = { ...deleted, ...storage };
    await this.prisma.job.update({
      where: { id: job.id },
      data: { payload: { ...payload, result } as Prisma.InputJsonValue },
    });

    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action: USER_DATA_RESET_COMPLETED_ACTION,
        targetType: 'user',
        targetId: userId,
        meta: { jobId: job.id, ...result } as Prisma.InputJsonValue,
      },
    });

    this.logger.log(
      `Data reset for user ${userId} finished (job ${job.id}): ` +
        `${storage.storageObjectsDeleted} object(s) deleted, ${storage.storageObjectsFailed} failed`,
    );
  }

  /** The user this job resets. The subject is authoritative; the payload must agree. */
  private resolveUserId(job: Job): string {
    const payloadUserId = payloadObject(job).userId;

    if (job.subjectType !== USER_DATA_RESET_SUBJECT_TYPE || !job.subjectId) {
      throw new Error(`Invalid ${USER_DATA_RESET_TYPE} job ${job.id}: expected subject user:<userId>`);
    }
    if (payloadUserId !== undefined && payloadUserId !== job.subjectId) {
      throw new Error(`Invalid ${USER_DATA_RESET_TYPE} job ${job.id}: payload userId does not match the subject`);
    }

    return job.subjectId;
  }

  /** Step 1: every storage object id the reset must delete. */
  collectObjectIds(userId: string): Promise<string[]> {
    return collectUserObjectIds(this.prisma, userId);
  }

  /**
   * Step 2: every row the header lists as DELETED, children before the
   * parents they RESTRICT. Runs inside the caller's transaction.
   */
  deleteRows(
    tx: Prisma.TransactionClient,
    userId: string,
    jobId: string,
    objectIds: readonly string[],
  ): Promise<DeletedRowCounts> {
    return deleteUserOwnedRows(tx, userId, jobId, objectIds);
  }

  /**
   * Step 3: bytes first, then the row. A failure keeps the row and is
   * counted; it never throws.
   */
  deleteObjects(
    userId: string,
    objectIds: readonly string[],
  ): Promise<{ storageObjectsDeleted: number; storageObjectsFailed: number }> {
    return deleteStorageObjects(this.prisma, this.storage, this.logger, `Data reset for user ${userId}`, objectIds);
  }
}
