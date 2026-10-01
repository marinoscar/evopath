// =============================================================================
// Per-user data purge — the deletion half of a data reset, shared (#202, #211)
// =============================================================================
//
// The row-level and storage-level deletes that make ONE user's data disappear
// while keeping the account. Extracted from `UserDataResetHandler` so the
// admin factory reset (`admin.factory_reset`, issue #211) runs exactly the
// same per-user deletion for every user rather than a second copy of it that
// could drift. The keep/delete decisions for every user-owned model are
// documented in `handlers/user-data-reset.handler.ts`; this file only
// executes them.
//
// Every function takes its Prisma client (or transaction client) as an
// argument and holds no state, so callers decide transaction boundaries.
// =============================================================================

import type { Logger } from '@nestjs/common';
import type { Job, Prisma, PrismaClient } from '@prisma/client';

import { normalizeProfileSettings } from '../common/profile-image/profile-image';
import type { StorageProvider } from '../storage/providers/storage-provider.interface';
import type { UserDataResetResult } from './dto/user-data.dto';

/** Largest `IN (...)` list sent in one statement. */
export const USER_DATA_RESET_CHUNK_SIZE = 1000;

/** The deletion transaction may take a while for a heavy user; Prisma's default is 5 s. */
export const USER_DATA_RESET_TX_TIMEOUT_MS = 5 * 60_000;

/** Counts written by the row deletion step. */
export type DeletedRowCounts = Omit<UserDataResetResult, 'storageObjectsDeleted' | 'storageObjectsFailed'>;

export const ZERO_ROW_COUNTS: Readonly<DeletedRowCounts> = Object.freeze({
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
});

/** The Prisma surface these functions need: the service, the raw client or a transaction. */
type Db = Prisma.TransactionClient | PrismaClient;

export function chunk<T>(items: readonly T[], size = USER_DATA_RESET_CHUNK_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** A job's payload as an object (`{}` for null or a non-object). */
export function payloadObject(job: Pick<Job, 'payload'>): Prisma.JsonObject {
  return job.payload && typeof job.payload === 'object' && !Array.isArray(job.payload)
    ? (job.payload as Prisma.JsonObject)
    : {};
}

/** Reads a counts object an earlier attempt left on the payload; missing keys are 0. */
export function readCounts<T extends Record<string, number>>(raw: unknown, zero: Readonly<T>): T | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = { ...zero } as T;
  for (const key of Object.keys(zero) as (keyof T)[]) {
    const value = (raw as Record<string, unknown>)[key as string];
    (out as Record<keyof T, number>)[key] = typeof value === 'number' ? value : 0;
  }
  return out;
}

/** Key-wise sum of two counts objects of the same shape. */
export function addCounts<T extends Record<string, number>>(a: T, b: Partial<T>): T {
  const sum = { ...a };
  for (const key of Object.keys(b) as (keyof T)[]) {
    (sum as Record<keyof T, number>)[key] = (sum[key] ?? 0) + (b[key] ?? 0);
  }
  return sum;
}

/** Every storage object id a user's reset must delete (uploads, photo and document links, the avatar). */
export async function collectUserObjectIds(db: Db, userId: string): Promise<string[]> {
  const [uploaded, intakePhotos, gymPhotos, workoutPhotos, healthDocuments, settings] = await Promise.all([
    db.storageObject.findMany({ where: { uploadedById: userId }, select: { id: true } }),
    db.photoIntakePhoto.findMany({
      where: { intake: { userId } },
      select: { storageObjectId: true },
    }),
    db.gymPhoto.findMany({ where: { gym: { userId } }, select: { storageObjectId: true } }),
    db.workoutPhoto.findMany({
      where: { workout: { userId } },
      select: { storageObjectId: true },
    }),
    // A purged document has already given its file up (`storageObjectId` null).
    db.healthDocument.findMany({
      where: { userId, storageObjectId: { not: null } },
      select: { storageObjectId: true },
    }),
    db.userSettings.findUnique({ where: { userId }, select: { value: true } }),
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
 * Every row of ONE user that a data reset deletes, children before the
 * parents they RESTRICT. Runs inside the caller's transaction. Keeps the
 * account (User, identities, roles, refresh tokens).
 *
 * `jobId` is the running reset job, never cancelled; `objectIds` are extra
 * subject ids whose PENDING jobs are cancelled with the rest.
 */
export async function deleteUserOwnedRows(
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

/** What `deleteStorageObjects` did. */
export interface StorageDeletionCounts {
  storageObjectsDeleted: number;
  storageObjectsFailed: number;
}

/**
 * Bytes first (aborting an unfinished multipart upload), then the row. A
 * provider failure keeps the row, is counted and logged under `context`, and
 * never throws.
 */
export async function deleteStorageObjects(
  db: Db,
  storage: StorageProvider,
  logger: Pick<Logger, 'warn'>,
  context: string,
  objectIds: readonly string[],
): Promise<StorageDeletionCounts> {
  let storageObjectsDeleted = 0;
  let storageObjectsFailed = 0;

  for (const ids of chunk(objectIds)) {
    const objects = await db.storageObject.findMany({
      where: { id: { in: ids } },
      select: { id: true, storageKey: true, s3UploadId: true },
    });

    for (const object of objects) {
      try {
        // Abort an unfinished multipart upload first: its parts are billed
        // and the row is the only record of the upload id.
        if (object.s3UploadId) {
          await storage.abortMultipartUpload(object.storageKey, object.s3UploadId);
        }
        await storage.delete(object.storageKey);
      } catch (error) {
        storageObjectsFailed += 1;
        logger.warn(
          `${context}: could not delete storage object ${object.id}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }

      // Chunks cascade. A row already gone (a concurrent delete) is fine.
      const { count } = await db.storageObject.deleteMany({ where: { id: object.id } });
      storageObjectsDeleted += count;
    }
  }

  return { storageObjectsDeleted, storageObjectsFailed };
}
