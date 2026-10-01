// =============================================================================
// Integration tests for the Android app trust routes (issue #279, epic #276)
// =============================================================================
//
//   GET /api/admin/android-app                system_settings:read
//   PUT /api/admin/android-app                system_settings:write
//   GET /api/well-known/assetlinks.json       public, raw JSON, maintenance-exempt
//
// Through the real AppModule, guard stack, validation pipe and response
// interceptor: RBAC in both directions, the envelope on the admin routes and
// its ABSENCE on the public one (Chrome needs a bare array), the headers, and
// the stored row and audit event a save writes.
// =============================================================================

import request from 'supertest';

import { PERMISSIONS_KEY } from '../../src/auth/decorators/permissions.decorator';
import { AndroidAppController } from '../../src/android-app/android-app.controller';
import {
  ANDROID_APP_SETTINGS_KEY,
  ANDROID_APP_TRUSTED_APPS_UPDATED_ACTION,
} from '../../src/android-app/android-app.schema';
import { MaintenanceModeService } from '../../src/common/maintenance/maintenance-mode.service';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  authHeader,
  createMockAdminUser,
  createMockContributorUser,
  createMockViewerUser,
} from '../helpers/auth-mock.helper';
import { TestContext, closeTestApp, createTestApp } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';

const ADMIN_ROUTE = '/api/admin/android-app';
const ASSET_LINKS_ROUTE = '/api/well-known/assetlinks.json';

const SHA_A = Array.from({ length: 32 }, () => 'AB').join(':');
const SHA_B = Array.from({ length: 32 }, () => 'CD').join(':');

describe('Android app trust API (Integration)', () => {
  let context: TestContext;
  let stored: unknown;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  }, 60000);

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    stored = undefined;

    const prisma = context.prismaMock;
    const globalFindUnique = prisma.systemSettings.findUnique.getMockImplementation();
    prisma.systemSettings.findUnique.mockImplementation(async (args: { where: { key: string } }) => {
      if (args.where.key === ANDROID_APP_SETTINGS_KEY) {
        return stored === undefined ? null : { key: ANDROID_APP_SETTINGS_KEY, value: stored, version: 1 };
      }
      return globalFindUnique ? globalFindUnique(args) : null;
    });
    prisma.systemSettings.upsert.mockImplementation(
      async (args: { where: { key: string }; create: { value: unknown } }) => {
        stored = args.create.value;
        return { key: args.where.key, value: args.create.value, version: 1 };
      },
    );
    prisma.healthSyncDevice.groupBy.mockResolvedValue([]);
  });

  const server = () => context.app.getHttpServer();
  const adminAuth = async () => authHeader((await createMockAdminUser(context)).accessToken);

  describe('permissions', () => {
    it('declares exactly the system_settings strings the admin card uses', () => {
      expect(Reflect.getMetadata(PERMISSIONS_KEY, AndroidAppController.prototype.get)).toEqual([
        'system_settings:read',
      ]);
      expect(Reflect.getMetadata(PERMISSIONS_KEY, AndroidAppController.prototype.replace)).toEqual([
        'system_settings:write',
      ]);
    });

    it('refuses unauthenticated callers on the admin routes', async () => {
      await request(server()).get(ADMIN_ROUTE).expect(401);
      await request(server()).put(ADMIN_ROUTE).send({ trustedApps: [] }).expect(401);
    });

    it('refuses a viewer and a contributor with 403', async () => {
      for (const user of [await createMockViewerUser(context), await createMockContributorUser(context)]) {
        await request(server()).get(ADMIN_ROUTE).set(authHeader(user.accessToken)).expect(403);
        await request(server())
          .put(ADMIN_ROUTE)
          .set(authHeader(user.accessToken))
          .send({ trustedApps: [] })
          .expect(403);
      }

      expect(context.prismaMock.systemSettings.upsert).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/admin/android-app', () => {
    it('returns an empty state in the { data } envelope when nothing is stored or reported', async () => {
      const { body } = await request(server()).get(ADMIN_ROUTE).set(await adminAuth()).expect(200);

      expect(body.data).toEqual({ trustedApps: [], reportedApps: [], assetLinks: [] });
    });

    it('lists reported apps from active devices, flagged against the trusted list', async () => {
      stored = { trustedApps: [{ packageName: 'com.example.app', sha256: SHA_A }] };
      context.prismaMock.healthSyncDevice.groupBy.mockResolvedValue([
        {
          packageName: 'com.example.app',
          signingSha256: SHA_A.toLowerCase(),
          _count: { _all: 2 },
          _max: { lastSeenAt: new Date('2026-09-30T10:00:00Z') },
        },
        {
          packageName: 'com.example.app.debug',
          signingSha256: SHA_B,
          _count: { _all: 1 },
          _max: { lastSeenAt: null },
        },
      ]);

      const { body } = await request(server()).get(ADMIN_ROUTE).set(await adminAuth()).expect(200);

      expect(body.data.reportedApps).toEqual([
        {
          packageName: 'com.example.app',
          sha256: SHA_A,
          deviceCount: 2,
          lastSeenAt: '2026-09-30T10:00:00.000Z',
          trusted: true,
        },
        { packageName: 'com.example.app.debug', sha256: SHA_B, deviceCount: 1, lastSeenAt: null, trusted: false },
      ]);
      expect(context.prismaMock.healthSyncDevice.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: 'active', packageName: { not: null }, signingSha256: { not: null } },
        }),
      );
    });
  });

  describe('PUT /api/admin/android-app', () => {
    it('normalises, de-duplicates, stores, audits and returns the new state', async () => {
      const admin = await createMockAdminUser(context);

      const { body } = await request(server())
        .put(ADMIN_ROUTE)
        .set(authHeader(admin.accessToken))
        .send({
          trustedApps: [
            { packageName: 'com.example.app', sha256: SHA_A.toLowerCase() },
            { packageName: 'com.example.app', sha256: SHA_B },
            { packageName: 'com.example.app', sha256: SHA_A },
          ],
        })
        .expect(200);

      const trustedApps = [
        { packageName: 'com.example.app', sha256: SHA_A },
        { packageName: 'com.example.app', sha256: SHA_B },
      ];
      expect(body.data.trustedApps).toEqual(trustedApps);
      expect(body.data.assetLinks).toEqual([
        {
          relation: ['delegate_permission/common.handle_all_urls'],
          target: { namespace: 'android_app', package_name: 'com.example.app', sha256_cert_fingerprints: [SHA_A, SHA_B] },
        },
      ]);
      expect(stored).toEqual({ trustedApps });
      expect(context.prismaMock.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorUserId: admin.id,
          action: ANDROID_APP_TRUSTED_APPS_UPDATED_ACTION,
          targetType: 'system_settings',
          targetId: ANDROID_APP_SETTINGS_KEY,
          meta: expect.objectContaining({ count: 2, added: trustedApps, removed: [] }),
        }),
      });
    });

    it.each([
      ['a missing list', {}],
      ['a bad package name', { trustedApps: [{ packageName: 'app', sha256: SHA_A }] }],
      ['a bad fingerprint', { trustedApps: [{ packageName: 'com.example.app', sha256: 'AB:CD' }] }],
      [
        'more than ten apps',
        { trustedApps: Array.from({ length: 11 }, (_, i) => ({ packageName: `com.example.a${i}`, sha256: SHA_A })) },
      ],
    ])('rejects %s with 400 and writes nothing', async (_label, payload) => {
      await request(server()).put(ADMIN_ROUTE).set(await adminAuth()).send(payload).expect(400);

      expect(context.prismaMock.systemSettings.upsert).not.toHaveBeenCalled();
      expect(context.prismaMock.auditEvent.create).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/well-known/assetlinks.json', () => {
    it('answers an anonymous caller with a bare array, JSON and a five-minute public cache', async () => {
      stored = {
        trustedApps: [
          { packageName: 'com.example.app', sha256: SHA_A },
          { packageName: 'com.example.app.debug', sha256: SHA_B },
        ],
      };

      const response = await request(server()).get(ASSET_LINKS_ROUTE).expect(200);

      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.headers['cache-control']).toBe('public, max-age=300');
      expect(response.body).toEqual([
        {
          relation: ['delegate_permission/common.handle_all_urls'],
          target: { namespace: 'android_app', package_name: 'com.example.app', sha256_cert_fingerprints: [SHA_A] },
        },
        {
          relation: ['delegate_permission/common.handle_all_urls'],
          target: { namespace: 'android_app', package_name: 'com.example.app.debug', sha256_cert_fingerprints: [SHA_B] },
        },
      ]);
    });

    it('is [] when nothing is stored, and when the stored row does not validate', async () => {
      await request(server()).get(ASSET_LINKS_ROUTE).expect(200).expect((res) => expect(res.body).toEqual([]));

      stored = { trustedApps: 'not a list' };
      await request(server()).get(ASSET_LINKS_ROUTE).expect(200).expect((res) => expect(res.body).toEqual([]));
    });

    it('stays reachable while a maintenance window is open', async () => {
      const maintenance = context.module.get(MaintenanceModeService);
      maintenance.setInMemoryOverride({ enabled: true, message: 'Down for maintenance', allowAdmins: false });

      try {
        await request(server()).get(ASSET_LINKS_ROUTE).expect(200);
        await request(server()).get(ADMIN_ROUTE).set(await adminAuth()).expect(503);
      } finally {
        maintenance.setInMemoryOverride(null);
      }
    });
  });
});
