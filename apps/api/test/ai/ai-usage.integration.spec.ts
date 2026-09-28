// =============================================================================
// AI usage aggregates over HTTP (issue #443, epic #420)
// =============================================================================
//
// The real controllers, guards (`AiEnabledGuard`, JWT, `ai:use` /
// `ai_config:read`), Zod query pipe and `AiUsageService`, over the mocked
// Prisma client. What is asserted here is the HTTP contract and the SCOPING —
// which user id reaches the SQL — not the SQL arithmetic, which
// `ai-usage.db.spec.ts` checks against a real Postgres.
// =============================================================================

import type { Prisma } from '@prisma/client';
import request from 'supertest';

import { PERMISSIONS_KEY } from '../../src/auth/decorators/permissions.decorator';
import { AiEnabledGuard } from '../../src/ai/config/ai-enabled.guard';
import { HARNESS_OTHER_USER, HARNESS_USER } from '../../src/ai/testing/ai-runtime-harness';
import { AiUsageAdminController } from '../../src/ai/usage/ai-usage-admin.controller';
import { AiUsageController } from '../../src/ai/usage/ai-usage.controller';
import { authHeader, createMockTestUser, TestUser } from '../helpers/auth-mock.helper';
import { AiHttpTestApp, createAiHttpTestApp } from './ai-http.helper';

function aggRow(key: string | null, requests: number, isTotal = 0) {
  return {
    is_total: isTotal,
    key,
    requests,
    failed: 0,
    input_tokens: requests * 10,
    output_tokens: requests * 5,
    reasoning_tokens: 0,
    cached_input_tokens: 0,
    org_requests: 0,
    org_input_tokens: 0,
    org_output_tokens: 0,
  };
}

describe('AI usage aggregates HTTP API Integration', () => {
  let t: AiHttpTestApp;
  let alice: TestUser;
  let admin: TestUser;
  let queryRaw: jest.Mock;

  beforeAll(async () => {
    t = await createAiHttpTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.reset();
    alice = await createMockTestUser(t.context, { id: HARNESS_USER, roleName: 'contributor' });
    admin = await createMockTestUser(t.context, { id: HARNESS_OTHER_USER, roleName: 'admin' });
    queryRaw = t.context.prismaMock.$queryRaw as unknown as jest.Mock;
    queryRaw.mockResolvedValue([]);
  });

  function server() {
    return t.context.app.getHttpServer();
  }

  /** Every bound value of every `$queryRaw` this request issued. */
  function boundValues(): unknown[] {
    return queryRaw.mock.calls.flatMap((call) => (call[0] as Prisma.Sql).values);
  }

  describe('guards', () => {
    it('GET /api/ai/usage/me requires exactly ai:use, behind AiEnabledGuard', () => {
      expect(Reflect.getMetadata(PERMISSIONS_KEY, AiUsageController.prototype.mine)).toEqual(['ai:use']);
      expect(Reflect.getMetadata('__guards__', AiUsageController)).toContain(AiEnabledGuard);
    });

    it('GET /api/admin/ai/usage requires exactly ai_config:read and is NOT behind AiEnabledGuard', () => {
      expect(Reflect.getMetadata(PERMISSIONS_KEY, AiUsageAdminController.prototype.report)).toEqual([
        'ai_config:read',
      ]);
      expect(Reflect.getMetadata('__guards__', AiUsageAdminController) ?? []).not.toContain(AiEnabledGuard);
    });

    it('401 without a token', async () => {
      await request(server()).get('/api/admin/ai/usage').expect(401);
    });

    it('403 for a non-admin on the admin report', async () => {
      await request(server()).get('/api/admin/ai/usage').set(authHeader(alice.accessToken)).expect(403);
      expect(queryRaw).not.toHaveBeenCalled();
    });

    it('while AI is off: /me is 403 AI_DISABLED, the admin report still answers', async () => {
      t.harness.setPolicy({ enabled: false });

      const mine = await request(server()).get('/api/ai/usage/me').set(authHeader(alice.accessToken));
      expect(mine.status).toBe(403);
      expect(mine.body.details.reason).toBe('AI_DISABLED');

      await request(server()).get('/api/admin/ai/usage').set(authHeader(admin.accessToken)).expect(200);
    });
  });

  describe('GET /api/ai/usage/me', () => {
    it("answers the caller's own report, scoped to the caller in SQL", async () => {
      queryRaw
        .mockResolvedValueOnce([aggRow(null, 2, 1), aggRow('openai:fake-model', 2)])
        .mockResolvedValueOnce([]);

      const res = await request(server())
        .get('/api/ai/usage/me?groupBy=model&from=2026-09-01&to=2026-09-26')
        .set(authHeader(alice.accessToken))
        .expect(200);

      expect(res.body.data).toEqual({
        range: { from: '2026-09-01', to: '2026-09-26' },
        groupBy: 'model',
        totals: expect.objectContaining({ requests: 2, inputTokens: 20, outputTokens: 10, units: {} }),
        series: [expect.objectContaining({ key: 'openai:fake-model', label: 'fake-model', requests: 2 })],
      });
      expect(boundValues()).toContain(HARNESS_USER);
    });

    it("cannot be pointed at another user's usage: a userId parameter is ignored", async () => {
      await request(server())
        .get(`/api/ai/usage/me?userId=${HARNESS_OTHER_USER}`)
        .set(authHeader(alice.accessToken))
        .expect(200);

      expect(boundValues()).toContain(HARNESS_USER);
      expect(boundValues()).not.toContain(HARNESS_OTHER_USER);
    });

    it('defaults to a zero-filled 30-day day series', async () => {
      const res = await request(server()).get('/api/ai/usage/me').set(authHeader(alice.accessToken)).expect(200);

      expect(res.body.data.groupBy).toBe('day');
      expect(res.body.data.series).toHaveLength(30);
      expect(res.body.data.series[29].key).toBe(res.body.data.range.to);
    });

    it('refuses the admin-only groupings with 400', async () => {
      for (const groupBy of ['user', 'provider', 'keySource']) {
        await request(server())
          .get(`/api/ai/usage/me?groupBy=${groupBy}`)
          .set(authHeader(alice.accessToken))
          .expect(400);
      }
      expect(queryRaw).not.toHaveBeenCalled();
    });

    it('refuses an over-long or reversed range with 400 AI_USAGE_RANGE_INVALID', async () => {
      for (const qs of ['from=2026-01-01&to=2026-09-01', 'from=2026-09-10&to=2026-09-01']) {
        const res = await request(server()).get(`/api/ai/usage/me?${qs}`).set(authHeader(alice.accessToken));
        expect(res.status).toBe(400);
        expect(res.body.details.reason).toBe('AI_USAGE_RANGE_INVALID');
      }
    });

    it('refuses a malformed date with 400', async () => {
      await request(server()).get('/api/ai/usage/me?from=yesterday').set(authHeader(alice.accessToken)).expect(400);
    });
  });

  describe('GET /api/admin/ai/usage', () => {
    it('reports every user unless filtered, labelling user groups with their email', async () => {
      queryRaw
        .mockResolvedValueOnce([aggRow(null, 3, 1), aggRow(HARNESS_USER, 2), aggRow(HARNESS_OTHER_USER, 1)])
        .mockResolvedValueOnce([]);
      (t.context.prismaMock.user.findMany as jest.Mock).mockResolvedValueOnce([
        { id: HARNESS_USER, email: 'alice@example.com' },
        { id: HARNESS_OTHER_USER, email: 'admin@example.com' },
      ]);

      const res = await request(server())
        .get('/api/admin/ai/usage?groupBy=user')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(res.body.data.totals.requests).toBe(3);
      expect(res.body.data.series.map((s: { key: string; label: string }) => [s.key, s.label])).toEqual([
        [HARNESS_USER, 'alice@example.com'],
        [HARNESS_OTHER_USER, 'admin@example.com'],
      ]);
      expect(boundValues()).not.toContain(HARNESS_USER);
    });

    it('filters by user, provider and model', async () => {
      await request(server())
        .get(`/api/admin/ai/usage?groupBy=keySource&userId=${HARNESS_USER}&provider=openai&model=fake-model`)
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(boundValues()).toEqual(expect.arrayContaining([HARNESS_USER, 'openai', 'fake-model']));
    });

    it('refuses an unknown groupBy and a malformed userId with 400', async () => {
      await request(server()).get('/api/admin/ai/usage?groupBy=week').set(authHeader(admin.accessToken)).expect(400);
      await request(server()).get('/api/admin/ai/usage?userId=nope').set(authHeader(admin.accessToken)).expect(400);
    });
  });
});
