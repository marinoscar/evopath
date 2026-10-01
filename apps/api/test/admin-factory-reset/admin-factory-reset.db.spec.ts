// =============================================================================
// `admin.factory_reset` on the real database (issue #211)
// =============================================================================
//
// What a mocked Prisma cannot prove: that the step order satisfies every real
// foreign key (a custom exercise one user owns and another user's workout
// uses; `Exercise.owner` CASCADE vs `WorkoutExercise` RESTRICT), that deleting
// the other users cascades cleanly after the per-user pass, that nodes survive
// their creator, and that everything a factory reset KEEPS (the actor's
// account and roles, roles/permissions, system settings, seeded catalogs,
// backup runs and their jobs, running jobs, the audit trail) survives — and
// that a second run is a clean no-op.
//
// ⚠ DESTRUCTIVE BY DESIGN: this suite deletes EVERY user but its own actor,
// and all application data, in the database it points at. Run it only against
// a disposable test database (`infra/compose/test.compose.yml`), like every
// `*.db.spec.ts` (`npm run test:db` runs them in band, so no other suite's
// rows are in flight while it runs). Needs a migrated, SEEDED database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import type { Job, PrismaClient } from '@prisma/client';

import { AdminFactoryResetHandler } from '../../src/admin-factory-reset/handlers/admin-factory-reset.handler';
import { ADMIN_FACTORY_RESET_TYPE } from '../../src/admin-factory-reset/admin-factory-reset.constants';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('admin-factory-reset.db.spec');

describeWithDb('admin.factory_reset (real Postgres)', () => {
  let client: PrismaClient;
  const tag = randomUUID().slice(0, 8);
  let actorId: string;
  const backupRunIds: string[] = [];
  const keptJobIds: string[] = [];

  beforeAll(() => {
    client = createDbClient();
  });

  afterAll(async () => {
    await client.databaseBackupRun.deleteMany({ where: { id: { in: backupRunIds } } });
    await client.job.deleteMany({ where: { OR: [{ id: { in: keptJobIds } }, { type: ADMIN_FACTORY_RESET_TYPE }] } });
    await client.storageObject.deleteMany({ where: { storageKey: { startsWith: `test/${tag}/` } } });
    await client.workerNode.deleteMany({ where: { name: { endsWith: tag } } });
    await client.auditEvent.deleteMany({ where: { actorUserId: actorId } });
    if (actorId) await client.user.deleteMany({ where: { id: actorId } });
    await client.$disconnect();
  });

  async function user(label: string, roleName?: string): Promise<string> {
    const row = await client.user.create({
      data: { email: `factory-${label}-${tag}@example.com`, displayName: label },
    });
    if (roleName) {
      const role = await client.role.findUniqueOrThrow({ where: { name: roleName } });
      await client.userRole.create({ data: { userId: row.id, roleId: role.id } });
    }
    return row.id;
  }

  async function storageObject(userId: string | null, key: string) {
    return client.storageObject.create({
      data: {
        name: `${key}.bin`,
        size: BigInt(10),
        mimeType: 'application/octet-stream',
        storageKey: `test/${tag}/${key}`,
        status: 'ready',
        uploadedById: userId,
      },
    });
  }

  function handler(storage: { delete: jest.Mock; abortMultipartUpload: jest.Mock }) {
    return new AdminFactoryResetHandler(new JobHandlerRegistry(), client as never, storage as never);
  }

  async function runningResetJob(): Promise<Job> {
    return client.job.create({
      data: { type: ADMIN_FACTORY_RESET_TYPE, reason: 'rerun', status: 'running', payload: { actorUserId: actorId } },
    });
  }

  it('wipes every other user and all data, keeps the actor, configuration, catalogs and backups, and re-runs cleanly', async () => {
    // --- Baseline of what must survive ------------------------------------------
    const roles = await client.role.count();
    const permissions = await client.permission.count();
    const rolePermissions = await client.rolePermission.count();
    const seededExercises = await client.exercise.count({ where: { ownerUserId: null } });
    const seededEquipment = await client.equipmentType.count({ where: { ownerUserId: null } });
    const capabilities = await client.capability.count();
    await client.systemSettings.upsert({
      where: { key: 'global' },
      create: { key: 'global', value: { factoryResetTest: tag } },
      update: {},
    });
    const settings = await client.systemSettings.count();

    // --- The actor ----------------------------------------------------------------
    actorId = await user('actor', 'admin');
    await client.userIdentity.create({ data: { userId: actorId, provider: 'google', providerSubject: `sub-${tag}` } });
    await client.refreshToken.create({
      data: { userId: actorId, tokenHash: `rt-${tag}`, expiresAt: new Date(Date.now() + 86_400_000) },
    });
    await client.gym.create({ data: { userId: actorId, name: 'Actor gym' } });
    const actorEmail = `factory-actor-${tag}@example.com`;
    await client.allowedEmail.create({ data: { email: actorEmail.toUpperCase() } });
    await client.allowedEmail.create({ data: { email: `someone-${tag}@example.com` } });

    // --- Other users and cross-user references ------------------------------------
    const b = await user('b', 'viewer');
    const c = await user('c');
    const cExercise = await client.exercise.create({
      data: { slug: `c-ex-${tag}`, name: 'C exercise', ownerUserId: c, primaryMuscles: ['quads'], movementPattern: 'squat' },
    });
    const bWorkout = await client.workout.create({
      data: { userId: b, name: 'B day', date: new Date('2026-09-01'), startedAt: new Date(), status: 'completed' },
    });
    await client.workoutExercise.create({ data: { workoutId: bWorkout.id, exerciseId: cExercise.id, position: 0 } });
    const entryId = randomUUID();
    const first = await client.measurement.create({
      data: { userId: b, entryId, metricKey: 'weight', value: 80, unit: 'kg', measuredAt: new Date(), supersededAt: new Date() },
    });
    await client.measurement.create({
      data: { userId: b, entryId, metricKey: 'weight', value: 81, unit: 'kg', measuredAt: new Date(), revision: 2, supersedesId: first.id },
    });
    await client.notification.create({ data: { userId: b, eventKey: 'x', title: 't', body: 'b' } });
    await client.notificationDelivery.create({
      data: { eventKey: 'x', userId: null, recipient: 'nobody@example.com', channel: 'email' },
    });
    await client.notificationBroadcast.create({
      data: { title: 'Hi', body: 'All', eventKey: 'broadcast', channels: ['in_app'], createdById: b },
    });

    // Infrastructure a deleted user created.
    const bNode = await client.workerNode.create({
      data: {
        name: `node-${tag}`,
        hostname: 'h',
        platform: 'linux',
        cliVersion: '1',
        eligibleTypes: [],
        concurrency: 1,
        createdById: b,
      },
    });
    await client.nodeCredential.create({
      data: { userId: b, name: 'n', tokenHash: `nod-${tag}`, tokenPrefix: 'nod_x' },
    });

    // --- Storage and backups ------------------------------------------------------------
    const bObject = await storageObject(b, 'b-photo');
    const brokenObject = await storageObject(b, 'broken');
    const orphanObject = await storageObject(null, 'orphan');
    // A deleted user's health document whose file the actor uploaded: only the
    // document links it to B, so step 7 (every non-backup object) must still
    // delete it, and its pending purge job goes in step 1.
    const docObject = await storageObject(actorId, 'b-labs');
    const bDoc = await client.healthDocument.create({
      data: {
        userId: b,
        kind: 'lab_report',
        storageObjectId: docObject.id,
        originalName: 'labs.pdf',
        mimeType: 'application/pdf',
        sizeBytes: BigInt(10),
        retention: 'delete_after_processing',
      },
    });
    const docPurge = await client.job.create({
      data: {
        type: 'health.document.purge',
        reason: 'upload',
        subjectType: 'health_document',
        subjectId: bDoc.id,
        payload: { healthDocumentId: bDoc.id },
      },
    });
    const backupJob = await client.job.create({
      data: { type: 'db.backup.run', reason: 'rerun', status: 'succeeded' },
    });
    keptJobIds.push(backupJob.id);
    const backupRun = await client.databaseBackupRun.create({
      data: {
        trigger: 'manual',
        status: 'completed',
        storageProvider: 's3',
        storageKey: `test/${tag}/backup.dump`,
        bucket: 'b',
        format: 'custom',
        jobId: backupJob.id,
        createdById: b,
      },
    });
    backupRunIds.push(backupRun.id);
    // Defensive: a storage row naming a backup archive's key is never deleted.
    const backupObject = await storageObject(null, 'backup.dump');

    // --- Jobs ------------------------------------------------------------------------
    const running = await client.job.create({ data: { type: 'email.send', reason: 'rerun', status: 'running' } });
    keptJobIds.push(running.id);
    const pending = await client.job.create({ data: { type: 'email.send', reason: 'rerun', status: 'pending' } });
    const finished = await client.job.create({ data: { type: 'email.send', reason: 'rerun', status: 'failed' } });

    // --- Run --------------------------------------------------------------------------
    const storage = {
      delete: jest.fn(async (key: string) => {
        if (key === brokenObject.storageKey) throw new Error('AccessDenied');
      }),
      abortMultipartUpload: jest.fn(),
    };
    const job = await runningResetJob();
    await handler(storage).process(job);

    // --- Deleted ------------------------------------------------------------------------
    for (const [label, count] of [
      ['other users', await client.user.count({ where: { id: { not: actorId } } })],
      ['workouts', await client.workout.count()],
      ['gyms', await client.gym.count()],
      ['measurements', await client.measurement.count()],
      ['notifications', await client.notification.count()],
      ['deliveries', await client.notificationDelivery.count()],
      ['broadcasts', await client.notificationBroadcast.count()],
      ['custom exercises', await client.exercise.count({ where: { ownerUserId: { not: null } } })],
      ['other allowlist', await client.allowedEmail.count({ where: { email: `someone-${tag}@example.com` } })],
      ['pending job', await client.job.count({ where: { id: pending.id } })],
      ['finished job', await client.job.count({ where: { id: finished.id } })],
      ['b object', await client.storageObject.count({ where: { id: bObject.id } })],
      ['orphan object', await client.storageObject.count({ where: { id: orphanObject.id } })],
      ['health documents', await client.healthDocument.count()],
      ['health document file', await client.storageObject.count({ where: { id: docObject.id } })],
      ['health document purge job', await client.job.count({ where: { id: docPurge.id } })],
    ] as const) {
      expect({ label, count }).toEqual({ label, count: 0 });
    }

    // --- Kept ------------------------------------------------------------------------
    const actor = await client.user.findUniqueOrThrow({
      where: { id: actorId },
      include: { userRoles: { include: { role: true } } },
    });
    expect(actor.userRoles.map((r) => r.role.name)).toEqual(['admin']);
    expect(await client.userIdentity.count({ where: { userId: actorId } })).toBe(1);
    expect(await client.refreshToken.count({ where: { userId: actorId } })).toBe(1);
    expect(await client.allowedEmail.count({ where: { email: actorEmail.toUpperCase() } })).toBe(1);
    expect(await client.role.count()).toBe(roles);
    expect(await client.permission.count()).toBe(permissions);
    expect(await client.rolePermission.count()).toBe(rolePermissions);
    expect(await client.systemSettings.count()).toBe(settings);
    expect(await client.exercise.count({ where: { ownerUserId: null } })).toBe(seededExercises);
    expect(await client.equipmentType.count({ where: { ownerUserId: null } })).toBe(seededEquipment);
    expect(await client.capability.count()).toBe(capabilities);
    const keptRun = await client.databaseBackupRun.findUniqueOrThrow({ where: { id: backupRun.id } });
    expect(keptRun.jobId).toBe(backupJob.id);
    expect(keptRun.createdById).toBeNull();
    expect(await client.storageObject.count({ where: { id: backupObject.id } })).toBe(1);
    expect(storage.delete).not.toHaveBeenCalledWith(backupObject.storageKey);
    expect(await client.job.count({ where: { id: { in: [running.id, backupJob.id, job.id] } } })).toBe(3);
    // The provider refused it: the row stays so a later reset can retry.
    expect(await client.storageObject.count({ where: { id: brokenObject.id } })).toBe(1);
    // Infrastructure changes hands instead of disappearing.
    expect((await client.workerNode.findUniqueOrThrow({ where: { id: bNode.id } })).createdById).toBe(actorId);
    expect(await client.nodeCredential.count({ where: { tokenHash: `nod-${tag}`, userId: actorId } })).toBe(1);

    const done = await client.job.findUniqueOrThrow({ where: { id: job.id } });
    const result = (done.payload as any).result;
    expect(result).toMatchObject({
      usersDeleted: 2,
      workouts: 1,
      gyms: 1,
      healthDocuments: 1,
      broadcasts: 1,
      workerNodesReassigned: 1,
      nodeCredentialsReassigned: 1,
      storageObjectsFailed: 1,
    });
    expect(result.storageObjectsDeleted).toBeGreaterThanOrEqual(3);
    expect(result.customExercises).toBeGreaterThanOrEqual(1);
    expect(result.jobs).toBeGreaterThanOrEqual(3);
    expect(
      await client.auditEvent.count({ where: { action: 'admin.factory_reset.completed', targetId: job.id } }),
    ).toBe(1);

    // --- Idempotent: a second run is a clean no-op on what is left ---------------------
    await client.job.update({ where: { id: job.id }, data: { status: 'succeeded' } });
    const again = await runningResetJob();
    await handler({ delete: jest.fn(), abortMultipartUpload: jest.fn() }).process(again);
    const second = ((await client.job.findUniqueOrThrow({ where: { id: again.id } })).payload as any).result;
    expect(second).toMatchObject({ usersDeleted: 0, workouts: 0, gyms: 0, workerNodesReassigned: 0 });
    // The earlier (succeeded) reset job is history now, and the retried object is gone.
    expect(await client.job.count({ where: { id: job.id } })).toBe(0);
    expect(await client.storageObject.count({ where: { id: brokenObject.id } })).toBe(0);
    expect(await client.user.count({ where: { id: actorId } })).toBe(1);
    expect(await client.databaseBackupRun.count({ where: { id: backupRun.id } })).toBe(1);
  });

  it('resumes from committed counts when retried after a partial run', async () => {
    const d = await user('d');
    await client.gym.create({ data: { userId: d, name: 'D gym' } });
    const job = await client.job.create({
      data: {
        type: ADMIN_FACTORY_RESET_TYPE,
        reason: 'rerun',
        status: 'running',
        // As if an earlier attempt had committed some steps before failing.
        payload: { actorUserId: actorId, deleted: { usersDeleted: 5, gyms: 7 } },
      },
    });

    await handler({ delete: jest.fn(), abortMultipartUpload: jest.fn() }).process(job);

    const result = ((await client.job.findUniqueOrThrow({ where: { id: job.id } })).payload as any).result;
    expect(result.usersDeleted).toBe(6);
    expect(result.gyms).toBe(8);
    expect(await client.user.count({ where: { id: d } })).toBe(0);
  });
});
