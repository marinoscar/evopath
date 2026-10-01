// =============================================================================
// Integration: /api/measurements (E2.2, #50) — mocked Prisma
// =============================================================================
//
// The HTTP contract end to end through the real guards, pipes, interceptor and
// exception filter: 401 without a token, 403 without the exact `health_data:*`
// permission, the `{ data }` envelope, 201/200/204, 400 with the failing field
// named under `details.issues`, 404 on an entry the caller does not own, 409 on
// a lost concurrent edit, and route ordering (`/latest`, `/series`,
// `/metrics` are never captured by a parameterised route). Prisma is mocked;
// revisions, the unique `supersedes_id` and a real concurrent edit are proven
// in `measurements.db.spec.ts`.
// =============================================================================

import { randomUUID } from 'node:crypto';

import request from 'supertest';

import { closeTestApp, createTestApp, TestContext } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { LAB_METRIC_KEYS } from '../../src/measurements/metric-registry';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  authHeader,
  createMockAdminUser,
  createMockContributorUser,
  createMockViewerUser,
} from '../helpers/auth-mock.helper';

const BASE = '/api/measurements';
const SUMMARY = '/api/health/biomarkers/summary';
const ENTRY_ID = '33333333-3333-4333-8333-333333333333';
const ACTIVE_PREDICATE = { supersededAt: null, deletedAt: null };

function storedRow(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    userId,
    entryId: ENTRY_ID,
    metricKey: 'weight',
    value: 80,
    unit: 'kg',
    measuredAt: new Date('2026-09-28T07:00:00.000Z'),
    localDate: null,
    method: 'unspecified',
    origin: 'manual',
    notes: null,
    referenceLow: null,
    referenceHigh: null,
    referenceText: null,
    flag: null,
    sourceRef: null,
    revision: 1,
    supersedesId: null,
    supersededAt: null,
    deletedAt: null,
    createdAt: new Date('2026-09-28T07:00:01.000Z'),
    updatedAt: new Date('2026-09-28T07:00:01.000Z'),
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

describe('Measurements (integration)', () => {
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
    prisma.measurement.create.mockImplementation(async ({ data }: any) =>
      storedRow(data.userId, { ...data, sourceRef: null }),
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
    { method: 'get', path: `${BASE}/metrics`, permission: 'health_data:read' },
    { method: 'get', path: `${BASE}/latest`, permission: 'health_data:read' },
    { method: 'get', path: `${BASE}/series?metricKey=weight`, permission: 'health_data:read' },
    { method: 'get', path: BASE, permission: 'health_data:read' },
    {
      method: 'post',
      path: BASE,
      permission: 'health_data:write',
      body: { readings: [{ metricKey: 'weight', value: 80 }] },
    },
    {
      method: 'patch',
      path: `${BASE}/entries/${ENTRY_ID}`,
      permission: 'health_data:write',
      body: { notes: null },
    },
    { method: 'delete', path: `${BASE}/entries/${ENTRY_ID}`, permission: 'health_data:write' },
    // Lab rows (H3, #187) sit behind the very same permissions.
    { method: 'get', path: `${BASE}?category=lab`, permission: 'health_data:read' },
    { method: 'get', path: `${BASE}/series?metricKey=ldl_cholesterol`, permission: 'health_data:read' },
    {
      method: 'post',
      path: BASE,
      permission: 'health_data:write',
      body: { readings: [{ metricKey: 'ldl_cholesterol', value: 130, referenceHigh: 99, flag: 'high' }] },
    },
    {
      method: 'patch',
      path: `${BASE}/entries/${ENTRY_ID}`,
      permission: 'health_data:write',
      body: { readings: [{ metricKey: 'ldl_cholesterol', value: 128, flag: 'normal' }] },
    },
    // Blood-work history (H5, #189).
    { method: 'get', path: `${BASE}/${ENTRY_ID}/revisions`, permission: 'health_data:read' },
    { method: 'get', path: SUMMARY, permission: 'health_data:read' },
    { method: 'get', path: `${SUMMARY}?panel=lipids&outOfRange=true`, permission: 'health_data:read' },
  ];

  describe.each(ROUTES)('$method $path', ({ method, path, permission, body }) => {
    it('returns 401 without a token', async () => {
      await request(server())[method](path).send(body as object).expect(401);
    });

    it(`returns 403 without ${permission}, touching no measurement`, async () => {
      const viewer = await createMockViewerUser(context);
      stripPermission(prisma, viewer.id, permission);

      const response = await request(server())
        [method](path)
        .set(authHeader(viewer.accessToken))
        .send(body as object)
        .expect(403);

      expect(response.body.code).toBe('FORBIDDEN');
      expect(prisma.measurement.findMany).not.toHaveBeenCalled();
      expect(prisma.measurement.create).not.toHaveBeenCalled();
      expect(prisma.measurement.updateMany).not.toHaveBeenCalled();
      expect(prisma.measurement.findFirst).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['admin', createMockAdminUser],
    ['contributor', createMockContributorUser],
    ['viewer', createMockViewerUser],
  ])('admits the seeded %s role', async (_role, create) => {
    const user = await create(context);
    await request(server()).get(`${BASE}/metrics`).set(authHeader(user.accessToken)).expect(200);
  });

  // ---------------------------------------------------------------------------
  // GET /metrics, /latest, /series — and route ordering
  // ---------------------------------------------------------------------------

  describe('GET /api/measurements/metrics', () => {
    it('returns the twelve-metric catalog and the lab analytes in the envelope', async () => {
      const viewer = await createMockViewerUser(context);

      const response = await request(server())
        .get(`${BASE}/metrics`)
        .set(authHeader(viewer.accessToken))
        .expect(200);

      const metrics = response.body.data.metrics as Array<{ category: string }>;
      expect(metrics.filter((metric) => metric.category !== 'lab')).toHaveLength(12);
      expect(metrics.filter((metric) => metric.category === 'lab')).toHaveLength(LAB_METRIC_KEYS.length);
      expect(response.body.data.metrics[0]).toMatchObject({
        key: 'weight',
        canonicalUnit: 'kg',
        units: [
          { unit: 'kg', factor: 1, label: 'kg' },
          { unit: 'lb', factor: 0.45359237, label: 'lb' },
        ],
        min: 20,
        max: 500,
        decimals: 1,
        siUnit: null,
      });
      const ldl = response.body.data.metrics.find((metric: { key: string }) => metric.key === 'ldl_cholesterol');
      expect(ldl).toMatchObject({
        canonicalUnit: 'mg/dL',
        siUnit: 'mmol/L',
        units: [
          { unit: 'mg/dL', decimals: 0 },
          { unit: 'mmol/L', decimals: 2 },
        ],
      });
      expect(response.body.data.methods.length).toBeGreaterThan(10);
      expect(response.body.meta?.timestamp).toBeDefined();
    });
  });

  describe('GET /api/measurements/latest', () => {
    it('returns the body/vital metrics in order, null where absent', async () => {
      const viewer = await createMockViewerUser(context);
      prisma.measurement.findMany.mockImplementation(async ({ where }: any) =>
        where.metricKey === 'weight'
          ? [storedRow(viewer.id, { value: 81 }), storedRow(viewer.id, { value: 80 })]
          : [],
      );

      const response = await request(server())
        .get(`${BASE}/latest`)
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(response.body.data.items.map((item: any) => item.metricKey)).toEqual([
        'weight',
        'body_fat_pct',
        'waist_circumference',
        'bp_systolic',
        'bp_diastolic',
        'resting_hr',
        'heart_rate_avg',
        'hrv_rmssd',
      ]);
      expect(response.body.data.items[0].latest).toMatchObject({ value: 81, edited: false });
      expect(response.body.data.items[0].previous).toMatchObject({ value: 80 });
      expect(response.body.data.items[1]).toEqual({
        metricKey: 'body_fat_pct',
        latest: null,
        previous: null,
      });
      for (const [arg] of prisma.measurement.findMany.mock.calls) {
        expect(arg.where).toMatchObject({ userId: viewer.id, ...ACTIVE_PREDICATE });
      }
    });
  });

  describe('GET /api/measurements/series', () => {
    it('returns ascending points', async () => {
      const viewer = await createMockViewerUser(context);
      prisma.measurement.findMany.mockResolvedValue([
        storedRow(viewer.id, { value: 81, measuredAt: new Date('2026-09-02T00:00:00Z') }),
        storedRow(viewer.id, { value: 80, measuredAt: new Date('2026-09-01T00:00:00Z') }),
      ]);

      const response = await request(server())
        .get(`${BASE}/series?metricKey=weight`)
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({ metricKey: 'weight', unit: 'kg', truncated: false });
      expect(response.body.data.points.map((p: any) => p.value)).toEqual([80, 81]);
    });

    it.each([
      ['no metricKey', ''],
      ['an unknown metricKey', '?metricKey=nope'],
      ['from after to', '?metricKey=weight&from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z'],
      ['a range over 5 years', '?metricKey=weight&from=2019-01-01T00:00:00Z&to=2026-01-01T00:00:00Z'],
    ])('returns 400 for %s', async (_case, qs) => {
      const viewer = await createMockViewerUser(context);

      await request(server())
        .get(`${BASE}/series${qs}`)
        .set(authHeader(viewer.accessToken))
        .expect(400);
      expect(prisma.measurement.findMany).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/measurements/series (lab, H5)', () => {
    it('returns each lab point with its own range and flag', async () => {
      const viewer = await createMockViewerUser(context);
      prisma.measurement.findMany.mockResolvedValue([
        storedRow(viewer.id, { metricKey: 'ldl_cholesterol', value: 130, unit: 'mg/dL', referenceHigh: 129, flag: 'high' }),
        storedRow(viewer.id, { metricKey: 'ldl_cholesterol', value: 95, unit: 'mg/dL', referenceHigh: 99, flag: 'normal' }),
      ]);

      const response = await request(server())
        .get(`${BASE}/series?metricKey=ldl_cholesterol`)
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(response.body.data.points).toEqual([
        expect.objectContaining({ value: 95, referenceLow: null, referenceHigh: 99, referenceText: null, flag: 'normal' }),
        expect.objectContaining({ value: 130, referenceLow: null, referenceHigh: 129, referenceText: null, flag: 'high' }),
      ]);
    });
  });

  describe('GET /api/measurements/:id/revisions', () => {
    it('returns the chain newest first, owner-scoped', async () => {
      const viewer = await createMockViewerUser(context);
      prisma.measurement.findFirst.mockResolvedValue({ entryId: ENTRY_ID, metricKey: 'weight' });
      prisma.measurement.findMany.mockResolvedValue([
        storedRow(viewer.id, { value: 81, revision: 2 }),
        storedRow(viewer.id, { value: 80, revision: 1, supersededAt: new Date('2026-09-29T00:00:00Z') }),
      ]);

      const response = await request(server())
        .get(`${BASE}/${ENTRY_ID}/revisions`)
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(response.body.data.items).toEqual([
        expect.objectContaining({ value: 81, revision: 2, edited: true, supersededAt: null }),
        expect.objectContaining({ value: 80, revision: 1, supersededAt: '2026-09-29T00:00:00.000Z' }),
      ]);
      expect(prisma.measurement.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: ENTRY_ID, userId: viewer.id } }),
      );
    });

    it('returns 404 for a reading the caller does not own', async () => {
      const viewer = await createMockViewerUser(context);
      prisma.measurement.findFirst.mockResolvedValue(null);

      await request(server())
        .get(`${BASE}/${ENTRY_ID}/revisions`)
        .set(authHeader(viewer.accessToken))
        .expect(404);
    });

    it('returns 400 for a non-UUID id', async () => {
      const viewer = await createMockViewerUser(context);

      await request(server())
        .get(`${BASE}/not-a-uuid/revisions`)
        .set(authHeader(viewer.accessToken))
        .expect(400);
    });
  });

  describe('GET /api/health/biomarkers/summary', () => {
    it('returns one item per analyte with values, in the envelope', async () => {
      const viewer = await createMockViewerUser(context);
      prisma.$queryRaw.mockResolvedValue([
        {
          id: randomUUID(), metric_key: 'ldl_cholesterol', value: 120, measured_at: new Date('2026-09-15T00:00:00Z'),
          flag: 'high', reference_low: null, reference_high: 99, reference_text: null, rn: 1, total: 2,
        },
        {
          id: randomUUID(), metric_key: 'ldl_cholesterol', value: 130, measured_at: new Date('2026-03-15T00:00:00Z'),
          flag: 'high', reference_low: null, reference_high: 99, reference_text: null, rn: 2, total: 2,
        },
      ]);

      const response = await request(server()).get(SUMMARY).set(authHeader(viewer.accessToken)).expect(200);

      expect(response.body.data.items).toEqual([
        expect.objectContaining({
          analyteKey: 'ldl_cholesterol',
          panel: 'lipids',
          unit: 'mg/dL',
          count: 2,
          delta: -10,
          latest: expect.objectContaining({ value: 120, flag: 'high', referenceHigh: 99 }),
          previous: expect.objectContaining({ value: 130 }),
        }),
      ]);
      expect(prisma.$queryRaw.mock.calls[0][0].values[0]).toBe(viewer.id);
    });

    it.each([
      ['an unknown panel', '?panel=urine'],
      ['a non-boolean outOfRange', '?outOfRange=1'],
      ['an unknown parameter', '?metricKey=ldl_cholesterol'],
    ])('returns 400 for %s', async (_case, qs) => {
      const viewer = await createMockViewerUser(context);

      await request(server()).get(`${SUMMARY}${qs}`).set(authHeader(viewer.accessToken)).expect(400);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/measurements
  // ---------------------------------------------------------------------------

  describe('GET /api/measurements', () => {
    it('returns the flat pagination shape, scoped to the caller', async () => {
      const viewer = await createMockViewerUser(context);
      prisma.measurement.findMany.mockResolvedValue([storedRow(viewer.id)]);
      prisma.measurement.count.mockResolvedValue(1);

      const response = await request(server())
        .get(`${BASE}?metricKey=weight&pageSize=5`)
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({ total: 1, page: 1, pageSize: 5, totalPages: 1 });
      expect(response.body.data.items[0]).toMatchObject({
        entryId: ENTRY_ID,
        metricKey: 'weight',
        value: 80,
        unit: 'kg',
        revision: 1,
        edited: false,
      });
      expect(prisma.measurement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: viewer.id, metricKey: 'weight', ...ACTIVE_PREDICATE }),
          take: 5,
        }),
      );
    });

    it.each([
      ['pageSize over 100', '?pageSize=101'],
      ['a wellness metricKey', '?metricKey=energy'],
      ['from after to', '?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z'],
    ])('returns 400 for %s', async (_case, qs) => {
      const viewer = await createMockViewerUser(context);
      await request(server()).get(`${BASE}${qs}`).set(authHeader(viewer.accessToken)).expect(400);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/measurements
  // ---------------------------------------------------------------------------

  describe('POST /api/measurements', () => {
    it('creates an entry: 208.4 lb is stored as kg, origin manual, revision 1', async () => {
      const viewer = await createMockViewerUser(context);

      const response = await request(server())
        .post(BASE)
        .set(authHeader(viewer.accessToken))
        .send({ readings: [{ metricKey: 'weight', value: 208.4, unit: 'lb' }] })
        .expect(201);

      expect(response.body.data.entryId).toMatch(/^[0-9a-f-]{36}$/);
      expect(response.body.data.items).toHaveLength(1);
      expect(response.body.data.items[0]).toMatchObject({
        entryId: response.body.data.entryId,
        value: 94.5286,
        unit: 'kg',
        origin: 'manual',
        method: 'unspecified',
        revision: 1,
        edited: false,
        sourceRef: null,
      });
      expect(prisma.measurement.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ userId: viewer.id, origin: 'manual' }),
      });
    });

    it('creates a lab panel with range and flag, converted to canonical units (H3, #187)', async () => {
      const viewer = await createMockViewerUser(context);

      const response = await request(server())
        .post(BASE)
        .set(authHeader(viewer.accessToken))
        .send({
          readings: [
            { metricKey: 'fasting_glucose', value: 5.55, unit: 'mmol/L', referenceLow: 3.9, referenceHigh: 5.5, flag: 'high' },
            { metricKey: 'hba1c', value: 5.4, method: 'lab', referenceText: '<5.7', flag: 'normal' },
          ],
        })
        .expect(201);

      const items = response.body.data.items;
      expect(new Set(items.map((i: any) => i.entryId)).size).toBe(1);
      expect(items[0]).toMatchObject({ metricKey: 'fasting_glucose', unit: 'mg/dL', flag: 'high', referenceText: null });
      expect(Math.round(items[0].value)).toBe(100);
      expect(items[0].referenceLow).toBeCloseTo(70.27, 2);
      expect(items[1]).toMatchObject({
        metricKey: 'hba1c',
        value: 5.4,
        unit: '%',
        method: 'lab',
        referenceLow: null,
        referenceHigh: null,
        referenceText: '<5.7',
        flag: 'normal',
      });
    });

    it('refuses a range on a body metric and a lab reading mixed with a body one', async () => {
      const viewer = await createMockViewerUser(context);

      for (const readings of [
        [{ metricKey: 'weight', value: 80, flag: 'high' }],
        [{ metricKey: 'weight', value: 80 }, { metricKey: 'tsh', value: 2 }],
      ]) {
        await request(server()).post(BASE).set(authHeader(viewer.accessToken)).send({ readings }).expect(400);
      }
      expect(prisma.measurement.create).not.toHaveBeenCalled();
    });

    it('saves a blood-pressure pair as two rows with one entryId and one measuredAt', async () => {
      const viewer = await createMockViewerUser(context);

      const response = await request(server())
        .post(BASE)
        .set(authHeader(viewer.accessToken))
        .send({
          readings: [
            { metricKey: 'bp_systolic', value: 128 },
            { metricKey: 'bp_diastolic', value: 84 },
          ],
        })
        .expect(201);

      const items = response.body.data.items;
      expect(items).toHaveLength(2);
      expect(new Set(items.map((i: any) => i.entryId)).size).toBe(1);
      expect(new Set(items.map((i: any) => i.measuredAt)).size).toBe(1);
    });

    const future = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const weight = (value: number, extra: Record<string, unknown> = {}) => ({
      metricKey: 'weight',
      value,
      ...extra,
    });

    it.each([
      ['an unknown metricKey', () => ({ readings: [{ metricKey: 'height', value: 180 }] }), 'readings.0.metricKey'],
      ['a wellness key', () => ({ readings: [{ metricKey: 'energy', value: 3 }] }), 'readings.0.metricKey'],
      ['a duplicate key', () => ({ readings: [weight(80), weight(81)] }), 'readings.1.metricKey'],
      ['unit stone', () => ({ readings: [weight(13, { unit: 'stone' })] }), 'readings.0.unit'],
      ['method dexa for weight', () => ({ readings: [weight(80, { method: 'dexa' })] }), 'readings.0.method'],
      ['weight 5 kg', () => ({ readings: [weight(5)] }), 'readings.0.value'],
      ['systolic without diastolic', () => ({ readings: [{ metricKey: 'bp_systolic', value: 120 }] }), 'readings'],
      [
        'systolic 80 with diastolic 90',
        () => ({
          readings: [
            { metricKey: 'bp_systolic', value: 80 },
            { metricKey: 'bp_diastolic', value: 90 },
          ],
        }),
        'readings',
      ],
      ['measuredAt an hour ahead', () => ({ measuredAt: future(), readings: [weight(80)] }), 'measuredAt'],
      [
        'more than 6 readings',
        () => ({ readings: Array.from({ length: 7 }, (_, i) => weight(80 + i)) }),
        'readings',
      ],
      ['origin', () => ({ origin: 'ai', readings: [weight(80)] }), ''],
      ['sourceRef', () => ({ sourceRef: { kind: 'x' }, readings: [weight(80)] }), ''],
    ])('returns 400 for %s, naming the field', async (_case, body, path) => {
      const viewer = await createMockViewerUser(context);

      const response = await request(server())
        .post(BASE)
        .set(authHeader(viewer.accessToken))
        .send(body())
        .expect(400);

      expect(response.body.code).toBe('BAD_REQUEST');
      expect(response.body.details.issues.map((issue: any) => issue.path)).toContain(path);
      expect(prisma.measurement.create).not.toHaveBeenCalled();
    });

    it('does not echo notes in a validation error', async () => {
      const viewer = await createMockViewerUser(context);

      const response = await request(server())
        .post(BASE)
        .set(authHeader(viewer.accessToken))
        .send({ notes: `do-not-echo-${'n'.repeat(600)}`, readings: [weight(80)] })
        .expect(400);

      expect(JSON.stringify(response.body)).not.toContain('do-not-echo');
    });
  });

  // ---------------------------------------------------------------------------
  // PATCH /api/measurements/entries/:entryId
  // ---------------------------------------------------------------------------

  describe('PATCH /api/measurements/entries/:entryId', () => {
    it('supersedes the entry and returns revision 2, edited', async () => {
      const viewer = await createMockViewerUser(context);
      const old = storedRow(viewer.id, { value: 80 });
      prisma.measurement.findMany.mockResolvedValue([old]);
      prisma.measurement.updateMany.mockResolvedValue({ count: 1 });

      const response = await request(server())
        .patch(`${BASE}/entries/${ENTRY_ID}`)
        .set(authHeader(viewer.accessToken))
        .send({ readings: [{ metricKey: 'weight', value: 81 }] })
        .expect(200);

      expect(response.body.data).toMatchObject({
        entryId: ENTRY_ID,
        items: [{ metricKey: 'weight', value: 81, revision: 2, edited: true }],
      });
      expect(prisma.measurement.findMany).toHaveBeenCalledWith({
        where: { userId: viewer.id, entryId: ENTRY_ID, ...ACTIVE_PREDICATE },
      });
      expect(prisma.measurement.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ supersedesId: old.id, revision: 2 }),
      });
    });

    it("returns 404 for another user's (or an unknown) entry", async () => {
      const viewer = await createMockViewerUser(context);
      prisma.measurement.findMany.mockResolvedValue([]);

      const response = await request(server())
        .patch(`${BASE}/entries/${ENTRY_ID}`)
        .set(authHeader(viewer.accessToken))
        .send({ notes: null })
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
      expect(prisma.measurement.updateMany).not.toHaveBeenCalled();
    });

    it('returns 409 when a concurrent request changed the entry', async () => {
      const viewer = await createMockViewerUser(context);
      prisma.measurement.findMany.mockResolvedValue([storedRow(viewer.id)]);
      prisma.measurement.updateMany.mockResolvedValue({ count: 0 });

      await request(server())
        .patch(`${BASE}/entries/${ENTRY_ID}`)
        .set(authHeader(viewer.accessToken))
        .send({ notes: null })
        .expect(409);
    });

    it('returns 400 for a metric not in the entry, naming the field', async () => {
      const viewer = await createMockViewerUser(context);
      prisma.measurement.findMany.mockResolvedValue([storedRow(viewer.id)]);

      const response = await request(server())
        .patch(`${BASE}/entries/${ENTRY_ID}`)
        .set(authHeader(viewer.accessToken))
        .send({ readings: [{ metricKey: 'resting_hr', value: 60 }] })
        .expect(400);

      expect(response.body.details.issues[0].path).toBe('readings.0.metricKey');
    });

    it.each([
      ['an empty body', {}],
      ['origin', { origin: 'ai' }],
    ])('returns 400 for %s', async (_case, body) => {
      const viewer = await createMockViewerUser(context);
      await request(server())
        .patch(`${BASE}/entries/${ENTRY_ID}`)
        .set(authHeader(viewer.accessToken))
        .send(body)
        .expect(400);
      expect(prisma.measurement.findMany).not.toHaveBeenCalled();
    });

    it('returns 400 for a non-UUID entry id', async () => {
      const viewer = await createMockViewerUser(context);
      await request(server())
        .patch(`${BASE}/entries/not-a-uuid`)
        .set(authHeader(viewer.accessToken))
        .send({ notes: null })
        .expect(400);
    });
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/measurements/entries/:entryId
  // ---------------------------------------------------------------------------

  describe('DELETE /api/measurements/entries/:entryId', () => {
    it('returns 204 and audits the reading count', async () => {
      const viewer = await createMockViewerUser(context);
      prisma.measurement.updateMany.mockResolvedValue({ count: 2 });

      const response = await request(server())
        .delete(`${BASE}/entries/${ENTRY_ID}`)
        .set(authHeader(viewer.accessToken))
        .expect(204);

      expect(response.body).toEqual({});
      expect(prisma.measurement.updateMany).toHaveBeenCalledWith({
        where: { userId: viewer.id, entryId: ENTRY_ID, ...ACTIVE_PREDICATE },
        data: { deletedAt: expect.any(Date) },
      });
      expect(prisma.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'measurement_entry:delete',
          targetType: 'measurement_entry',
          targetId: ENTRY_ID,
          meta: { readingCount: 2 },
        }),
      });
    });

    it("returns 404 for another user's, an unknown or an already-deleted entry", async () => {
      const viewer = await createMockViewerUser(context);
      prisma.measurement.updateMany.mockResolvedValue({ count: 0 });

      await request(server())
        .delete(`${BASE}/entries/${ENTRY_ID}`)
        .set(authHeader(viewer.accessToken))
        .expect(404);
      expect(prisma.auditEvent.create).not.toHaveBeenCalled();
    });

    it('returns 204 even when the audit write fails', async () => {
      const viewer = await createMockViewerUser(context);
      prisma.measurement.updateMany.mockResolvedValue({ count: 1 });
      prisma.auditEvent.create.mockRejectedValue(new Error('audit down'));

      await request(server())
        .delete(`${BASE}/entries/${ENTRY_ID}`)
        .set(authHeader(viewer.accessToken))
        .expect(204);
    });
  });
});
