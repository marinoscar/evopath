// =============================================================================
// Integration tests for GET /api/onboarding (#203)
// =============================================================================
//
// Drives the route through the REAL AppModule, guard stack, validation pipe and
// response interceptor. The Doctor and the AI policy are stubbed (they have
// their own suites); Prisma is the shared mock.
// =============================================================================

import request from 'supertest';

import { AiConfigService } from '../../src/ai/config/ai-config.service';
import { PERMISSIONS_KEY } from '../../src/auth/decorators/permissions.decorator';
import { DoctorService } from '@marinoscar/platform-api/doctor';
import { OnboardingController } from '../../src/onboarding/onboarding.controller';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  authHeader,
  createMockAdminUser,
  createMockContributorUser,
  createMockViewerUser,
} from '../helpers/auth-mock.helper';
import { TestContext, closeTestApp, createTestApp } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';

const ROUTE = '/api/onboarding';

const doctorStub = {
  run: jest.fn(),
};
const aiConfigStub = {
  isEnabled: jest.fn(),
};

describe('Onboarding API (Integration)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [
        { provide: DoctorService, useValue: doctorStub },
        { provide: AiConfigService, useValue: aiConfigStub },
      ],
    });
  }, 60000);

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    doctorStub.run.mockReset();
    doctorStub.run.mockImplementation(async () => ({
      verdict: 'pass',
      generatedAt: new Date().toISOString(),
      durationMs: 1,
      checks: [],
    }));
    aiConfigStub.isEnabled.mockReset();
    aiConfigStub.isEnabled.mockResolvedValue(true);

    const p = context.prismaMock;
    p.userSettings.findUnique.mockResolvedValue(null);
    p.healthProfile.findUnique.mockResolvedValue(null);
    p.gym.findFirst.mockResolvedValue(null);
    p.workout.findFirst.mockResolvedValue(null);
    p.program.findFirst.mockResolvedValue(null);
    p.allowedEmail.findFirst.mockResolvedValue(null);
  });

  const server = () => context.app.getHttpServer();

  describe('permissions', () => {
    it('declares exactly user_settings:read', () => {
      expect(Reflect.getMetadata(PERMISSIONS_KEY, OnboardingController.prototype.get)).toEqual([
        'user_settings:read',
      ]);
    });

    it('refuses an unauthenticated caller with 401', async () => {
      await request(server()).get(ROUTE).expect(401);
    });
  });

  describe('response', () => {
    it('gives a viewer a 200 envelope with a null admin block and no ai_plan', async () => {
      const viewer = await createMockViewerUser(context);

      const { body } = await request(server()).get(ROUTE).set(authHeader(viewer.accessToken)).expect(200);

      expect(body).toHaveProperty('meta');
      expect(body.data).toMatchObject({
        welcomeSeenAt: null,
        checklistDismissedAt: null,
        goal: null,
        admin: null,
      });
      expect(body.data.user.steps.map((s: { id: string }) => s.id)).not.toContain('ai_plan');
      expect(body.data.user.total).toBe(body.data.user.steps.length);
      expect(doctorStub.run).not.toHaveBeenCalled();
    });

    it('gives a contributor a 200 with ai_plan and a null admin block', async () => {
      const contributor = await createMockContributorUser(context);

      const { body } = await request(server()).get(ROUTE).set(authHeader(contributor.accessToken)).expect(200);

      expect(body.data.user.steps.map((s: { id: string }) => s.id)).toContain('ai_plan');
      expect(body.data.admin).toBeNull();
    });

    // E7.12: the same step id, relabelled once a plan exists.
    it('turns ai_plan into "Meet your coach" once a program exists, done after the coach settings were saved', async () => {
      const contributor = await createMockContributorUser(context);
      const p = context.prismaMock;
      p.program.findFirst.mockResolvedValue({ id: 'p1' });
      const aiPlan = (body: { data: { user: { steps: Array<{ id: string }> } } }) =>
        body.data.user.steps.find((s) => s.id === 'ai_plan');

      const before = await request(server()).get(ROUTE).set(authHeader(contributor.accessToken)).expect(200);
      expect(aiPlan(before.body)).toMatchObject({ status: 'todo', label: 'Meet your coach', href: '/settings/coach' });
      expect(before.body.data.user.steps.length).toBeLessThanOrEqual(4);

      p.userSettings.findUnique.mockResolvedValue({ value: { coach: { personaId: 'stoic' } } });
      const after = await request(server()).get(ROUTE).set(authHeader(contributor.accessToken)).expect(200);
      expect(aiPlan(after.body)).toMatchObject({ status: 'done', label: 'Meet your coach' });

      // The GET writes nothing.
      expect(p.userSettings.create).not.toHaveBeenCalled();
      expect(p.userSettings.update).not.toHaveBeenCalled();
      expect(p.userSettings.upsert).not.toHaveBeenCalled();
    });

    it('gives an admin a non-null admin block', async () => {
      const admin = await createMockAdminUser(context);

      const { body } = await request(server()).get(ROUTE).set(authHeader(admin.accessToken)).expect(200);

      expect(body.data.admin).toMatchObject({
        total: 6,
        requiredDone: false,
        steps: expect.any(Array),
      });
      expect(body.data.admin.steps.map((s: { id: string }) => s.id)).toEqual([
        'storage',
        'email',
        'allowlist',
        'ai',
        'push',
        'backup',
      ]);
    });

    it('reflects the stored onboarding state', async () => {
      const viewer = await createMockViewerUser(context);
      context.prismaMock.userSettings.findUnique.mockResolvedValue({
        value: { onboarding: { goal: 'strength', welcomeSeenAt: '2026-01-01T00:00:00.000Z' } },
      });

      const { body } = await request(server()).get(ROUTE).set(authHeader(viewer.accessToken)).expect(200);

      expect(body.data.goal).toBe('strength');
      expect(body.data.welcomeSeenAt).toBe('2026-01-01T00:00:00.000Z');
      expect(body.data.user.steps[0].id).toBe('gym');
    });

    it('never writes', async () => {
      const admin = await createMockAdminUser(context);
      const p = context.prismaMock;
      p.userSettings.create.mockClear();
      p.userSettings.upsert.mockClear();
      p.userSettings.update.mockClear();

      await request(server()).get(ROUTE).set(authHeader(admin.accessToken)).expect(200);

      expect(p.userSettings.create).not.toHaveBeenCalled();
      expect(p.userSettings.upsert).not.toHaveBeenCalled();
      expect(p.userSettings.update).not.toHaveBeenCalled();
    });
  });

  describe('refresh', () => {
    it('forwards refresh=true to the Doctor', async () => {
      const admin = await createMockAdminUser(context);

      await request(server()).get(`${ROUTE}?refresh=true`).set(authHeader(admin.accessToken)).expect(200);

      expect(doctorStub.run).toHaveBeenCalled();
      for (const [arg] of doctorStub.run.mock.calls) expect(arg.refresh).toBe(true);
    });

    it.each(['', '?refresh=false'])('does not refresh by default (%p)', async (qs) => {
      const admin = await createMockAdminUser(context);

      await request(server()).get(`${ROUTE}${qs}`).set(authHeader(admin.accessToken)).expect(200);

      for (const [arg] of doctorStub.run.mock.calls) expect(arg.refresh).toBe(false);
    });

    it('rejects an invalid refresh value with 400', async () => {
      const admin = await createMockAdminUser(context);

      await request(server()).get(`${ROUTE}?refresh=maybe`).set(authHeader(admin.accessToken)).expect(400);

      expect(doctorStub.run).not.toHaveBeenCalled();
    });
  });
});
