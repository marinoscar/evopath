// =============================================================================
// /api/ai/training/models and /api/ai/training/estimate over HTTP
// =============================================================================
//
// The real controller, guards (AiEnabledGuard, JWT, ai:use) and resolver, over
// the AI runtime harness's in-memory keys, models and settings. The kill
// switch and RBAC suites cover these routes by discovery; this suite checks
// the response shapes and a few states end to end.
// =============================================================================

import request from 'supertest';

import {
  HARNESS_MODEL,
  HARNESS_USER,
  HARNESS_USER_KEY,
  HARNESS_ORG_KEY,
} from '../../src/ai/testing/ai-runtime-harness';
import { FAKE_TEXT_MODEL_CAPABILITIES } from '../../src/ai/testing/fake-ai-provider';
import { authHeader, createMockTestUser, createMockViewerUser, type TestUser } from '../helpers/auth-mock.helper';
import { createAiHttpTestApp, type AiHttpTestApp } from './ai-http.helper';

const HOSTED = {
  ...FAKE_TEXT_MODEL_CAPABILITIES,
  capabilities: [...FAKE_TEXT_MODEL_CAPABILITIES.capabilities, 'hosted_tools' as const],
};

describe('/api/ai/training (models, estimate)', () => {
  let t: AiHttpTestApp;
  let alice: TestUser;

  beforeAll(async () => {
    t = await createAiHttpTestApp(
      { models: [{ modelId: HARNESS_MODEL, capabilities: FAKE_TEXT_MODEL_CAPABILITIES }, { modelId: 'hosted', capabilities: HOSTED }] },
      { harnessTrainingResolver: true },
    );
  }, 60_000);

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.reset();
    alice = await createMockTestUser(t.context, { id: HARNESS_USER, roleName: 'contributor' });
    t.harness.setPolicy({ hostedTools: { ...t.harness.policy.hostedTools, web_search: false } });
  });

  const server = () => t.context.app.getHttpServer();

  it('GET models: every role resolved; researcher blocked while web search is off', async () => {
    const res = await request(server()).get('/api/ai/training/models').set(authHeader(alice.accessToken)).expect(200);
    const data = res.body.data;

    expect(Object.keys(data.roles).sort()).toEqual(['critic', 'evaluator', 'planner', 'researcher']);
    expect(data.roles.planner).toMatchObject({
      role: 'planner',
      state: 'auto',
      model: { provider: 'openai', keySource: 'user' },
      needs: ['responses', 'structured_output'],
      requestedEffort: 'high',
      effectiveEffort: 'high',
      fix: null,
    });
    expect(data.roles.researcher).toMatchObject({ state: 'web_search_disabled', fix: 'admin' });
    expect(data.webSearch).toEqual({ adminEnabled: false });
    expect(data.limits).toEqual({
      defaultRunTokens: { create: 400_000, revise: 400_000, evaluate: 150_000 },
      minRunTokens: 10_000,
      hardMaxRunTokens: 2_000_000,
    });
    expect(data.canRun).toEqual({
      create: false,
      revise: true,
      evaluate: true,
      blockers: [{ role: 'researcher', state: 'web_search_disabled' }],
    });

    const body = JSON.stringify(res.body);
    for (const key of [HARNESS_USER_KEY, HARNESS_ORG_KEY]) expect(body).not.toContain(key);
  });

  it('GET models: create can run once web search is on', async () => {
    t.harness.setPolicy({ hostedTools: { ...t.harness.policy.hostedTools, web_search: true } });

    const res = await request(server()).get('/api/ai/training/models').set(authHeader(alice.accessToken)).expect(200);

    expect(res.body.data.roles.researcher).toMatchObject({ state: 'auto', model: { modelId: 'hosted' } });
    expect(res.body.data.canRun).toMatchObject({ create: true, blockers: [] });
  });

  it('POST estimate: tokens, the default cap and whether it binds', async () => {
    const res = await request(server())
      .post('/api/ai/training/estimate')
      .set(authHeader(alice.accessToken))
      .send({ kind: 'evaluate', contextChars: 0 })
      .expect(200);

    expect(res.body.data).toMatchObject({ cap: 150_000, capBinding: false });
    expect(res.body.data.tokens.low).toBeLessThanOrEqual(res.body.data.tokens.high);
    expect(Object.keys(res.body.data.tokens.byRole).sort()).toEqual(['critic', 'evaluator']);
  });

  it('POST estimate: 400 on an unknown kind or out-of-range rounds', async () => {
    for (const body of [{ kind: 'nope' }, { kind: 'create', criticRounds: 4 }, { kind: 'create', contextChars: -1 }]) {
      await request(server()).post('/api/ai/training/estimate').set(authHeader(alice.accessToken)).send(body).expect(400);
    }
  });

  it('401 without a token, 403 for a viewer', async () => {
    const viewer = await createMockViewerUser(t.context);

    await request(server()).get('/api/ai/training/models').expect(401);
    await request(server()).post('/api/ai/training/estimate').send({ kind: 'create' }).expect(401);
    await request(server()).get('/api/ai/training/models').set(authHeader(viewer.accessToken)).expect(403);
    await request(server())
      .post('/api/ai/training/estimate')
      .set(authHeader(viewer.accessToken))
      .send({ kind: 'create' })
      .expect(403);
  });

  it('403 AI_DISABLED while AI is off, even unauthenticated', async () => {
    t.harness.setPolicy({ enabled: false });

    const res = await request(server()).get('/api/ai/training/models').expect(403);

    expect(res.body.details.reason).toBe('AI_DISABLED');
  });
});
