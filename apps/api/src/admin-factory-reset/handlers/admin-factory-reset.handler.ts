// =============================================================================
// `admin.factory_reset` job handler — reset the whole application (issue #211)
// =============================================================================
//
// Returns the deployment to a clean slate while keeping the administrator who
// asked, the configuration, the infrastructure and the backups. Enqueued only
// by `POST /api/admin/factory-reset` (no subject, so the queue's active dedup
// allows ONE pending/running factory reset per deployment). Payload:
// `{ actorUserId }`.
//
// STEPS, each its own transaction (or its own provider call), in this order:
//
//   1. JOBS. Delete every PENDING, SUCCEEDED and FAILED job row except this
//      job and any job a `DatabaseBackupRun` links to, in chunks. First, so
//      queued work about rows that are about to go (a training run, a scan)
//      does not start mid-reset. RUNNING jobs of other types are left alone:
//      they hold a lease and a worker; they find their rows gone and fail on
//      their own, as handlers already must tolerate.
//   2. EVERY USER'S DATA. For each user, the actor included, the SAME per-user
//      deletion the user's own data reset runs (`deleteUserOwnedRows`,
//      `user-data/user-data-purge.ts`), one transaction per user. A table that
//      gains a user relation is added there once and covered here for free.
//   3. CUSTOM CATALOG ROWS. Custom exercises, then custom equipment types
//      (`ownerUserId` not null) that step 2 kept because ANOTHER user's
//      workout/program/gym still used them. Every user's data is gone now, so
//      they are unreferenced. Must precede step 5: `Exercise.owner` is a
//      CASCADE, and cascading an exercise still used by a workout would hit
//      `WorkoutExercise`'s RESTRICT and fail the user delete.
//   4. NODES. Worker nodes and node credentials of other users are handed to
//      the actor (`createdById`/`userId` reassigned) instead of cascading away
//      with their owner: nodes are infrastructure, and the actor can see and
//      revoke the credentials at /api/node-credentials. A node whose name the
//      actor already uses cannot be reassigned (`@@unique([createdById,
//      name])`); it is left to cascade with its owner and counted as
//      `workerNodesRemoved`.
//   5. OTHER USERS. `User.deleteMany` in chunks. Everything still pointing at
//      them either CASCADES (identities, roles, refresh tokens, settings) or
//      is SET NULL provenance on a table that is kept (audit, settings,
//      credentials, AI models, backup runs). Step 2 already deleted the
//      SET NULL rows that are user data (AiRun, AiUsageEvent,
//      NotificationDelivery), so none are left as orphans.
//   6. DEPLOYMENT-WIDE LEFTOVERS, one transaction: allowlist (except the
//      actor's own entry), broadcasts, and rows with a nullable or no user
//      that step 2 could not reach (notification deliveries, AI runs and
//      usage events without a user, device codes not yet approved,
//      checkpoints whose run is gone, job statistics).
//   7. STORAGE. Every `StorageObject` whose `storageKey` is not a backup
//      archive's, in id order: bytes from the provider, then the row. A
//      provider failure is counted (`storageObjectsFailed`), logged, KEEPS
//      the row, and never fails the job — the rule the user reset follows.
//
// WHY SEVERAL TRANSACTIONS, NOT ONE. A deployment's worth of rows in one
// transaction would hold locks on every user table for minutes and exceed any
// sane transaction timeout. Each step is instead an idempotent `deleteMany`
// by a condition that a re-run re-evaluates, so a retry after any committed
// step deletes what is left and nothing else. Counts are committed onto
// `payload.deleted` in the same transaction as the rows they count, so a retry
// adds to them rather than losing them.
//
// WHY STORAGE IDS ARE NOT PERSISTED FIRST (unlike the user reset). The user
// reset must remember its object ids before step 2 because the link rows that
// identify "this user's objects" cascade away. Here the set is "every object
// that is not a backup archive", which a retry recomputes exactly; row
// deletion never removes a `StorageObject` (`uploadedById` is SET NULL). So
// there is nothing to lose, and no deployment-sized id list in a JSON payload.
//
// The result is written to `payload.result` (the queue has no result column;
// the user reset set the precedent) and `GET /api/admin/factory-reset/:jobId`
// reads it. An audit event `admin.factory_reset.completed` closes the run.
//
// SERVER-ONLY: neither `nodeResultSchema` nor `persistNodeResult`. It writes
// as it goes, spans every table and deletes storage objects (CLAUDE.md queue
// rules 2 and 3).
//
// -----------------------------------------------------------------------------
// KEEP / DELETE, for EVERY model in schema.prisma
// -----------------------------------------------------------------------------
//
//   Model                        Decision
//   ---------------------------  ------------------------------------------------
//   User                         actor KEPT; every other user DELETED (step 5)
//   UserIdentity, UserRole       actor's KEPT; others' cascade with their user
//   RefreshToken                 actor's KEPT (stays signed in); others' cascade
//   Role, Permission,
//   RolePermission               KEPT (seeded access model)
//   SystemSettings               KEPT (deployment configuration)
//   UserSettings                 DELETED (step 2; defaults recreated on read)
//   AuditEvent                   KEPT (the audit trail outlives the data;
//                                actorUserId of deleted users is SET NULL)
//   PersonalAccessToken          DELETED (step 2; others' also cascade)
//   AllowedEmail                 DELETED except the actor's entry (by email,
//                                case-insensitive, or claimed by the actor)
//   DeviceCode                   DELETED (step 2, plus all remaining ones in step 6)
//   StorageObject (+Chunk)       DELETED except backup archives (step 7)
//   Credential                   KEPT (deployment credentials: storage, AI, SMTP)
//   UserCredential               DELETED (step 2)
//   NotificationDelivery         DELETED (step 2, plus user-less ones in step 6)
//   Notification                 DELETED (step 2, plus a final sweep in step 6)
//   PushSubscription             DELETED (step 2, plus a final sweep in step 6)
//   NotificationBroadcast        DELETED (step 6)
//   Job                          pending/succeeded/failed DELETED (step 1);
//                                KEPT: this job, running jobs, and jobs linked
//                                from a DatabaseBackupRun
//   JobStatsRollup               DELETED (step 6): it is aggregated job history,
//                                and job history is deleted; the counters
//                                restart from this job's own completion
//   WorkerNode                   KEPT, other users' reassigned to the actor
//                                (step 4); a name clash cascades (counted)
//   NodeCredential               KEPT, other users' reassigned to the actor
//   JobNodeSecret                KEPT (no FK; holds only handles, and the
//                                node-secret sweep must still see them to
//                                revoke what they name)
//   DatabaseBackupRun            KEPT, and its archive is never deleted
//   AiModel                      KEPT (deployment catalog)
//   UserAiKey                    DELETED (step 2)
//   AiRun, AiUsageEvent          DELETED (step 2, plus user-less ones in step 6)
//   HealthProfile, Measurement   DELETED (step 2)
//   PhotoIntake (+Photo,
//   DraftItem)                   DELETED (step 2, cascades)
//   HealthDocument               DELETED (step 2, explicitly: it cascades only
//                                from the User row). Its file is deleted in
//                                step 7 with every non-backup object; a
//                                pending `health.document.purge` job is
//                                deleted in step 1 with every pending job
//   Gym (+GymEquipment,
//   GymPhoto, GymEquipmentPhoto) DELETED (step 2, cascades)
//   Capability                   KEPT (seeded catalog)
//   EquipmentType                seeded KEPT; custom DELETED (steps 2 and 3)
//   EquipmentTypeCapability      follows its equipment type (cascade)
//   Exercise                     seeded KEPT; custom DELETED (steps 2 and 3)
//   ExerciseRequirement          follows its exercise (cascade)
//   Workout (+WorkoutPhoto,
//   WorkoutExercise, SetLog)     DELETED (step 2, cascades)
//   TrainingRunCheckpoint(+Write) DELETED (step 2 by run id; orphans in step 6)
//   TrainingPlanRun
//   (+TrainingRunEvent)          DELETED (step 2)
//   WorkoutAdaptation            DELETED (step 2)
//   ProgressPhoto, CoachMessage,
//   UserMemory, UserMemoryState,
//   CoachState                   DELETED (step 2, explicitly: they cascade only
//                                from the User row). Photo images and coach
//                                voice notes are deleted in step 7 with every
//                                non-backup object
//   Program (+Block, Week,
//   Workout, Exercise, Version)  DELETED (step 2, cascades)
//   ProgramChangeLog,
//   ProgramSession               DELETED (step 2)
//   AndroidAppRelease            KEPT (deployment artifact, #285): rows and
//                                their APKs under `android-releases/` (not
//                                StorageObject rows, so step 7 never sees
//                                them); uploadedById of deleted users SET NULL
//
// The raw-SQL partial unique indexes (one active job per dedup key, one
// default gym / in-progress workout / active run / active program / active
// adaptation per user, one active backup) are only ever relieved by these
// deletes, never touched.
// =============================================================================

import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job, Prisma } from '@prisma/client';

import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { STORAGE_PROVIDER, type StorageProvider } from '../../storage/providers/storage-provider.interface';
import {
  USER_DATA_RESET_CHUNK_SIZE,
  USER_DATA_RESET_TX_TIMEOUT_MS,
  ZERO_ROW_COUNTS,
  addCounts,
  deleteStorageObjects,
  deleteUserOwnedRows,
  payloadObject,
  readCounts,
} from '../../user-data/user-data-purge';
import {
  ADMIN_FACTORY_RESET_COMPLETED_ACTION,
  ADMIN_FACTORY_RESET_TYPE,
} from '../admin-factory-reset.constants';
import { DELETABLE_JOB_STATUSES, allowlistEntriesToDelete } from '../admin-factory-reset.service';
import type { AdminFactoryResetResult } from '../dto/admin-factory-reset.dto';

/** Row counts committed step by step onto `payload.deleted`. */
export type FactoryResetRowCounts = Omit<AdminFactoryResetResult, 'storageObjectsDeleted' | 'storageObjectsFailed'>;

export const ZERO_FACTORY_RESET_COUNTS: Readonly<FactoryResetRowCounts> = Object.freeze({
  ...ZERO_ROW_COUNTS,
  usersDeleted: 0,
  jobs: 0,
  jobStatsRollups: 0,
  allowlistEntries: 0,
  broadcasts: 0,
  workerNodesReassigned: 0,
  nodeCredentialsReassigned: 0,
  workerNodesRemoved: 0,
});

/** Rows per chunked step (job ids, user ids, storage objects). */
export const FACTORY_RESET_CHUNK_SIZE = USER_DATA_RESET_CHUNK_SIZE;

interface Actor {
  id: string;
  email: string;
}

@Injectable()
export class AdminFactoryResetHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(AdminFactoryResetHandler.name);

  readonly type = ADMIN_FACTORY_RESET_TYPE;

  /** Retried on a database error; every step is idempotent. */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 30 * 60_000, maxAttempts: 3 };

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
    const actor = await this.resolveActor(job);
    const base = payloadObject(job);
    const run = new StepRunner(
      this.prisma,
      job.id,
      base,
      readCounts(base.deleted, ZERO_FACTORY_RESET_COUNTS) ?? { ...ZERO_FACTORY_RESET_COUNTS },
    );

    await this.deleteJobs(run, job.id);
    await this.deleteEveryUsersData(run, job.id);
    await this.deleteCustomCatalogRows(run);
    await this.reassignNodes(run, actor);
    await this.deleteOtherUsers(run, actor);
    await this.deleteDeploymentLeftovers(run, actor);
    const storage = await this.deleteStorage();

    const result: AdminFactoryResetResult = { ...run.totals, ...storage };
    await this.prisma.job.update({
      where: { id: job.id },
      data: { payload: { ...run.payload, result } as Prisma.InputJsonValue },
    });

    await this.prisma.auditEvent.create({
      data: {
        actorUserId: actor.id,
        action: ADMIN_FACTORY_RESET_COMPLETED_ACTION,
        targetType: 'job',
        targetId: job.id,
        meta: { jobId: job.id, ...result } as Prisma.InputJsonValue,
      },
    });

    this.logger.warn(
      `Factory reset by user ${actor.id} finished (job ${job.id}): ${result.usersDeleted} user(s) deleted, ` +
        `${storage.storageObjectsDeleted} object(s) deleted, ${storage.storageObjectsFailed} failed`,
    );
  }

  /** The admin who asked. Their account must still exist: it is what the reset keeps. */
  private async resolveActor(job: Job): Promise<Actor> {
    const actorUserId = payloadObject(job).actorUserId;
    if (typeof actorUserId !== 'string' || actorUserId.length === 0) {
      throw new Error(`Invalid ${ADMIN_FACTORY_RESET_TYPE} job ${job.id}: payload has no actorUserId`);
    }

    const actor = await this.prisma.user.findUnique({
      where: { id: actorUserId },
      select: { id: true, email: true },
    });
    if (!actor) {
      throw new Error(`Invalid ${ADMIN_FACTORY_RESET_TYPE} job ${job.id}: actor ${actorUserId} does not exist`);
    }
    return actor;
  }

  /** Step 1: pending and finished job rows, except this one and backup-linked ones. */
  async deleteJobs(run: StepRunner, jobId: string): Promise<void> {
    const where: Prisma.JobWhereInput = {
      id: { not: jobId },
      status: { in: [...DELETABLE_JOB_STATUSES] },
      backupRun: { is: null },
    };

    for (;;) {
      const batch = await this.prisma.job.findMany({ where, select: { id: true }, take: FACTORY_RESET_CHUNK_SIZE });
      if (batch.length === 0) return;

      // The status filter is re-applied: a job claimed since the read is
      // running now and is left alone.
      const deleted = await run.step(async (tx) => ({
        jobs: (await tx.job.deleteMany({ where: { ...where, id: { in: batch.map((row) => row.id) } } })).count,
      }));
      if (deleted.jobs === 0) return;
    }
  }

  /** Step 2: the per-user data reset, for every user, one transaction each. */
  async deleteEveryUsersData(run: StepRunner, jobId: string): Promise<void> {
    let cursor: string | undefined;
    for (;;) {
      const users = await this.prisma.user.findMany({
        select: { id: true },
        orderBy: { id: 'asc' },
        take: FACTORY_RESET_CHUNK_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (users.length === 0) return;

      for (const user of users) {
        await run.step((tx) => deleteUserOwnedRows(tx, user.id, jobId, []));
      }
      cursor = users[users.length - 1].id;
    }
  }

  /** Step 3: custom exercises, then custom equipment, now that nothing uses them. */
  async deleteCustomCatalogRows(run: StepRunner): Promise<void> {
    await run.step(async (tx) => {
      // ExerciseRequirement RESTRICTs the equipment type: exercises first.
      const customExercises = (
        await tx.exercise.deleteMany({
          where: { ownerUserId: { not: null }, workoutExercises: { none: {} }, programExercises: { none: {} } },
        })
      ).count;
      const customEquipment = (
        await tx.equipmentType.deleteMany({
          where: { ownerUserId: { not: null }, gymEquipment: { none: {} }, exerciseRequirements: { none: {} } },
        })
      ).count;
      return { customExercises, customEquipment };
    });
  }

  /** Step 4: hand other users' worker nodes and node credentials to the actor. */
  async reassignNodes(run: StepRunner, actor: Actor): Promise<void> {
    await run.step(async (tx) => {
      const [own, others] = await Promise.all([
        tx.workerNode.findMany({ where: { createdById: actor.id }, select: { name: true } }),
        tx.workerNode.findMany({
          where: { createdById: { not: actor.id } },
          select: { id: true, name: true },
          orderBy: { registeredAt: 'asc' },
        }),
      ]);

      const taken = new Set(own.map((node) => node.name));
      let workerNodesReassigned = 0;
      let workerNodesRemoved = 0;
      for (const node of others) {
        if (taken.has(node.name)) {
          // `@@unique([createdById, name])`: left to cascade with its owner.
          workerNodesRemoved += 1;
          continue;
        }
        await tx.workerNode.update({ where: { id: node.id }, data: { createdById: actor.id } });
        taken.add(node.name);
        workerNodesReassigned += 1;
      }

      const nodeCredentialsReassigned = (
        await tx.nodeCredential.updateMany({ where: { userId: { not: actor.id } }, data: { userId: actor.id } })
      ).count;

      return { workerNodesReassigned, workerNodesRemoved, nodeCredentialsReassigned };
    });
  }

  /** Step 5: every user but the actor. Their remaining rows cascade or are SET NULL. */
  async deleteOtherUsers(run: StepRunner, actor: Actor): Promise<void> {
    for (;;) {
      const batch = await this.prisma.user.findMany({
        where: { id: { not: actor.id } },
        select: { id: true },
        take: FACTORY_RESET_CHUNK_SIZE,
      });
      if (batch.length === 0) return;

      const deleted = await run.step(async (tx) => ({
        usersDeleted: (
          await tx.user.deleteMany({ where: { id: { in: batch.map((row) => row.id), not: actor.id } } })
        ).count,
      }));
      if (deleted.usersDeleted === 0) return;
    }
  }

  /** Step 6: deployment-wide tables and rows no single user owns any more. */
  async deleteDeploymentLeftovers(run: StepRunner, actor: Actor): Promise<void> {
    await run.step(async (tx) => {
      const allowlistEntries = (await tx.allowedEmail.deleteMany({ where: allowlistEntriesToDelete(actor) }))
        .count;
      const broadcasts = (await tx.notificationBroadcast.deleteMany({})).count;
      const notifications = (await tx.notification.deleteMany({})).count;
      const notificationDeliveries = (await tx.notificationDelivery.deleteMany({})).count;
      const pushSubscriptions = (await tx.pushSubscription.deleteMany({})).count;
      const aiRuns = (await tx.aiRun.deleteMany({})).count;
      const aiUsageEvents = (await tx.aiUsageEvent.deleteMany({})).count;
      const deviceCodes = (await tx.deviceCode.deleteMany({})).count;

      // Checkpoints carry no FK; keep only those of a run or adaptation that
      // still exists (one started while this job ran).
      const [runs, adaptations] = await Promise.all([
        tx.trainingPlanRun.findMany({ select: { id: true } }),
        tx.workoutAdaptation.findMany({ select: { id: true } }),
      ]);
      const liveThreads = [...runs, ...adaptations].map((row) => row.id);
      await tx.trainingRunCheckpointWrite.deleteMany({ where: { threadId: { notIn: liveThreads } } });
      const trainingCheckpoints = (
        await tx.trainingRunCheckpoint.deleteMany({ where: { threadId: { notIn: liveThreads } } })
      ).count;

      const jobStatsRollups = (await tx.jobStatsRollup.deleteMany({})).count;

      return {
        allowlistEntries,
        broadcasts,
        notifications,
        notificationDeliveries,
        pushSubscriptions,
        aiRuns,
        aiUsageEvents,
        deviceCodes,
        trainingCheckpoints,
        jobStatsRollups,
      };
    });
  }

  /**
   * Step 7: every storage object except backup archives, bytes then row. A
   * provider failure keeps the row and is counted; it never throws.
   */
  async deleteStorage(): Promise<{ storageObjectsDeleted: number; storageObjectsFailed: number }> {
    const backups = await this.prisma.databaseBackupRun.findMany({ select: { storageKey: true } });
    const where: Prisma.StorageObjectWhereInput = { storageKey: { notIn: backups.map((row) => row.storageKey) } };

    let storageObjectsDeleted = 0;
    let storageObjectsFailed = 0;
    let cursor: string | undefined;

    for (;;) {
      const batch = await this.prisma.storageObject.findMany({
        where: cursor ? { ...where, id: { gt: cursor } } : where,
        select: { id: true },
        orderBy: { id: 'asc' },
        take: FACTORY_RESET_CHUNK_SIZE,
      });
      if (batch.length === 0) break;

      const counts = await deleteStorageObjects(
        this.prisma,
        this.storage,
        this.logger,
        'Factory reset',
        batch.map((row) => row.id),
      );
      storageObjectsDeleted += counts.storageObjectsDeleted;
      storageObjectsFailed += counts.storageObjectsFailed;
      // Ids only move forward, so a failed object (row kept) is not retried
      // within this run.
      cursor = batch[batch.length - 1].id;
    }

    return { storageObjectsDeleted, storageObjectsFailed };
  }
}

/**
 * Runs one step in its own transaction and commits the step's counts onto
 * `payload.deleted` in that same transaction, so the running totals a retry
 * reads back are exactly what has been deleted.
 */
export class StepRunner {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobId: string,
    private base: Prisma.JsonObject,
    public totals: FactoryResetRowCounts,
  ) {}

  get payload(): Prisma.JsonObject {
    return { ...this.base, deleted: this.totals };
  }

  async step<T extends Partial<FactoryResetRowCounts>>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    const { delta, next } = await this.prisma.$transaction(
      async (tx) => {
        const delta = await fn(tx);
        const next = addCounts(this.totals, delta);
        await tx.job.update({
          where: { id: this.jobId },
          data: { payload: { ...this.base, deleted: next } as Prisma.InputJsonValue },
        });
        return { delta, next };
      },
      { timeout: USER_DATA_RESET_TX_TIMEOUT_MS },
    );
    this.totals = next;
    return delta;
  }
}
