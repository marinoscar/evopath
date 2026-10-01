import request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';

import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { createMockAdminUser, createMockViewerUser, authHeader } from '../helpers/auth-mock.helper';
import { PERMISSIONS_KEY } from '../../src/auth/decorators/permissions.decorator';
import { StackAgentClient } from '../../src/telemetry/stack/stack-agent.client';
import { TelemetryStackController } from '../../src/telemetry/stack/telemetry-stack.controller';
import { TELEMETRY_STACK_DEPLOY_TYPE } from '../../src/telemetry/stack/telemetry-stack-deploy.handler';

// =============================================================================
// Telemetry services (stack-agent) integration (issue #567)
// =============================================================================
//
// HTTP-level coverage of `/api/admin/telemetry/stack*` through the REAL
// `AppModule` wiring: RBAC (`system_settings:read` for the status,
// `system_settings:write` for the deploy, 401 without auth), the response
// shapes inside the `{ data }` envelope, the 409 when no stack agent is
// configured, and the idempotent enqueue (a dedup conflict on the queue's
// active-dedup index returns the job already in flight).
//
// `StackAgentClient` is replaced with a stub — no network — and the queue's
// `JobsService` is the real one over the mocked Prisma client.
// =============================================================================

const BASE = '/api/admin/telemetry/stack';

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

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    type: TELEMETRY_STACK_DEPLOY_TYPE,
    status: 'pending',
    createdAt: new Date('2026-09-27T10:00:00.000Z'),
    finishedAt: null,
    lastError: null,
    payload: { requestedByUserId: 'x' },
    ...overrides,
  };
}

describe('Telemetry stack integration', () => {
  let context: TestContext;
  const agent = {
    isConfigured: jest.fn(),
    telemetryStatus: jest.fn(),
    telemetryUp: jest.fn(),
  };

  beforeAll(async () => {
    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [{ provide: StackAgentClient, useValue: agent }],
    });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();

    agent.isConfigured.mockReset().mockReturnValue(true);
    agent.telemetryStatus.mockReset().mockResolvedValue({
      ok: true,
      services: [
        { name: 'greptimedb', state: 'running', health: 'healthy' },
        { name: 'otel-collector', state: 'running', health: null },
      ],
    });
    agent.telemetryUp.mockReset();

    context.prismaMock.job.findFirst.mockResolvedValue(null);
    context.prismaMock.auditEvent.create.mockResolvedValue({} as never);
  });

  /** A user holding ONLY `system_settings:read`. */
  async function createSettingsReadOnlyUser(): Promise<{ accessToken: string }> {
    const jwtService = context.module.get<JwtService>(JwtService);
    const id = 'settings-read-only';
    const email = 'settings-read-only@example.com';

    context.prismaMock.user.findUnique.mockImplementation(async ({ where }: any) => {
      if (where?.id !== id && where?.email !== email) return null;
      return {
        id,
        email,
        displayName: null,
        providerDisplayName: 'Settings Read Only',
        profileImageUrl: null,
        providerProfileImageUrl: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        userRoles: [
          {
            role: {
              id: 'role-settings-readonly',
              name: 'settings-readonly',
              description: 'Read-only system settings',
              rolePermissions: [
                {
                  permission: {
                    id: 'perm-ss-read',
                    name: 'system_settings:read',
                    description: 'Read system settings',
                  },
                },
              ],
            },
          },
        ],
      };
    });

    return { accessToken: jwtService.sign({ sub: id, email, roles: ['settings-readonly'] }) };
  }

  describe('declared permission metadata', () => {
    it('GET requires exactly system_settings:read', () => {
      expect(Reflect.getMetadata(PERMISSIONS_KEY, TelemetryStackController.prototype.getStatus)).toEqual([
        'system_settings:read',
      ]);
    });

    it('POST deploy requires exactly system_settings:write', () => {
      expect(Reflect.getMetadata(PERMISSIONS_KEY, TelemetryStackController.prototype.deploy)).toEqual([
        'system_settings:write',
      ]);
    });
  });

  describe('RBAC', () => {
    it('returns 401 without auth on both endpoints', async () => {
      const server = context.app.getHttpServer();

      await request(server).get(BASE).expect(401);
      await request(server).post(`${BASE}/deploy`).expect(401);
      expect(agent.telemetryStatus).not.toHaveBeenCalled();
    });

    it('refuses a viewer with 403 on both endpoints', async () => {
      const viewer = await createMockViewerUser(context);
      const server = context.app.getHttpServer();

      await request(server).get(BASE).set(authHeader(viewer.accessToken)).expect(403);
      await request(server).post(`${BASE}/deploy`).set(authHeader(viewer.accessToken)).expect(403);
    });

    it('lets system_settings:read see the status but not deploy', async () => {
      const readOnly = await createSettingsReadOnlyUser();
      const server = context.app.getHttpServer();

      await request(server).get(BASE).set(authHeader(readOnly.accessToken)).expect(200);
      await request(server).post(`${BASE}/deploy`).set(authHeader(readOnly.accessToken)).expect(403);
      expect(context.prismaMock.job.create).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/admin/telemetry/stack', () => {
    it('returns the agent state, services and latest deploy inside the envelope', async () => {
      const admin = await createMockAdminUser(context);
      context.prismaMock.job.findFirst.mockResolvedValue(
        jobRow({
          status: 'succeeded',
          finishedAt: new Date('2026-09-27T10:02:00.000Z'),
          payload: { result: { ok: true, exitCode: 0, output: 'Started' } },
        }),
      );

      const res = await request(context.app.getHttpServer()).get(BASE).set(authHeader(admin.accessToken)).expect(200);

      expect(res.body.data).toEqual({
        agent: 'available',
        agentError: null,
        services: [
          { name: 'greptimedb', state: 'running', health: 'healthy' },
          { name: 'otel-collector', state: 'running', health: null },
        ],
        deploy: {
          jobId: '11111111-1111-4111-8111-111111111111',
          status: 'succeeded',
          createdAt: '2026-09-27T10:00:00.000Z',
          finishedAt: '2026-09-27T10:02:00.000Z',
          error: null,
          output: 'Started',
        },
      });
    });

    it('reports not_configured with a 200 on a deployment without an agent', async () => {
      const admin = await createMockAdminUser(context);
      agent.telemetryStatus.mockResolvedValue({ ok: false, error: 'not_configured', message: 'x' });

      const res = await request(context.app.getHttpServer()).get(BASE).set(authHeader(admin.accessToken)).expect(200);

      expect(res.body.data).toEqual({ agent: 'not_configured', agentError: null, services: [], deploy: null });
    });

    it('reports why the agent is unavailable', async () => {
      const admin = await createMockAdminUser(context);
      const message = 'stack-agent at http://stack-agent:8080 is unreachable: ECONNREFUSED (connect ECONNREFUSED)';
      agent.telemetryStatus.mockResolvedValue({ ok: false, error: 'unreachable', message });

      const res = await request(context.app.getHttpServer()).get(BASE).set(authHeader(admin.accessToken)).expect(200);

      expect(res.body.data).toEqual({ agent: 'unavailable', agentError: message, services: [], deploy: null });
    });
  });

  describe('POST /api/admin/telemetry/stack/deploy', () => {
    it('queues a deploy job and answers 202 with its id', async () => {
      const admin = await createMockAdminUser(context);
      context.prismaMock.job.create.mockResolvedValue(jobRow());

      const res = await request(context.app.getHttpServer())
        .post(`${BASE}/deploy`)
        .set(authHeader(admin.accessToken))
        .expect(202);

      expect(res.body.data).toEqual({ jobId: '11111111-1111-4111-8111-111111111111' });
      expect(context.prismaMock.job.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: TELEMETRY_STACK_DEPLOY_TYPE,
          dedupKey: `${TELEMETRY_STACK_DEPLOY_TYPE}::`,
        }),
      });
      expect(context.prismaMock.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ action: 'telemetry:stack_deploy', targetType: 'job' }),
      });
      // The deploy itself runs on the queue, never in the request.
      expect(agent.telemetryUp).not.toHaveBeenCalled();
    });

    it('is idempotent: a second request returns the job already in flight', async () => {
      const admin = await createMockAdminUser(context);
      const inFlight = jobRow({ id: '22222222-2222-4222-8222-222222222222', status: 'running' });
      context.prismaMock.job.create.mockRejectedValue(activeDedupConflict());
      context.prismaMock.job.findFirst.mockResolvedValue(inFlight);

      const res = await request(context.app.getHttpServer())
        .post(`${BASE}/deploy`)
        .set(authHeader(admin.accessToken))
        .expect(202);

      expect(res.body.data).toEqual({ jobId: '22222222-2222-4222-8222-222222222222' });
    });

    it('refuses with 409 STACK_AGENT_NOT_CONFIGURED when there is no stack agent', async () => {
      const admin = await createMockAdminUser(context);
      agent.isConfigured.mockReturnValue(false);

      const res = await request(context.app.getHttpServer())
        .post(`${BASE}/deploy`)
        .set(authHeader(admin.accessToken))
        .expect(409);

      expect(res.body.code).toBe('CONFLICT');
      expect(res.body.details).toMatchObject({ reason: 'STACK_AGENT_NOT_CONFIGURED' });
      expect(context.prismaMock.job.create).not.toHaveBeenCalled();
    });
  });
});
