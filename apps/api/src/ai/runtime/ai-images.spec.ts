// =============================================================================
// AiService — image generation and editing (issue #437)
// =============================================================================
//
// The facade's gate pipeline for `generateImage`/`editImage` (queue time)
// and `executeImageRun` (job time), over the #432 harness: the real
// AiService/AiConfigService/AiKeyResolver/UsableModelsService/
// AiUsageRecorder/AiRunsService/AiStorageInputResolver, `FakeAiProvider`'s
// images port recording every call and key, and in-memory object storage.
// =============================================================================

import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { FAKE_IMAGE_MODEL_CAPABILITIES } from '../testing/fake-ai-provider';
import {
  createAiRuntimeHarness,
  HARNESS_IMAGE_MODEL,
  HARNESS_MODEL,
  HARNESS_ORG_KEY,
  HARNESS_OTHER_USER,
  HARNESS_USER,
  HARNESS_USER_KEY,
  type AiRuntimeHarnessOptions,
} from '../testing/ai-runtime-harness';
import { parseStoredImageRunRequest } from './ai-image-run-request';
import { AI_IMAGE_GENERATE_TYPE } from './ai-runs.service';

const GENERATE_ONLY_MODEL = 'fake-image-generate-only';

function setup(opts: AiRuntimeHarnessOptions = {}) {
  const h = createAiRuntimeHarness(opts);
  const client = h.ai.forUser(HARNESS_USER);
  const row = (runId: string) => h.runRows.find((r) => r.id === runId)!;

  return { h, client, row };
}

describe('AiService — images', () => {
  describe('generateImage (queue time)', () => {
    it('gates the request, stores it with operation images.generate and no key, and enqueues ai.image.generate', async () => {
      const { h, client, row } = setup();

      const handle = await client.generateImage({
        model: HARNESS_IMAGE_MODEL,
        prompt: 'a lighthouse',
        n: 2,
        size: '1024x1024',
        outputFormat: 'webp',
      });

      expect(row(handle.runId)).toMatchObject({
        status: 'pending',
        userId: HARNESS_USER,
        provider: 'openai',
        modelId: HARNESS_IMAGE_MODEL,
        jobId: handle.jobId,
        request: {
          operation: 'images.generate',
          provider: 'openai',
          model: HARNESS_IMAGE_MODEL,
          prompt: 'a lighthouse',
          n: 2,
          size: '1024x1024',
          outputFormat: 'webp',
        },
      });
      expect(h.enqueued).toEqual([
        expect.objectContaining({ type: AI_IMAGE_GENERATE_TYPE, subjectType: 'ai_run', subjectId: handle.runId }),
      ]);

      const serialised = JSON.stringify(h.runRows) + JSON.stringify(h.enqueued);
      expect(serialised).not.toContain(HARNESS_USER_KEY);
      expect(serialised).not.toContain(HARNESS_ORG_KEY);
      // Queueing makes no provider call and records no usage.
      expect(h.fake.calls).toEqual([]);
      expect(h.usageEvents).toEqual([]);
    });

    it('a model without image_generation is AI_CAPABILITY_UNSUPPORTED, creating nothing', async () => {
      const { h, client } = setup();

      await expect(client.generateImage({ model: HARNESS_MODEL, prompt: 'x' })).rejects.toMatchObject({
        code: 'AI_CAPABILITY_UNSUPPORTED',
      });
      expect(h.runRows).toEqual([]);
      expect(h.enqueued).toEqual([]);
    });

    it('a provider without the images port is AI_CAPABILITY_UNSUPPORTED even for a model that declares it', async () => {
      const { client } = setup({ fake: { imagesPort: false } });

      await expect(client.generateImage({ model: HARNESS_IMAGE_MODEL, prompt: 'x' })).rejects.toMatchObject({
        code: 'AI_CAPABILITY_UNSUPPORTED',
      });
    });

    it.each([
      ['an empty prompt', { prompt: '   ' }],
      ['n = 0', { n: 0 }],
      ['n = 5', { n: 5 }],
      ['a fractional n', { n: 1.5 }],
      ['no model', { model: '' }],
    ])('refuses %s as AI_INVALID_REQUEST', async (_name, patch) => {
      const { h, client } = setup();

      await expect(
        client.generateImage({ model: HARNESS_IMAGE_MODEL, prompt: 'x', ...patch }),
      ).rejects.toMatchObject({ code: 'AI_INVALID_REQUEST' });
      expect(h.runRows).toEqual([]);
    });

    it('answers the kill switch first', async () => {
      const { client } = setup({ policy: { enabled: false } });

      await expect(client.generateImage({ model: HARNESS_IMAGE_MODEL, prompt: 'x' })).rejects.toMatchObject({
        code: 'AI_DISABLED',
      });
    });

    it('fails fast when the caller has no key', async () => {
      const { h, client } = setup({ userKey: false });

      await expect(client.generateImage({ model: HARNESS_IMAGE_MODEL, prompt: 'x' })).rejects.toMatchObject({
        code: 'AI_KEY_REQUIRED',
      });
      expect(h.runRows).toEqual([]);
    });

    it('is not subject to allowBackgroundRuns — there is no synchronous form to fall back to', async () => {
      const { client } = setup({ policy: { defaults: { allowBackgroundRuns: false } } });

      await expect(client.generateImage({ model: HARNESS_IMAGE_MODEL, prompt: 'x' })).resolves.toMatchObject({
        runId: expect.any(String),
      });
    });
  });

  describe('editImage (queue time)', () => {
    it("stores the caller's own inputs by id, never their bytes", async () => {
      const { h, client, row } = setup();
      const image = h.storage.addObject({ uploadedById: HARNESS_USER, bytes: Buffer.from('source-bytes') });
      const mask = h.storage.addObject({ uploadedById: HARNESS_USER, mimeType: 'image/png' });

      const handle = await client.editImage({
        model: HARNESS_IMAGE_MODEL,
        prompt: 'add a hat',
        imageStorageObjectIds: [image.id],
        maskStorageObjectId: mask.id,
      });

      expect(row(handle.runId).request).toEqual({
        operation: 'images.edit',
        provider: 'openai',
        model: HARNESS_IMAGE_MODEL,
        prompt: 'add a hat',
        imageStorageObjectIds: [image.id],
        maskStorageObjectId: mask.id,
      });
      expect(JSON.stringify(h.runRows)).not.toContain(Buffer.from('source-bytes').toString('base64'));
      expect(h.storage.provider.download).not.toHaveBeenCalled();
    });

    it("refuses another user's image with 403 and queues nothing", async () => {
      const { h, client } = setup();
      const foreign = h.storage.addObject({ uploadedById: HARNESS_OTHER_USER });

      await expect(
        client.editImage({ model: HARNESS_IMAGE_MODEL, prompt: 'x', imageStorageObjectIds: [foreign.id] }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(h.runRows).toEqual([]);
    });

    it('refuses an unknown image with 404', async () => {
      const { client } = setup();

      await expect(
        client.editImage({
          model: HARNESS_IMAGE_MODEL,
          prompt: 'x',
          imageStorageObjectIds: ['33333333-3333-4333-8333-333333333333'],
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each([
      ['a PDF source', { mimeType: 'application/pdf' }, 'image'],
      ['a source that is not ready', { status: 'processing' }, 'image'],
      ['a JPEG mask', { mimeType: 'image/jpeg' }, 'mask'],
    ])('refuses %s as AI_INVALID_REQUEST', async (_name, attrs, slot) => {
      const { h, client } = setup();
      const good = h.storage.addObject({ uploadedById: HARNESS_USER });
      const bad = h.storage.addObject({ uploadedById: HARNESS_USER, ...attrs });

      await expect(
        client.editImage({
          model: HARNESS_IMAGE_MODEL,
          prompt: 'x',
          imageStorageObjectIds: slot === 'image' ? [bad.id] : [good.id],
          ...(slot === 'mask' ? { maskStorageObjectId: bad.id } : {}),
        }),
      ).rejects.toMatchObject({ code: 'AI_INVALID_REQUEST' });
      expect(h.runRows).toEqual([]);
    });

    it.each([
      ['no source image', []],
      ['a repeated source image', ['same', 'same']],
    ])('refuses %s as AI_INVALID_REQUEST', async (_name, ids) => {
      const { client } = setup();

      await expect(
        client.editImage({ model: HARNESS_IMAGE_MODEL, prompt: 'x', imageStorageObjectIds: ids }),
      ).rejects.toMatchObject({ code: 'AI_INVALID_REQUEST' });
    });

    it('a model with image_generation but not image_edit is AI_CAPABILITY_UNSUPPORTED', async () => {
      const { h, client } = setup({
        models: [
          {
            modelId: GENERATE_ONLY_MODEL,
            capabilities: { ...FAKE_IMAGE_MODEL_CAPABILITIES, capabilities: ['image_generation'] },
          },
        ],
      });
      const image = h.storage.addObject({ uploadedById: HARNESS_USER });

      await expect(
        client.editImage({ model: GENERATE_ONLY_MODEL, prompt: 'x', imageStorageObjectIds: [image.id] }),
      ).rejects.toMatchObject({ code: 'AI_CAPABILITY_UNSUPPORTED' });
      await expect(client.generateImage({ model: GENERATE_ONLY_MODEL, prompt: 'x' })).resolves.toBeDefined();
    });
  });

  describe('executeImageRun (job time)', () => {
    it('generates with the user key and records one usage row: operation images, units { images: n }', async () => {
      const { h, client, row } = setup();
      const handle = await client.generateImage({ model: HARNESS_IMAGE_MODEL, prompt: 'a fox', n: 3 });
      const stored = parseStoredImageRunRequest(row(handle.runId).request);

      const result = await h.ai.executeImageRun(HARNESS_USER, stored, { jobId: handle.jobId });

      expect(result.images).toHaveLength(3);
      expect(h.fake.callsTo('images.generate')).toEqual([
        expect.objectContaining({ apiKey: HARNESS_USER_KEY, imageRequest: expect.objectContaining({ n: 3 }) }),
      ]);
      expect(h.usageEvents).toEqual([
        expect.objectContaining({
          userId: HARNESS_USER,
          provider: 'openai',
          modelId: HARNESS_IMAGE_MODEL,
          operation: 'images',
          keySource: 'user',
          status: 'succeeded',
          units: { images: 3 },
          inputTokens: 2,
          jobId: handle.jobId,
        }),
      ]);
    });

    it('edits by reading the inputs’ bytes from storage and handing them to the port', async () => {
      const { h, client, row } = setup();
      const bytes = Buffer.from('the-source-image');
      const maskBytes = Buffer.from('the-mask');
      const image = h.storage.addObject({ uploadedById: HARNESS_USER, bytes, mimeType: 'image/jpeg' });
      const mask = h.storage.addObject({ uploadedById: HARNESS_USER, bytes: maskBytes });
      const handle = await client.editImage({
        model: HARNESS_IMAGE_MODEL,
        prompt: 'add a hat',
        imageStorageObjectIds: [image.id],
        maskStorageObjectId: mask.id,
      });

      await h.ai.executeImageRun(HARNESS_USER, parseStoredImageRunRequest(row(handle.runId).request));

      const [call] = h.fake.callsTo('images.edit');
      const request = call.imageRequest as { images: Array<{ data: Uint8Array; mimeType: string }>; mask?: { data: Uint8Array } };

      expect(Buffer.from(request.images[0].data).equals(bytes)).toBe(true);
      expect(request.images[0].mimeType).toBe('image/jpeg');
      expect(Buffer.from(request.mask!.data).equals(maskBytes)).toBe(true);
      expect(h.usageEvents).toEqual([expect.objectContaining({ operation: 'images', units: { images: 1 } })]);
    });

    it('re-runs the gates: a key removed since queueing is AI_KEY_REQUIRED, with no call', async () => {
      const { h, client, row } = setup();
      const handle = await client.generateImage({ model: HARNESS_IMAGE_MODEL, prompt: 'x' });

      h.removeUserKeys(HARNESS_USER);

      await expect(
        h.ai.executeImageRun(HARNESS_USER, parseStoredImageRunRequest(row(handle.runId).request)),
      ).rejects.toMatchObject({ code: 'AI_KEY_REQUIRED' });
      expect(h.fake.calls).toEqual([]);
    });

    it('re-checks ownership: an input deleted since queueing is a 404, with no call', async () => {
      const { h, client, row } = setup();
      const image = h.storage.addObject({ uploadedById: HARNESS_USER });
      const handle = await client.editImage({ model: HARNESS_IMAGE_MODEL, prompt: 'x', imageStorageObjectIds: [image.id] });

      h.storage.objects.length = 0;

      await expect(
        h.ai.executeImageRun(HARNESS_USER, parseStoredImageRunRequest(row(handle.runId).request)),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(h.fake.calls).toEqual([]);
    });

    it('runs beforeCall after the gates and before the key is resolved or the provider called', async () => {
      const { h, client, row } = setup();
      const handle = await client.generateImage({ model: HARNESS_IMAGE_MODEL, prompt: 'x' });
      const stored = parseStoredImageRunRequest(row(handle.runId).request);
      const resolve = jest.spyOn(h.resolver, 'resolve');

      await expect(
        h.ai.executeImageRun(HARNESS_USER, stored, {
          beforeCall: async () => {
            expect(resolve).not.toHaveBeenCalled();
            throw new Error('no storage');
          },
        }),
      ).rejects.toThrow('no storage');
      expect(h.fake.calls).toEqual([]);
      expect(h.usageEvents).toEqual([]);
    });

    it('a provider failure records a failed usage row with its code and no units', async () => {
      const { h, client, row } = setup();
      const handle = await client.generateImage({ model: HARNESS_IMAGE_MODEL, prompt: 'x' });

      h.fake.images!.generate = async () => {
        throw new Error('socket hang up');
      };

      await expect(
        h.ai.executeImageRun(HARNESS_USER, parseStoredImageRunRequest(row(handle.runId).request)),
      ).rejects.toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE' });
      expect(h.usageEvents).toEqual([
        expect.objectContaining({ operation: 'images', status: 'failed', errorCode: 'AI_PROVIDER_UNAVAILABLE' }),
      ]);
      expect(h.usageEvents[0].units).toBeUndefined();
    });
  });
});
