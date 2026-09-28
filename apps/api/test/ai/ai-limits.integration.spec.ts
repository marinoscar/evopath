// =============================================================================
// AI rate limits over HTTP (issue #450, epic #421)
// =============================================================================
//
// The real controllers, guards, global exception filter and gate pipeline
// over the #432 harness (`ai-http.helper.ts`), with a fake clock driving the
// limiter and stamping the usage rows. What this file pins is the WIRE: a
// limit answers `429 TOO_MANY_REQUESTS` with `details.reason:
// 'AI_RATE_LIMITED'`, `details.limit` naming the limit, `details.retryAfterMs`,
// and a `Retry-After` header in whole seconds — on the synchronous routes and
// on the SSE route's pre-stream refusal alike. The limiter's own arithmetic is
// `src/ai/runtime/ai-limits.service.spec.ts`.
// =============================================================================

import request from 'supertest';

import {
  HARNESS_EMBEDDING_MODEL,
  HARNESS_MODEL,
  HARNESS_OTHER_USER,
  HARNESS_USER,
} from '../../src/ai/testing/ai-runtime-harness';
import { authHeader, createMockTestUser, TestUser } from '../helpers/auth-mock.helper';
import { AiHttpTestApp, createAiHttpTestApp, OTHER_USER_KEY } from './ai-http.helper';

/** 21:30:00 UTC — two and a half hours before the next UTC midnight. */
const T0 = Date.UTC(2026, 8, 26, 21, 30, 0);

describe('AI rate limits over HTTP (#450)', () => {
  let t: AiHttpTestApp;
  let alice: TestUser;
  let bob: TestUser;
  let now = T0;

  beforeAll(async () => {
    t = await createAiHttpTestApp({ clock: () => now });
  }, 60_000);

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.reset();
    // A fresh day for every test: nothing an earlier test admitted is still
    // in any window, local or database.
    now += 24 * 60 * 60 * 1000;
    alice = await createMockTestUser(t.context, { id: HARNESS_USER, roleName: 'contributor' });
    bob = await createMockTestUser(t.context, { id: HARNESS_OTHER_USER, roleName: 'contributor' });
  });

  const server = () => t.context.app.getHttpServer();
  const respond = (user: TestUser, body: object = { model: HARNESS_MODEL, input: 'hello' }) =>
    request(server()).post('/api/ai/responses').set(authHeader(user.accessToken)).send(body);

  it('perUser.requestsPerMinute: 429 with Retry-After, details.limit and retryAfterMs', async () => {
    t.harness.setPolicy({ limits: { perUser: { requestsPerMinute: 2 } } });

    await respond(alice).expect(200);
    now += 15_000;
    await respond(alice).expect(200);
    now += 5_000;

    const res = await respond(alice).expect(429);

    // The first call leaves the window 60s after it was made — 40s from now.
    expect(res.headers['retry-after']).toBe('40');
    expect(res.body).toMatchObject({
      statusCode: 429,
      code: 'TOO_MANY_REQUESTS',
      details: {
        reason: 'AI_RATE_LIMITED',
        limit: 'perUser.requestsPerMinute',
        max: 2,
        window: 'minute',
        retryAfterMs: 40_000,
      },
    });
    expect(t.harness.fake.calls).toHaveLength(2);

    // Another user (on a key of their own) has a budget of their own.
    t.harness.addUserKey(HARNESS_OTHER_USER, OTHER_USER_KEY, [HARNESS_MODEL]);
    await respond(bob).expect(200);

    // Once the window slides past the first call, one more fits.
    now += 40_000;
    await respond(alice).expect(200);
  });

  it('perUser.requestsPerDay: Retry-After runs to the next UTC midnight', async () => {
    t.harness.setPolicy({ limits: { perUser: { requestsPerDay: 1 } } });

    await request(server())
      .post('/api/ai/embeddings')
      .set(authHeader(alice.accessToken))
      .send({ model: HARNESS_EMBEDDING_MODEL, input: 'one' })
      .expect(200);

    const res = await respond(alice).expect(429);
    const untilMidnight = 24 * 60 * 60 * 1000 - (now % (24 * 60 * 60 * 1000));

    expect(res.body.details).toMatchObject({ limit: 'perUser.requestsPerDay', window: 'day' });
    expect(res.body.details.retryAfterMs).toBe(untilMidnight);
    expect(res.headers['retry-after']).toBe(String(Math.ceil(untilMidnight / 1000)));
  });

  it('perModel.requestsPerMinutePerUser: one model is limited, the others are not', async () => {
    t.harness.setPolicy({
      limits: { perModel: { [`openai:${HARNESS_MODEL}`]: { requestsPerMinutePerUser: 1 } } },
    });

    await respond(alice).expect(200);

    const res = await respond(alice).expect(429);

    expect(res.body.details).toMatchObject({
      limit: 'perModel.requestsPerMinutePerUser',
      provider: 'openai',
      model: HARNESS_MODEL,
    });
    expect(res.headers['retry-after']).toBe('60');

    await request(server())
      .post('/api/ai/embeddings')
      .set(authHeader(alice.accessToken))
      .send({ model: HARNESS_EMBEDDING_MODEL, input: 'x' })
      .expect(200);
  });

  it('orgKey limits bind org-key users only', async () => {
    t.harness.setOrgKey('sk-org-admin-key-9999');
    t.harness.setPolicy({ keyPolicy: 'byok_with_org_fallback', limits: { orgKey: { requestsPerDayPerUser: 1 } } });

    // Bob has no key of his own: the org key pays, and the limit applies.
    await respond(bob).expect(200);
    const res = await respond(bob).expect(429);

    expect(res.body.details).toMatchObject({ limit: 'orgKey.requestsPerDayPerUser', keySource: 'org' });

    // Alice pays with her own key: the org limit never counts her.
    await respond(alice).expect(200);
    await respond(alice).expect(200);
  });

  it('the SSE route refuses before streaming, as an ordinary JSON 429', async () => {
    t.harness.setPolicy({ limits: { perUser: { requestsPerMinute: 1 } } });

    await respond(alice).expect(200);

    const res = await request(server())
      .post('/api/ai/responses/stream')
      .set(authHeader(alice.accessToken))
      .set('Accept', 'text/event-stream')
      .send({ model: HARNESS_MODEL, input: 'hello' })
      .expect(429);

    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['retry-after']).toBe('60');
    expect(res.body.details).toMatchObject({ reason: 'AI_RATE_LIMITED', limit: 'perUser.requestsPerMinute' });
  });

  it('per-model maxOutputTokens clamps what the provider is asked for', async () => {
    t.harness.setPolicy({
      defaults: { allowBackgroundRuns: true, allowRealtime: false, maxOutputTokensCap: 1_000 },
      limits: { perModel: { [`openai:${HARNESS_MODEL}`]: { maxOutputTokens: 256 } } },
    });

    await respond(alice, { model: HARNESS_MODEL, input: 'hello', maxOutputTokens: 4_000 }).expect(200);
    await respond(alice).expect(200);

    expect(t.harness.fake.calls.map((c) => c.request?.maxOutputTokens)).toEqual([256, 256]);
  });

  it('no limits: no 429, however many calls, and no usage query', async () => {
    t.harness.prisma.aiUsageEvent.count.mockClear();

    for (let i = 0; i < 10; i += 1) await respond(alice).expect(200);

    expect(t.harness.prisma.aiUsageEvent.count).not.toHaveBeenCalled();
  });
});
