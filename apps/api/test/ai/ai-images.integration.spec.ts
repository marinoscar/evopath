// =============================================================================
// POST /api/ai/images and /api/ai/images/edits (issue #437, epic #420)
// =============================================================================
//
// The real controllers, guards (`AiEnabledGuard`, JWT, `ai:use`) and DTOs
// over the #432 harness (`ai-http.helper.ts`): the real gate pipeline and run
// state machine, the REAL `ai.image.generate` handler from the Nest
// container, `FakeAiProvider`'s images port, and in-memory object storage
// standing in for the storage provider. End to end: 202 -> the job runs ->
// `GET /api/ai/runs/{id}` shows `output.storageObjectIds`, each a storage
// object the caller owns. The platform-wide invariants (kill switch, RBAC,
// key policy, secret egress) are proven for these routes by the #435 suites.
// =============================================================================

import request from 'supertest';

import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { aiRunSchema, aiRunStartedSchema } from '../../src/ai/http/dto/ai-response.dto';
import { aiOutputKeyPrefix } from '../../src/ai/storage/ai-output-writer';
import {
  HARNESS_IMAGE_MODEL,
  HARNESS_MODEL,
  HARNESS_OTHER_USER,
  HARNESS_USER,
} from '../../src/ai/testing/ai-runtime-harness';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { ALL_KEYS, AiHttpTestApp, createAiHttpTestApp } from './ai-http.helper';

describe('AI images over HTTP (#437)', () => {
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

  const server = () => t.context.app.getHttpServer();
  const generate = (body: unknown) =>
    request(server()).post('/api/ai/images').set(authHeader(token)).send(body as object);
  const edit = (body: unknown) =>
    request(server()).post('/api/ai/images/edits').set(authHeader(token)).send(body as object);
  const getRun = (runId: string) => request(server()).get(`/api/ai/runs/${runId}`).set(authHeader(token));

  /** Runs the queued job through the real handler the app registered. */
  async function runJob(handle: { runId: string; jobId: string }): Promise<void> {
    const handler = t.context.app.get(JobHandlerRegistry).get('ai.image.generate');

    expect(handler).toBeDefined();
    await handler!.process({ id: handle.jobId, payload: { runId: handle.runId } } as never);
  }

  describe('POST /api/ai/images', () => {
    it('answers 202 { runId, jobId }; once the job runs, the run carries storage objects the caller owns', async () => {
      const started = await generate({ model: HARNESS_IMAGE_MODEL, prompt: 'a lighthouse at dusk', n: 2 }).expect(202);

      expect(aiRunStartedSchema.safeParse(started.body.data).success).toBe(true);

      const pending = await getRun(started.body.data.runId).expect(200);
      expect(pending.body.data).toMatchObject({ status: 'pending', output: null, modelId: HARNESS_IMAGE_MODEL });

      await runJob(started.body.data);

      const done = await getRun(started.body.data.runId).expect(200);

      expect(aiRunSchema.safeParse(done.body.data).success).toBe(true);
      expect(done.body.data).toMatchObject({
        status: 'succeeded',
        output: { type: 'images', provider: 'openai', model: HARNESS_IMAGE_MODEL },
      });

      const ids: string[] = done.body.data.output.storageObjectIds;

      expect(ids).toHaveLength(2);
      expect(done.body.data.output.images.map((i: { storageObjectId: string }) => i.storageObjectId)).toEqual(ids);

      for (const id of ids) {
        const object = t.harness.storage.objects.find((o) => o.id === id);

        expect(object).toMatchObject({ uploadedById: HARNESS_USER, status: 'ready', mimeType: 'image/png' });
        expect(object!.storageKey.startsWith(aiOutputKeyPrefix(HARNESS_USER, started.body.data.runId))).toBe(true);
      }

      // No image bytes and no key in anything the API answered.
      const serialised = JSON.stringify(done.body) + JSON.stringify(started.body);
      for (const key of ALL_KEYS) expect(serialised).not.toContain(key);
      expect(serialised).not.toContain('iVBORw0KGgo');

      expect(t.harness.usageEvents).toEqual([
        expect.objectContaining({ userId: HARNESS_USER, operation: 'images', units: { images: 2 }, keySource: 'user' }),
      ]);
    });

    it('a model without image_generation is 400 AI_CAPABILITY_UNSUPPORTED, nothing queued', async () => {
      const res = await generate({ model: HARNESS_MODEL, prompt: 'x' }).expect(400);

      expect(res.body.details.reason).toBe('AI_CAPABILITY_UNSUPPORTED');
      expect(t.harness.runRows).toEqual([]);
      expect(t.harness.fake.calls).toEqual([]);
    });

    it('an unknown model is 403 AI_MODEL_NOT_ENABLED', async () => {
      const res = await generate({ model: 'no-such-image-model', prompt: 'x' }).expect(403);

      expect(res.body.details.reason).toBe('AI_MODEL_NOT_ENABLED');
    });

    it.each([
      ['no model', { prompt: 'x' }],
      ['no prompt', { model: HARNESS_IMAGE_MODEL }],
      ['an empty prompt', { model: HARNESS_IMAGE_MODEL, prompt: '' }],
      ['n = 5', { model: HARNESS_IMAGE_MODEL, prompt: 'x', n: 5 }],
      ['a malformed size', { model: HARNESS_IMAGE_MODEL, prompt: 'x', size: 'huge' }],
      ['an unknown outputFormat', { model: HARNESS_IMAGE_MODEL, prompt: 'x', outputFormat: 'gif' }],
      ['an unknown field', { model: HARNESS_IMAGE_MODEL, prompt: 'x', response_format: 'url' }],
    ])('%s is a 400 validation error, nothing queued', async (_name, body) => {
      await generate(body).expect(400);

      expect(t.harness.runRows).toEqual([]);
    });

    it('unconfigured storage surfaces as a failed run with errorCode AI_STORAGE_UNAVAILABLE — no image billed', async () => {
      const started = await generate({ model: HARNESS_IMAGE_MODEL, prompt: 'x' }).expect(202);

      t.harness.storage.setConfigured(false);

      // Terminal: the job returns rather than throwing a 503 the queue would defer (issue #509).
      await expect(runJob(started.body.data)).resolves.toBeUndefined();

      const res = await getRun(started.body.data.runId).expect(200);

      expect(res.body.data).toMatchObject({ status: 'failed', errorCode: 'AI_STORAGE_UNAVAILABLE', output: null });
      expect(res.body.data.errorMessage).toContain('/admin/settings/storage');
      expect(t.harness.fake.calls).toEqual([]);
    });

    it('can be cancelled like any run: a cancelled image run never calls the provider', async () => {
      const started = await generate({ model: HARNESS_IMAGE_MODEL, prompt: 'x' }).expect(202);

      const cancelled = await request(server())
        .post(`/api/ai/runs/${started.body.data.runId}/cancel`)
        .set(authHeader(token))
        .expect(200);

      expect(cancelled.body.data.status).toBe('cancelled');

      await runJob(started.body.data);

      expect(t.harness.fake.calls).toEqual([]);
      expect(t.harness.storage.objects).toEqual([]);
    });

    it("another user's image run is a 404", async () => {
      const started = await generate({ model: HARNESS_IMAGE_MODEL, prompt: 'x' }).expect(202);
      const other = await createMockTestUser(t.context, { id: HARNESS_OTHER_USER, roleName: 'contributor' });

      await request(server())
        .get(`/api/ai/runs/${started.body.data.runId}`)
        .set(authHeader(other.accessToken))
        .expect(404);
    });
  });

  describe('POST /api/ai/images/edits', () => {
    it("edits the caller's own image: 202, then the run holds the edited image as a new object", async () => {
      const source = t.harness.storage.addObject({ uploadedById: HARNESS_USER, bytes: Buffer.from('original') });

      const started = await edit({
        model: HARNESS_IMAGE_MODEL,
        prompt: 'add a hat',
        imageStorageObjectIds: [source.id],
      }).expect(202);

      await runJob(started.body.data);

      const done = await getRun(started.body.data.runId).expect(200);

      expect(done.body.data.status).toBe('succeeded');
      expect(done.body.data.output.storageObjectIds).toHaveLength(1);
      expect(done.body.data.output.storageObjectIds).not.toContain(source.id);

      const [call] = t.harness.fake.callsTo('images.edit');
      const sent = call.imageRequest as { images: Array<{ data: Uint8Array }> };
      expect(Buffer.from(sent.images[0].data).toString()).toBe('original');
    });

    it("another user's image is 403, and nothing is queued", async () => {
      const foreign = t.harness.storage.addObject({ uploadedById: HARNESS_OTHER_USER });

      const res = await edit({ model: HARNESS_IMAGE_MODEL, prompt: 'x', imageStorageObjectIds: [foreign.id] }).expect(403);

      expect(res.body.details).toMatchObject({ storageObjectId: foreign.id });
      expect(t.harness.runRows).toEqual([]);
      expect(t.harness.fake.calls).toEqual([]);
    });

    it("another user's mask is 403 too", async () => {
      const mine = t.harness.storage.addObject({ uploadedById: HARNESS_USER });
      const foreign = t.harness.storage.addObject({ uploadedById: HARNESS_OTHER_USER });

      await edit({
        model: HARNESS_IMAGE_MODEL,
        prompt: 'x',
        imageStorageObjectIds: [mine.id],
        maskStorageObjectId: foreign.id,
      }).expect(403);
    });

    it('an unknown image is 404', async () => {
      await edit({
        model: HARNESS_IMAGE_MODEL,
        prompt: 'x',
        imageStorageObjectIds: ['33333333-3333-4333-8333-333333333333'],
      }).expect(404);
    });

    it('a non-image input is 400 AI_INVALID_REQUEST', async () => {
      const pdf = t.harness.storage.addObject({ uploadedById: HARNESS_USER, mimeType: 'application/pdf' });

      const res = await edit({ model: HARNESS_IMAGE_MODEL, prompt: 'x', imageStorageObjectIds: [pdf.id] }).expect(400);

      expect(res.body.details.reason).toBe('AI_INVALID_REQUEST');
    });

    it.each([
      ['no images', { imageStorageObjectIds: [] }],
      ['a non-uuid id', { imageStorageObjectIds: ['nope'] }],
      ['17 images', { imageStorageObjectIds: Array.from({ length: 17 }, () => '33333333-3333-4333-8333-333333333333') }],
    ])('%s is a 400 validation error', async (_name, patch) => {
      await edit({ model: HARNESS_IMAGE_MODEL, prompt: 'x', ...patch }).expect(400);
    });

    it("an image deleted before the job runs fails the run AI_INVALID_REQUEST", async () => {
      const source = t.harness.storage.addObject({ uploadedById: HARNESS_USER });
      const started = await edit({ model: HARNESS_IMAGE_MODEL, prompt: 'x', imageStorageObjectIds: [source.id] }).expect(202);

      t.harness.storage.objects.length = 0;
      await runJob(started.body.data);

      const res = await getRun(started.body.data.runId).expect(200);
      expect(res.body.data).toMatchObject({ status: 'failed', errorCode: 'AI_INVALID_REQUEST' });
    });
  });

  it.each(['/api/ai/images', '/api/ai/images/edits'])('%s is behind the kill switch (403 AI_DISABLED, unauthenticated)', async (path) => {
    t.harness.setPolicy({ enabled: false });

    const res = await request(server()).post(path).send({ model: HARNESS_IMAGE_MODEL, prompt: 'x' }).expect(403);

    expect(res.body.details.reason).toBe('AI_DISABLED');
  });

  it.each(['/api/ai/images', '/api/ai/images/edits'])('%s requires authentication', async (path) => {
    await request(server()).post(path).send({ model: HARNESS_IMAGE_MODEL, prompt: 'x' }).expect(401);
  });
});
