// =============================================================================
// Integration tests for GET /api/admin/onboarding/metrics (#212)
// =============================================================================
// Real AppModule, guards, validation pipe and interceptor; Prisma is the shared
// mock (`$queryRaw` returns one aggregate row). The SQL has its own real-Postgres
// suite: onboarding-metrics.db.spec.ts.
// =============================================================================

import request from 'supertest';

import { PERMISSIONS_KEY } from '../../src/auth/decorators/permissions.decorator';
import { OnboardingAdminController } from '../../src/onboarding/onboarding-admin.controller';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  authHeader,
  createMockAdminUser,
  createMockContributorUser,
  createMockViewerUser,
} from '../helpers/auth-mock.helper';
import { TestContext, closeTestApp, createTestApp } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';

const ROUTE = '/api/admin/onboarding/metrics';

const ROW = {
  cohort_size: 4,
  eligible: 2,
  activated: 1,
  median_hours: 12.34,
  health_profile: 2,
  gym: 1,
  first_workout: 1,
  ai_plan: 0,
};

describe('Onboarding metrics API (Integration)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  }, 60000);

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    (context.prismaMock.$queryRaw as jest.Mock).mockReset();
    (context.prismaMock.$queryRaw as jest.Mock).mockResolvedValue([ROW]);
  });

  const server = () => context.app.getHttpServer();
  const queryRaw = () => context.prismaMock.$queryRaw as jest.Mock;

  describe('permissions', () => {
    it('declares exactly system_settings:read', () => {
      expect(Reflect.getMetadata(PERMISSIONS_KEY, OnboardingAdminController.prototype.metrics)).toEqual([
        'system_settings:read',
      ]);
    });

    it('refuses an unauthenticated caller with 401', async () => {
      await request(server()).get(ROUTE).expect(401);
      expect(queryRaw()).not.toHaveBeenCalled();
    });

    it.each([
      ['viewer', createMockViewerUser],
      ['contributor', createMockContributorUser],
    ])('refuses a %s with 403 and never queries', async (_role, make) => {
      const user = await make(context);

      await request(server()).get(ROUTE).set(authHeader(user.accessToken)).expect(403);
      expect(queryRaw()).not.toHaveBeenCalled();
    });
  });

  describe('response', () => {
    it('gives an admin a 200 envelope with the metrics and default days 30', async () => {
      const admin = await createMockAdminUser(context);

      const { body } = await request(server()).get(ROUTE).set(authHeader(admin.accessToken)).expect(200);

      expect(body).toHaveProperty('meta');
      expect(body.data).toMatchObject({
        windowDays: 30,
        activationWindowDays: 7,
        cohortSize: 4,
        eligible: 2,
        activated: 1,
        activationRate: 0.5,
        medianHoursToFirstWorkout: 12.3,
      });
      expect(body.data.steps.map((s: { id: string }) => s.id)).toEqual([
        'health_profile',
        'gym',
        'first_workout',
        'ai_plan',
      ]);
      expect(queryRaw()).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['1', 1],
      ['365', 365],
      ['90', 90],
    ])('accepts days=%s and echoes it', async (days, expected) => {
      const admin = await createMockAdminUser(context);

      const { body } = await request(server())
        .get(`${ROUTE}?days=${days}`)
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(body.data.windowDays).toBe(expected);
    });
  });

  describe('days validation', () => {
    it.each(['0', '366', 'abc', '-5', '1.5'])('rejects days=%s with 400', async (days) => {
      const admin = await createMockAdminUser(context);

      await request(server()).get(`${ROUTE}?days=${days}`).set(authHeader(admin.accessToken)).expect(400);
      expect(queryRaw()).not.toHaveBeenCalled();
    });
  });
});
