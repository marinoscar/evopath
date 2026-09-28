// =============================================================================
// Background AI runs over HTTP Integration (issue #433, epic #419)
// =============================================================================
//
//   POST /api/ai/runs                  202 { runId, jobId }
//   GET  /api/ai/runs/:runId           the caller's run
//   POST /api/ai/runs/:runId/cancel    the caller's run, cancelled
//
//   * `ai:use` + `AiEnabledGuard`: 403 AI_DISABLED on every route while off.
//   * Gates run at enqueue time: an unusable request is the same JSON error
//     the synchronous route answers, and nothing is queued.
//   * Runs are isolated per user: another user's run id is a 404.
//   * The published view carries neither the stored prompt nor any key.
// =============================================================================

import request from 'supertest';

import { PERMISSIONS_KEY } from '../../src/auth/decorators/permissions.decorator';
import { AiEnabledGuard } from '../../src/ai/config/ai-enabled.guard';
import { AiRunsController } from '../../src/ai/http/ai-runs.controller';
import { AI_RESPONSE_RUN_TYPE } from '../../src/ai/runtime/ai-runs.service';
import { HARNESS_MODEL, HARNESS_OTHER_USER, HARNESS_USER } from '../../src/ai/testing/ai-runtime-harness';
import { authHeader, createMockTestUser, TestUser } from '../helpers/auth-mock.helper';
import { ALL_KEYS, AiHttpTestApp, OTHER_USER_KEY, createAiHttpTestApp } from './ai-http.helper';

const SECRET_PROMPT = 'confidential prompt text 7f3a';

describe('AI background runs HTTP API Integration', () => {
  let t: AiHttpTestApp;
  let alice: TestUser;
  let bob: TestUser;
  let bodies: string[];

  beforeAll(async () => {
    t = await createAiHttpTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.reset();
    bodies = [];
    alice = await createMockTestUser(t.context, { id: HARNESS_USER, roleName: 'contributor' });
    bob = await createMockTestUser(t.context, { id: HARNESS_OTHER_USER, roleName: 'contributor' });
  });

  afterEach(() => {
    for (const body of bodies) {
      for (const key of ALL_KEYS) {
        expect(body).not.toContain(key);
      }
    }
  });

  function server() {
    return t.context.app.getHttpServer();
  }

  function record(res: request.Response): request.Response {
    bodies.push(res.text);
    return res;
  }

  const body = { model: HARNESS_MODEL, input: SECRET_PROMPT };

  async function start(user: TestUser = alice): Promise<string> {
    const res = record(
      await request(server()).post('/api/ai/runs').set(authHeader(user.accessToken)).send(body).expect(202),
    );
    return res.body.data.runId;
  }

  describe('guards', () => {
    it.each([['start'], ['get'], ['cancel']] as Array<[keyof AiRunsController]>)('%s requires exactly ai:use', (h) => {
      expect(Reflect.getMetadata(PERMISSIONS_KEY, AiRunsController.prototype[h])).toEqual(['ai:use']);
    });

    it('carries AiEnabledGuard on the controller', () => {
      expect(Reflect.getMetadata('__guards__', AiRunsController)).toContain(AiEnabledGuard);
    });

    it('403 AI_DISABLED on every route while AI is off', async () => {
      const runId = await start();
      t.harness.setPolicy({ enabled: false });

      const responses = [
        await request(server()).post('/api/ai/runs').set(authHeader(alice.accessToken)).send(body),
        await request(server()).get(`/api/ai/runs/${runId}`).set(authHeader(alice.accessToken)),
        await request(server()).post(`/api/ai/runs/${runId}/cancel`).set(authHeader(alice.accessToken)),
      ];

      for (const res of responses) {
        record(res);
        expect(res.status).toBe(403);
        expect(res.body.details.reason).toBe('AI_DISABLED');
      }
      expect(t.harness.enqueued).toHaveLength(1);
      expect(t.harness.runRows[0].status).toBe('pending');
    });

    it('401 without a token', async () => {
      await request(server()).post('/api/ai/runs').send(body).expect(401);
      await request(server()).get('/api/ai/runs/00000000-0000-4000-8000-000000000000').expect(401);
    });
  });

  describe('POST /api/ai/runs', () => {
    it('queues one ai.response.run job and answers 202 { runId, jobId }', async () => {
      const res = record(
        await request(server()).post('/api/ai/runs').set(authHeader(alice.accessToken)).send(body).expect(202),
      );

      expect(res.body.data).toEqual({ runId: expect.any(String), jobId: expect.any(String) });
      expect(t.harness.enqueued).toEqual([
        expect.objectContaining({ id: res.body.data.jobId, type: AI_RESPONSE_RUN_TYPE, subjectId: res.body.data.runId }),
      ]);
      expect(t.harness.runRows[0]).toMatchObject({ userId: HARNESS_USER, status: 'pending', modelId: HARNESS_MODEL });
      // Queued, not executed: no provider call yet.
      expect(t.harness.fake.calls).toHaveLength(0);
    });

    it('stores a structured-output JSON Schema so the job can rebuild it', async () => {
      const jsonSchema = {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false,
      };

      record(
        await request(server())
          .post('/api/ai/runs')
          .set(authHeader(alice.accessToken))
          .send({ ...body, structuredOutput: { name: 'answer', jsonSchema, strict: true } })
          .expect(202),
      );

      expect(t.harness.runRows[0].request).toMatchObject({
        structuredOutput: { name: 'answer', strict: true, jsonSchema: expect.objectContaining({ type: 'object' }) },
      });
    });

    it('refuses an unusable request at enqueue time with the synchronous route’s error', async () => {
      const res = record(
        await request(server()).post('/api/ai/runs').set(authHeader(bob.accessToken)).send(body).expect(403),
      );

      expect(res.body.details.reason).toBe('AI_KEY_REQUIRED');
      expect(t.harness.enqueued).toHaveLength(0);
    });

    it('400 AI_INVALID_REQUEST when background runs are disabled', async () => {
      t.harness.setPolicy({ defaults: { allowBackgroundRuns: false, allowRealtime: false } });

      const res = record(
        await request(server()).post('/api/ai/runs').set(authHeader(alice.accessToken)).send(body).expect(400),
      );

      expect(res.body.details.reason).toBe('AI_INVALID_REQUEST');
      expect(t.harness.enqueued).toHaveLength(0);
    });

    it('refuses function tools with 400', async () => {
      record(
        await request(server())
          .post('/api/ai/runs')
          .set(authHeader(alice.accessToken))
          .send({ ...body, tools: [{ type: 'function', name: 'x' }] })
          .expect(400),
      );
      expect(t.harness.enqueued).toHaveLength(0);
    });
  });

  describe('GET /api/ai/runs/:runId', () => {
    it('returns the owner’s run without the stored prompt or job internals', async () => {
      const runId = await start();

      const res = record(
        await request(server()).get(`/api/ai/runs/${runId}`).set(authHeader(alice.accessToken)).expect(200),
      );

      expect(res.body.data).toEqual({
        id: runId,
        status: 'pending',
        provider: 'openai',
        modelId: HARNESS_MODEL,
        output: null,
        errorCode: null,
        errorMessage: null,
        createdAt: expect.any(String),
        completedAt: null,
      });
      expect(res.text).not.toContain(SECRET_PROMPT);
    });

    it('returns the completed response once the run succeeded', async () => {
      const runId = await start();
      await t.harness.runs.claim(runId, t.harness.enqueued[0].id);
      const output = await t.harness.ai.forUser(HARNESS_USER).respond({ model: HARNESS_MODEL, input: 'hi' });
      await t.harness.runs.complete(runId, output);

      const res = record(
        await request(server()).get(`/api/ai/runs/${runId}`).set(authHeader(alice.accessToken)).expect(200),
      );

      expect(res.body.data).toMatchObject({ status: 'succeeded', output: { outputText: 'fake: hi' } });
      expect(new Date(res.body.data.completedAt).getTime()).not.toBeNaN();
    });

    it('404 for another user’s run — indistinguishable from a missing one', async () => {
      t.harness.addUserKey(HARNESS_OTHER_USER, OTHER_USER_KEY, [HARNESS_MODEL]);
      const aliceRun = await start(alice);

      const foreign = record(
        await request(server()).get(`/api/ai/runs/${aliceRun}`).set(authHeader(bob.accessToken)).expect(404),
      );
      const missing = record(
        await request(server())
          .get('/api/ai/runs/00000000-0000-4000-8000-000000000000')
          .set(authHeader(bob.accessToken))
          .expect(404),
      );

      expect(foreign.body.message).toBe(missing.body.message);
      expect(foreign.text).not.toContain(SECRET_PROMPT);
    });

    it('404 for a malformed id', async () => {
      record(await request(server()).get('/api/ai/runs/not-a-uuid').set(authHeader(alice.accessToken)).expect(404));
    });
  });

  describe('POST /api/ai/runs/:runId/cancel', () => {
    it('cancels the owner’s pending run (200) and is idempotent', async () => {
      const runId = await start();

      const first = record(
        await request(server()).post(`/api/ai/runs/${runId}/cancel`).set(authHeader(alice.accessToken)).expect(200),
      );
      const again = record(
        await request(server()).post(`/api/ai/runs/${runId}/cancel`).set(authHeader(alice.accessToken)).expect(200),
      );

      expect(first.body.data).toMatchObject({ id: runId, status: 'cancelled', completedAt: expect.any(String) });
      expect(again.body.data.status).toBe('cancelled');
    });

    it('404 — and no change — for another user’s run', async () => {
      const runId = await start(alice);

      record(await request(server()).post(`/api/ai/runs/${runId}/cancel`).set(authHeader(bob.accessToken)).expect(404));

      expect(t.harness.runRows[0].status).toBe('pending');
    });
  });
});
