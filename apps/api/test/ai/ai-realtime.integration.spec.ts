// =============================================================================
// POST /api/ai/realtime/sessions (issue #449, epic #421)
// =============================================================================
//
// The real controller, guards (`AiEnabledGuard`, JWT, `ai:use`) and DTO over
// the #432 harness (`ai-http.helper.ts`): the real gate pipeline, with
// `FakeAiProvider`'s realtime port recording every call and the key it
// carried. The platform-wide invariants (kill switch, RBAC, key policy,
// secret egress) are proven for this route by the #435 suites; this file
// covers what is specific to realtime.
// =============================================================================

import request from 'supertest';

import { aiRealtimeSessionResponseSchema } from '../../src/ai/http/dto/ai-realtime.dto';
import { FAKE_REALTIME_SECRET_PREFIX } from '../../src/ai/testing/fake-ai-provider';
import {
  HARNESS_EMBEDDING_MODEL,
  HARNESS_IMAGE_MODEL,
  HARNESS_MODEL,
  HARNESS_REALTIME_MODEL,
  HARNESS_SPEECH_MODEL,
  HARNESS_TRANSCRIPTION_MODEL,
  HARNESS_USER,
  HARNESS_USER_KEY,
} from '../../src/ai/testing/ai-runtime-harness';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { ALL_KEYS, AiHttpTestApp, createAiHttpTestApp } from './ai-http.helper';

const ALL_HARNESS_MODELS = [
  HARNESS_MODEL,
  HARNESS_EMBEDDING_MODEL,
  HARNESS_IMAGE_MODEL,
  HARNESS_TRANSCRIPTION_MODEL,
  HARNESS_SPEECH_MODEL,
  HARNESS_REALTIME_MODEL,
];

describe('POST /api/ai/realtime/sessions (#449)', () => {
  let t: AiHttpTestApp;
  let token: string;

  beforeAll(async () => {
    t = await createAiHttpTestApp();
  }, 60_000);

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.reset();
    t.harness.setPolicy({ defaults: { allowBackgroundRuns: true, allowRealtime: true } });
    const holder = await createMockTestUser(t.context, { id: HARNESS_USER, roleName: 'contributor' });
    token = holder.accessToken;
  });

  const post = (body: unknown) =>
    request(t.context.app.getHttpServer())
      .post('/api/ai/realtime/sessions')
      .set(authHeader(token))
      .send(body as object);

  it('answers 201 { provider, model, voice, clientSecret, expiresAt, connectUrl } — the ephemeral secret, never the key', async () => {
    const res = await post({ model: HARNESS_REALTIME_MODEL, voice: 'alloy', instructions: 'Be brief.' }).expect(201);

    expect(aiRealtimeSessionResponseSchema.safeParse(res.body.data).success).toBe(true);
    expect(res.body.data).toEqual({
      provider: 'openai',
      model: HARNESS_REALTIME_MODEL,
      voice: 'alloy',
      clientSecret: `${FAKE_REALTIME_SECRET_PREFIX}1`,
      expiresAt: expect.any(String),
      connectUrl: 'https://realtime.fake.invalid/v1/realtime/calls',
    });
    expect(new Date(res.body.data.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const serialised = JSON.stringify(res.body) + JSON.stringify(res.headers);
    for (const key of ALL_KEYS) expect(serialised).not.toContain(key);

    expect(t.harness.fake.callsTo('realtime.createSession')[0].realtimeRequest).toEqual({
      model: HARNESS_REALTIME_MODEL,
      voice: 'alloy',
      instructions: 'Be brief.',
    });
  });

  it('defaults the model and voice, and records one usage row: operation realtime, units { sessions: 1 }', async () => {
    const res = await post({}).expect(201);

    expect(res.body.data).toMatchObject({ model: HARNESS_REALTIME_MODEL, voice: 'marin' });
    expect(t.harness.usageEvents).toEqual([
      expect.objectContaining({
        userId: HARNESS_USER,
        operation: 'realtime',
        keySource: 'user',
        status: 'succeeded',
        units: { sessions: 1 },
      }),
    ]);
    expect(JSON.stringify(t.harness.usageEvents)).not.toContain(res.body.data.clientSecret);
  });

  it('refuses 403 AI_REALTIME_DISABLED while allowRealtime is off (the default), with no provider call', async () => {
    t.harness.setPolicy({ defaults: { allowBackgroundRuns: true, allowRealtime: false } });

    const res = await post({}).expect(403);

    expect(res.body.details.reason).toBe('AI_REALTIME_DISABLED');
    expect(t.harness.fake.callsTo('realtime.createSession')).toHaveLength(0);
    expect(t.harness.usageEvents).toHaveLength(0);
  });

  it('refuses 403 AI_DISABLED while AI is off', async () => {
    t.harness.setPolicy({ enabled: false });

    const res = await post({}).expect(403);

    expect(res.body.details.reason).toBe('AI_DISABLED');
    expect(t.harness.fake.calls).toHaveLength(0);
  });

  it('refuses 400 AI_CAPABILITY_UNSUPPORTED for a model without realtime', async () => {
    const res = await post({ model: HARNESS_MODEL }).expect(400);

    expect(res.body.details.reason).toBe('AI_CAPABILITY_UNSUPPORTED');
    expect(t.harness.fake.callsTo('realtime.createSession')).toHaveLength(0);
  });

  it('refuses 403 AI_KEY_REQUIRED for a user with no key (byok: the org key is never used)', async () => {
    t.harness.setOrgKey('sk-org-admin-key-9999');
    t.harness.removeUserKeys(HARNESS_USER);

    try {
      const res = await post({ model: HARNESS_REALTIME_MODEL }).expect(403);

      expect(res.body.details.reason).toBe('AI_KEY_REQUIRED');
      expect(t.harness.fake.callsTo('realtime.createSession')).toHaveLength(0);
    } finally {
      t.harness.addUserKey(HARNESS_USER, HARNESS_USER_KEY, ALL_HARNESS_MODELS);
    }
  });

  it('refuses 400 AI_INVALID_REQUEST for a voice the model does not list', async () => {
    const res = await post({ model: HARNESS_REALTIME_MODEL, voice: 'cedar' }).expect(400);

    expect(res.body.details.reason).toBe('AI_INVALID_REQUEST');
  });

  it('refuses a Viewer, who holds no ai:use since #501 — a bare RBAC 403, no provider call', async () => {
    const viewer = await createMockTestUser(t.context, { roleName: 'viewer' });

    const res = await request(t.context.app.getHttpServer())
      .post('/api/ai/realtime/sessions')
      .set(authHeader(viewer.accessToken))
      .send({})
      .expect(403);

    expect(res.body.details?.reason).toBeUndefined();
    expect(t.harness.fake.calls).toHaveLength(0);
  });

  it('rejects unknown body fields (tools are not accepted over HTTP)', async () => {
    await post({ tools: [{ type: 'function', name: 'x' }] }).expect(400);
    expect(t.harness.fake.calls).toHaveLength(0);
  });

  it('answers 429 AI_RATE_LIMITED once the per-user limit is spent — a mint counts as a request', async () => {
    t.harness.setPolicy({ limits: { perUser: { requestsPerMinute: 1 } } });

    await post({}).expect(201);
    const res = await post({}).expect(429);

    expect(res.body.details.reason).toBe('AI_RATE_LIMITED');
    expect(t.harness.fake.callsTo('realtime.createSession')).toHaveLength(1);
  });
});
