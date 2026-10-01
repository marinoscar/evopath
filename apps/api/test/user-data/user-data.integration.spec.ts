import request from 'supertest';
import { Prisma } from '@prisma/client';

import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockViewerUser } from '../helpers/auth-mock.helper';
import { PERMISSIONS_KEY } from '../../src/auth/decorators/permissions.decorator';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { UserDataController } from '../../src/user-data/user-data.controller';
import { USER_DATA_RESET_TYPE } from '../../src/user-data/user-data.constants';

// =============================================================================
// /api/user-data integration (issue #202)
// =============================================================================
//
// HTTP-level coverage through the REAL `AppModule` wiring: every route is
// `user_settings:write`, 401 without auth, the `{ data }` envelope, the 400 on
// a wrong confirmation phrase (nothing queued), the 202 enqueue and its dedup
// onto the reset already in flight, and the status route's 404 for any job
// that is not the caller's own reset. The queue's `JobsService` is the real
// one over the mocked Prisma client.
// =============================================================================

const BASE = '/api/user-data';
const JOB_ID = '11111111-1111-4111-8111-111111111111';

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

describe('User data integration', () => {
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
      '%s requires exactly user_settings:write',
      (method) => {
        expect(Reflect.getMetadata(PERMISSIONS_KEY, UserDataController.prototype[method])).toEqual([
          'user_settings:write',
        ]);
      },
    );
  });

  it('registers the user.data_reset job type as server-only', () => {
    const registry = context.module.get(JobHandlerRegistry);
    expect(registry.types()).toContain(USER_DATA_RESET_TYPE);
    expect(registry.serverOnlyTypes()).toContain(USER_DATA_RESET_TYPE);
  });

  it('returns 401 without auth on every route', async () => {
    const server = context.app.getHttpServer();
    await request(server).get(`${BASE}/summary`).expect(401);
    await request(server).post(`${BASE}/reset`).send({ confirmation: 'DELETE MY DATA' }).expect(401);
    await request(server).get(`${BASE}/reset/${JOB_ID}`).expect(401);
    expect(context.prismaMock.job.create).not.toHaveBeenCalled();
  });

  describe('GET /api/user-data/summary', () => {
    it("returns the caller's counts inside the envelope", async () => {
      const user = await createMockViewerUser(context);
      for (const model of [
        'workout',
        'gym',
        'measurement',
        'program',
        'trainingPlanRun',
        'exercise',
        'storageObject',
        'userAiKey',
        'personalAccessToken',
        'notification',
        'equipmentType',
        'photoIntake',
        'workoutAdaptation',
        'userCredential',
        'healthDocument',
        'progressPhoto',
        'coachMessage',
      ] as const) {
        (context.prismaMock as any)[model].count.mockResolvedValue(2);
      }

      const res = await request(context.app.getHttpServer())
        .get(`${BASE}/summary`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(res.body.data).toEqual({
        workouts: 2,
        gyms: 2,
        measurements: 2,
        programs: 2,
        trainingRuns: 2,
        customExercises: 2,
        photos: 2,
        aiKeys: 2,
        accessTokens: 2,
        notifications: 2,
        customEquipment: 2,
        photoIntakes: 2,
        workoutAdaptations: 2,
        userCredentials: 2,
        healthDocuments: 2,
        progressPhotos: 2,
        coachMessages: 2,
      });
      expect(context.prismaMock.workout.count).toHaveBeenCalledWith({ where: { userId: user.id } });
    });
  });

  describe('POST /api/user-data/reset', () => {
    it.each([
      [{}],
      [{ confirmation: 'delete my data' }],
      [{ confirmation: 'DELETE MY DATA!' }],
    ])('refuses %j with 400 and queues nothing', async (body) => {
      const user = await createMockViewerUser(context);

      const res = await request(context.app.getHttpServer())
        .post(`${BASE}/reset`)
        .set(authHeader(user.accessToken))
        .send(body)
        .expect(400);

      expect(res.body.code).toBe('BAD_REQUEST');
      expect(context.prismaMock.job.create).not.toHaveBeenCalled();
      expect(context.prismaMock.auditEvent.create).not.toHaveBeenCalled();
    });

    it('queues a reset for the caller and answers 202 with its id and status', async () => {
      const user = await createMockViewerUser(context);
      context.prismaMock.job.create.mockResolvedValue({ id: JOB_ID, status: 'pending' } as never);

      const res = await request(context.app.getHttpServer())
        .post(`${BASE}/reset`)
        .set(authHeader(user.accessToken))
        .send({ confirmation: 'DELETE MY DATA' })
        .expect(202);

      expect(res.body.data).toEqual({ jobId: JOB_ID, status: 'pending' });
      expect(context.prismaMock.job.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: USER_DATA_RESET_TYPE,
          subjectType: 'user',
          subjectId: user.id,
          dedupKey: `${USER_DATA_RESET_TYPE}:user:${user.id}`,
        }),
      });
      expect(context.prismaMock.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ action: 'user.data_reset.requested', targetId: user.id }),
      });
    });

    it('is idempotent: a second request returns the reset already in flight', async () => {
      const user = await createMockViewerUser(context);
      context.prismaMock.job.create.mockRejectedValue(activeDedupConflict());
      context.prismaMock.job.findFirst.mockResolvedValue({
        id: '22222222-2222-4222-8222-222222222222',
        status: 'running',
      } as never);

      const res = await request(context.app.getHttpServer())
        .post(`${BASE}/reset`)
        .set(authHeader(user.accessToken))
        .send({ confirmation: 'DELETE MY DATA' })
        .expect(202);

      expect(res.body.data).toEqual({ jobId: '22222222-2222-4222-8222-222222222222', status: 'running' });
    });
  });

  describe('GET /api/user-data/reset/:jobId', () => {
    it('returns the status and result of the caller reset', async () => {
      const user = await createMockViewerUser(context);
      context.prismaMock.job.findFirst.mockResolvedValue({
        id: JOB_ID,
        status: 'failed',
        lastError: 'deadlock detected',
        payload: { userId: user.id },
      } as never);

      const res = await request(context.app.getHttpServer())
        .get(`${BASE}/reset/${JOB_ID}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(res.body.data).toEqual({ jobId: JOB_ID, status: 'failed', error: 'deadlock detected' });
      expect(context.prismaMock.job.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: JOB_ID, type: USER_DATA_RESET_TYPE, subjectType: 'user', subjectId: user.id },
        }),
      );
    });

    it("is a 404 for a job that is not the caller's own reset", async () => {
      const user = await createMockViewerUser(context);
      context.prismaMock.job.findFirst.mockResolvedValue(null);

      const res = await request(context.app.getHttpServer())
        .get(`${BASE}/reset/${JOB_ID}`)
        .set(authHeader(user.accessToken))
        .expect(404);

      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('is a 400 for an id that is not a UUID', async () => {
      const user = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .get(`${BASE}/reset/not-a-uuid`)
        .set(authHeader(user.accessToken))
        .expect(400);
      expect(context.prismaMock.job.findFirst).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: 'not-a-uuid' }) }),
      );
    });
  });
});
