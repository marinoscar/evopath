// =============================================================================
// Integration: /api/goals and /api/activity-entries (#266, #267, #268)
// =============================================================================
//
// The HTTP contract through the real guards, pipes, interceptor and exception
// filter, over a mocked Prisma: 401 without a token and 403 without the exact
// permission on every route; the three seeded roles are admitted; Zod and
// service validation answer 400; the 409s (GOAL_LIMIT_REACHED, ENTRY_DERIVED,
// GOAL_ILLEGAL_TRANSITION), If-Match (428 missing, 412 stale) and the entry
// backdating window. Partial indexes, cascades and real counting are proven in
// `activity.db.spec.ts`.
// =============================================================================

import request from 'supertest';

import { ActivityEntriesController } from '../../src/activity/activity-entries.controller';
import { GoalsController } from '../../src/activity/goals.controller';
import { PERMISSIONS_KEY } from '../../src/auth/decorators/permissions.decorator';

import { closeTestApp, createTestApp, TestContext } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  authHeader,
  createMockAdminUser,
  createMockContributorUser,
  createMockViewerUser,
} from '../helpers/auth-mock.helper';

const GOAL = '11111111-1111-4111-8111-111111111111';
const ENTRY = '22222222-2222-4222-8222-222222222222';
const WORKOUT = '33333333-3333-4333-8333-333333333333';

const NOW = new Date();
const TODAY = NOW.toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

function goalRow(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: GOAL,
    userId,
    title: 'Walk 4 times a week',
    activityKind: 'walk',
    customLabel: null,
    metric: 'sessions',
    target: 4,
    period: 'week',
    status: 'active',
    startsOn: new Date(`${TODAY}T00:00:00.000Z`),
    version: 3,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function entryRow(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: ENTRY,
    userId,
    occurredOn: new Date(`${TODAY}T00:00:00.000Z`),
    occurredAt: null,
    activityKind: 'walk',
    completed: true,
    durationSeconds: null,
    steps: null,
    distanceMeters: null,
    source: 'manual',
    workoutId: null,
    provider: null,
    externalId: null,
    note: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** Removes one permission from one mocked user's roles. */
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
          rolePermissions: (userRole.role.rolePermissions ?? []).filter((rp: any) => rp.permission.name !== permission),
        },
      })),
    };
  });
}

describe('Goals and activity entries (integration)', () => {
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
    prisma.$transaction.mockImplementation(async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg)));
    // No Health Profile: UTC.
    prisma.healthProfile.findUnique.mockResolvedValue(null);
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.workout.findMany.mockResolvedValue([]);
    prisma.activityEntry.findMany.mockResolvedValue([]);
    prisma.activityGoal.findMany.mockResolvedValue([]);
  });

  // ---------------------------------------------------------------------------
  // Access control, per route
  // ---------------------------------------------------------------------------

  const ROUTES: Array<{ method: 'get' | 'post' | 'patch' | 'delete'; path: string; permission: string; body?: unknown }> = [
    { method: 'get', path: '/api/goals', permission: 'goals:read' },
    { method: 'get', path: '/api/goals/templates', permission: 'goals:read' },
    { method: 'get', path: '/api/goals/progress', permission: 'goals:read' },
    { method: 'get', path: `/api/goals/${GOAL}`, permission: 'goals:read' },
    { method: 'get', path: `/api/goals/${GOAL}/history`, permission: 'goals:read' },
    {
      method: 'post',
      path: '/api/goals',
      permission: 'goals:write',
      body: { title: 'T', activityKind: 'walk', metric: 'sessions', target: 3, period: 'week' },
    },
    { method: 'patch', path: `/api/goals/${GOAL}`, permission: 'goals:write', body: { title: 'X' } },
    { method: 'post', path: `/api/goals/${GOAL}/pause`, permission: 'goals:write' },
    { method: 'post', path: `/api/goals/${GOAL}/resume`, permission: 'goals:write' },
    { method: 'post', path: `/api/goals/${GOAL}/archive`, permission: 'goals:write' },
    { method: 'get', path: `/api/activity-entries?from=${TODAY}&to=${TODAY}`, permission: 'goals:read' },
    { method: 'post', path: '/api/activity-entries', permission: 'goals:write', body: { activityKind: 'walk' } },
    {
      method: 'post',
      path: '/api/activity-entries/batch',
      permission: 'goals:write',
      body: { entries: [{ activityKind: 'walk' }] },
    },
    { method: 'patch', path: `/api/activity-entries/${ENTRY}`, permission: 'goals:write', body: { note: 'x' } },
    { method: 'delete', path: `/api/activity-entries/${ENTRY}`, permission: 'goals:write' },
  ];

  describe('declared permission metadata (the matrix)', () => {
    const goalsMatrix: Array<[keyof GoalsController, string]> = [
      ['list', 'goals:read'],
      ['templates', 'goals:read'],
      ['progressList', 'goals:read'],
      ['get', 'goals:read'],
      ['history', 'goals:read'],
      ['create', 'goals:write'],
      ['update', 'goals:write'],
      ['pause', 'goals:write'],
      ['resume', 'goals:write'],
      ['archive', 'goals:write'],
    ];
    const entriesMatrix: Array<[keyof ActivityEntriesController, string]> = [
      ['list', 'goals:read'],
      ['create', 'goals:write'],
      ['batch', 'goals:write'],
      ['update', 'goals:write'],
      ['remove', 'goals:write'],
    ];

    it.each(goalsMatrix)('GoalsController.%s requires exactly %s', (method, permission) => {
      expect(Reflect.getMetadata(PERMISSIONS_KEY, GoalsController.prototype[method])).toEqual([permission]);
    });

    it.each(entriesMatrix)('ActivityEntriesController.%s requires exactly %s', (method, permission) => {
      expect(Reflect.getMetadata(PERMISSIONS_KEY, ActivityEntriesController.prototype[method])).toEqual([permission]);
    });
  });

  describe.each(ROUTES)('$method $path ($permission)', ({ method, path, permission, body }) => {
    it('returns 401 without a token', async () => {
      await request(server())[method](path).send(body as object).expect(401);
    });

    it(`returns 403 without ${permission}, touching no goal or entry`, async () => {
      const user = await createMockContributorUser(context);
      stripPermission(prisma, user.id, permission);

      const response = await request(server())
        [method](path)
        .set(authHeader(user.accessToken))
        .set('If-Match', '3')
        .send(body as object)
        .expect(403);

      expect(response.body.code).toBe('FORBIDDEN');
      for (const model of [prisma.activityGoal, prisma.activityEntry]) {
        expect(model.findMany).not.toHaveBeenCalled();
        expect(model.findFirst).not.toHaveBeenCalled();
        expect(model.create).not.toHaveBeenCalled();
        expect(model.updateMany).not.toHaveBeenCalled();
        expect(model.deleteMany).not.toHaveBeenCalled();
      }
    });
  });

  it.each([
    ['admin', createMockAdminUser],
    ['contributor', createMockContributorUser],
    ['viewer', createMockViewerUser],
  ])('admits the seeded %s role to read goals and log an entry', async (_role, create) => {
    const user = await create(context);
    prisma.activityEntry.create.mockImplementation(async ({ data }: any) => entryRow(user.id, data));

    await request(server()).get('/api/goals').set(authHeader(user.accessToken)).expect(200);
    await request(server())
      .post('/api/activity-entries')
      .set(authHeader(user.accessToken))
      .send({ activityKind: 'walk' })
      .expect(201);
  });

  // ---------------------------------------------------------------------------
  // Goals
  // ---------------------------------------------------------------------------

  describe('goals', () => {
    it('lists the four templates', async () => {
      const user = await createMockContributorUser(context);
      const response = await request(server()).get('/api/goals/templates').set(authHeader(user.accessToken)).expect(200);
      expect(response.body.data.map((t: any) => t.key)).toEqual([
        'walk_4x_week',
        'cardio_150_min_week',
        'steps_8000_day',
        'workout_3x_week',
      ]);
    });

    it('creates a goal under the cap, startsOn today, after locking the user row', async () => {
      const user = await createMockContributorUser(context);
      prisma.activityGoal.count.mockResolvedValue(9);
      prisma.activityGoal.create.mockImplementation(async ({ data }: any) => goalRow(user.id, { ...data, version: 1 }));

      const response = await request(server())
        .post('/api/goals')
        .set(authHeader(user.accessToken))
        .send({ title: 'Walks', activityKind: 'walk', metric: 'sessions', target: 4, period: 'week', customLabel: 'ignored' })
        .expect(201);

      expect(response.body.data).toMatchObject({ title: 'Walks', startsOn: TODAY, customLabel: null, version: 1 });
      expect(prisma.$queryRaw).toHaveBeenCalled();
      expect(prisma.activityGoal.count).toHaveBeenCalledWith({ where: { userId: user.id, status: 'active' } });
    });

    it('answers 409 GOAL_LIMIT_REACHED with 10 active goals', async () => {
      const user = await createMockContributorUser(context);
      prisma.activityGoal.count.mockResolvedValue(10);

      const response = await request(server())
        .post('/api/goals')
        .set(authHeader(user.accessToken))
        .send({ title: 'One more', activityKind: 'run', metric: 'sessions', target: 2, period: 'week' })
        .expect(409);

      expect(response.body.details.reason).toBe('GOAL_LIMIT_REACHED');
      expect(prisma.activityGoal.create).not.toHaveBeenCalled();
    });

    it.each([
      ['kind steps', { activityKind: 'steps', metric: 'steps', target: 8000, period: 'day' }],
      ['target 0', { activityKind: 'walk', metric: 'sessions', target: 0, period: 'week' }],
      ['target above 1,000,000', { activityKind: 'walk', metric: 'steps', target: 1_000_001, period: 'week' }],
      ['a fractional target', { activityKind: 'walk', metric: 'minutes', target: 1.5, period: 'week' }],
      ['an unknown field', { activityKind: 'walk', metric: 'sessions', target: 3, period: 'week', extra: 1 }],
    ])('refuses %s with 400', async (_label, body) => {
      const user = await createMockContributorUser(context);
      await request(server())
        .post('/api/goals')
        .set(authHeader(user.accessToken))
        .send({ title: 'T', ...body })
        .expect(400);
      expect(prisma.activityGoal.create).not.toHaveBeenCalled();
    });

    it('refuses a title over 80 characters', async () => {
      const user = await createMockContributorUser(context);
      await request(server())
        .post('/api/goals')
        .set(authHeader(user.accessToken))
        .send({ title: 'x'.repeat(81), activityKind: 'walk', metric: 'sessions', target: 3, period: 'week' })
        .expect(400);
    });

    it.each([
      ['sessions per day', { activityKind: 'walk', metric: 'sessions', target: 1, period: 'day' }, 'period'],
      ['custom without a label', { activityKind: 'custom', metric: 'minutes', target: 60, period: 'week' }, 'customLabel'],
    ])('refuses %s with 400 INVALID_GOAL', async (_label, body, path) => {
      const user = await createMockContributorUser(context);
      const response = await request(server())
        .post('/api/goals')
        .set(authHeader(user.accessToken))
        .send({ title: 'T', ...body })
        .expect(400);
      expect(response.body.details).toMatchObject({ reason: 'INVALID_GOAL', path });
    });

    it('refuses a startsOn more than a year away', async () => {
      const user = await createMockContributorUser(context);
      const response = await request(server())
        .post('/api/goals')
        .set(authHeader(user.accessToken))
        .send({ title: 'T', activityKind: 'walk', metric: 'sessions', target: 3, period: 'week', startsOn: '2020-01-01' })
        .expect(400);
      expect(response.body.details.reason).toBe('START_DATE_OUT_OF_RANGE');
    });

    it('GET /:id answers the goal with its version as ETag; another user\'s goal is 404', async () => {
      const user = await createMockContributorUser(context);
      prisma.activityGoal.findFirst.mockResolvedValueOnce(goalRow(user.id));

      const response = await request(server()).get(`/api/goals/${GOAL}`).set(authHeader(user.accessToken)).expect(200);
      expect(response.headers.etag).toBe('"3"');
      expect(prisma.activityGoal.findFirst).toHaveBeenCalledWith({ where: { id: GOAL, userId: user.id } });

      prisma.activityGoal.findFirst.mockResolvedValueOnce(null);
      await request(server()).get(`/api/goals/${GOAL}`).set(authHeader(user.accessToken)).expect(404);
    });

    describe('PATCH /:id (If-Match)', () => {
      it('answers 428 IF_MATCH_REQUIRED without If-Match', async () => {
        const user = await createMockContributorUser(context);
        const response = await request(server())
          .patch(`/api/goals/${GOAL}`)
          .set(authHeader(user.accessToken))
          .send({ title: 'New' })
          .expect(428);
        expect(response.body.details.reason).toBe('IF_MATCH_REQUIRED');
        expect(prisma.activityGoal.updateMany).not.toHaveBeenCalled();
      });

      it('answers 412 GOAL_VERSION_MISMATCH with the current version on a stale If-Match', async () => {
        const user = await createMockContributorUser(context);
        prisma.activityGoal.findFirst.mockResolvedValue(goalRow(user.id, { version: 4 }));

        const response = await request(server())
          .patch(`/api/goals/${GOAL}`)
          .set(authHeader(user.accessToken))
          .set('If-Match', '"3"')
          .send({ title: 'New' })
          .expect(412);

        expect(response.body.code).toBe('PRECONDITION_FAILED');
        expect(response.body.details).toMatchObject({ reason: 'GOAL_VERSION_MISMATCH', currentVersion: 4 });
        expect(prisma.activityGoal.updateMany).not.toHaveBeenCalled();
      });

      it('answers 412 when a concurrent edit wins between the read and the write', async () => {
        const user = await createMockContributorUser(context);
        prisma.activityGoal.findFirst
          .mockResolvedValueOnce(goalRow(user.id))
          .mockResolvedValueOnce({ version: 4 });
        prisma.activityGoal.updateMany.mockResolvedValue({ count: 0 });

        const response = await request(server())
          .patch(`/api/goals/${GOAL}`)
          .set(authHeader(user.accessToken))
          .set('If-Match', '3')
          .send({ title: 'New' })
          .expect(412);
        expect(response.body.details.currentVersion).toBe(4);
      });

      it('writes conditionally on the version, bumps it and answers the new ETag', async () => {
        const user = await createMockContributorUser(context);
        prisma.activityGoal.findFirst
          .mockResolvedValueOnce(goalRow(user.id))
          .mockResolvedValueOnce(goalRow(user.id, { title: 'New', target: 5, version: 4 }));
        prisma.activityGoal.updateMany.mockResolvedValue({ count: 1 });

        const response = await request(server())
          .patch(`/api/goals/${GOAL}`)
          .set(authHeader(user.accessToken))
          .set('If-Match', 'W/"3"')
          .send({ title: 'New', target: 5 })
          .expect(200);

        expect(response.headers.etag).toBe('"4"');
        expect(prisma.activityGoal.updateMany).toHaveBeenCalledWith({
          where: { id: GOAL, userId: user.id, version: 3 },
          data: { customLabel: null, version: { increment: 1 }, title: 'New', target: 5 },
        });
      });

      it('judges the merged goal: switching a weekly sessions goal to daily is a 400', async () => {
        const user = await createMockContributorUser(context);
        prisma.activityGoal.findFirst.mockResolvedValue(goalRow(user.id));

        const response = await request(server())
          .patch(`/api/goals/${GOAL}`)
          .set(authHeader(user.accessToken))
          .set('If-Match', '3')
          .send({ period: 'day' })
          .expect(400);
        expect(response.body.details.reason).toBe('INVALID_GOAL');
      });

      it('refuses to edit an archived goal with 409 GOAL_ARCHIVED', async () => {
        const user = await createMockContributorUser(context);
        prisma.activityGoal.findFirst.mockResolvedValue(goalRow(user.id, { status: 'archived' }));

        const response = await request(server())
          .patch(`/api/goals/${GOAL}`)
          .set(authHeader(user.accessToken))
          .set('If-Match', '3')
          .send({ title: 'New' })
          .expect(409);
        expect(response.body.details.reason).toBe('GOAL_ARCHIVED');
      });
    });

    describe('transitions', () => {
      it('pauses an active goal and bumps the version', async () => {
        const user = await createMockContributorUser(context);
        prisma.activityGoal.findFirst.mockResolvedValue(goalRow(user.id));
        prisma.activityGoal.update.mockImplementation(async ({ data }: any) => goalRow(user.id, { status: data.status, version: 4 }));

        const response = await request(server()).post(`/api/goals/${GOAL}/pause`).set(authHeader(user.accessToken)).expect(200);
        expect(response.body.data).toMatchObject({ status: 'paused', version: 4 });
        expect(prisma.activityGoal.update).toHaveBeenCalledWith({
          where: { id: GOAL },
          data: { status: 'paused', version: { increment: 1 } },
        });
      });

      it('resuming counts against the cap (409 GOAL_LIMIT_REACHED)', async () => {
        const user = await createMockContributorUser(context);
        prisma.activityGoal.findFirst.mockResolvedValue(goalRow(user.id, { status: 'paused' }));
        prisma.activityGoal.count.mockResolvedValue(10);

        const response = await request(server()).post(`/api/goals/${GOAL}/resume`).set(authHeader(user.accessToken)).expect(409);
        expect(response.body.details.reason).toBe('GOAL_LIMIT_REACHED');
        expect(prisma.activityGoal.update).not.toHaveBeenCalled();
      });

      it('an archived goal cannot be resumed (409 GOAL_ILLEGAL_TRANSITION)', async () => {
        const user = await createMockContributorUser(context);
        prisma.activityGoal.findFirst.mockResolvedValue(goalRow(user.id, { status: 'archived' }));

        const response = await request(server()).post(`/api/goals/${GOAL}/resume`).set(authHeader(user.accessToken)).expect(409);
        expect(response.body.details.reason).toBe('GOAL_ILLEGAL_TRANSITION');
      });

      it('asking for the current state is a no-op', async () => {
        const user = await createMockContributorUser(context);
        prisma.activityGoal.findFirst.mockResolvedValue(goalRow(user.id, { status: 'archived' }));

        await request(server()).post(`/api/goals/${GOAL}/archive`).set(authHeader(user.accessToken)).expect(200);
        expect(prisma.activityGoal.update).not.toHaveBeenCalled();
      });
    });

    describe('progress', () => {
      it('evaluates active goals with superseded flags', async () => {
        const user = await createMockContributorUser(context);
        prisma.activityGoal.findMany.mockResolvedValue([goalRow(user.id, { startsOn: new Date('2026-01-01T00:00:00Z') })]);
        prisma.activityEntry.findMany.mockResolvedValue([
          entryRow(user.id, { id: 'a0000000-0000-4000-8000-000000000001' }),
          entryRow(user.id, { id: 'a0000000-0000-4000-8000-000000000002', source: 'workout', workoutId: WORKOUT }),
        ]);

        const response = await request(server())
          .get(`/api/goals/progress?date=${TODAY}`)
          .set(authHeader(user.accessToken))
          .expect(200);

        const [progress] = response.body.data;
        expect(progress).toMatchObject({ goalId: GOAL, done: 1, target: 4, remaining: 3, hit: false });
        expect(progress).not.toHaveProperty('elapsedFraction');
        expect(progress.entries.map((e: any) => e.superseded)).toEqual([true, false]);
        expect(prisma.activityGoal.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: { userId: user.id, status: 'active' } }),
        );
      });

      it('refuses a date far in the future', async () => {
        const user = await createMockContributorUser(context);
        const response = await request(server())
          .get('/api/goals/progress?date=2099-01-01')
          .set(authHeader(user.accessToken))
          .expect(400);
        expect(response.body.details.reason).toBe('DATE_OUT_OF_RANGE');
      });

      it('history: limit is bounded and the goal must be the caller\'s', async () => {
        const user = await createMockContributorUser(context);
        await request(server()).get(`/api/goals/${GOAL}/history?limit=0`).set(authHeader(user.accessToken)).expect(400);
        prisma.activityGoal.findFirst.mockResolvedValue(null);
        await request(server()).get(`/api/goals/${GOAL}/history`).set(authHeader(user.accessToken)).expect(404);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Activity entries
  // ---------------------------------------------------------------------------

  describe('activity entries', () => {
    it('creates an "I did it" entry today as manual, whatever the client sends', async () => {
      const user = await createMockContributorUser(context);
      prisma.activityEntry.create.mockImplementation(async ({ data }: any) => entryRow(user.id, data));

      const response = await request(server())
        .post('/api/activity-entries')
        .set(authHeader(user.accessToken))
        .send({ activityKind: 'walk' })
        .expect(201);

      expect(response.body.data).toMatchObject({ occurredOn: TODAY, completed: true, source: 'manual' });
      expect(prisma.activityEntry.create.mock.calls[0][0].data).toMatchObject({ userId: user.id, source: 'manual' });
    });

    it('refuses a client-claimed source (unknown field)', async () => {
      const user = await createMockContributorUser(context);
      await request(server())
        .post('/api/activity-entries')
        .set(authHeader(user.accessToken))
        .send({ activityKind: 'walk', source: 'integration' })
        .expect(400);
    });

    it.each([
      ['8 days back', daysAgo(8)],
      ['tomorrow', daysAgo(-1)],
    ])('refuses a day %s with 400 ENTRY_DATE_OUT_OF_RANGE', async (_label, occurredOn) => {
      const user = await createMockContributorUser(context);
      const response = await request(server())
        .post('/api/activity-entries')
        .set(authHeader(user.accessToken))
        .send({ activityKind: 'walk', occurredOn })
        .expect(400);
      expect(response.body.details.reason).toBe('ENTRY_DATE_OUT_OF_RANGE');
      expect(prisma.activityEntry.create).not.toHaveBeenCalled();
    });

    it('accepts exactly 7 days back', async () => {
      const user = await createMockContributorUser(context);
      prisma.activityEntry.create.mockImplementation(async ({ data }: any) => entryRow(user.id, data));
      await request(server())
        .post('/api/activity-entries')
        .set(authHeader(user.accessToken))
        .send({ activityKind: 'walk', occurredOn: daysAgo(7) })
        .expect(201);
    });

    it.each([
      ['a steps entry without steps', { activityKind: 'steps' }],
      ['steps above 200000', { activityKind: 'steps', steps: 200_001 }],
      ['a duration above a day', { activityKind: 'walk', durationSeconds: 86_401 }],
      ['a note over 280 characters', { activityKind: 'walk', note: 'x'.repeat(281) }],
    ])('refuses %s with 400', async (_label, body) => {
      const user = await createMockContributorUser(context);
      await request(server()).post('/api/activity-entries').set(authHeader(user.accessToken)).send(body).expect(400);
    });

    it('refuses a list range over 400 days', async () => {
      const user = await createMockContributorUser(context);
      const response = await request(server())
        .get('/api/activity-entries?from=2025-01-01&to=2026-02-15')
        .set(authHeader(user.accessToken))
        .expect(400);
      expect(response.body.details.reason).toBe('RANGE_TOO_LARGE');
    });

    it.each([
      ['patch', { note: 'x' }],
      ['delete', undefined],
    ] as const)('%s on a workout-derived entry is 409 ENTRY_DERIVED', async (method, body) => {
      const user = await createMockContributorUser(context);
      prisma.activityEntry.findFirst.mockResolvedValue(entryRow(user.id, { source: 'workout', workoutId: WORKOUT }));

      const response = await request(server())
        [method](`/api/activity-entries/${ENTRY}`)
        .set(authHeader(user.accessToken))
        .send(body as object)
        .expect(409);

      expect(response.body.details).toMatchObject({ reason: 'ENTRY_DERIVED', source: 'workout', workoutId: WORKOUT });
      expect(prisma.activityEntry.updateMany).not.toHaveBeenCalled();
      expect(prisma.activityEntry.deleteMany).not.toHaveBeenCalled();
    });

    it('deletes a manual entry with 204; another user\'s is 404', async () => {
      const user = await createMockContributorUser(context);
      prisma.activityEntry.findFirst.mockResolvedValueOnce(entryRow(user.id));
      prisma.activityEntry.deleteMany.mockResolvedValue({ count: 1 });
      await request(server()).delete(`/api/activity-entries/${ENTRY}`).set(authHeader(user.accessToken)).expect(204);
      expect(prisma.activityEntry.deleteMany).toHaveBeenCalledWith({ where: { id: ENTRY, userId: user.id, source: 'manual' } });

      prisma.activityEntry.findFirst.mockResolvedValueOnce(null);
      await request(server()).delete(`/api/activity-entries/${ENTRY}`).set(authHeader(user.accessToken)).expect(404);
    });

    it('batch: refuses 0 and 501 entries, and an out-of-window day with its index', async () => {
      const user = await createMockContributorUser(context);
      const post = (body: unknown) =>
        request(server()).post('/api/activity-entries/batch').set(authHeader(user.accessToken)).send(body as object);

      await post({ entries: [] }).expect(400);
      await post({ entries: Array.from({ length: 501 }, () => ({ activityKind: 'walk' })) }).expect(400);
      const response = await post({ entries: [{ activityKind: 'walk' }, { activityKind: 'walk', occurredOn: daysAgo(30) }] }).expect(400);
      expect(response.body.details).toMatchObject({ reason: 'ENTRY_DATE_OUT_OF_RANGE', path: 'entries.1.occurredOn' });
    });

    it('batch: inserts plain rows and upserts keyed ones, counting each', async () => {
      const user = await createMockContributorUser(context);
      prisma.activityEntry.createMany.mockResolvedValue({ count: 1 });
      prisma.$queryRaw.mockResolvedValueOnce([{ inserted: true }]).mockResolvedValueOnce([{ inserted: false }]);

      const response = await request(server())
        .post('/api/activity-entries/batch')
        .set(authHeader(user.accessToken))
        .send({
          entries: [
            { activityKind: 'walk' },
            { activityKind: 'steps', steps: 4000, provider: 'p', externalId: 'a' },
            { activityKind: 'steps', steps: 5000, provider: 'p', externalId: 'b' },
            // Same pair again: the last occurrence wins, one statement.
            { activityKind: 'steps', steps: 6000, provider: 'p', externalId: 'b' },
          ],
        })
        .expect(200);

      expect(response.body.data).toEqual({ created: 2, updated: 1 });
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
      expect(prisma.activityEntry.createMany.mock.calls[0][0].data[0]).toMatchObject({ userId: user.id, source: 'manual' });
    });
  });
});
