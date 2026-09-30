// =============================================================================
// Training agent usage routes over HTTP (E6.3)
// =============================================================================
//
//   GET /api/ai/training/runs/:runId/usage
//   GET /api/ai/training/usage?month=YYYY-MM
//
// The real controller, guards (`AiEnabledGuard`, JWT, `ai:use`) and Zod pipe
// over the mocked `PrismaService`. What the SQL returns is proved against a
// real Postgres in `test/training-usage/training-usage.db.spec.ts`; here:
// the access matrix, the 404 for a run that is not the caller's, the month
// validation, and that every statement is keyed by the CALLER's id.
// =============================================================================

import { randomUUID } from 'node:crypto';

import type { Prisma } from '@prisma/client';
import request from 'supertest';

import { authHeader, createMockTestUser, createMockViewerUser, type TestUser } from '../helpers/auth-mock.helper';
import { createAiHttpTestApp, type AiHttpTestApp } from './ai-http.helper';

const RUNS = '/api/ai/training/runs';
const MONTHLY = '/api/ai/training/usage';

describe('training agent usage routes (E6.3)', () => {
  let t: AiHttpTestApp;
  let alice: TestUser;
  let viewer: TestUser;

  const server = () => t.context.app.getHttpServer();
  const as = (user: TestUser) => authHeader(user.accessToken);
  const prisma = () => t.context.prismaMock;

  beforeAll(async () => {
    t = await createAiHttpTestApp();
  }, 60_000);

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.reset();
    alice = await createMockTestUser(t.context, { roleName: 'contributor' });
    viewer = await createMockViewerUser(t.context);
    prisma().$queryRaw.mockResolvedValue([]);
    prisma().trainingRunEvent.findMany.mockResolvedValue([]);
    prisma().trainingPlanRun.findMany.mockResolvedValue([]);
  });

  describe('GET /runs/:runId/usage', () => {
    it("is 404 for a run that is not the caller's (the lookup is keyed by the caller)", async () => {
      prisma().trainingPlanRun.findFirst.mockResolvedValue(null);
      const runId = randomUUID();

      await request(server()).get(`${RUNS}/${runId}/usage`).set(as(alice)).expect(404);

      expect(prisma().trainingPlanRun.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: runId, userId: alice.id } }),
      );
      expect(prisma().$queryRaw).not.toHaveBeenCalled();
    });

    it('answers the report for an own run, every statement keyed by the caller', async () => {
      const runId = randomUUID();
      const jobId = randomUUID();
      prisma().trainingPlanRun.findFirst.mockResolvedValue({
        id: runId,
        kind: 'adapt',
        status: 'running',
        jobId,
        tokenCap: 10_000,
        errorCode: null,
        roleModels: { planner: { provider: 'openai', modelId: 'm', effort: null, keySource: 'user' } },
        usage: { byRole: {}, byNode: {}, total: {} },
      });

      const res = await request(server()).get(`${RUNS}/${runId}/usage`).set(as(alice)).expect(200);

      expect(res.body.data).toMatchObject({
        runId,
        jobId,
        kind: 'adapt',
        status: 'running',
        byNode: [],
        cap: { limitTokens: 10_000, usedTokens: 0, reached: false },
        retention: { purged: false },
      });
      expect(res.body.data.totals.requests).toBe(0);
      for (const [sql] of prisma().$queryRaw.mock.calls as Array<[Prisma.Sql]>) {
        expect(sql.values).toContain(alice.id);
      }
      // No currency anywhere.
      expect(JSON.stringify(res.body)).not.toMatch(/price|cost|usd|eur|currency/i);
    });

    it('a malformed run id is 400', async () => {
      await request(server()).get(`${RUNS}/not-a-uuid/usage`).set(as(alice)).expect(400);
    });
  });

  describe('GET /usage', () => {
    it('defaults to the current UTC month and keys the SQL by the caller', async () => {
      const res = await request(server()).get(MONTHLY).set(as(alice)).expect(200);
      const now = new Date();
      const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

      expect(res.body.data).toMatchObject({ month, byRole: [], byModel: [], byKeySource: [], byKind: [] });
      expect(res.body.data.typical).toEqual({ create: null, revise: null, evaluate: null, adapt: null });
      expect(prisma().$queryRaw).toHaveBeenCalled();
      for (const [sql] of prisma().$queryRaw.mock.calls as Array<[Prisma.Sql]>) {
        expect(sql.values).toContain(alice.id);
      }
    });

    it('ignores a userId in the query (the DTO has none)', async () => {
      await request(server()).get(`${MONTHLY}?userId=${randomUUID()}`).set(as(alice)).expect(200);
      for (const [sql] of prisma().$queryRaw.mock.calls as Array<[Prisma.Sql]>) {
        expect(sql.values).toContain(alice.id);
      }
    });

    it.each(['2026-13', '26-01', 'soon'])('a malformed month (%s) is 400', async (month) => {
      await request(server()).get(`${MONTHLY}?month=${month}`).set(as(alice)).expect(400);
    });

    it('a future month or one more than 12 months back is 400 TRAINING_USAGE_MONTH_INVALID', async () => {
      const now = new Date();
      const future = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 7);
      const old = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 13, 1)).toISOString().slice(0, 7);

      for (const month of [future, old]) {
        const res = await request(server()).get(`${MONTHLY}?month=${month}`).set(as(alice)).expect(400);
        expect(res.body.details.reason).toBe('TRAINING_USAGE_MONTH_INVALID');
      }
    });
  });

  describe('access', () => {
    it('a viewer without ai:use is 403 on both routes', async () => {
      for (const path of [`${RUNS}/${randomUUID()}/usage`, MONTHLY]) {
        const res = await request(server()).get(path).set(as(viewer)).expect(403);
        expect(res.body.details).toBeUndefined();
      }
    });

    it('unauthenticated is 401', async () => {
      await request(server()).get(MONTHLY).expect(401);
    });

    it('AI off: 403 AI_DISABLED on both routes', async () => {
      t.harness.setPolicy({ enabled: false });
      for (const path of [`${RUNS}/${randomUUID()}/usage`, MONTHLY]) {
        const res = await request(server()).get(path).set(as(alice)).expect(403);
        expect(res.body.details.reason).toBe('AI_DISABLED');
      }
    });
  });
});
