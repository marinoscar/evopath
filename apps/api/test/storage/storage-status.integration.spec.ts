// =============================================================================
// Integration tests for GET /api/storage/status (#204)
// =============================================================================
// Real AppModule, guard stack and response interceptor; the storage
// configuration is stubbed (it has its own suites), Prisma is the shared mock.
// =============================================================================

import request from 'supertest';

import { PERMISSIONS_KEY } from '../../src/auth/decorators/permissions.decorator';
import { StorageConfigService } from '../../src/storage/config/storage-config.service';
import { StorageStatusController } from '../../src/storage/status/storage-status.controller';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  authHeader,
  createMockAdminUser,
  createMockContributorUser,
  createMockViewerUser,
} from '../helpers/auth-mock.helper';
import { TestContext, closeTestApp, createTestApp } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';

const ROUTE = '/api/storage/status';

const storageConfigStub = { resolve: jest.fn() };

describe('Storage status API (Integration)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [{ provide: StorageConfigService, useValue: storageConfigStub }],
    });
  }, 60000);

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    storageConfigStub.resolve.mockReset();
    storageConfigStub.resolve.mockResolvedValue({ configured: false, provider: 's3', missing: ['bucket'] });
  });

  const server = () => context.app.getHttpServer();

  it('declares exactly storage:read', () => {
    expect(Reflect.getMetadata(PERMISSIONS_KEY, StorageStatusController.prototype.getStatus)).toEqual([
      'storage:read',
    ]);
  });

  it('refuses an unauthenticated caller with 401', async () => {
    await request(server()).get(ROUTE).expect(401);
  });

  it.each([
    ['viewer', createMockViewerUser],
    ['contributor', createMockContributorUser],
    ['admin', createMockAdminUser],
  ])('gives a %s a 200 envelope with only { configured }', async (_role, make) => {
    const user = await make(context);

    const { body } = await request(server()).get(ROUTE).set(authHeader(user.accessToken)).expect(200);

    expect(body).toHaveProperty('meta');
    expect(body.data).toEqual({ configured: false });
  });

  it('reports configured: true without leaking the provider fields', async () => {
    storageConfigStub.resolve.mockResolvedValue({
      configured: true,
      config: { provider: 's3', bucket: 'b-secret', region: 'r-secret', accessKeyId: 'ak', secretAccessKey: 'sk' },
    });
    const viewer = await createMockViewerUser(context);

    const { body } = await request(server()).get(ROUTE).set(authHeader(viewer.accessToken)).expect(200);

    expect(body.data).toEqual({ configured: true });
    expect(JSON.stringify(body)).not.toMatch(/b-secret|r-secret|"ak"|"sk"/);
  });

  it('answers 200 configured: false when the configuration cannot be read', async () => {
    storageConfigStub.resolve.mockRejectedValue(new Error('decrypt failed'));
    const viewer = await createMockViewerUser(context);

    const { body } = await request(server()).get(ROUTE).set(authHeader(viewer.accessToken)).expect(200);

    expect(body.data).toEqual({ configured: false });
  });
});
