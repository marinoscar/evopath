// =============================================================================
// Storage-object inputs over HTTP (issue #441, epic #420)
// =============================================================================
//
// `POST /api/ai/responses`, `/responses/stream` and `/runs` with image/file
// parts naming the caller's own storage objects — the real controllers,
// guards and DTOs over the #432 harness (`ai-http.helper.ts`): the real gate
// pipeline and input resolver, in-memory object storage whose presigned URLs
// carry a sentinel signature, and `FakeAiProvider` delivering inputs the way
// OpenAI does (images by presigned URL, files by upload + delete).
//
// Another user's object answers 403, not the 404 the issue text suggests:
// `AiStorageInputResolver` (#437) gives exactly the answers `ObjectsService`
// gives for the same object, and the image-edit routes already answer 403.
// =============================================================================

import request from 'supertest';

import type { AiModelCapabilities } from '../../src/ai/core/capabilities';
import { AI_STORAGE_INPUT_FILE_MAX_BYTES } from '../../src/ai/core/types/file-inputs.types';
import { aiRunStartedSchema } from '../../src/ai/http/dto/ai-response.dto';
import { HARNESS_MODEL, HARNESS_OTHER_USER, HARNESS_USER } from '../../src/ai/testing/ai-runtime-harness';
import { IN_MEMORY_PRESIGNED_SIGNATURE } from '../../src/ai/testing/in-memory-ai-storage';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { ALL_KEYS, AiHttpTestApp, createAiHttpTestApp, parseSse } from './ai-http.helper';

const TEXT_ONLY = 'fake-text-only';
const PDF = Buffer.from('%PDF-1.7 the invoice total is 42 EUR');

describe('AI storage-object inputs over HTTP (#441)', () => {
  let t: AiHttpTestApp;
  let token: string;

  beforeAll(async () => {
    t = await createAiHttpTestApp({
      models: [
        { modelId: HARNESS_MODEL },
        {
          modelId: TEXT_ONLY,
          capabilities: {
            capabilities: ['responses', 'streaming'],
            inputModalities: ['text'],
            outputModalities: ['text'],
          } as AiModelCapabilities,
        },
      ],
    });
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
  const post = (path: string, body: unknown) =>
    request(server()).post(path).set(authHeader(token)).send(body as object);

  const pdf = (owner = HARNESS_USER, size?: number) =>
    t.harness.storage.addObject({
      uploadedById: owner,
      bytes: PDF,
      mimeType: 'application/pdf',
      name: 'invoice.pdf',
      ...(size !== undefined ? { size } : {}),
    });
  const png = () => t.harness.storage.addObject({ uploadedById: HARNESS_USER, mimeType: 'image/png', name: 'cat.png' });

  const body = (part: Record<string, unknown>, model = HARNESS_MODEL) => ({
    model,
    input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Extract the total.' }, part] }],
  });

  /** Nothing the API answered, logged into a row, or recorded may carry a key or a presigned URL. */
  function expectNoSecrets(...texts: string[]) {
    const all = texts.join('\n') + JSON.stringify(t.harness.usageEvents) + JSON.stringify(t.harness.runRows);

    expect(all).not.toContain(IN_MEMORY_PRESIGNED_SIGNATURE);
    for (const key of ALL_KEYS) expect(all).not.toContain(key);
  }

  describe('POST /api/ai/responses', () => {
    it('an owned PDF + prompt: the provider receives a file id (not bytes via a body), the response references it, the upload is deleted', async () => {
      const object = pdf();

      // The "model" reads what it was handed: the delivered input's name.
      t.script((_req, ctx) => ({
        outputText: `Read ${[...(ctx.storageInputs?.values() ?? [])].map((input) => input.filename).join(', ')}`,
      }));

      const res = await post('/api/ai/responses', body({ type: 'file', storageObjectId: object.id })).expect(200);

      expect(res.body.data.outputText).toBe('Read invoice.pdf');

      const [call] = t.harness.fake.callsTo('responses.create');

      expect(call.storageInputs).toEqual([
        expect.objectContaining({ storageObjectId: object.id, strategy: 'upload', fileId: 'fake_file_1', bytes: PDF.length }),
      ]);
      expect(t.harness.fake.deletedFileIds).toEqual(['fake_file_1']);
      expectNoSecrets(JSON.stringify(res.body), JSON.stringify(res.headers));
    });

    it('an owned image reaches the provider by presigned URL, which the response never shows', async () => {
      const object = png();

      const res = await post('/api/ai/responses', body({ type: 'image', storageObjectId: object.id, detail: 'high' })).expect(200);

      const [delivered] = t.harness.fake.callsTo('responses.create')[0].storageInputs!;

      expect(delivered).toMatchObject({ strategy: 'presigned_url', modality: 'image' });
      expect(delivered.url).toContain(IN_MEMORY_PRESIGNED_SIGNATURE);
      expectNoSecrets(JSON.stringify(res.body), JSON.stringify(res.headers));
    });

    it("another user's object is 403 with details.storageObjectId — nothing reaches the provider", async () => {
      const foreign = pdf(HARNESS_OTHER_USER);

      const res = await post('/api/ai/responses', body({ type: 'file', storageObjectId: foreign.id })).expect(403);

      expect(res.body.details).toMatchObject({ storageObjectId: foreign.id });
      expect(t.harness.fake.calls).toEqual([]);
    });

    it('an unknown object is 404', async () => {
      await post('/api/ai/responses', body({ type: 'file', storageObjectId: '33333333-3333-4333-8333-333333333333' })).expect(404);

      expect(t.harness.fake.calls).toEqual([]);
    });

    it('a PDF to a model without file input is 400 AI_CAPABILITY_UNSUPPORTED', async () => {
      const res = await post('/api/ai/responses', body({ type: 'file', storageObjectId: pdf().id }, TEXT_ONLY)).expect(400);

      expect(res.body.details).toMatchObject({ reason: 'AI_CAPABILITY_UNSUPPORTED', capability: 'file_input' });
    });

    it('an oversized file is 400 AI_INVALID_REQUEST', async () => {
      const res = await post(
        '/api/ai/responses',
        body({ type: 'file', storageObjectId: pdf(HARNESS_USER, AI_STORAGE_INPUT_FILE_MAX_BYTES + 1).id }),
      ).expect(400);

      expect(res.body.details).toMatchObject({ reason: 'AI_INVALID_REQUEST', maxBytes: AI_STORAGE_INPUT_FILE_MAX_BYTES });
    });

    it('unconfigured object storage is 503 AI_STORAGE_UNAVAILABLE', async () => {
      const object = png();

      t.harness.storage.setConfigured(false);

      const res = await post('/api/ai/responses', body({ type: 'image', storageObjectId: object.id })).expect(503);

      expect(res.body.details.reason).toBe('AI_STORAGE_UNAVAILABLE');
      expect(t.harness.fake.calls).toEqual([]);
    });

    it.each([
      ['both url and storageObjectId', { type: 'file', url: 'https://example.com/a.pdf', storageObjectId: '11111111-1111-4111-8111-111111111111' }],
      ['a malformed storageObjectId', { type: 'file', storageObjectId: 'not-a-uuid' }],
      ['neither', { type: 'image' }],
    ])('a part with %s is a 400 validation error', async (_name, part) => {
      await post('/api/ai/responses', body(part)).expect(400);

      expect(t.harness.fake.calls).toEqual([]);
    });
  });

  describe('POST /api/ai/responses/stream', () => {
    it('streams with the stored file delivered, and deletes the upload once the stream ends', async () => {
      const object = pdf();

      const res = await post('/api/ai/responses/stream', body({ type: 'file', storageObjectId: object.id })).expect(200);
      const frames = parseSse(res.text);

      expect(frames.at(-1)?.event).toBe('response.completed');
      expect(t.harness.fake.callsTo('responses.stream')[0].storageInputs?.[0].fileId).toBe('fake_file_1');
      expect(t.harness.fake.deletedFileIds).toEqual(['fake_file_1']);
      expectNoSecrets(res.text);
    });

    it("a pre-stream refusal (another user's object) is an ordinary JSON 403", async () => {
      const res = await post('/api/ai/responses/stream', body({ type: 'file', storageObjectId: pdf(HARNESS_OTHER_USER).id })).expect(403);

      expect(res.headers['content-type']).toMatch(/json/);
    });
  });

  describe('POST /api/ai/runs', () => {
    it('stores only the storage object id; the job resolves the inputs when it runs', async () => {
      const doc = pdf();
      const img = png();
      const presign = t.harness.storage.provider.getSignedDownloadUrl as jest.Mock;

      presign.mockClear();

      const started = await post('/api/ai/runs', {
        model: HARNESS_MODEL,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'text', text: 'Compare.' },
              { type: 'file', storageObjectId: doc.id },
              { type: 'image', storageObjectId: img.id },
            ],
          },
        ],
      }).expect(202);

      expect(aiRunStartedSchema.safeParse(started.body.data).success).toBe(true);
      expect(presign).not.toHaveBeenCalled();

      const handler = t.context.app.get(JobHandlerRegistry).get('ai.response.run');

      await handler!.process({ id: started.body.data.jobId, payload: { runId: started.body.data.runId } } as never);

      const run = await request(server()).get(`/api/ai/runs/${started.body.data.runId}`).set(authHeader(token)).expect(200);

      expect(run.body.data.status).toBe('succeeded');
      expect(t.harness.fake.callsTo('responses.create')[0].storageInputs?.map((i) => i.strategy)).toEqual([
        'upload',
        'presigned_url',
      ]);
      expectNoSecrets(JSON.stringify(run.body), JSON.stringify(started.body));
    });

    it("another user's object is refused at queue time, nothing queued", async () => {
      await post('/api/ai/runs', body({ type: 'file', storageObjectId: pdf(HARNESS_OTHER_USER).id })).expect(403);

      expect(t.harness.runRows).toEqual([]);
    });
  });
});
