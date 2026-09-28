// =============================================================================
// POST /api/ai/embeddings (issue #440, epic #420)
// =============================================================================
//
// The real controller, guards (`AiEnabledGuard`, JWT, `ai:use`) and DTO over
// the #432 harness (`ai-http.helper.ts`): the real gate pipeline, with
// `FakeAiProvider`'s embeddings port recording every call and the key it
// carried. The platform-wide invariants (kill switch, RBAC, key policy,
// secret egress) are proven for this route by the #435 suites; this file
// covers what is specific to embeddings.
// =============================================================================

import request from 'supertest';

import { AI_EMBEDDINGS_MAX_INPUTS } from '../../src/ai/core/types/media.types';
import { aiEmbeddingsResponseSchema } from '../../src/ai/http/dto/ai-embeddings.dto';
import { HARNESS_EMBEDDING_MODEL, HARNESS_MODEL, HARNESS_USER } from '../../src/ai/testing/ai-runtime-harness';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { ALL_KEYS, AiHttpTestApp, createAiHttpTestApp } from './ai-http.helper';

describe('POST /api/ai/embeddings (#440)', () => {
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
    const holder = await createMockTestUser(t.context, { id: HARNESS_USER, roleName: 'contributor' });
    token = holder.accessToken;
  });

  const post = (body: unknown) =>
    request(t.context.app.getHttpServer()).post('/api/ai/embeddings').set(authHeader(token)).send(body as object);

  it('answers 200 { provider, model, dimensions, vectors, usage } — one vector per input, in order', async () => {
    const res = await post({ model: HARNESS_EMBEDDING_MODEL, input: ['alpha', 'beta', 'gamma'] }).expect(200);

    expect(aiEmbeddingsResponseSchema.safeParse(res.body.data).success).toBe(true);
    expect(res.body.data).toMatchObject({ provider: 'openai', model: HARNESS_EMBEDDING_MODEL, dimensions: 8 });
    expect(res.body.data.vectors).toHaveLength(3);
    expect(res.body.data.vectors.every((v: number[]) => v.length === 8)).toBe(true);
    expect(res.body.data.usage.inputTokens).toBeGreaterThan(0);

    const single = await post({ model: HARNESS_EMBEDDING_MODEL, input: 'beta' }).expect(200);
    expect(single.body.data.vectors).toEqual([res.body.data.vectors[1]]);
  });

  it('honours dimensions', async () => {
    const res = await post({ model: HARNESS_EMBEDDING_MODEL, input: ['a', 'b'], dimensions: 16 }).expect(200);

    expect(res.body.data.dimensions).toBe(16);
    expect(res.body.data.vectors.every((v: number[]) => v.length === 16)).toBe(true);
    expect(t.harness.fake.callsTo('embeddings.embed')[0].embeddingRequest).toMatchObject({ dimensions: 16 });
  });

  it('records one ai_usage_events row with operation embeddings, and returns no key', async () => {
    const res = await post({ model: HARNESS_EMBEDDING_MODEL, input: 'hello' }).expect(200);

    expect(t.harness.usageEvents).toEqual([
      expect.objectContaining({ userId: HARNESS_USER, operation: 'embeddings', keySource: 'user', status: 'succeeded' }),
    ]);

    const serialised = JSON.stringify(res.body) + JSON.stringify(res.headers);
    for (const key of ALL_KEYS) expect(serialised).not.toContain(key);
  });

  it('a model without the embeddings capability is 400 AI_CAPABILITY_UNSUPPORTED, no provider call', async () => {
    const res = await post({ model: HARNESS_MODEL, input: 'hello' }).expect(400);

    expect(res.body.details.reason).toBe('AI_CAPABILITY_UNSUPPORTED');
    expect(t.harness.fake.calls).toEqual([]);
  });

  it(`more than ${AI_EMBEDDINGS_MAX_INPUTS} inputs is 400 AI_INVALID_REQUEST, telling the caller to chunk`, async () => {
    const input = Array.from({ length: AI_EMBEDDINGS_MAX_INPUTS + 1 }, (_, i) => `t${i}`);
    const res = await post({ model: HARNESS_EMBEDDING_MODEL, input }).expect(400);

    expect(res.body.details.reason).toBe('AI_INVALID_REQUEST');
    expect(res.body.message).toMatch(/chunk/);
    expect(t.harness.fake.calls).toEqual([]);
  });

  it('an unknown model is 403 AI_MODEL_NOT_ENABLED', async () => {
    const res = await post({ model: 'no-such-model', input: 'hello' }).expect(403);

    expect(res.body.details.reason).toBe('AI_MODEL_NOT_ENABLED');
  });

  it.each([
    ['no model', { input: 'hello' }],
    ['no input', { model: HARNESS_EMBEDDING_MODEL }],
    ['an empty string', { model: HARNESS_EMBEDDING_MODEL, input: '' }],
    ['an empty batch', { model: HARNESS_EMBEDDING_MODEL, input: [] }],
    ['an empty string in a batch', { model: HARNESS_EMBEDDING_MODEL, input: ['ok', ''] }],
    ['non-positive dimensions', { model: HARNESS_EMBEDDING_MODEL, input: 'x', dimensions: 0 }],
    ['an unknown field', { model: HARNESS_EMBEDDING_MODEL, input: 'x', encoding_format: 'base64' }],
  ])('%s is a 400 validation error, no provider call', async (_name, body) => {
    await post(body).expect(400);

    expect(t.harness.fake.calls).toEqual([]);
  });

  it('is behind the kill switch: 403 AI_DISABLED, even unauthenticated', async () => {
    t.harness.setPolicy({ enabled: false });

    const res = await request(t.context.app.getHttpServer())
      .post('/api/ai/embeddings')
      .send({ model: HARNESS_EMBEDDING_MODEL, input: 'hello' })
      .expect(403);

    expect(res.body.details.reason).toBe('AI_DISABLED');
  });

  it('requires authentication', async () => {
    await request(t.context.app.getHttpServer())
      .post('/api/ai/embeddings')
      .send({ model: HARNESS_EMBEDDING_MODEL, input: 'hello' })
      .expect(401);
  });
});
