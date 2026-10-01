// =============================================================================
// Integration: /api/health/documents (H6, #190) — mocked Prisma
// =============================================================================
//
// The HTTP contract through the real guards, pipes, interceptor and exception
// filter: 401 without a token and 403 without the exact `health_data:*`
// permission on every route (the RBAC matrix), the seeded roles admitted, the
// `{ data }` envelope with the flat pagination shape, `ETag`, `If-Match`
// required (400) and stale (412 PRECONDITION_FAILED), 404 for an id the caller
// does not own, `Cache-Control: no-store` on the download link. Real rows, the
// purge job and a real provider: `health-documents-api.db.spec.ts`.
// =============================================================================

import request from 'supertest';

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

const BASE = '/api/health/documents';
const DOC = '77777777-7777-4777-8777-777777777777';
const OBJECT = '55555555-5555-4555-8555-555555555555';

const storage = { getSignedDownloadUrl: jest.fn(async () => 'https://storage.example.test/signed?sig=1') };

function documentRow(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: DOC,
    userId,
    kind: 'body_metric',
    storageObjectId: OBJECT,
    originalName: 'scale.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 1234n,
    retention: 'keep',
    intakeId: null,
    documentDate: null,
    fileDeletedAt: null,
    version: 2,
    createdAt: new Date('2026-09-20T10:00:00.000Z'),
    updatedAt: new Date('2026-09-20T10:00:00.000Z'),
    ...overrides,
  };
}

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

describe('Health documents API (integration)', () => {
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
    storage.getSignedDownloadUrl.mockClear();
    prisma = context.prismaMock;
    prisma.$transaction.mockImplementation(async (arg: any) =>
      typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
    );
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.job.findMany.mockResolvedValue([]);
  });

  /** The caller owns `DOC`; anyone else gets nothing. */
  function ownDocument(userId: string, overrides: Record<string, unknown> = {}) {
    prisma.healthDocument.findFirst.mockImplementation(async ({ where }: any) =>
      where.id === DOC && where.userId === userId ? documentRow(userId, overrides) : null,
    );
    prisma.healthDocument.findMany.mockImplementation(async ({ where }: any) =>
      where.userId === userId ? [documentRow(userId, overrides)] : [],
    );
    prisma.healthDocument.count.mockResolvedValue(1);
    prisma.healthDocument.updateMany.mockImplementation(async ({ where }: any) => ({
      count: where.userId === userId && where.version === 2 ? 1 : 0,
    }));
    prisma.storageObject.findFirst.mockResolvedValue({ storageKey: 'k/scale.jpg', status: 'ready' });
    prisma.job.create.mockResolvedValue({ id: '99999999-9999-4999-8999-999999999999' });
  }

  // ---------------------------------------------------------------------------
  // RBAC matrix
  // ---------------------------------------------------------------------------

  const ROUTES: Array<{
    method: 'get' | 'patch' | 'delete';
    path: string;
    permission: string;
    body?: unknown;
  }> = [
    { method: 'get', path: BASE, permission: 'health_data:read' },
    { method: 'get', path: `${BASE}/${DOC}`, permission: 'health_data:read' },
    { method: 'get', path: `${BASE}/${DOC}/download`, permission: 'health_data:read' },
    { method: 'patch', path: `${BASE}/${DOC}`, permission: 'health_data:write', body: { originalName: 'x.jpg' } },
    { method: 'delete', path: `${BASE}/${DOC}`, permission: 'health_data:write' },
  ];

  describe.each(ROUTES)('$method $path', ({ method, path, permission, body }) => {
    it('returns 401 without a token', async () => {
      await request(server())[method](path).set('If-Match', '2').send(body as object).expect(401);
    });

    it(`returns 403 without ${permission}, touching no document`, async () => {
      const viewer = await createMockViewerUser(context);
      stripPermission(prisma, viewer.id, permission);

      const response = await request(server())
        [method](path)
        .set(authHeader(viewer.accessToken))
        .set('If-Match', '2')
        .send(body as object)
        .expect(403);

      expect(response.body.code).toBe('FORBIDDEN');
      expect(prisma.healthDocument.findMany).not.toHaveBeenCalled();
      expect(prisma.healthDocument.findFirst).not.toHaveBeenCalled();
      expect(prisma.healthDocument.updateMany).not.toHaveBeenCalled();
      expect(storage.getSignedDownloadUrl).not.toHaveBeenCalled();
    });

    it("returns 404 for another user's document id", async () => {
      if (path === BASE) return; // the list has no id: it is simply empty (below)
      const owner = await createMockContributorUser(context);
      ownDocument(owner.id);
      const other = await createMockAdminUser(context);

      const response = await request(server())
        [method](path)
        .set(authHeader(other.accessToken))
        .set('If-Match', '2')
        .send(body as object)
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
      expect(storage.getSignedDownloadUrl).not.toHaveBeenCalled();
      expect(prisma.job.create).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['admin', createMockAdminUser],
    ['contributor', createMockContributorUser],
    ['viewer', createMockViewerUser],
  ])('admits the seeded %s role to the list', async (_role, create) => {
    const user = await create(context);
    ownDocument(user.id);
    await request(server()).get(BASE).set(authHeader(user.accessToken)).expect(200);
  });

  // ---------------------------------------------------------------------------
  // Shapes
  // ---------------------------------------------------------------------------

  it('lists only the caller\'s documents in the flat pagination shape, sizeBytes as a string', async () => {
    const user = await createMockViewerUser(context);
    ownDocument(user.id);

    const response = await request(server()).get(`${BASE}?kind=body_metric`).set(authHeader(user.accessToken)).expect(200);

    expect(prisma.healthDocument.findMany.mock.calls[0][0].where).toEqual({ userId: user.id, kind: 'body_metric' });
    expect(response.body.data).toEqual({
      items: [
        expect.objectContaining({ id: DOC, sizeBytes: '1234', valueCount: 0, fileAvailable: true, version: 2 }),
      ],
      total: 1,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    });
  });

  it('refuses an unknown kind with the field named', async () => {
    const user = await createMockViewerUser(context);

    const response = await request(server()).get(`${BASE}?kind=xray`).set(authHeader(user.accessToken)).expect(400);

    expect(response.body.details.issues[0].path).toBe('kind');
  });

  it('GET :id sends the ETag', async () => {
    const user = await createMockViewerUser(context);
    ownDocument(user.id);

    const response = await request(server()).get(`${BASE}/${DOC}`).set(authHeader(user.accessToken)).expect(200);

    expect(response.headers.etag).toBe('"2"');
    expect(response.body.data.version).toBe(2);
  });

  it('download returns a short-lived link and is never cached', async () => {
    const user = await createMockViewerUser(context);
    ownDocument(user.id);

    const response = await request(server())
      .get(`${BASE}/${DOC}/download?disposition=attachment`)
      .set(authHeader(user.accessToken))
      .expect(200);

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.data).toMatchObject({ expiresIn: 300, disposition: 'attachment', fileName: 'scale.jpg' });
    expect(storage.getSignedDownloadUrl).toHaveBeenCalledWith('k/scale.jpg', {
      expiresIn: 300,
      responseContentDisposition: `attachment; filename="scale.jpg"; filename*=UTF-8''scale.jpg`,
    });
  });

  it('download of an erased file is a 409 with a reason', async () => {
    const user = await createMockViewerUser(context);
    ownDocument(user.id, { storageObjectId: null, fileDeletedAt: new Date() });

    const response = await request(server())
      .get(`${BASE}/${DOC}/download`)
      .set(authHeader(user.accessToken))
      .expect(409);

    expect(response.body.details.reason).toBe('HEALTH_DOCUMENT_FILE_DELETED');
  });

  it.each([
    ['patch', { originalName: 'x.jpg' }],
    ['delete', undefined],
  ] as const)('%s without If-Match is a 400 IF_MATCH_REQUIRED', async (method, body) => {
    const user = await createMockContributorUser(context);
    ownDocument(user.id);

    const response = await request(server())[method](`${BASE}/${DOC}`).set(authHeader(user.accessToken)).send(body).expect(400);

    expect(response.body.details.reason).toBe('IF_MATCH_REQUIRED');
    expect(prisma.healthDocument.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['patch', { originalName: 'x.jpg' }],
    ['delete', undefined],
  ] as const)('%s with a stale If-Match is a 412 PRECONDITION_FAILED', async (method, body) => {
    const user = await createMockContributorUser(context);
    ownDocument(user.id);

    const response = await request(server())
      [method](`${BASE}/${DOC}`)
      .set(authHeader(user.accessToken))
      .set('If-Match', '"1"')
      .send(body)
      .expect(412);

    expect(response.body.code).toBe('PRECONDITION_FAILED');
    expect(response.body.details).toEqual({ reason: 'HEALTH_DOCUMENT_STALE', currentVersion: 2 });
    expect(prisma.job.create).not.toHaveBeenCalled();
  });

  it('PATCH renames with the ETag of the new version', async () => {
    const user = await createMockContributorUser(context);
    ownDocument(user.id);

    await request(server())
      .patch(`${BASE}/${DOC}`)
      .set(authHeader(user.accessToken))
      .set('If-Match', '2')
      .send({ originalName: ' My‮scale.jpg ', documentDate: '2026-09-15' })
      .expect(200);

    expect(prisma.healthDocument.updateMany.mock.calls[0][0]).toEqual({
      where: { id: DOC, userId: user.id, version: 2 },
      data: { version: { increment: 1 }, originalName: 'Myscale.jpg', documentDate: new Date('2026-09-15T00:00:00.000Z') },
    });
  });

  it('DELETE queues the user_delete purge and answers what it did', async () => {
    const user = await createMockContributorUser(context);
    ownDocument(user.id);

    const response = await request(server())
      .delete(`${BASE}/${DOC}?deleteValues=false`)
      .set(authHeader(user.accessToken))
      .set('If-Match', '2')
      .expect(200);

    expect(response.body.data).toEqual({
      id: DOC,
      scope: 'file',
      jobId: '99999999-9999-4999-8999-999999999999',
      valuesDeleted: 0,
    });
    expect(prisma.job.create.mock.calls[0][0].data).toMatchObject({
      type: 'health.document.purge',
      subjectId: DOC,
      payload: { healthDocumentId: DOC, reason: 'user_delete' },
    });
  });
});
