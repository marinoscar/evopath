// =============================================================================
// Integration: /api/gyms, /api/equipment-types, /api/capabilities (E3.3)
// =============================================================================
//
// The HTTP contract through the real guards, pipes, interceptor and exception
// filter, over a mocked Prisma: 401 without a token and 403 without the exact
// permission on every route; photo attach/remove also need `storage:write`
// (a viewer lacks it); every seeded role can manage gyms and equipment; the
// `{ data }` envelope; 400 with `details.issues` naming each field; and
// owner-scoping (every lookup filters by the caller, so a foreign id is a
// 404). Real-row behaviour (the default gym, cascades, search over the seeded
// catalog) is proven in `gyms-api.db.spec.ts`.
// =============================================================================

import request from 'supertest';

import { closeTestApp, createTestApp, TestContext } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  authHeader,
  createMockAdminUser,
  createMockContributorUser,
  createMockViewerUser,
} from '../helpers/auth-mock.helper';

const GYM = '11111111-1111-4111-8111-111111111111';
const EQUIPMENT = '22222222-2222-4222-8222-222222222222';
const PHOTO = '33333333-3333-4333-8333-333333333333';
const TYPE = '44444444-4444-4444-8444-444444444444';
const OBJECT = '55555555-5555-4555-8555-555555555555';
const CAPABILITY = '66666666-6666-4666-8666-666666666666';

const NOW = new Date('2026-09-29T10:00:00.000Z');

function gymRow(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: GYM,
    userId,
    name: 'Home Gym',
    type: 'home',
    description: null,
    notes: null,
    latitude: null,
    longitude: null,
    isDefault: true,
    isTemporary: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function typeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TYPE,
    slug: 'elliptical',
    name: 'Elliptical',
    category: 'cardio',
    aliases: ['cross trainer'],
    description: null,
    sortOrder: 300,
    ownerUserId: null,
    createdAt: NOW,
    capabilities: [
      { equipmentTypeId: TYPE, capabilityId: CAPABILITY, capability: { id: CAPABILITY, slug: 'steady_state_cardio', name: 'Steady-state cardio', sortOrder: 1 } },
    ],
    ...overrides,
  };
}

function equipmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: EQUIPMENT,
    gymId: GYM,
    equipmentTypeId: TYPE,
    quantity: 2,
    brand: 'Precor',
    model: null,
    notes: null,
    origin: 'manual',
    confidence: null,
    userVerified: true,
    originalAiValue: null,
    createdAt: NOW,
    updatedAt: NOW,
    equipmentType: typeRow(),
    ...overrides,
  };
}

function photoRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PHOTO,
    gymId: GYM,
    storageObjectId: OBJECT,
    caption: null,
    takenAt: null,
    createdAt: NOW,
    equipment: [],
    ...overrides,
  };
}

/** Removes one permission from one mocked user's roles (see check-ins.integration.spec.ts). */
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

describe('Gyms (integration)', () => {
  let context: TestContext;
  let prisma: any;

  const server = () => context.app.getHttpServer();

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    prisma = context.prismaMock;
    prisma.$transaction.mockImplementation(async (arg: any) =>
      typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
    );
  });

  // ---------------------------------------------------------------------------
  // Access control, per route
  // ---------------------------------------------------------------------------

  const ROUTES: Array<{
    method: 'get' | 'post' | 'patch' | 'delete';
    path: string;
    permission: string;
    body?: unknown;
  }> = [
    { method: 'get', path: '/api/gyms', permission: 'gyms:read' },
    { method: 'post', path: '/api/gyms', permission: 'gyms:write', body: { name: 'G', type: 'home' } },
    { method: 'get', path: `/api/gyms/${GYM}`, permission: 'gyms:read' },
    { method: 'patch', path: `/api/gyms/${GYM}`, permission: 'gyms:write', body: { name: 'G' } },
    { method: 'delete', path: `/api/gyms/${GYM}`, permission: 'gyms:write' },
    { method: 'post', path: `/api/gyms/${GYM}/default`, permission: 'gyms:write' },
    { method: 'get', path: `/api/gyms/${GYM}/equipment`, permission: 'gyms:read' },
    { method: 'post', path: `/api/gyms/${GYM}/equipment`, permission: 'gyms:write', body: { equipmentTypeId: TYPE } },
    { method: 'patch', path: `/api/gyms/${GYM}/equipment/${EQUIPMENT}`, permission: 'gyms:write', body: { quantity: 3 } },
    { method: 'delete', path: `/api/gyms/${GYM}/equipment/${EQUIPMENT}`, permission: 'gyms:write' },
    { method: 'get', path: `/api/gyms/${GYM}/photos`, permission: 'gyms:read' },
    { method: 'post', path: `/api/gyms/${GYM}/photos`, permission: 'gyms:write', body: { storageObjectId: OBJECT } },
    { method: 'post', path: `/api/gyms/${GYM}/photos`, permission: 'storage:write', body: { storageObjectId: OBJECT } },
    { method: 'patch', path: `/api/gyms/${GYM}/photos/${PHOTO}`, permission: 'gyms:write', body: { caption: 'x' } },
    { method: 'delete', path: `/api/gyms/${GYM}/photos/${PHOTO}`, permission: 'gyms:write' },
    { method: 'delete', path: `/api/gyms/${GYM}/photos/${PHOTO}`, permission: 'storage:write' },
    { method: 'get', path: '/api/equipment-types', permission: 'gyms:read' },
    { method: 'post', path: '/api/equipment-types', permission: 'gyms:write', body: { name: 'Sled', category: 'accessories' } },
    { method: 'patch', path: `/api/equipment-types/${TYPE}`, permission: 'gyms:write', body: { name: 'Sled' } },
    { method: 'delete', path: `/api/equipment-types/${TYPE}`, permission: 'gyms:write' },
    { method: 'get', path: '/api/capabilities', permission: 'gyms:read' },
  ];

  describe.each(ROUTES)('$method $path ($permission)', ({ method, path, permission, body }) => {
    it('returns 401 without a token', async () => {
      await request(server())[method](path).send(body as object).expect(401);
    });

    it(`returns 403 without ${permission}, touching no gym data`, async () => {
      const user = await createMockContributorUser(context);
      stripPermission(prisma, user.id, permission);

      const response = await request(server())
        [method](path)
        .set(authHeader(user.accessToken))
        .send(body as object)
        .expect(403);

      expect(response.body.code).toBe('FORBIDDEN');
      expect(prisma.gym.findFirst).not.toHaveBeenCalled();
      expect(prisma.gym.findMany).not.toHaveBeenCalled();
      expect(prisma.gym.create).not.toHaveBeenCalled();
      expect(prisma.equipmentType.findMany).not.toHaveBeenCalled();
      expect(prisma.equipmentType.create).not.toHaveBeenCalled();
      expect(prisma.capability.findMany).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['admin', createMockAdminUser],
    ['contributor', createMockContributorUser],
    ['viewer', createMockViewerUser],
  ])('admits the seeded %s role to manage gyms and equipment', async (_role, create) => {
    const user = await create(context);
    prisma.gym.count.mockResolvedValue(0);
    prisma.gym.create.mockImplementation(async ({ data }: any) => gymRow(user.id, data));
    prisma.gym.findFirst.mockResolvedValue(gymRow(user.id));
    prisma.equipmentType.findFirst.mockResolvedValue({ id: TYPE });
    prisma.gymEquipment.create.mockResolvedValue(equipmentRow());

    await request(server()).post('/api/gyms').set(authHeader(user.accessToken)).send({ name: 'G', type: 'home' }).expect(201);
    await request(server())
      .post(`/api/gyms/${GYM}/equipment`)
      .set(authHeader(user.accessToken))
      .send({ equipmentTypeId: TYPE })
      .expect(201);
  });

  it('refuses a viewer photo attach with 403 (no storage:write) before reading anything', async () => {
    const viewer = await createMockViewerUser(context);

    await request(server())
      .post(`/api/gyms/${GYM}/photos`)
      .set(authHeader(viewer.accessToken))
      .send({ storageObjectId: OBJECT })
      .expect(403);

    expect(prisma.gym.findFirst).not.toHaveBeenCalled();
    expect(prisma.storageObject.findFirst).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Envelope and shapes
  // ---------------------------------------------------------------------------

  describe('shapes', () => {
    it('GET /api/gyms lists summaries with counts and cover photo', async () => {
      const user = await createMockContributorUser(context);
      prisma.gym.findMany.mockResolvedValue([
        { ...gymRow(user.id), _count: { equipment: 3, photos: 2 }, photos: [{ id: PHOTO, storageObjectId: OBJECT }] },
      ]);

      const response = await request(server()).get('/api/gyms').set(authHeader(user.accessToken)).expect(200);

      expect(response.body.meta.timestamp).toBeDefined();
      expect(response.body.data).toEqual([
        expect.objectContaining({
          id: GYM,
          name: 'Home Gym',
          type: 'home',
          isDefault: true,
          equipmentCount: 3,
          photoCount: 2,
          coverPhotoId: PHOTO,
          coverStorageObjectId: OBJECT,
          createdAt: NOW.toISOString(),
        }),
      ]);
      expect(prisma.gym.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: user.id },
          orderBy: [{ isDefault: 'desc' }, { name: 'asc' }, { createdAt: 'asc' }],
        }),
      );
    });

    it('GET /api/gyms?includeTemporary=false filters temporary gyms', async () => {
      const user = await createMockContributorUser(context);
      prisma.gym.findMany.mockResolvedValue([]);

      await request(server()).get('/api/gyms?includeTemporary=false').set(authHeader(user.accessToken)).expect(200);

      expect(prisma.gym.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: user.id, isTemporary: false } }),
      );
    });

    it('GET /api/gyms/:id returns equipment with its type and photos with links', async () => {
      const user = await createMockContributorUser(context);
      prisma.gym.findFirst.mockResolvedValue({
        ...gymRow(user.id),
        equipment: [equipmentRow()],
        photos: [photoRow({ equipment: [{ gymEquipmentId: EQUIPMENT }] })],
      });

      const response = await request(server()).get(`/api/gyms/${GYM}`).set(authHeader(user.accessToken)).expect(200);

      expect(response.body.data.equipment).toEqual([
        expect.objectContaining({
          id: EQUIPMENT,
          quantity: 2,
          brand: 'Precor',
          origin: 'manual',
          userVerified: true,
          equipmentType: {
            id: TYPE,
            slug: 'elliptical',
            name: 'Elliptical',
            category: 'cardio',
            isCustom: false,
            capabilities: [{ id: CAPABILITY, slug: 'steady_state_cardio', name: 'Steady-state cardio' }],
          },
        }),
      ]);
      expect(response.body.data.photos).toEqual([
        { id: PHOTO, gymId: GYM, storageObjectId: OBJECT, caption: null, takenAt: null, equipmentIds: [EQUIPMENT], createdAt: NOW.toISOString() },
      ]);
    });

    it('POST /api/gyms makes the first gym the default and returns 201 with a detail', async () => {
      const user = await createMockContributorUser(context);
      prisma.gym.count.mockResolvedValue(0);
      prisma.gym.create.mockImplementation(async ({ data }: any) => gymRow(user.id, data));

      const response = await request(server())
        .post('/api/gyms')
        .set(authHeader(user.accessToken))
        .send({ name: '  Home Gym ', type: 'home', description: '' })
        .expect(201);

      expect(prisma.gym.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ userId: user.id, name: 'Home Gym', description: null, isDefault: true }),
      });
      expect(response.body.data).toEqual(expect.objectContaining({ name: 'Home Gym', isDefault: true, equipment: [], photos: [] }));
    });

    it('POST /api/gyms refuses a 51st gym with GYM_LIMIT', async () => {
      const user = await createMockContributorUser(context);
      prisma.gym.count.mockResolvedValue(50);

      const response = await request(server())
        .post('/api/gyms')
        .set(authHeader(user.accessToken))
        .send({ name: 'G', type: 'home' })
        .expect(400);

      expect(response.body.details.reason).toBe('GYM_LIMIT');
      expect(prisma.gym.create).not.toHaveBeenCalled();
    });

    it('GET /api/equipment-types?q=cross matches Elliptical by alias', async () => {
      const user = await createMockContributorUser(context);
      prisma.equipmentType.findMany.mockResolvedValue([
        typeRow(),
        typeRow({ id: CAPABILITY, slug: 'treadmill', name: 'Treadmill', aliases: [] }),
      ]);

      const response = await request(server())
        .get('/api/equipment-types?q=CROSS')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.map((t: any) => t.name)).toEqual(['Elliptical']);
      expect(prisma.equipmentType.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { OR: [{ ownerUserId: null }, { ownerUserId: user.id }] } }),
      );
    });

    it('DELETE /api/equipment-types/:id is 409 EQUIPMENT_TYPE_IN_USE while used, 204 otherwise', async () => {
      const user = await createMockContributorUser(context);
      prisma.equipmentType.findFirst.mockResolvedValue(typeRow({ ownerUserId: user.id }));
      prisma.gymEquipment.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
      prisma.equipmentType.deleteMany.mockResolvedValue({ count: 1 });

      const conflict = await request(server())
        .delete(`/api/equipment-types/${TYPE}`)
        .set(authHeader(user.accessToken))
        .expect(409);
      expect(conflict.body.details.reason).toBe('EQUIPMENT_TYPE_IN_USE');

      await request(server()).delete(`/api/equipment-types/${TYPE}`).set(authHeader(user.accessToken)).expect(204);
    });

    it('GET /api/capabilities lists capabilities', async () => {
      const user = await createMockViewerUser(context);
      prisma.capability.findMany.mockResolvedValue([
        { id: CAPABILITY, slug: 'back_squat', name: 'Back squat', movementPattern: 'squat', primaryMuscles: ['quads'], description: null, sortOrder: 10 },
      ]);

      const response = await request(server()).get('/api/capabilities').set(authHeader(user.accessToken)).expect(200);

      expect(response.body.data).toEqual([
        { id: CAPABILITY, slug: 'back_squat', name: 'Back squat', movementPattern: 'squat', primaryMuscles: ['quads'], description: null },
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // Validation: 400 with field errors
  // ---------------------------------------------------------------------------

  describe('validation', () => {
    const issuePaths = (body: any): string[] => (body.details?.issues ?? []).map((issue: any) => issue.path);

    it.each([
      ['quantity 0', { equipmentTypeId: TYPE, quantity: 0 }, 'quantity'],
      ['quantity 100', { equipmentTypeId: TYPE, quantity: 100 }, 'quantity'],
      ['a fractional quantity', { equipmentTypeId: TYPE, quantity: 1.5 }, 'quantity'],
      ['a brand of 61 characters', { equipmentTypeId: TYPE, brand: 'b'.repeat(61) }, 'brand'],
      ['a server-owned field', { equipmentTypeId: TYPE, origin: 'ai' }, ''],
    ])('POST equipment with %s is 400', async (_label, body, path) => {
      const user = await createMockContributorUser(context);

      const response = await request(server())
        .post(`/api/gyms/${GYM}/equipment`)
        .set(authHeader(user.accessToken))
        .send(body)
        .expect(400);

      if (path) expect(issuePaths(response.body)).toContain(path);
      expect(prisma.gymEquipment.create).not.toHaveBeenCalled();
    });

    it.each([
      ['a name of 81 characters', { name: 'n'.repeat(81), type: 'home' }, 'name'],
      ['an empty name', { name: '   ', type: 'home' }, 'name'],
      ['a type outside the enum', { name: 'G', type: 'castle' }, 'type'],
      ['no type', { name: 'G' }, 'type'],
      ['latitude without longitude', { name: 'G', type: 'home', latitude: 10 }, 'longitude'],
      ['latitude out of range', { name: 'G', type: 'home', latitude: 91, longitude: 0 }, 'latitude'],
      ['isDefault (not writable)', { name: 'G', type: 'home', isDefault: true }, ''],
    ])('POST /api/gyms with %s is 400', async (_label, body, path) => {
      const user = await createMockContributorUser(context);

      const response = await request(server()).post('/api/gyms').set(authHeader(user.accessToken)).send(body).expect(400);

      expect(response.body.code).toBe('BAD_REQUEST');
      if (path) expect(issuePaths(response.body)).toContain(path);
      expect(prisma.gym.create).not.toHaveBeenCalled();
    });

    it.each([
      ['latitude without longitude', { latitude: 10 }, 'longitude'],
      ['longitude without latitude', { longitude: 10 }, 'latitude'],
      ['one coordinate null, one set', { latitude: null, longitude: 10 }, 'latitude'],
      ['longitude out of range', { latitude: 0, longitude: 181 }, 'longitude'],
    ])('PATCH /api/gyms/:id with %s is 400', async (_label, body, path) => {
      const user = await createMockContributorUser(context);

      const response = await request(server())
        .patch(`/api/gyms/${GYM}`)
        .set(authHeader(user.accessToken))
        .send(body)
        .expect(400);

      expect(issuePaths(response.body)).toContain(path);
    });

    it('PATCH /api/gyms/:id accepts both coordinates', async () => {
      const user = await createMockContributorUser(context);
      prisma.gym.findFirst.mockResolvedValue({ ...gymRow(user.id), equipment: [], photos: [] });
      prisma.gym.updateMany.mockResolvedValue({ count: 1 });

      await request(server())
        .patch(`/api/gyms/${GYM}`)
        .set(authHeader(user.accessToken))
        .send({ latitude: 9.93, longitude: -84.08 })
        .expect(200);

      expect(prisma.gym.updateMany).toHaveBeenCalledWith({
        where: { id: GYM, userId: user.id },
        data: { latitude: 9.93, longitude: -84.08 },
      });
    });

    it('POST /api/equipment-types refuses more than 12 capabilities and a name of 81', async () => {
      const user = await createMockContributorUser(context);
      const ids = Array.from({ length: 13 }, (_, i) => `66666666-6666-4666-8666-${String(i).padStart(12, '0')}`);

      const response = await request(server())
        .post('/api/equipment-types')
        .set(authHeader(user.accessToken))
        .send({ name: 'n'.repeat(81), category: 'accessories', capabilityIds: ids })
        .expect(400);

      expect(issuePaths(response.body)).toEqual(expect.arrayContaining(['name', 'capabilityIds']));
    });

    it('GET /api/equipment-types refuses limit 201 and an unknown category', async () => {
      const user = await createMockContributorUser(context);

      await request(server()).get('/api/equipment-types?limit=201').set(authHeader(user.accessToken)).expect(400);
      await request(server()).get('/api/equipment-types?category=spaceship').set(authHeader(user.accessToken)).expect(400);
    });

    it('a non-UUID id is 400', async () => {
      const user = await createMockContributorUser(context);

      await request(server()).get('/api/gyms/not-a-uuid').set(authHeader(user.accessToken)).expect(400);
    });
  });

  // ---------------------------------------------------------------------------
  // Owner scoping: a foreign id is a 404 on every route
  // ---------------------------------------------------------------------------

  describe('owner scoping', () => {
    const FOREIGN_GYM_ROUTES: Array<{ method: 'get' | 'post' | 'patch' | 'delete'; path: string; body?: unknown }> = [
      { method: 'get', path: `/api/gyms/${GYM}` },
      { method: 'patch', path: `/api/gyms/${GYM}`, body: { name: 'Mine now' } },
      { method: 'delete', path: `/api/gyms/${GYM}` },
      { method: 'post', path: `/api/gyms/${GYM}/default` },
      { method: 'get', path: `/api/gyms/${GYM}/equipment` },
      { method: 'post', path: `/api/gyms/${GYM}/equipment`, body: { equipmentTypeId: TYPE } },
      { method: 'patch', path: `/api/gyms/${GYM}/equipment/${EQUIPMENT}`, body: { quantity: 3 } },
      { method: 'delete', path: `/api/gyms/${GYM}/equipment/${EQUIPMENT}` },
      { method: 'get', path: `/api/gyms/${GYM}/photos` },
      { method: 'post', path: `/api/gyms/${GYM}/photos`, body: { storageObjectId: OBJECT } },
      { method: 'patch', path: `/api/gyms/${GYM}/photos/${PHOTO}`, body: { caption: 'x' } },
      { method: 'delete', path: `/api/gyms/${GYM}/photos/${PHOTO}` },
    ];

    it.each(FOREIGN_GYM_ROUTES)('$method $path is 404 for a gym the caller does not own', async ({ method, path, body }) => {
      const user = await createMockContributorUser(context);
      // The owner-scoped lookup finds nothing: the row exists, but not for this user.
      prisma.gym.findFirst.mockImplementation(async ({ where }: any) =>
        where.userId === user.id ? null : gymRow('someone-else'),
      );

      const response = await request(server())
        [method](path)
        .set(authHeader(user.accessToken))
        .send(body as object)
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
      expect(prisma.gym.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: GYM, userId: user.id }) }),
      );
      expect(prisma.gym.updateMany).not.toHaveBeenCalled();
      expect(prisma.gym.deleteMany).not.toHaveBeenCalled();
      expect(prisma.gymEquipment.create).not.toHaveBeenCalled();
      expect(prisma.gymPhoto.create).not.toHaveBeenCalled();
    });

    it('equipment of another gym is 404', async () => {
      const user = await createMockContributorUser(context);
      prisma.gym.findFirst.mockResolvedValue(gymRow(user.id));
      prisma.gymEquipment.findFirst.mockResolvedValue(null);
      prisma.gymEquipment.deleteMany.mockResolvedValue({ count: 0 });

      await request(server())
        .patch(`/api/gyms/${GYM}/equipment/${EQUIPMENT}`)
        .set(authHeader(user.accessToken))
        .send({ quantity: 3 })
        .expect(404);
      await request(server()).delete(`/api/gyms/${GYM}/equipment/${EQUIPMENT}`).set(authHeader(user.accessToken)).expect(404);

      expect(prisma.gymEquipment.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: EQUIPMENT, gymId: GYM } }),
      );
    });

    it('a photo of another gym is 404', async () => {
      const user = await createMockContributorUser(context);
      prisma.gym.findFirst.mockResolvedValue(gymRow(user.id));
      prisma.gymPhoto.findFirst.mockResolvedValue(null);

      await request(server()).delete(`/api/gyms/${GYM}/photos/${PHOTO}`).set(authHeader(user.accessToken)).expect(404);
      expect(prisma.gymPhoto.deleteMany).not.toHaveBeenCalled();
    });

    it("another user's custom equipment type is 404 when added to my gym", async () => {
      const user = await createMockContributorUser(context);
      prisma.gym.findFirst.mockResolvedValue(gymRow(user.id));
      prisma.equipmentType.findFirst.mockResolvedValue(null);

      await request(server())
        .post(`/api/gyms/${GYM}/equipment`)
        .set(authHeader(user.accessToken))
        .send({ equipmentTypeId: TYPE })
        .expect(404);

      expect(prisma.equipmentType.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: TYPE, OR: [{ ownerUserId: null }, { ownerUserId: user.id }] } }),
      );
      expect(prisma.gymEquipment.create).not.toHaveBeenCalled();
    });

    it("another user's storage object is 404 on photo attach", async () => {
      const user = await createMockContributorUser(context);
      prisma.gym.findFirst.mockResolvedValue(gymRow(user.id));
      prisma.storageObject.findFirst.mockResolvedValue(null);

      const response = await request(server())
        .post(`/api/gyms/${GYM}/photos`)
        .set(authHeader(user.accessToken))
        .send({ storageObjectId: OBJECT })
        .expect(404);

      expect(response.body.details).toEqual({ storageObjectId: OBJECT });
      expect(prisma.storageObject.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: OBJECT, uploadedById: user.id } }),
      );
    });

    it.each([
      ['patch', { name: 'Mine' }],
      ['delete', undefined],
    ] as const)("%s of another user's (or a catalog) equipment type is 404", async (method, body) => {
      const user = await createMockContributorUser(context);
      prisma.equipmentType.findFirst.mockResolvedValue(null);

      await request(server())
        [method](`/api/equipment-types/${TYPE}`)
        .set(authHeader(user.accessToken))
        .send(body as object)
        .expect(404);

      expect(prisma.equipmentType.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: TYPE, ownerUserId: user.id } }),
      );
    });
  });
});
