// =============================================================================
// /api/ai/training/runs and /api/ai/training/stream over HTTP
// =============================================================================
//
// The real controller, guards (AiEnabledGuard, JWT, ai:use) and the real
// `TrainingRunsService`, over the in-memory run table and event log. The kill
// switch and RBAC suites cover these routes by discovery; this suite checks
// ownership (another user's run is a 404 on every route that takes a run id),
// the start route's refusals and 202, that no response carries the request's
// free text, the job id (outside the start's own answer) or a key, and the
// SSE replay over a real socket.
// =============================================================================

import { randomUUID } from 'node:crypto';

import { Prisma } from '@prisma/client';
import request from 'supertest';

import { HARNESS_OTHER_USER, HARNESS_USER, HARNESS_USER_KEY, HARNESS_ORG_KEY } from '../../src/ai/testing/ai-runtime-harness';
import { TRAINING_AGENT_ROLES } from '../../src/common/schemas/settings.schema';
import { TRAINING_GRAPH_READY } from '../../src/training-agents/graph/training-graphs';
import type { RoleResolution } from '../../src/training-agents/models/dto/role-resolution.dto';
import { RunEventsService } from '../../src/training-agents/runtime/run-events.service';
import { ACTIVE_RUN_INDEX_NAME } from '../../src/training-agents/runtime/training-runs.constants';
import { TrainingRunsService } from '../../src/training-agents/runtime/training-runs.service';
import { InMemoryRunEventLog } from '../../src/training-agents/testing/in-memory-run-event-log';
import { createInMemoryTrainingPrisma } from '../../src/training-agents/testing/in-memory-training-prisma';
import { authHeader, createMockTestUser, createMockViewerUser, type TestUser } from '../helpers/auth-mock.helper';
import { ALL_KEYS, createAiHttpTestApp, parseSse, type AiHttpTestApp } from './ai-http.helper';

const FREE_TEXT = 'my-secret-free-text-about-my-knee';

const ready = (role: string): RoleResolution =>
  ({
    role,
    state: 'ready',
    model: { provider: 'openai', modelId: 'fake-model', displayName: 'Fake', keySource: 'user' },
    needs: [],
    requestedEffort: 'high',
    effectiveEffort: 'high',
    fix: null,
  }) as RoleResolution;

describe('/api/ai/training/runs and /stream', () => {
  let t: AiHttpTestApp;
  let alice: TestUser;
  let bob: TestUser;
  let db: ReturnType<typeof createInMemoryTrainingPrisma>;
  let events: InMemoryRunEventLog;
  let roles: Record<string, RoleResolution>;
  let jobs: { enqueueWithin: jest.Mock };
  let service: TrainingRunsService;
  let savedReady: typeof TRAINING_GRAPH_READY;

  // The overrides are fixed at app creation; they forward to per-test state.
  const runsProxy = {
    create: (...a: unknown[]) => (service.create as (...x: unknown[]) => unknown)(...a),
    list: (...a: unknown[]) => (service.list as (...x: unknown[]) => unknown)(...a),
    get: (...a: unknown[]) => (service.get as (...x: unknown[]) => unknown)(...a),
    statusOf: (...a: unknown[]) => (service.statusOf as (...x: unknown[]) => unknown)(...a),
    cancel: (...a: unknown[]) => (service.cancel as (...x: unknown[]) => unknown)(...a),
    resume: (...a: unknown[]) => (service.resume as (...x: unknown[]) => unknown)(...a),
    decide: (...a: unknown[]) => (service.decide as (...x: unknown[]) => unknown)(...a),
    requeue: (...a: unknown[]) => (service.requeue as (...x: unknown[]) => unknown)(...a),
  };
  const eventsProxy = {
    append: (...a: unknown[]) => (events.append as (...x: unknown[]) => unknown)(...a),
    emit: (...a: unknown[]) => (events.emit as (...x: unknown[]) => unknown)(...a),
    list: (...a: unknown[]) => (events.list as (...x: unknown[]) => unknown)(...a),
  };

  beforeAll(async () => {
    t = await createAiHttpTestApp(
      {},
      {
        overrideProviders: [
          { provide: TrainingRunsService, useValue: runsProxy },
          { provide: RunEventsService, useValue: eventsProxy },
        ],
      },
    );
  }, 60_000);

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.reset();
    savedReady = { ...TRAINING_GRAPH_READY };

    db = createInMemoryTrainingPrisma();
    events = new InMemoryRunEventLog();
    roles = Object.fromEntries(TRAINING_AGENT_ROLES.map((r) => [r, ready(r)]));
    jobs = { enqueueWithin: jest.fn(async () => ({ id: randomUUID() })) };

    // The partial unique index: one active run per user.
    const create = db.prisma.trainingPlanRun.create.getMockImplementation()!;
    db.prisma.trainingPlanRun.create.mockImplementation(async (args: { data: Partial<{ userId: string; status: string }> }) => {
      const active = [...db.runs.values()].some(
        (r) => r.userId === args.data.userId && ['queued', 'running', 'awaiting_approval'].includes(r.status),
      );
      if (active && (args.data.status ?? 'queued') !== 'blocked_safety') {
        throw new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'x',
          meta: { target: ACTIVE_RUN_INDEX_NAME },
        });
      }
      return create(args);
    });

    service = new TrainingRunsService(
      db.prisma as never,
      jobs as never,
      {
        resolveForRun: async () => ({
          roles,
          settings: { training: { maxRunTokens: 50_000, maxCriticRounds: 3 } },
          limits: () => ({ contextWindow: 128_000, maxOutputTokens: 16_384 }),
        }),
      } as never,
      events as never,
      { screen: async () => ({ stop: false as const }) },
    );

    alice = await createMockTestUser(t.context, { id: HARNESS_USER, roleName: 'contributor' });
    bob = await createMockTestUser(t.context, { id: HARNESS_OTHER_USER, roleName: 'contributor' });
  });

  afterEach(() => {
    Object.assign(TRAINING_GRAPH_READY, savedReady);
  });

  const server = () => t.context.app.getHttpServer();
  const as = (u: TestUser) => authHeader(u.accessToken);

  const seedRun = (userId: string, over: Record<string, unknown> = {}) =>
    db.add({ userId, input: { request: { instruction: FREE_TEXT }, maxCriticRounds: 2 }, jobId: randomUUID(), ...over } as never);

  describe('auth matrix', () => {
    it('401 without a token, 403 for a viewer, on every route', async () => {
      const viewer = await createMockViewerUser(t.context);
      const id = randomUUID();
      const routes: Array<['get' | 'post', string, object?]> = [
        ['post', '/api/ai/training/runs', { kind: 'create', input: {} }],
        ['get', '/api/ai/training/runs'],
        ['get', `/api/ai/training/runs/${id}`],
        ['post', `/api/ai/training/runs/${id}/cancel`],
        ['post', `/api/ai/training/runs/${id}/resume`],
        ['post', `/api/ai/training/runs/${id}/decision`, { decision: 'approve' }],
        ['get', `/api/ai/training/stream/${id}`],
      ];

      for (const [method, url, body] of routes) {
        await request(server())[method](url).send(body).expect(401);
        await request(server())[method](url).set(as(viewer)).send(body).expect(403);
      }
    });
  });

  describe('ownership: another user\'s run is a 404', () => {
    it('get, cancel, resume, decision and stream all answer 404, and change nothing', async () => {
      const mine = seedRun(alice.id, { status: 'awaiting_approval' });
      const before = JSON.stringify(db.get(mine.id));

      const responses = [
        await request(server()).get(`/api/ai/training/runs/${mine.id}`).set(as(bob)).expect(404),
        await request(server()).post(`/api/ai/training/runs/${mine.id}/cancel`).set(as(bob)).expect(404),
        await request(server()).post(`/api/ai/training/runs/${mine.id}/resume`).set(as(bob)).expect(404),
        await request(server())
          .post(`/api/ai/training/runs/${mine.id}/decision`)
          .set(as(bob))
          .send({ decision: 'approve' })
          .expect(404),
        await request(server()).get(`/api/ai/training/stream/${mine.id}`).set(as(bob)).expect(404),
      ];

      for (const res of responses) expect(res.headers['content-type']).toMatch(/json/);
      expect(JSON.stringify(db.get(mine.id))).toBe(before);
      // Indistinguishable from a run that does not exist.
      const missing = await request(server()).get(`/api/ai/training/runs/${randomUUID()}`).set(as(bob)).expect(404);
      expect(missing.body.message ?? missing.body.error?.message).toBe(
        responses[0].body.message ?? responses[0].body.error?.message,
      );
    });

    it('the owner still reads it, and the list holds only the caller\'s runs', async () => {
      const mine = seedRun(alice.id, { status: 'succeeded' });
      seedRun(bob.id, { status: 'succeeded' });

      await request(server()).get(`/api/ai/training/runs/${mine.id}`).set(as(alice)).expect(200);
      const list = await request(server()).get('/api/ai/training/runs').set(as(alice)).expect(200);

      expect((list.body.items ?? list.body.data.items ?? list.body.data).map((r: { id: string }) => r.id)).toEqual([mine.id]);
    });
  });

  describe('POST /runs', () => {
    it('501 TRAINING_NOT_IMPLEMENTED while the graph is stubbed, and creates nothing', async () => {
      const res = await request(server())
        .post('/api/ai/training/runs')
        .set(as(alice))
        .send({ kind: 'create', input: { instruction: FREE_TEXT } })
        .expect(501);

      expect(JSON.stringify(res.body)).toContain('TRAINING_NOT_IMPLEMENTED');
      expect(db.runs.size).toBe(0);
      expect(jobs.enqueueWithin).not.toHaveBeenCalled();
    });

    it('202 { runId, jobId, status: queued } once the graph is ready, with no free text or key anywhere', async () => {
      TRAINING_GRAPH_READY.create = true;

      const res = await request(server())
        .post('/api/ai/training/runs')
        .set(as(alice))
        .send({ kind: 'revise', input: { instruction: FREE_TEXT } })
        .expect(202);

      expect(res.body.data).toEqual({ runId: expect.any(String), jobId: expect.any(String), status: 'queued' });
      expect(db.get(res.body.data.runId)).toMatchObject({ userId: alice.id, status: 'queued' });

      const body = JSON.stringify(res.body);
      expect(body).not.toContain(FREE_TEXT);
      for (const key of ALL_KEYS) expect(body).not.toContain(key);
    });

    it('409 TRAINING_RUN_ACTIVE names the run in progress', async () => {
      TRAINING_GRAPH_READY.create = true;
      const active = seedRun(alice.id, { status: 'running' });

      const res = await request(server())
        .post('/api/ai/training/runs')
        .set(as(alice))
        .send({ kind: 'create', input: {} })
        .expect(409);

      expect(JSON.stringify(res.body)).toContain('TRAINING_RUN_ACTIVE');
      expect(JSON.stringify(res.body)).toContain(active.id);
      // Another user is not blocked by it.
      await request(server()).post('/api/ai/training/runs').set(as(bob)).send({ kind: 'create', input: {} }).expect(202);
    });

    it('409 TRAINING_ROLE_UNAVAILABLE names the role and its state', async () => {
      TRAINING_GRAPH_READY.evaluate = true;
      roles.evaluator = { ...ready('evaluator'), state: 'no_key', model: undefined } as RoleResolution;

      const res = await request(server())
        .post('/api/ai/training/runs')
        .set(as(alice))
        .send({ kind: 'evaluate', input: {} })
        .expect(409);

      const body = JSON.stringify(res.body);
      expect(body).toContain('TRAINING_ROLE_UNAVAILABLE');
      expect(body).toContain('evaluator');
      expect(body).toContain('no_key');
      expect(db.runs.size).toBe(0);
    });
  });

  describe('responses never carry the request, the job id or a key', () => {
    it('get, list, cancel and decision views omit input free text, jobId and keys', async () => {
      const paused = seedRun(alice.id, { status: 'awaiting_approval', expiresAt: new Date(Date.now() + 60_000) });
      const queued = seedRun(alice.id, { status: 'succeeded' });
      const bodies: unknown[] = [
        (await request(server()).get(`/api/ai/training/runs/${queued.id}`).set(as(alice)).expect(200)).body,
        (await request(server()).get('/api/ai/training/runs').set(as(alice)).expect(200)).body,
        (await request(server()).post(`/api/ai/training/runs/${queued.id}/cancel`).set(as(alice)).expect(200)).body,
      ];
      jobs.enqueueWithin.mockImplementation(async () => ({ id: randomUUID() }));
      bodies.push(
        (
          await request(server())
            .post(`/api/ai/training/runs/${paused.id}/decision`)
            .set(as(alice))
            .send({ decision: 'approve', note: FREE_TEXT })
            .expect(202)
        ).body,
      );

      const newJob = db.get(paused.id)!.jobId!;

      for (const body of bodies) {
        const text = JSON.stringify(body);
        expect(text).not.toContain(FREE_TEXT);
        expect(text).not.toContain(queued.jobId!);
        expect(text).not.toContain(paused.jobId!);
        expect(text).not.toContain(newJob);
        expect(text).not.toMatch(/"jobIds?"/);
        for (const key of [HARNESS_USER_KEY, HARNESS_ORG_KEY, ...ALL_KEYS]) expect(text).not.toContain(key);
      }
    });
  });

  describe('GET /stream/:runId (SSE)', () => {
    const appendAll = async (runId: string) => {
      await events.append(runId, 'run.queued', { kind: 'create', trigger: 'user' });
      await events.append(runId, 'run.started', { kind: 'create' });
      await events.append(runId, 'stage.started', { node: 'prepare_context' });
      await events.append(runId, 'run.completed', {
        status: 'succeeded',
        tokens: { calls: 1, inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
      });
    };

    const read = async (path: string, headers: Record<string, string> = {}) => {
      const res = await fetch(`${t.baseUrl}${path}`, { headers: { ...as(alice), ...headers } });
      return { res, text: await res.text() };
    };

    it('replays everything for a terminal run and ends with event: end', async () => {
      const run = seedRun(alice.id, { status: 'succeeded' });
      await appendAll(run.id);

      const { res, text } = await read(`/api/ai/training/stream/${run.id}`);
      const frames = parseSse(text).filter((f) => !f.comment);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
      expect(frames.map((f) => f.event)).toEqual(['run.queued', 'run.started', 'stage.started', 'run.completed', 'end']);
      expect(frames.at(-1)!.data).toEqual({ status: 'succeeded' });
      expect(text).toContain('id: 1\n');
      expect(text).toContain('id: 4\n');
    });

    it('replays only events after ?after= and after Last-Event-ID', async () => {
      const run = seedRun(alice.id, { status: 'succeeded' });
      await appendAll(run.id);

      const afterQuery = await read(`/api/ai/training/stream/${run.id}?after=2`);
      expect(parseSse(afterQuery.text).filter((f) => !f.comment).map((f) => f.event)).toEqual([
        'stage.started',
        'run.completed',
        'end',
      ]);

      const afterHeader = await read(`/api/ai/training/stream/${run.id}`, { 'Last-Event-ID': '3' });
      expect(parseSse(afterHeader.text).filter((f) => !f.comment).map((f) => f.event)).toEqual(['run.completed', 'end']);

      const drained = await read(`/api/ai/training/stream/${run.id}?after=4`);
      expect(parseSse(drained.text).filter((f) => !f.comment).map((f) => f.event)).toEqual(['end']);
      expect(drained.text).not.toContain(FREE_TEXT);
    });
  });
});
