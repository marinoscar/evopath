// =============================================================================
// POST /api/ai/audio/speech (issue #439, epic #420)
// =============================================================================
//
// The real controller, guards (`AiEnabledGuard`, JWT, `ai:use`) and DTO over
// the #432 harness (`ai-http.helper.ts`): the real gate pipeline and run
// state machine, the REAL `ai.audio.speech` handler from the Nest container,
// `FakeAiProvider`'s audio port, and in-memory object storage receiving the
// audio. End to end: 202 -> the job runs -> `GET /api/ai/runs/{id}` names a
// storage object the caller owns and can download, disclosed as
// AI-generated. Also: a speech model's voices reach `GET /api/ai/models`.
// The platform-wide invariants (kill switch, RBAC, key policy, secret
// egress) are proven for this route by the #435 suites.
// =============================================================================

import request from 'supertest';

import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { aiRunSchema, aiRunStartedSchema } from '../../src/ai/http/dto/ai-response.dto';
import { classifyOpenAiModel, OPENAI_TTS1_VOICES } from '../../src/ai/providers/openai/openai-model-catalog';
import { aiOutputKeyPrefix } from '../../src/ai/storage/ai-output-writer';
import {
  HARNESS_MODEL,
  HARNESS_OTHER_USER,
  HARNESS_SPEECH_MODEL,
  HARNESS_USER,
} from '../../src/ai/testing/ai-runtime-harness';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { ALL_KEYS, AiHttpTestApp, createAiHttpTestApp } from './ai-http.helper';

const TEXT = 'Your parcel will arrive tomorrow.';

describe('AI speech over HTTP (#439)', () => {
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
  const speak = (body: unknown) => request(server()).post('/api/ai/audio/speech').set(authHeader(token)).send(body as object);
  const getRun = (runId: string) => request(server()).get(`/api/ai/runs/${runId}`).set(authHeader(token));

  /** Runs the queued job through the real handler the app registered. */
  async function runJob(handle: { runId: string; jobId: string }, attempts = 1): Promise<void> {
    const handler = t.context.app.get(JobHandlerRegistry).get('ai.audio.speech');

    expect(handler).toBeDefined();
    await handler!.process({ id: handle.jobId, attempts, payload: { runId: handle.runId } } as never);
  }

  it('answers 202 { runId, jobId }; once the job runs, the run names an audio object the caller owns, marked aiGenerated', async () => {
    const started = await speak({ input: TEXT, model: HARNESS_SPEECH_MODEL, voice: 'echo', format: 'opus' }).expect(202);

    expect(aiRunStartedSchema.safeParse(started.body.data).success).toBe(true);

    const pending = await getRun(started.body.data.runId).expect(200);
    expect(pending.body.data).toMatchObject({ status: 'pending', output: null, modelId: HARNESS_SPEECH_MODEL });

    await runJob(started.body.data);

    const done = await getRun(started.body.data.runId).expect(200);

    expect(aiRunSchema.safeParse(done.body.data).success).toBe(true);
    expect(done.body.data).toMatchObject({
      status: 'succeeded',
      output: {
        type: 'speech',
        provider: 'openai',
        model: HARNESS_SPEECH_MODEL,
        mimeType: 'audio/opus',
        format: 'opus',
        voice: 'echo',
        characters: TEXT.length,
        aiGenerated: true,
      },
    });

    const id: string = done.body.data.output.storageObjectId;
    const object = t.harness.storage.objects.find((o) => o.id === id);

    expect(object).toMatchObject({ uploadedById: HARNESS_USER, status: 'ready', mimeType: 'audio/opus' });
    expect(object!.storageKey).toBe(`${aiOutputKeyPrefix(HARNESS_USER, started.body.data.runId)}speech.opus`);
    expect(object!.metadata).toMatchObject({ aiGenerated: 'true', voice: 'echo' });

    // No audio bytes and no key in anything the API answered.
    const serialised = JSON.stringify(done.body) + JSON.stringify(started.body);
    for (const key of ALL_KEYS) expect(serialised).not.toContain(key);
    expect(serialised).not.toContain('FAKE-opus');

    expect(t.harness.usageEvents).toEqual([
      expect.objectContaining({
        userId: HARNESS_USER,
        operation: 'audio.speech',
        units: { characters: TEXT.length },
        keySource: 'user',
      }),
    ]);
  });

  it('the stored audio is a downloadable storage object owned by the caller', async () => {
    const started = await speak({ input: TEXT }).expect(202);

    await runJob(started.body.data);

    const done = await getRun(started.body.data.runId).expect(200);
    const id: string = done.body.data.output.storageObjectId;
    const object = t.harness.storage.objects.find((o) => o.id === id)!;

    // What `GET /api/storage/objects/{id}/download` signs: the row's key, in the bucket, owned by the caller.
    expect(object.uploadedById).toBe(HARNESS_USER);
    expect(t.harness.storage.blobs.get(object.storageKey)?.toString()).toBe(`FAKE-mp3:alloy:${TEXT}`);
  });

  it('with no model or voice named, uses the first speech model and its first voice', async () => {
    const started = await speak({ input: 'Hi.' }).expect(202);

    await runJob(started.body.data);

    const done = await getRun(started.body.data.runId).expect(200);
    expect(done.body.data).toMatchObject({ modelId: HARNESS_SPEECH_MODEL, output: { voice: 'alloy', format: 'mp3' } });
  });

  it('input over 4096 characters is a 400 before anything is queued or called', async () => {
    const res = await speak({ input: 'x'.repeat(4097), model: HARNESS_SPEECH_MODEL }).expect(400);

    expect(res.body.code).toBeDefined();
    expect(t.harness.runRows).toEqual([]);
    expect(t.harness.fake.calls).toEqual([]);
  });

  it('exactly 4096 characters is accepted', async () => {
    await speak({ input: 'x'.repeat(4096), model: HARNESS_SPEECH_MODEL }).expect(202);
  });

  it('a model without audio_speech is 400 AI_CAPABILITY_UNSUPPORTED', async () => {
    const res = await speak({ input: TEXT, model: HARNESS_MODEL, voice: 'alloy' }).expect(400);

    expect(res.body.details.reason).toBe('AI_CAPABILITY_UNSUPPORTED');
    expect(t.harness.runRows).toEqual([]);
  });

  it('a voice the model does not speak is 400 AI_INVALID_REQUEST', async () => {
    const res = await speak({ input: TEXT, model: HARNESS_SPEECH_MODEL, voice: 'nova' }).expect(400);

    expect(res.body.details).toMatchObject({ reason: 'AI_INVALID_REQUEST', voice: 'nova', voices: ['alloy', 'echo'] });
    expect(t.harness.runRows).toEqual([]);
  });

  it.each([
    ['no input', {}],
    ['an empty input', { input: '' }],
    ['an unknown format', { input: TEXT, format: 'ogg' }],
    ['a speed of 5', { input: TEXT, speed: 5 }],
    ['a speed as a string', { input: TEXT, speed: '1' }],
    ['an unknown field', { input: TEXT, response_format: 'mp3' }],
  ])('%s is a 400 validation error, nothing queued', async (_name, body) => {
    await speak(body).expect(400);

    expect(t.harness.runRows).toEqual([]);
  });

  it('unconfigured storage fails the run AI_STORAGE_UNAVAILABLE — no audio billed', async () => {
    const started = await speak({ input: TEXT }).expect(202);

    t.harness.storage.setConfigured(false);

    // Terminal on the first attempt, and the job returns (issue #509).
    await expect(runJob(started.body.data, 1)).resolves.toBeUndefined();

    const res = await getRun(started.body.data.runId).expect(200);

    expect(res.body.data).toMatchObject({ status: 'failed', errorCode: 'AI_STORAGE_UNAVAILABLE', output: null });
    expect(t.harness.fake.calls).toEqual([]);
  });

  it('can be cancelled like any run: a cancelled speech run never calls the provider or stores audio', async () => {
    const started = await speak({ input: TEXT }).expect(202);

    await request(server()).post(`/api/ai/runs/${started.body.data.runId}/cancel`).set(authHeader(token)).expect(200);
    await runJob(started.body.data);

    expect(t.harness.fake.calls).toEqual([]);
    expect(t.harness.storage.objects).toEqual([]);
  });

  it("another user's speech run is a 404", async () => {
    const started = await speak({ input: TEXT }).expect(202);
    const other = await createMockTestUser(t.context, { id: HARNESS_OTHER_USER, roleName: 'contributor' });

    await request(server()).get(`/api/ai/runs/${started.body.data.runId}`).set(authHeader(other.accessToken)).expect(404);
  });

  it('is behind the kill switch (403 AI_DISABLED, unauthenticated)', async () => {
    t.harness.setPolicy({ enabled: false });

    const res = await request(server()).post('/api/ai/audio/speech').send({ input: TEXT }).expect(403);

    expect(res.body.details.reason).toBe('AI_DISABLED');
  });

  it('requires authentication', async () => {
    await request(server()).post('/api/ai/audio/speech').send({ input: TEXT }).expect(401);
  });

  it("GET /api/ai/models surfaces a speech model's voices in its capabilities", async () => {
    const prisma = t.context.prismaMock;

    (prisma.userAiKey.findMany as jest.Mock).mockResolvedValueOnce([
      { provider: 'openai', reachableModelIds: ['tts-1'] },
    ]);
    (prisma.aiModel.findMany as jest.Mock).mockResolvedValueOnce([
      {
        provider: 'openai',
        modelId: 'tts-1',
        displayName: null,
        capabilities: classifyOpenAiModel('tts-1'),
        enabled: true,
        deprecatedAt: null,
      },
    ]);

    const res = await request(server()).get('/api/ai/models').set(authHeader(token)).expect(200);

    expect(res.body.data).toEqual([
      expect.objectContaining({
        modelId: 'tts-1',
        capabilities: expect.objectContaining({ capabilities: ['audio_speech'], voices: [...OPENAI_TTS1_VOICES] }),
      }),
    ]);
  });
});
