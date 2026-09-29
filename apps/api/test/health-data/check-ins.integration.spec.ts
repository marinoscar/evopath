// =============================================================================
// Integration: /api/check-ins (E2.4, #56) — mocked Prisma
// =============================================================================
//
// The HTTP contract end to end through the real guards, pipes, interceptor and
// exception filter: 401 without a token, 403 without the exact `health_data:*`
// permission, the `{ data }` envelope, 200/204, 400 naming the rule (date
// window, real date, scores, note, empty submission, days), 404 on a missing
// day, 409 on a lost concurrent save, and route order (`/today` is never
// captured by `/:date`). Prisma is mocked; revisions against real rows and a
// real concurrent save are proven in `check-ins.db.spec.ts`.
// =============================================================================

import { randomUUID } from 'node:crypto';

import request from 'supertest';

import { addDays, localDateInZone } from '../../src/check-ins/local-date';
import { closeTestApp, createTestApp, TestContext } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  authHeader,
  createMockAdminUser,
  createMockContributorUser,
  createMockViewerUser,
} from '../helpers/auth-mock.helper';

const BASE = '/api/check-ins';
const ACTIVE_PREDICATE = { supersededAt: null, deletedAt: null };
const WELLNESS_KEYS = ['energy', 'sleep_quality', 'muscle_soreness', 'stress'];

/** Today in UTC (no profile time zone in these tests unless a test sets one). */
const todayUtc = () => localDateInZone(new Date(), null);

/** Fakes only `Date`; timers, ticks and I/O stay real so the HTTP stack works. */
function freezeDate(iso: string): void {
  jest.useFakeTimers({
    now: new Date(iso),
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });
}

function storedRow(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    userId,
    entryId: '33333333-3333-4333-8333-333333333333',
    metricKey: 'energy',
    value: 4,
    unit: 'score',
    measuredAt: new Date('2026-09-29T07:00:00.000Z'),
    localDate: new Date(`${todayUtc()}T00:00:00.000Z`),
    method: 'self_report',
    origin: 'manual',
    notes: null,
    sourceRef: null,
    revision: 1,
    supersedesId: null,
    supersededAt: null,
    deletedAt: null,
    createdAt: new Date('2026-09-29T07:00:01.000Z'),
    updatedAt: new Date('2026-09-29T07:00:01.000Z'),
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

describe('Check-ins (integration)', () => {
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
    prisma.healthProfile.findUnique.mockResolvedValue(null);
    prisma.measurement.findMany.mockResolvedValue([]);
    prisma.measurement.create.mockImplementation(async ({ data }: any) =>
      storedRow(data.userId, { ...data, sourceRef: null, updatedAt: new Date() }),
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // Access control, per route
  // ---------------------------------------------------------------------------

  const ROUTES: Array<{
    method: 'get' | 'put' | 'delete';
    path: () => string;
    permission: string;
    body?: unknown;
  }> = [
    { method: 'get', path: () => `${BASE}/today`, permission: 'health_data:read' },
    { method: 'get', path: () => BASE, permission: 'health_data:read' },
    {
      method: 'put',
      path: () => `${BASE}/${todayUtc()}`,
      permission: 'health_data:write',
      body: { energy: 3 },
    },
    { method: 'delete', path: () => `${BASE}/${todayUtc()}`, permission: 'health_data:write' },
  ];

  describe.each(ROUTES)('$method $permission', ({ method, path, permission, body }) => {
    it('returns 401 without a token', async () => {
      await request(server())[method](path()).send(body as object).expect(401);
    });

    it(`returns 403 without ${permission}, touching no measurement`, async () => {
      const viewer = await createMockViewerUser(context);
      stripPermission(prisma, viewer.id, permission);

      const response = await request(server())
        [method](path())
        .set(authHeader(viewer.accessToken))
        .send(body as object)
        .expect(403);

      expect(response.body.code).toBe('FORBIDDEN');
      expect(prisma.measurement.findMany).not.toHaveBeenCalled();
      expect(prisma.measurement.create).not.toHaveBeenCalled();
      expect(prisma.measurement.updateMany).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['admin', createMockAdminUser],
    ['contributor', createMockContributorUser],
    ['viewer', createMockViewerUser],
  ])('admits the seeded %s role to read and write', async (_role, create) => {
    const user = await create(context);
    await request(server()).get(`${BASE}/today`).set(authHeader(user.accessToken)).expect(200);
    await request(server())
      .put(`${BASE}/${todayUtc()}`)
      .set(authHeader(user.accessToken))
      .send({ energy: 3 })
      .expect(200);
  });

  // ---------------------------------------------------------------------------
  // GET /today
  // ---------------------------------------------------------------------------

  describe('GET /api/check-ins/today', () => {
    it('returns today in the profile time zone (Pacific/Auckland at 12:30Z is tomorrow)', async () => {
      freezeDate('2026-09-29T12:30:00.000Z');
      const viewer = await createMockViewerUser(context);
      prisma.healthProfile.findUnique.mockResolvedValue({ timeZone: 'Pacific/Auckland' });

      const response = await request(server())
        .get(`${BASE}/today`)
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(response.body.data).toEqual({ date: '2026-09-30', checkIn: null });
      expect(response.body.meta?.timestamp).toBeDefined();
      expect(prisma.healthProfile.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: viewer.id } }),
      );
      expect(prisma.measurement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: viewer.id,
            ...ACTIVE_PREDICATE,
            localDate: new Date('2026-09-30T00:00:00.000Z'),
            metricKey: { in: WELLNESS_KEYS },
          },
        }),
      );
    });

    it('returns the UTC date when no time zone is set', async () => {
      freezeDate('2026-09-29T12:30:00.000Z');
      const viewer = await createMockViewerUser(context);

      const response = await request(server())
        .get(`${BASE}/today`)
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(response.body.data.date).toBe('2026-09-29');
    });

    it("returns today's check-in in the documented shape", async () => {
      const viewer = await createMockViewerUser(context);
      prisma.measurement.findMany.mockResolvedValue([
        storedRow(viewer.id, { metricKey: 'energy', value: 4, notes: 'Big presentation' }),
        storedRow(viewer.id, { metricKey: 'muscle_soreness', value: 2, notes: 'Big presentation' }),
      ]);

      const response = await request(server())
        .get(`${BASE}/today`)
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(response.body.data).toEqual({
        date: todayUtc(),
        checkIn: {
          date: todayUtc(),
          energy: 4,
          sleepQuality: null,
          soreness: 2,
          stress: null,
          note: 'Big presentation',
          updatedAt: '2026-09-29T07:00:01.000Z',
        },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // GET /
  // ---------------------------------------------------------------------------

  describe('GET /api/check-ins', () => {
    it('lists the last `days` days newest first, scoped to the caller', async () => {
      freezeDate('2026-09-29T12:30:00.000Z');
      const viewer = await createMockViewerUser(context);
      prisma.measurement.findMany.mockResolvedValue([
        storedRow(viewer.id, { localDate: new Date('2026-09-25T00:00:00Z'), value: 2 }),
        storedRow(viewer.id, { localDate: new Date('2026-09-28T00:00:00Z'), value: 5 }),
      ]);

      const response = await request(server())
        .get(`${BASE}?days=7`)
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(response.body.data.items.map((i: any) => [i.date, i.energy])).toEqual([
        ['2026-09-28', 5],
        ['2026-09-25', 2],
      ]);
      expect(prisma.measurement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: viewer.id,
            ...ACTIVE_PREDICATE,
            localDate: {
              gte: new Date('2026-09-23T00:00:00.000Z'),
              lte: new Date('2026-09-29T00:00:00.000Z'),
            },
          }),
        }),
      );
    });

    it('defaults to 30 days', async () => {
      freezeDate('2026-09-29T12:30:00.000Z');
      const viewer = await createMockViewerUser(context);

      const response = await request(server()).get(BASE).set(authHeader(viewer.accessToken)).expect(200);

      expect(response.body.data).toEqual({ items: [] });
      expect(prisma.measurement.findMany.mock.calls[0][0].where.localDate.gte).toEqual(
        new Date('2026-08-31T00:00:00.000Z'),
      );
    });

    it.each(['0', '400', '366', '2.5', 'abc'])('returns 400 for days=%s before any query', async (days) => {
      const viewer = await createMockViewerUser(context);

      const response = await request(server())
        .get(`${BASE}?days=${days}`)
        .set(authHeader(viewer.accessToken))
        .expect(400);

      expect(response.body.details.issues[0].path).toBe('days');
      expect(prisma.measurement.findMany).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // PUT /:date
  // ---------------------------------------------------------------------------

  describe('PUT /api/check-ins/:date', () => {
    const FULL = { energy: 4, sleepQuality: 3, soreness: 2, stress: 3, note: 'Big presentation' };

    it('creates the day and returns the check-in with 200', async () => {
      const viewer = await createMockViewerUser(context);
      const date = todayUtc();

      const response = await request(server())
        .put(`${BASE}/${date}`)
        .set(authHeader(viewer.accessToken))
        .send(FULL)
        .expect(200);

      expect(response.body.data).toEqual({ date, ...FULL, updatedAt: expect.any(String) });
      expect(prisma.measurement.create).toHaveBeenCalledTimes(4);
      for (const [{ data }] of prisma.measurement.create.mock.calls) {
        expect(data).toMatchObject({
          userId: viewer.id,
          localDate: new Date(`${date}T00:00:00.000Z`),
          method: 'self_report',
          origin: 'manual',
          unit: 'score',
          revision: 1,
        });
      }
    });

    it('accepts a date 7 days back', async () => {
      const viewer = await createMockViewerUser(context);
      await request(server())
        .put(`${BASE}/${addDays(todayUtc(), -7)}`)
        .set(authHeader(viewer.accessToken))
        .send({ stress: 5 })
        .expect(200);
    });

    it('returns 409 when a concurrent save won', async () => {
      const viewer = await createMockViewerUser(context);
      prisma.measurement.findMany.mockResolvedValue([storedRow(viewer.id)]);
      prisma.measurement.updateMany.mockResolvedValue({ count: 0 });

      const response = await request(server())
        .put(`${BASE}/${todayUtc()}`)
        .set(authHeader(viewer.accessToken))
        .send({ energy: 1 })
        .expect(409);

      expect(response.body.code).toBe('CONFLICT');
    });

    it.each([
      ['no score at all', {}, ''],
      ['only nulls and a note', { energy: null, stress: null, note: 'hi' }, ''],
      ['a score of 0', { energy: 0 }, 'energy'],
      ['a score of 6', { sleepQuality: 6 }, 'sleepQuality'],
      ['a score of 3.5', { soreness: 3.5 }, 'soreness'],
      ['a string score', { stress: '3' }, 'stress'],
      ['a note over 500 characters', { energy: 3, note: 'n'.repeat(501) }, 'note'],
      ['an unknown field', { energy: 3, readiness: 80 }, ''],
    ])('returns 400 for %s', async (_case, body, path) => {
      const viewer = await createMockViewerUser(context);

      const response = await request(server())
        .put(`${BASE}/${todayUtc()}`)
        .set(authHeader(viewer.accessToken))
        .send(body)
        .expect(400);

      expect(response.body.code).toBe('BAD_REQUEST');
      expect(response.body.details.issues.map((issue: any) => issue.path)).toContain(path);
      expect(prisma.measurement.create).not.toHaveBeenCalled();
    });

    it('names the empty-submission rule', async () => {
      const viewer = await createMockViewerUser(context);

      const response = await request(server())
        .put(`${BASE}/${todayUtc()}`)
        .set(authHeader(viewer.accessToken))
        .send({})
        .expect(400);

      expect(response.body.details.issues[0].message).toBe('Enter at least one score');
    });

    it.each([
      ['tomorrow', () => addDays(todayUtc(), 1), 'The check-in date must not be later than today'],
      [
        '8 days ago',
        () => addDays(todayUtc(), -8),
        'The check-in date must be today or at most 7 days earlier',
      ],
      ['2026-02-30', () => '2026-02-30', 'date must be a real calendar date'],
      ['a malformed date', () => '29-09-2026', 'date must be in YYYY-MM-DD format'],
    ])('returns 400 for %s, naming the rule', async (_case, date, message) => {
      const viewer = await createMockViewerUser(context);

      const response = await request(server())
        .put(`${BASE}/${date()}`)
        .set(authHeader(viewer.accessToken))
        .send({ energy: 3 })
        .expect(400);

      expect(response.body.details.issues).toContainEqual({ path: 'date', message });
      expect(prisma.measurement.findMany).not.toHaveBeenCalled();
      expect(prisma.measurement.create).not.toHaveBeenCalled();
    });

    it('does not echo the note in a validation error', async () => {
      const viewer = await createMockViewerUser(context);

      const response = await request(server())
        .put(`${BASE}/${todayUtc()}`)
        .set(authHeader(viewer.accessToken))
        .send({ energy: 3, note: `do-not-echo-${'n'.repeat(600)}` })
        .expect(400);

      expect(JSON.stringify(response.body)).not.toContain('do-not-echo');
    });
  });

  // ---------------------------------------------------------------------------
  // DELETE /:date
  // ---------------------------------------------------------------------------

  describe('DELETE /api/check-ins/:date', () => {
    it('returns 204 and audits the score count only', async () => {
      const viewer = await createMockViewerUser(context);
      const date = todayUtc();
      prisma.measurement.updateMany.mockResolvedValue({ count: 4 });

      const response = await request(server())
        .delete(`${BASE}/${date}`)
        .set(authHeader(viewer.accessToken))
        .expect(204);

      expect(response.body).toEqual({});
      expect(prisma.measurement.updateMany).toHaveBeenCalledWith({
        where: {
          userId: viewer.id,
          ...ACTIVE_PREDICATE,
          localDate: new Date(`${date}T00:00:00.000Z`),
          metricKey: { in: WELLNESS_KEYS },
        },
        data: { deletedAt: expect.any(Date) },
      });
      expect(prisma.auditEvent.create).toHaveBeenCalledWith({
        data: {
          actorUserId: viewer.id,
          action: 'check_in:delete',
          targetType: 'check_in',
          targetId: date,
          meta: { scoreCount: 4 },
        },
      });
    });

    it('returns 404 when there is no check-in that day', async () => {
      const viewer = await createMockViewerUser(context);
      prisma.measurement.updateMany.mockResolvedValue({ count: 0 });

      const response = await request(server())
        .delete(`${BASE}/${todayUtc()}`)
        .set(authHeader(viewer.accessToken))
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
      expect(prisma.auditEvent.create).not.toHaveBeenCalled();
    });

    it('returns 400 for an invalid date before any query', async () => {
      const viewer = await createMockViewerUser(context);

      await request(server())
        .delete(`${BASE}/2026-02-30`)
        .set(authHeader(viewer.accessToken))
        .expect(400);
      expect(prisma.measurement.updateMany).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Route order
  // ---------------------------------------------------------------------------

  describe('route order', () => {
    it('GET /today is its own route, not a malformed :date', async () => {
      const viewer = await createMockViewerUser(context);
      const response = await request(server())
        .get(`${BASE}/today`)
        .set(authHeader(viewer.accessToken))
        .expect(200);
      expect(response.body.data).toHaveProperty('date');
    });

    it('PUT /today is treated as a date and refused (the client echoes the real date)', async () => {
      const viewer = await createMockViewerUser(context);
      const response = await request(server())
        .put(`${BASE}/today`)
        .set(authHeader(viewer.accessToken))
        .send({ energy: 3 })
        .expect(400);
      expect(response.body.details.issues[0].path).toBe('date');
    });
  });
});
