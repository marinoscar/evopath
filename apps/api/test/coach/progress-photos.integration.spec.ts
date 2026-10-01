// =============================================================================
// Integration: /api/progress-photos (E7.9, #249) — mocked Prisma
// =============================================================================
//
// The HTTP contract through the real guards, pipes, interceptor and exception
// filter: 401 without a token and 403 without the exact `health_data:*`
// permission (the RBAC matrix), the seeded roles admitted, the `{ data }`
// envelope, ownership of the storage object (403 and no row), the magic-byte
// check (400 `PROGRESS_PHOTO_NOT_IMAGE` whatever the declared type), delete
// (204, the object deleted, then 404) and no `AiEnabledGuard` on any route.
// =============================================================================

import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Readable } from 'node:stream';
import request from 'supertest';

import { AiEnabledGuard } from '../../src/ai/config/ai-enabled.guard';
import { ProgressPhotosController } from '../../src/progress-photos/progress-photos.controller';
import { STORAGE_PROVIDER } from '../../src/storage/providers/storage-provider.interface';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  authHeader,
  createMockAdminUser,
  createMockContributorUser,
  createMockViewerUser,
} from '../helpers/auth-mock.helper';
import { closeTestApp, createTestApp, TestContext } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';

const BASE = '/api/progress-photos';
const PHOTO = '77777777-7777-4777-8777-777777777777';
const OBJECT = '55555555-5555-4555-8555-555555555555';
const OTHER_USER = '99999999-9999-4999-8999-999999999999';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const HTML = Buffer.from('<html><script>alert(1)</script></html>');

const storage = {
  download: jest.fn(async () => Readable.from([JPEG])),
  delete: jest.fn(async () => undefined),
  getSignedDownloadUrl: jest.fn(async () => 'https://storage.example.test/signed?sig=1'),
};

/** See the helper of the same name in `health-profile.integration.spec.ts`. */
function stripPermission(prisma: any, userId: string, permission: string): void {
  const previous = prisma.user.findUnique.getMockImplementation();

  prisma.user.findUnique.mockImplementation(async (args: any) => {
    const user = await previous(args);
    if (!user || user.id !== userId) return user;
    return {
      ...user,
      userRoles: (user.userRoles ?? []).map((userRole: any) => ({
        ...userRole,
        role: {
          ...userRole.role,
          rolePermissions: (userRole.role.rolePermissions ?? []).filter(
            (rp: any) => rp.permission.name !== permission,
          ),
        },
      })),
    };
  });
}

function objectRow(ownerId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: OBJECT,
    uploadedById: ownerId,
    status: 'ready',
    mimeType: 'image/jpeg',
    size: BigInt(4096),
    storageKey: `uploads/${ownerId}/photo.jpg`,
    name: 'photo.jpg',
    ...overrides,
  };
}

function photoRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PHOTO,
    storageObjectId: OBJECT,
    localDate: new Date('2026-09-28T00:00:00.000Z'),
    pose: 'front',
    note: 'Fasted',
    createdAt: new Date('2026-09-28T07:00:00.000Z'),
    ...overrides,
  };
}

const CREATE_BODY = { storageObjectId: OBJECT, localDate: '2026-09-28', pose: 'front', note: 'Fasted' };

describe('Progress photos API (integration)', () => {
  let context: TestContext;
  let prisma: any;

  const server = () => context.app.getHttpServer();

  beforeAll(async () => {
    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [{ provide: STORAGE_PROVIDER, useValue: storage }],
    });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    storage.download.mockClear().mockImplementation(async () => Readable.from([JPEG]));
    storage.delete.mockClear();
    prisma = context.prismaMock;
    prisma.$transaction.mockImplementation(async (arg: any) =>
      typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
    );
    prisma.progressPhoto.count.mockResolvedValue(0);
    prisma.progressPhoto.findMany.mockResolvedValue([]);
    prisma.progressPhoto.create.mockImplementation(async ({ data }: any) =>
      photoRow({ localDate: data.localDate, pose: data.pose, note: data.note }),
    );
    prisma.photoIntakePhoto.count.mockResolvedValue(0);
    prisma.gymPhoto.count.mockResolvedValue(0);
    prisma.workoutPhoto.count.mockResolvedValue(0);
    prisma.healthDocument.count.mockResolvedValue(0);
  });

  /** The caller owns `PHOTO` and `OBJECT`; anyone else sees nothing. */
  function ownPhoto(userId: string) {
    prisma.progressPhoto.findFirst.mockImplementation(async ({ where }: any) =>
      where.id === PHOTO && where.userId === userId ? photoRow() : null,
    );
    prisma.progressPhoto.deleteMany.mockImplementation(async ({ where }: any) => ({
      count: where.id === PHOTO && where.userId === userId ? 1 : 0,
    }));
    prisma.storageObject.findUnique.mockResolvedValue(objectRow(userId));
    prisma.storageObject.findFirst.mockResolvedValue(objectRow(userId));
    prisma.storageObject.delete.mockResolvedValue(objectRow(userId));
  }

  // ---------------------------------------------------------------------------
  // RBAC matrix
  // ---------------------------------------------------------------------------

  const ROUTES: Array<{ method: 'get' | 'post' | 'delete'; path: string; permission: string; body?: unknown }> = [
    { method: 'get', path: BASE, permission: 'health_data:read' },
    { method: 'post', path: BASE, permission: 'health_data:write', body: CREATE_BODY },
    { method: 'delete', path: `${BASE}/${PHOTO}`, permission: 'health_data:write' },
  ];

  describe.each(ROUTES)('$method $path', ({ method, path, permission, body }) => {
    it('returns 401 without a token', async () => {
      await request(server())[method](path).send(body as object).expect(401);
    });

    it(`returns 403 without ${permission}, touching no photo`, async () => {
      const viewer = await createMockViewerUser(context);
      ownPhoto(viewer.id);
      stripPermission(prisma, viewer.id, permission);

      const response = await request(server())
        [method](path)
        .set(authHeader(viewer.accessToken))
        .send(body as object)
        .expect(403);

      expect(response.body.code).toBe('FORBIDDEN');
      expect(prisma.progressPhoto.findMany).not.toHaveBeenCalled();
      expect(prisma.progressPhoto.create).not.toHaveBeenCalled();
      expect(prisma.progressPhoto.deleteMany).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['admin', createMockAdminUser],
    ['contributor', createMockContributorUser],
    ['viewer', createMockViewerUser],
  ])('admits the seeded %s role to list and add', async (_role, create) => {
    const user = await create(context);
    ownPhoto(user.id);

    await request(server()).get(BASE).set(authHeader(user.accessToken)).expect(200);
    await request(server()).post(BASE).set(authHeader(user.accessToken)).send(CREATE_BODY).expect(201);
  });

  it('is not behind AiEnabledGuard on any route', () => {
    for (const handler of ['list', 'create', 'remove'] as const) {
      const guards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, ProgressPhotosController.prototype[handler]) ?? [];
      expect(guards).not.toContain(AiEnabledGuard);
      expect(guards.length).toBeGreaterThan(0); // @Auth is there, so the scan is not vacuous
    }
  });

  // ---------------------------------------------------------------------------
  // Shapes and rules
  // ---------------------------------------------------------------------------

  it("lists only the caller's photos in the keyset shape", async () => {
    const user = await createMockViewerUser(context);
    prisma.progressPhoto.findMany.mockResolvedValue([photoRow()]);

    const response = await request(server()).get(`${BASE}?pose=front&limit=10`).set(authHeader(user.accessToken)).expect(200);

    expect(prisma.progressPhoto.findMany.mock.calls[0][0].where).toEqual({ userId: user.id, pose: 'front' });
    expect(response.body.data).toEqual({
      items: [
        {
          id: PHOTO,
          storageObjectId: OBJECT,
          localDate: '2026-09-28',
          pose: 'front',
          note: 'Fasted',
          createdAt: '2026-09-28T07:00:00.000Z',
        },
      ],
      nextCursor: null,
    });
  });

  it('refuses an unknown pose filter with the field named', async () => {
    const user = await createMockViewerUser(context);
    const response = await request(server()).get(`${BASE}?pose=selfie`).set(authHeader(user.accessToken)).expect(400);
    expect(response.body.details.issues[0].path).toBe('pose');
  });

  it('adds a photo from the caller\'s own uploaded image (201)', async () => {
    const user = await createMockContributorUser(context);
    ownPhoto(user.id);

    const response = await request(server()).post(BASE).set(authHeader(user.accessToken)).send(CREATE_BODY).expect(201);

    expect(response.body.data).toEqual(expect.objectContaining({ storageObjectId: OBJECT, pose: 'front', localDate: '2026-09-28' }));
    expect(prisma.progressPhoto.create.mock.calls[0][0].data.userId).toBe(user.id);
  });

  it("refuses another user's storage object with 403 PROGRESS_PHOTO_OBJECT_NOT_OWNED and creates no row", async () => {
    const user = await createMockContributorUser(context);
    prisma.storageObject.findUnique.mockResolvedValue(objectRow(OTHER_USER));

    const response = await request(server()).post(BASE).set(authHeader(user.accessToken)).send(CREATE_BODY).expect(403);

    expect(response.body.details.reason).toBe('PROGRESS_PHOTO_OBJECT_NOT_OWNED');
    expect(prisma.progressPhoto.create).not.toHaveBeenCalled();
    expect(storage.download).not.toHaveBeenCalled();
  });

  it('refuses non-image bytes declared as a JPEG with 400 PROGRESS_PHOTO_NOT_IMAGE', async () => {
    const user = await createMockContributorUser(context);
    ownPhoto(user.id);
    storage.download.mockImplementation(async () => Readable.from([HTML]));

    const response = await request(server()).post(BASE).set(authHeader(user.accessToken)).send(CREATE_BODY).expect(400);

    expect(response.body.details.reason).toBe('PROGRESS_PHOTO_NOT_IMAGE');
    expect(JSON.stringify(response.body)).not.toContain('uploads/');
    expect(prisma.progressPhoto.create).not.toHaveBeenCalled();
  });

  it('refuses an oversize image with 413 PROGRESS_PHOTO_TOO_LARGE', async () => {
    const user = await createMockContributorUser(context);
    prisma.storageObject.findUnique.mockResolvedValue(objectRow(user.id, { size: BigInt(50 * 1024 * 1024) }));

    const response = await request(server()).post(BASE).set(authHeader(user.accessToken)).send(CREATE_BODY).expect(413);

    expect(response.body.details.reason).toBe('PROGRESS_PHOTO_TOO_LARGE');
  });

  it.each([
    ['an unknown pose', { ...CREATE_BODY, pose: 'selfie' }, 'pose'],
    ['a malformed date', { ...CREATE_BODY, localDate: '28/09/2026' }, 'localDate'],
    ['a future date', { ...CREATE_BODY, localDate: '2999-01-01' }, 'localDate'],
    ['a note over 200 characters', { ...CREATE_BODY, note: 'x'.repeat(201) }, 'note'],
    ['an unknown field', { ...CREATE_BODY, url: 'https://x' }, ''],
  ])('refuses %s as a validation error', async (_name, body, field) => {
    const user = await createMockContributorUser(context);

    const response = await request(server()).post(BASE).set(authHeader(user.accessToken)).send(body).expect(400);

    if (field) expect(response.body.details.issues.map((issue: any) => issue.path)).toContain(field);
    expect(prisma.progressPhoto.create).not.toHaveBeenCalled();
  });

  it('deletes the photo and its storage object (204), then 404 for the same id', async () => {
    const user = await createMockContributorUser(context);
    ownPhoto(user.id);

    await request(server()).delete(`${BASE}/${PHOTO}`).set(authHeader(user.accessToken)).expect(204);

    expect(prisma.progressPhoto.deleteMany).toHaveBeenCalledWith({ where: { id: PHOTO, userId: user.id } });
    expect(storage.delete).toHaveBeenCalledWith(`uploads/${user.id}/photo.jpg`);
    expect(prisma.storageObject.delete).toHaveBeenCalledWith({ where: { id: OBJECT } });

    prisma.progressPhoto.findFirst.mockResolvedValue(null);
    const response = await request(server()).delete(`${BASE}/${PHOTO}`).set(authHeader(user.accessToken)).expect(404);
    expect(response.body.details.reason).toBe('PROGRESS_PHOTO_NOT_FOUND');
  });

  it("is a 404 for another user's photo, deleting nothing", async () => {
    const owner = await createMockContributorUser(context);
    ownPhoto(owner.id);
    const other = await createMockAdminUser(context);

    await request(server()).delete(`${BASE}/${PHOTO}`).set(authHeader(other.accessToken)).expect(404);

    expect(prisma.progressPhoto.deleteMany).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });
});
