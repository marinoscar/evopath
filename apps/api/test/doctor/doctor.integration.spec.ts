// =============================================================================
// Integration tests for GET /api/admin/doctor (issue #634)
// =============================================================================
//
// `src/doctor/doctor.service.spec.ts` proves what the service DECIDES. This
// suite drives the route through the REAL AppModule, guard stack, validation
// pipe and response interceptor — the things a unit test cannot see:
//
//   1. RBAC in both directions (anonymous 401, viewer 403, admin 200), for the
//      permissionless-route trap `about.integration.spec.ts` describes.
//   2. The checks every feature module registers really are wired: the report
//      an admin receives through the real app lists them.
//   3. ⚠ NO SECRET ON THE WIRE. The serialized report — every detail, error
//      and data value of every check in the application — must not contain the
//      configured JWT secret or encryption key.
// =============================================================================

// Set before the app (and `secret-cipher.ts`'s key cache) is loaded.
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const ORIGINAL_KEY_ENV = process.env.SECRETS_ENCRYPTION_KEY;
process.env.SECRETS_ENCRYPTION_KEY = ENCRYPTION_KEY;

import request from 'supertest';

import { PERMISSIONS_KEY } from '../../src/auth/decorators/permissions.decorator';
import { DoctorController } from '../../src/doctor/doctor.controller';
import { DoctorService } from '../../src/doctor/doctor.service';
import { TestContext, closeTestApp, createTestApp } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  authHeader,
  createMockAdminUser,
  createMockContributorUser,
  createMockViewerUser,
} from '../helpers/auth-mock.helper';

const ROUTE = '/api/admin/doctor';

describe('Doctor API (Integration)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  }, 60000);

  afterAll(async () => {
    await closeTestApp(context);

    if (ORIGINAL_KEY_ENV === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
    else process.env.SECRETS_ENCRYPTION_KEY = ORIGINAL_KEY_ENV;
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    context.prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    context.module.get(DoctorService).invalidate();
  });

  const server = () => context.app.getHttpServer();
  const adminAuth = async () => authHeader((await createMockAdminUser(context)).accessToken);

  describe('permissions', () => {
    it('declares exactly system_settings:read, and invents no doctor:read', () => {
      const declared = Reflect.getMetadata(PERMISSIONS_KEY, DoctorController.prototype.getReport);

      expect(declared).toEqual(['system_settings:read']);
    });

    it('refuses an unauthenticated caller with 401', async () => {
      await request(server()).get(ROUTE).expect(401);
    });

    it('refuses a viewer with 403', async () => {
      const viewer = await createMockViewerUser(context);

      await request(server()).get(ROUTE).set(authHeader(viewer.accessToken)).expect(403);
    });

    it('refuses a contributor with 403', async () => {
      const contributor = await createMockContributorUser(context);

      await request(server()).get(ROUTE).set(authHeader(contributor.accessToken)).expect(403);
    });

    it('gives an admin a populated 200 in the { data, meta } envelope', async () => {
      const { body } = await request(server()).get(ROUTE).set(await adminAuth()).expect(200);

      expect(body).toHaveProperty('meta');
      expect(body.data).toMatchObject({
        verdict: expect.stringMatching(/^(pass|warn|fail|skip)$/),
        generatedAt: expect.any(String),
        durationMs: expect.any(Number),
        checks: expect.any(Array),
      });
    }, 30000);
  });

  describe('the report', () => {
    it('lists every registered check with a full row, and a remedy on each warn/fail', async () => {
      const { body } = await request(server()).get(ROUTE).set(await adminAuth()).expect(200);
      const checks = body.data.checks as Array<Record<string, unknown>>;

      for (const check of checks) {
        expect(Object.keys(check).sort()).toEqual(
          ['category', 'data', 'detail', 'durationMs', 'error', 'id', 'label', 'remedy', 'settingsPath', 'status'].sort(),
        );

        if (check.status === 'warn' || check.status === 'fail') {
          expect(typeof check.remedy).toBe('string');
        }
      }
    }, 30000);

    it('filters by category', async () => {
      const { body } = await request(server())
        .get(`${ROUTE}?category=core&refresh=true`)
        .set(await adminAuth())
        .expect(200);

      for (const check of body.data.checks) expect(check.category).toBe('core');
    }, 30000);

    it('rejects a malformed category with 400', async () => {
      await request(server()).get(`${ROUTE}?category=${encodeURIComponent('DROP TABLE')}`).set(await adminAuth()).expect(400);
    });

    it('rejects a non-boolean refresh with 400', async () => {
      await request(server()).get(`${ROUTE}?refresh=yes`).set(await adminAuth()).expect(400);
    });

    it('never puts the JWT secret or the encryption key on the wire', async () => {
      const { text } = await request(server()).get(`${ROUTE}?refresh=true`).set(await adminAuth()).expect(200);

      const jwtSecret = process.env.JWT_SECRET;
      expect(jwtSecret && jwtSecret.length).toBeTruthy();
      expect(text).not.toContain(jwtSecret as string);
      expect(text).not.toContain(ENCRYPTION_KEY);
      expect(text).not.toContain(Buffer.from(ENCRYPTION_KEY, 'base64').toString('hex'));
    }, 30000);
  });
});
