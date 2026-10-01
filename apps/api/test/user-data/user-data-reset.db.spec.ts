// =============================================================================
// `user.data_reset` on the real database (issue #202)
// =============================================================================
//
// What a mocked Prisma cannot prove: that the deletion order satisfies every
// real foreign key (the RESTRICTs on custom exercises and equipment, the
// measurement revision chain's self-RESTRICT), that the cascades remove what
// the handler relies on them removing, that the explicit checkpoint delete
// catches rows with no FK, and that everything the handler must KEEP (the
// account, its identity, its session, another user's data) survives.
//
// THIS IS A `*.db.spec.ts` FILE: skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import type { Job, PrismaClient } from '@prisma/client';

import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { UserDataResetHandler } from '../../src/user-data/handlers/user-data-reset.handler';
import { USER_DATA_RESET_TYPE } from '../../src/user-data/user-data.constants';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('user-data-reset.db.spec');

describeWithDb('user.data_reset (real Postgres)', () => {
  let client: PrismaClient;
  const tag = randomUUID().slice(0, 8);
  const userIds: string[] = [];

  beforeAll(() => {
    client = createDbClient();
  });

  afterAll(async () => {
    await client.job.deleteMany({ where: { subjectId: { in: userIds } } });
    await client.storageObject.deleteMany({ where: { uploadedById: { in: userIds } } });
    await client.auditEvent.deleteMany({ where: { targetId: { in: userIds } } });
    await client.workout.deleteMany({ where: { userId: { in: userIds } } });
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.$disconnect();
  });

  async function user(label: string): Promise<string> {
    const row = await client.user.create({
      data: { email: `reset-${label}-${randomUUID().slice(0, 8)}-${tag}@example.com`, displayName: 'Custom Name' },
    });
    userIds.push(row.id);
    return row.id;
  }

  async function storageObject(userId: string, key: string) {
    return client.storageObject.create({
      data: {
        name: `${key}.jpg`,
        size: BigInt(10),
        mimeType: 'image/jpeg',
        storageKey: `test/${tag}/${key}-${randomUUID()}`,
        status: 'ready',
        uploadedById: userId,
      },
    });
  }

  it('deletes the user data in FK order, keeps the account and other users, and tolerates a storage failure', async () => {
    const a = await user('a');
    const b = await user('b');

    // --- Account rows that must survive ------------------------------------
    await client.userIdentity.create({
      data: { userId: a, provider: 'google', providerSubject: `sub-${tag}` },
    });
    await client.refreshToken.create({
      data: { userId: a, tokenHash: `rt-${tag}`, expiresAt: new Date(Date.now() + 86_400_000) },
    });

    // --- A's data ------------------------------------------------------------
    await client.userSettings.create({
      data: { userId: a, value: { theme: 'dark', profile: { imageSource: 'provider', imageObjectId: null } } },
    });
    await client.healthProfile.create({ data: { userId: a } });

    // A measurement revision chain (self-FK ON DELETE RESTRICT).
    const entryId = randomUUID();
    const first = await client.measurement.create({
      data: { userId: a, entryId, metricKey: 'weight', value: 80, unit: 'kg', measuredAt: new Date(), supersededAt: new Date() },
    });
    await client.measurement.create({
      data: { userId: a, entryId, metricKey: 'weight', value: 81, unit: 'kg', measuredAt: new Date(), revision: 2, supersedesId: first.id },
    });

    // Custom equipment used by A's gym (GymEquipment RESTRICT).
    const equipment = await client.equipmentType.create({
      data: { slug: `custom-eq-${tag}`, name: 'My sled', category: 'accessories', ownerUserId: a },
    });
    const gym = await client.gym.create({ data: { userId: a, name: 'Home' } });
    await client.gymEquipment.create({ data: { gymId: gym.id, equipmentTypeId: equipment.id } });
    const gymPhotoObject = await storageObject(a, 'gym');
    await client.gymPhoto.create({ data: { gymId: gym.id, storageObjectId: gymPhotoObject.id } });
    const brokenObject = await storageObject(a, 'broken');

    // Two custom exercises: one only A uses, one B's workout also uses.
    const privateExercise = await client.exercise.create({
      data: { slug: `custom-a-${tag}`, name: 'A only', ownerUserId: a, primaryMuscles: ['quads'], movementPattern: 'squat' },
    });
    const sharedExercise = await client.exercise.create({
      data: { slug: `custom-shared-${tag}`, name: 'Shared', ownerUserId: a, primaryMuscles: ['quads'], movementPattern: 'squat' },
    });
    const workoutA = await client.workout.create({
      data: { userId: a, name: 'Leg day', date: new Date('2026-09-01'), startedAt: new Date(), status: 'completed', gymId: gym.id },
    });
    await client.workoutExercise.create({ data: { workoutId: workoutA.id, exerciseId: privateExercise.id, position: 0 } });
    const workoutB = await client.workout.create({
      data: { userId: b, name: 'B day', date: new Date('2026-09-01'), startedAt: new Date(), status: 'completed' },
    });
    await client.workoutExercise.create({ data: { workoutId: workoutB.id, exerciseId: sharedExercise.id, position: 0 } });

    // Training: a run, its checkpoints (no FK), and a pending job about it.
    const run = await client.trainingPlanRun.create({
      data: { userId: a, kind: 'create', status: 'succeeded', input: {}, tokenCap: 100000 },
    });
    await client.trainingRunCheckpoint.create({
      data: { threadId: run.id, checkpointId: 'c1', type: 'json', checkpoint: Buffer.from('{}'), metadata: Buffer.from('{}') },
    });
    const pendingAboutRun = await client.job.create({
      data: { type: 'ai.training.plan.run', reason: 'rerun', subjectType: 'training_plan_run', subjectId: run.id },
    });

    // Health documents: one kept file linked to an intake, one "delete after
    // processing" file whose purge is still pending, one already purged (no
    // file). The object is uploaded by B so only the document link can
    // collect it; SET NULL on the object must not strand the file.
    const intake = await client.photoIntake.create({
      data: { userId: a, kind: 'body_metric_reading', status: 'applied' },
    });
    const keptDocObject = await storageObject(b, 'doc-kept');
    await client.healthDocument.create({
      data: {
        userId: a,
        kind: 'body_metric',
        storageObjectId: keptDocObject.id,
        originalName: 'scale.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: BigInt(10),
        intakeId: intake.id,
      },
    });
    const purgeDocObject = await storageObject(a, 'doc-purge');
    const purgeDoc = await client.healthDocument.create({
      data: {
        userId: a,
        kind: 'lab_report',
        storageObjectId: purgeDocObject.id,
        originalName: 'labs.pdf',
        mimeType: 'application/pdf',
        sizeBytes: BigInt(10),
        retention: 'delete_after_processing',
        intakeId: intake.id,
      },
    });
    await client.healthDocument.create({
      data: {
        userId: a,
        kind: 'body_metric',
        originalName: 'old.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: BigInt(10),
        retention: 'delete_after_processing',
        fileDeletedAt: new Date(),
      },
    });
    const pendingPurge = await client.job.create({
      data: {
        type: 'health.document.purge',
        reason: 'upload',
        subjectType: 'health_document',
        subjectId: purgeDoc.id,
        payload: { healthDocumentId: purgeDoc.id },
      },
    });

    await client.notification.create({ data: { userId: a, eventKey: 'x', title: 't', body: 'b' } });
    await client.personalAccessToken.create({
      data: {
        userId: a,
        name: 'cli',
        tokenHash: `pat-${tag}`,
        tokenPrefix: 'pat_x',
        durationValue: 1,
        durationUnit: 'days',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    // AI Coach (E7): a progress photo, a coach message with a voice note and
    // one without, and the coach state. Both files are uploaded by B, so only
    // the coach rows can collect them (the photo row CASCADES from its object
    // and the audio link is SET NULL, so neither survives step 2 to name it).
    const progressObject = await storageObject(b, 'progress');
    await client.progressPhoto.create({
      data: { userId: a, storageObjectId: progressObject.id, localDate: new Date('2026-09-01'), pose: 'side' },
    });
    const audioObject = await storageObject(b, 'coach-audio');
    await client.coachMessage.create({
      data: {
        userId: a,
        role: 'coach',
        kind: 'nudge',
        body: 'Time to train',
        audioStatus: 'ready',
        audioStorageObjectId: audioObject.id,
      },
    });
    await client.coachMessage.create({ data: { userId: a, role: 'user', kind: 'chat', body: 'On my way' } });
    await client.coachState.create({ data: { userId: a, weeklyStreak: 2, pausedUntil: new Date(Date.now() + 86_400_000) } });

    // Activity goals and entries (epic #260): a goal, a manual entry and one
    // derived from A's workout (counted, not just cascaded); B keeps theirs.
    const goalShape = { title: 'Walk', activityKind: 'walk', metric: 'sessions', target: 3, period: 'week', startsOn: new Date('2026-09-01') } as const;
    await client.activityGoal.create({ data: { userId: a, ...goalShape } });
    await client.activityEntry.create({ data: { userId: a, occurredOn: new Date('2026-09-01'), activityKind: 'walk' } });
    await client.activityEntry.create({
      data: { userId: a, occurredOn: new Date('2026-09-01'), activityKind: 'workout_any', source: 'workout', workoutId: workoutA.id },
    });
    await client.activityGoal.create({ data: { userId: b, ...goalShape } });
    await client.activityEntry.create({
      data: { userId: b, occurredOn: new Date('2026-09-01'), activityKind: 'workout_any', source: 'workout', workoutId: workoutB.id },
    });

    // --- B's data, which must be untouched ---------------------------------
    await client.gym.create({ data: { userId: b, name: 'B gym' } });
    const docObjectB = await storageObject(b, 'doc-b');
    await client.healthDocument.create({
      data: {
        userId: b,
        kind: 'body_metric',
        storageObjectId: docObjectB.id,
        originalName: 'b.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: BigInt(10),
      },
    });
    await client.notification.create({ data: { userId: b, eventKey: 'x', title: 't', body: 'b' } });
    const progressObjectB = await storageObject(b, 'progress-b');
    await client.progressPhoto.create({
      data: { userId: b, storageObjectId: progressObjectB.id, localDate: new Date('2026-09-01') },
    });
    await client.coachMessage.create({ data: { userId: b, role: 'coach', kind: 'chat', body: 'Hi B' } });
    await client.coachState.create({ data: { userId: b } });

    // Step 1 collects the coach files before anything is deleted.
    const collected = await new UserDataResetHandler(
      new JobHandlerRegistry(),
      client as never,
      {} as never,
    ).collectObjectIds(a);
    expect(collected).toEqual(expect.arrayContaining([progressObject.id, audioObject.id]));
    expect(collected).not.toContain(progressObjectB.id);

    // --- Run the reset -------------------------------------------------------
    const job = await client.job.create({
      data: {
        type: USER_DATA_RESET_TYPE,
        reason: 'rerun',
        subjectType: 'user',
        subjectId: a,
        status: 'running',
        payload: { userId: a },
      },
    });

    const storage = {
      delete: jest.fn(async (key: string) => {
        if (key === brokenObject.storageKey) throw new Error('AccessDenied');
      }),
      abortMultipartUpload: jest.fn(),
    };
    const handler = new UserDataResetHandler(
      new JobHandlerRegistry(),
      client as never,
      storage as never,
    );

    await handler.process(job as Job);

    // --- Deleted -------------------------------------------------------------
    for (const [label, count] of [
      ['gyms', await client.gym.count({ where: { userId: a } })],
      ['workouts', await client.workout.count({ where: { userId: a } })],
      ['measurements', await client.measurement.count({ where: { userId: a } })],
      ['healthProfile', await client.healthProfile.count({ where: { userId: a } })],
      ['runs', await client.trainingPlanRun.count({ where: { userId: a } })],
      ['checkpoints', await client.trainingRunCheckpoint.count({ where: { threadId: run.id } })],
      ['notifications', await client.notification.count({ where: { userId: a } })],
      ['pats', await client.personalAccessToken.count({ where: { userId: a } })],
      ['settings', await client.userSettings.count({ where: { userId: a } })],
      ['privateExercise', await client.exercise.count({ where: { id: privateExercise.id } })],
      ['equipment', await client.equipmentType.count({ where: { id: equipment.id } })],
      ['gymPhotoObject', await client.storageObject.count({ where: { id: gymPhotoObject.id } })],
      ['pendingJob', await client.job.count({ where: { id: pendingAboutRun.id } })],
      ['healthDocuments', await client.healthDocument.count({ where: { userId: a } })],
      ['photoIntakes', await client.photoIntake.count({ where: { id: intake.id } })],
      ['keptDocObject', await client.storageObject.count({ where: { id: keptDocObject.id } })],
      ['purgeDocObject', await client.storageObject.count({ where: { id: purgeDocObject.id } })],
      ['pendingPurge', await client.job.count({ where: { id: pendingPurge.id } })],
      ['progressPhotos', await client.progressPhoto.count({ where: { userId: a } })],
      ['progressObject', await client.storageObject.count({ where: { id: progressObject.id } })],
      ['coachMessages', await client.coachMessage.count({ where: { userId: a } })],
      ['audioObject', await client.storageObject.count({ where: { id: audioObject.id } })],
      ['coachState', await client.coachState.count({ where: { userId: a } })],
      ['activityGoals', await client.activityGoal.count({ where: { userId: a } })],
      ['activityEntries', await client.activityEntry.count({ where: { userId: a } })],
    ] as const) {
      expect({ label, count }).toEqual({ label, count: 0 });
    }

    // --- Kept ----------------------------------------------------------------
    const account = await client.user.findUniqueOrThrow({ where: { id: a } });
    expect(account.displayName).toBeNull();
    expect(await client.userIdentity.count({ where: { userId: a } })).toBe(1);
    expect(await client.refreshToken.count({ where: { userId: a } })).toBe(1);
    // Still referenced by B's workout: kept rather than failing the reset.
    expect(await client.exercise.count({ where: { id: sharedExercise.id } })).toBe(1);
    // The provider refused it: the row stays so a later reset can retry.
    expect(await client.storageObject.count({ where: { id: brokenObject.id } })).toBe(1);
    // B is untouched.
    expect(await client.gym.count({ where: { userId: b } })).toBe(1);
    expect(await client.workout.count({ where: { userId: b } })).toBe(1);
    expect(await client.notification.count({ where: { userId: b } })).toBe(1);
    expect(await client.healthDocument.count({ where: { userId: b, storageObjectId: docObjectB.id } })).toBe(1);
    expect(await client.storageObject.count({ where: { id: docObjectB.id } })).toBe(1);
    expect(await client.progressPhoto.count({ where: { userId: b } })).toBe(1);
    expect(await client.storageObject.count({ where: { id: progressObjectB.id } })).toBe(1);
    expect(await client.coachMessage.count({ where: { userId: b } })).toBe(1);
    expect(await client.coachState.count({ where: { userId: b } })).toBe(1);
    expect(await client.activityGoal.count({ where: { userId: b } })).toBe(1);
    expect(await client.activityEntry.count({ where: { userId: b } })).toBe(1);
    // Both document files reached the provider, not just the database.
    expect(storage.delete).toHaveBeenCalledWith(keptDocObject.storageKey);
    expect(storage.delete).toHaveBeenCalledWith(purgeDocObject.storageKey);
    expect(storage.delete).not.toHaveBeenCalledWith(docObjectB.storageKey);
    // The coach files reached the provider too.
    expect(storage.delete).toHaveBeenCalledWith(progressObject.storageKey);
    expect(storage.delete).toHaveBeenCalledWith(audioObject.storageKey);
    expect(storage.delete).not.toHaveBeenCalledWith(progressObjectB.storageKey);

    // --- Result and audit ----------------------------------------------------
    const done = await client.job.findUniqueOrThrow({ where: { id: job.id } });
    const result = (done.payload as { result: Record<string, number> }).result;
    expect(result).toMatchObject({
      gyms: 1,
      workouts: 1,
      measurements: 2,
      healthProfiles: 1,
      trainingRuns: 1,
      trainingCheckpoints: 1,
      customExercises: 1,
      customEquipment: 1,
      notifications: 1,
      accessTokens: 1,
      userSettings: 1,
      healthDocuments: 3,
      photoIntakes: 1,
      progressPhotos: 1,
      coachMessages: 2,
      coachStates: 1,
      activityGoals: 1,
      activityEntries: 2,
      cancelledJobs: 2,
      storageObjectsDeleted: 5,
      storageObjectsFailed: 1,
    });
    expect(
      await client.auditEvent.count({ where: { targetId: a, action: 'user.data_reset.completed' } }),
    ).toBe(1);

    // --- Retry-safe: a second run deletes nothing more and keeps the counts --
    const again = await client.job.findUniqueOrThrow({ where: { id: job.id } });
    await handler.process(again);
    const rerun = await client.job.findUniqueOrThrow({ where: { id: job.id } });
    expect((rerun.payload as { result: Record<string, number> }).result).toMatchObject({
      gyms: 1,
      measurements: 2,
      storageObjectsFailed: 1,
    });
  });
});
