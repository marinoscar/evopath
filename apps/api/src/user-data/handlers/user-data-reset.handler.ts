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

import { normalizeProfileSettings } from '../../common/profile-image/profile-image';
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

/** Largest `IN (...)` list sent in one statement. */
export const USER_DATA_RESET_CHUNK_SIZE = 1000;

/** The deletion transaction may take a while for a heavy user; Prisma's default is 5 s. */
export const USER_DATA_RESET_TX_TIMEOUT_MS = 5 * 60_000;

/** Counts written by step 2. */
export type DeletedRowCounts = Omit<UserDataResetResult, 'storageObjectsDeleted' | 'storageObjectsFailed'>;

const ZERO_ROW_COUNTS: DeletedRowCounts = {
  workouts: 0,
  gyms: 0,
  measurements: 0,
  healthProfiles: 0,
  photoIntakes: 0,
  healthDocuments: 0,
  programs: 0,
  programChangeLogs: 0,
  trainingRuns: 0,
  workoutAdaptations: 0,
  trainingCheckpoints: 0,
  customExercises: 0,
  customEquipment: 0,
  aiRuns: 0,
  aiUsageEvents: 0,
  aiKeys: 0,
  userCredentials: 0,
  accessTokens: 0,
  deviceCodes: 0,
  pushSubscriptions: 0,
  notifications: 0,
  notificationDeliveries: 0,
  userSettings: 0,
  cancelledJobs: 0,
};

/** What an earlier attempt of the same job left on its payload. */
interface ResetProgress {
  objectIds: string[];
  deleted: DeletedRowCounts | null;
}

export function chunk<T>(items: readonly T[], size = USER_DATA_RESET_CHUNK_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function payloadObject(job: Pick<Job, 'payload'>): Prisma.JsonObject {
  return job.payload && typeof job.payload === 'object' && !Array.isArray(job.payload)
    ? (job.payload as Prisma.JsonObject)
    : {};
}

function readProgress(payload: Prisma.JsonObject): ResetProgress {
  const ids = Array.isArray(payload.objectIds)
    ? payload.objectIds.filter((id): id is string => typeof id === 'string')
    : [];

  const raw = payload.deleted;
  let deleted: DeletedRowCounts | null = null;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    deleted = { ...ZERO_ROW_COUNTS };
    for (const key of Object.keys(ZERO_ROW_COUNTS) as (keyof DeletedRowCounts)[]) {
      const value = (raw as Prisma.JsonObject)[key];
      deleted[key] = typeof value === 'number' ? value : 0;
    }
  }

  return { objectIds: ids, deleted };
}

function addCounts(a: DeletedRowCounts, b: DeletedRowCounts): DeletedRowCounts {
  const sum = { ...a };
  for (const key of Object.keys(sum) as (keyof DeletedRowCounts)[]) sum[key] += b[key];
  return sum;
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
  async collectObjectIds(userId: string): Promise<string[]> {
    const [uploaded, intakePhotos, gymPhotos, workoutPhotos, healthDocuments, settings] = await Promise.all([
      this.prisma.storageObject.findMany({ where: { uploadedById: userId }, select: { id: true } }),
      this.prisma.photoIntakePhoto.findMany({
        where: { intake: { userId } },
        select: { storageObjectId: true },
      }),
      this.prisma.gymPhoto.findMany({ where: { gym: { userId } }, select: { storageObjectId: true } }),
      this.prisma.workoutPhoto.findMany({
        where: { workout: { userId } },
        select: { storageObjectId: true },
      }),
      // A purged document has already given its file up (`storageObjectId` null).
      this.prisma.healthDocument.findMany({
        where: { userId, storageObjectId: { not: null } },
        select: { storageObjectId: true },
      }),
      this.prisma.userSettings.findUnique({ where: { userId }, select: { value: true } }),
    ]);

    const ids = new Set<string>();
    uploaded.forEach((row) => ids.add(row.id));
    intakePhotos.forEach((row) => ids.add(row.storageObjectId));
    gymPhotos.forEach((row) => ids.add(row.storageObjectId));
    workoutPhotos.forEach((row) => ids.add(row.storageObjectId));
    healthDocuments.forEach((row) => {
      if (row.storageObjectId) ids.add(row.storageObjectId);
    });

    const settingsValue = settings?.value as { profile?: unknown } | null | undefined;
    const avatarId = settingsValue ? normalizeProfileSettings(settingsValue.profile).imageObjectId : null;
    if (avatarId) ids.add(avatarId);

    return [...ids];
  }

  /**
   * Step 2: every row the header lists as DELETED, children before the
   * parents they RESTRICT. Runs inside the caller's transaction.
   */
  async deleteRows(
    tx: Prisma.TransactionClient,
    userId: string,
    jobId: string,
    objectIds: readonly string[],
  ): Promise<DeletedRowCounts> {
    const counts: DeletedRowCounts = { ...ZERO_ROW_COUNTS };

    // Ids the rest of the system may name without a foreign key: checkpoints
    // (thread = run or adaptation id) and pending jobs' subjects.
    const [runs, adaptations, intakes, workouts, gyms, programs, healthDocuments] = await Promise.all([
      tx.trainingPlanRun.findMany({ where: { userId }, select: { id: true } }),
      tx.workoutAdaptation.findMany({ where: { userId }, select: { id: true } }),
      tx.photoIntake.findMany({ where: { userId }, select: { id: true } }),
      tx.workout.findMany({ where: { userId }, select: { id: true } }),
      tx.gym.findMany({ where: { userId }, select: { id: true } }),
      tx.program.findMany({ where: { userId }, select: { id: true } }),
      tx.healthDocument.findMany({ where: { userId }, select: { id: true } }),
    ]);
    const threadIds = [...runs, ...adaptations].map((row) => row.id);
    const subjectIds = [
      ...threadIds,
      ...[...intakes, ...workouts, ...gyms, ...programs, ...healthDocuments].map((row) => row.id),
      ...objectIds,
    ];

    // Pending jobs about rows that are about to disappear. Running ones are
    // left to fail on their own; this job itself is excluded.
    for (const ids of chunk(subjectIds)) {
      const { count } = await tx.job.deleteMany({
        where: { status: 'pending', subjectId: { in: ids }, id: { not: jobId } },
      });
      counts.cancelledJobs += count;
    }

    // Training: checkpoints carry no FK, so they are deleted explicitly.
    for (const ids of chunk(threadIds)) {
      await tx.trainingRunCheckpointWrite.deleteMany({ where: { threadId: { in: ids } } });
      const { count } = await tx.trainingRunCheckpoint.deleteMany({ where: { threadId: { in: ids } } });
      counts.trainingCheckpoints += count;
    }
    counts.workoutAdaptations = (await tx.workoutAdaptation.deleteMany({ where: { userId } })).count;
    counts.trainingRuns = (await tx.trainingPlanRun.deleteMany({ where: { userId } })).count;

    // Workouts before programs is not required (ProgramSession cascades from
    // both); both before custom exercises (WorkoutExercise/ProgramExercise
    // RESTRICT the exercise).
    await tx.programSession.deleteMany({ where: { userId } });
    counts.workouts = (await tx.workout.deleteMany({ where: { userId } })).count;
    counts.programChangeLogs = (await tx.programChangeLog.deleteMany({ where: { userId } })).count;
    counts.programs = (await tx.program.deleteMany({ where: { userId } })).count;

    // Health documents cascade only from the (kept) User row, so they are
    // deleted explicitly; their intake link is SET NULL. Files: step 3.
    counts.healthDocuments = (await tx.healthDocument.deleteMany({ where: { userId } })).count;
    counts.photoIntakes = (await tx.photoIntake.deleteMany({ where: { userId } })).count;
    // Before custom equipment (GymEquipment RESTRICTs the equipment type).
    counts.gyms = (await tx.gym.deleteMany({ where: { userId } })).count;

    // A custom row another user's data still references is kept rather than
    // failing the whole reset on its RESTRICT.
    counts.customExercises = (
      await tx.exercise.deleteMany({
        where: { ownerUserId: userId, workoutExercises: { none: {} }, programExercises: { none: {} } },
      })
    ).count;
    counts.customEquipment = (
      await tx.equipmentType.deleteMany({
        where: { ownerUserId: userId, gymEquipment: { none: {} }, exerciseRequirements: { none: {} } },
      })
    ).count;

    // Health data. The revision chain's self-FK is RESTRICT: unlink it first.
    await tx.measurement.updateMany({
      where: { userId, supersedesId: { not: null } },
      data: { supersedesId: null },
    });
    counts.measurements = (await tx.measurement.deleteMany({ where: { userId } })).count;
    counts.healthProfiles = (await tx.healthProfile.deleteMany({ where: { userId } })).count;

    // AI and secrets.
    counts.aiRuns = (await tx.aiRun.deleteMany({ where: { userId } })).count;
    counts.aiUsageEvents = (await tx.aiUsageEvent.deleteMany({ where: { userId } })).count;
    counts.aiKeys = (await tx.userAiKey.deleteMany({ where: { userId } })).count;
    counts.userCredentials = (await tx.userCredential.deleteMany({ where: { userId } })).count;

    // Credentials other than the session. DeviceCode → PAT is SET NULL, and a
    // refresh token's deviceCodeId is SET NULL, so the session survives.
    counts.deviceCodes = (await tx.deviceCode.deleteMany({ where: { userId } })).count;
    counts.accessTokens = (await tx.personalAccessToken.deleteMany({ where: { userId } })).count;

    // Notifications.
    counts.pushSubscriptions = (await tx.pushSubscription.deleteMany({ where: { userId } })).count;
    counts.notifications = (await tx.notification.deleteMany({ where: { userId } })).count;
    counts.notificationDeliveries = (await tx.notificationDelivery.deleteMany({ where: { userId } })).count;

    // Settings fall back to defaults on next read; the avatar and display
    // name the settings drove are cleared on the user row.
    counts.userSettings = (await tx.userSettings.deleteMany({ where: { userId } })).count;
    await tx.user.updateMany({
      where: { id: userId },
      data: { profileImageUrl: null, displayName: null },
    });

    return counts;
  }

  /**
   * Step 3: bytes first, then the row. A failure keeps the row and is
   * counted; it never throws.
   */
  async deleteObjects(
    userId: string,
    objectIds: readonly string[],
  ): Promise<{ storageObjectsDeleted: number; storageObjectsFailed: number }> {
    let storageObjectsDeleted = 0;
    let storageObjectsFailed = 0;

    for (const ids of chunk(objectIds)) {
      const objects = await this.prisma.storageObject.findMany({
        where: { id: { in: ids } },
        select: { id: true, storageKey: true, s3UploadId: true },
      });

      for (const object of objects) {
        try {
          // Abort an unfinished multipart upload first: its parts are billed
          // and the row is the only record of the upload id.
          if (object.s3UploadId) {
            await this.storage.abortMultipartUpload(object.storageKey, object.s3UploadId);
          }
          await this.storage.delete(object.storageKey);
        } catch (error) {
          storageObjectsFailed += 1;
          this.logger.warn(
            `Data reset for user ${userId}: could not delete storage object ${object.id}: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }

        // Chunks cascade. A row already gone (a concurrent delete) is fine.
        const { count } = await this.prisma.storageObject.deleteMany({ where: { id: object.id } });
        storageObjectsDeleted += count;
      }
    }

    return { storageObjectsDeleted, storageObjectsFailed };
  }
}
