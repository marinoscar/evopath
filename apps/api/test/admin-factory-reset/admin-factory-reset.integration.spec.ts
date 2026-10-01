import request from 'supertest';
import { Prisma } from '@prisma/client';

import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  authHeader,
  createMockAdminUser,
  createMockContributorUser,
  createMockViewerUser,
} from '../helpers/auth-mock.helper';
import { PERMISSIONS_KEY } from '../../src/auth/decorators/permissions.decorator';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { AdminFactoryResetController } from '../../src/admin-factory-reset/admin-factory-reset.controller';
import { ADMIN_FACTORY_RESET_TYPE } from '../../src/admin-factory-reset/admin-factory-reset.constants';

// =============================================================================
// /api/admin/factory-reset integration (issue #211)
// =============================================================================
//
// HTTP-level coverage through the REAL `AppModule` wiring: every route is
// exactly `system:factory_reset`, 401 without auth, 403 for non-admins, the
// `{ data }` envelope, the 400 on a wrong confirmation phrase (nothing
// queued), the 202 enqueue and its deployment-wide dedup onto the reset
// already in flight, and the status route's 404 for any job that is not a
// factory reset. `JobsService` is the real one over the mocked Prisma client.
// =============================================================================

const BASE = '/api/admin/factory-reset';
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const PHRASE = 'FACTORY RESET';

/** A P2002 on the active-dedup index, shaped the way `@prisma/adapter-pg` reports one. */
function activeDedupConflict() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: {
      modelName: 'Job',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23505',
          originalMessage: 'duplicate key value violates unique constraint "jobs_active_dedup_uniq_idx"',
          kind: 'UniqueConstraintViolation',
          constraint: { fields: ['dedup_key'] },
        },
      },
    },
  });
}

describe('Admin factory reset integration', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    context.prismaMock.auditEvent.create.mockResolvedValue({} as never);
  });

  describe('declared permission metadata', () => {
    it.each(['getSummary', 'requestReset', 'getResetStatus'] as const)(
      '%s requires exactly system:factory_reset',
      (method) => {
        expect(Reflect.getMetadata(PERMISSIONS_KEY, AdminFactoryResetController.prototype[method])).toEqual([
          'system:factory_reset',
        ]);
      },
    );
  });

  it('registers the admin.factory_reset job type as server-only', () => {
    const registry = context.module.get(JobHandlerRegistry);
    expect(registry.types()).toContain(ADMIN_FACTORY_RESET_TYPE);
    expect(registry.serverOnlyTypes()).toContain(ADMIN_FACTORY_RESET_TYPE);
  });

  it('returns 401 without auth on every route', async () => {
    const server = context.app.getHttpServer();
    await request(server).get(`${BASE}/summary`).expect(401);
    await request(server).post(BASE).send({ confirmation: PHRASE }).expect(401);
    await request(server).get(`${BASE}/${JOB_ID}`).expect(401);
    expect(context.prismaMock.job.create).not.toHaveBeenCalled();
  });

  it.each([
    ['viewer', createMockViewerUser],
    ['contributor', createMockContributorUser],
  ] as const)('returns 403 for a %s on every route and queues nothing', async (_role, create) => {
    const user = await create(context);
    const server = context.app.getHttpServer();
    await request(server).get(`${BASE}/summary`).set(authHeader(user.accessToken)).expect(403);
    await request(server).post(BASE).set(authHeader(user.accessToken)).send({ confirmation: PHRASE }).expect(403);
    await request(server).get(`${BASE}/${JOB_ID}`).set(authHeader(user.accessToken)).expect(403);
    expect(context.prismaMock.job.create).not.toHaveBeenCalled();
  });

  describe('GET /api/admin/factory-reset/summary', () => {
    it('returns the deployment-wide counts inside the envelope', async () => {
      const admin = await createMockAdminUser(context);
      context.prismaMock.databaseBackupRun.findMany.mockResolvedValue([] as never);
      for (const model of [
        'user',
        'workout',
        'gym',
        'measurement',
        'program',
        'trainingPlanRun',
        'storageObject',
        'job',
        'notification',
        'allowedEmail',
        'notificationBroadcast',
        'aiRun',
        'exercise',
        'equipmentType',
      ] as const) {
        (context.prismaMock as any)[model].count.mockResolvedValue(2);
      }

      const res = await request(context.app.getHttpServer())
        .get(`${BASE}/summary`)
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(res.body.data).toEqual({
        otherUsers: 2,
        workouts: 2,
        gyms: 2,
        measurements: 2,
        programs: 2,
        trainingRuns: 2,
        storageObjects: 2,
        jobs: 2,
        notifications: 2,
        allowlistEntries: 2,
        broadcasts: 2,
        aiRuns: 2,
        customExercises: 2,
        customEquipment: 2,
      });
      expect(context.prismaMock.user.count).toHaveBeenCalledWith({ where: { id: { not: admin.id } } });
    });
  });

  describe('POST /api/admin/factory-reset', () => {
    it.each([[{}], [{ confirmation: 'factory reset' }], [{ confirmation: 'DELETE MY DATA' }]])(
      'refuses %j with 400 and queues nothing',
      async (body) => {
        const admin = await createMockAdminUser(context);

        const res = await request(context.app.getHttpServer())
          .post(BASE)
          .set(authHeader(admin.accessToken))
          .send(body)
          .expect(400);

        expect(res.body.code).toBe('BAD_REQUEST');
        expect(context.prismaMock.job.create).not.toHaveBeenCalled();
        expect(context.prismaMock.auditEvent.create).not.toHaveBeenCalled();
      },
    );

    it('queues a factory reset and answers 202 with its id and status', async () => {
      const admin = await createMockAdminUser(context);
      context.prismaMock.job.create.mockResolvedValue({ id: JOB_ID, status: 'pending' } as never);

      const res = await request(context.app.getHttpServer())
        .post(BASE)
        .set(authHeader(admin.accessToken))
        .send({ confirmation: PHRASE })
        .expect(202);

      expect(res.body.data).toEqual({ jobId: JOB_ID, status: 'pending' });
      expect(context.prismaMock.job.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: ADMIN_FACTORY_RESET_TYPE,
          subjectType: null,
          subjectId: null,
          // One key for the whole deployment, whoever asks.
          dedupKey: `${ADMIN_FACTORY_RESET_TYPE}::`,
          payload: { actorUserId: admin.id },
        }),
      });
      expect(context.prismaMock.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ action: 'admin.factory_reset.requested', actorUserId: admin.id }),
      });
    });

    it('is deduplicated deployment-wide: a second request returns the reset already in flight', async () => {
      const admin = await createMockAdminUser(context);
      context.prismaMock.job.create.mockRejectedValue(activeDedupConflict());
      context.prismaMock.job.findFirst.mockResolvedValue({
        id: '22222222-2222-4222-8222-222222222222',
        status: 'running',
      } as never);

      const res = await request(context.app.getHttpServer())
        .post(BASE)
        .set(authHeader(admin.accessToken))
        .send({ confirmation: PHRASE })
        .expect(202);

      expect(res.body.data).toEqual({ jobId: '22222222-2222-4222-8222-222222222222', status: 'running' });
      expect(context.prismaMock.job.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { dedupKey: `${ADMIN_FACTORY_RESET_TYPE}::`, status: { in: ['pending', 'running'] } },
        }),
      );
    });
  });

  describe('GET /api/admin/factory-reset/:jobId', () => {
    it('returns the status and result of a finished reset', async () => {
      const admin = await createMockAdminUser(context);
      const result = {
        workouts: 1, gyms: 1, measurements: 1, healthProfiles: 1, healthDocuments: 0, photoIntakes: 0, programs: 0,
        progressPhotos: 0, coachMessages: 0, coachStates: 0, activityGoals: 0, activityEntries: 0,
        healthSyncDevices: 0, healthSyncRuns: 0, healthSyncDiagnosticReports: 0,
        programChangeLogs: 0, trainingRuns: 0, workoutAdaptations: 0, trainingCheckpoints: 0,
        customExercises: 0, customEquipment: 0, aiRuns: 0, aiUsageEvents: 0, aiKeys: 0,
        userCredentials: 0, accessTokens: 0, deviceCodes: 0, pushSubscriptions: 0, notifications: 0,
        notificationDeliveries: 0, userSettings: 1, cancelledJobs: 0, storageObjectsDeleted: 2,
        storageObjectsFailed: 0, usersDeleted: 3, jobs: 4, jobStatsRollups: 1, allowlistEntries: 2,
        broadcasts: 0, workerNodesReassigned: 0, nodeCredentialsReassigned: 0, workerNodesRemoved: 0,
      };
      context.prismaMock.job.findFirst.mockResolvedValue({
        id: JOB_ID,
        status: 'succeeded',
        lastError: null,
        payload: { actorUserId: admin.id, result },
      } as never);

      const res = await request(context.app.getHttpServer())
        .get(`${BASE}/${JOB_ID}`)
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(res.body.data).toEqual({ jobId: JOB_ID, status: 'succeeded', result });
      expect(context.prismaMock.job.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: JOB_ID, type: ADMIN_FACTORY_RESET_TYPE } }),
      );
    });

    it('returns the error of a failed reset', async () => {
      const admin = await createMockAdminUser(context);
      context.prismaMock.job.findFirst.mockResolvedValue({
        id: JOB_ID,
        status: 'failed',
        lastError: 'deadlock detected',
        payload: { actorUserId: admin.id },
      } as never);

      const res = await request(context.app.getHttpServer())
        .get(`${BASE}/${JOB_ID}`)
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(res.body.data).toEqual({ jobId: JOB_ID, status: 'failed', error: 'deadlock detected' });
    });

    it('is a 404 for a job that is not a factory reset', async () => {
      const admin = await createMockAdminUser(context);
      context.prismaMock.job.findFirst.mockResolvedValue(null);

      const res = await request(context.app.getHttpServer())
        .get(`${BASE}/${JOB_ID}`)
        .set(authHeader(admin.accessToken))
        .expect(404);

      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('is a 400 for an id that is not a UUID', async () => {
      const admin = await createMockAdminUser(context);
      await request(context.app.getHttpServer())
        .get(`${BASE}/not-a-uuid`)
        .set(authHeader(admin.accessToken))
        .expect(400);
    });
  });
});
