// =============================================================================
// POST /api/ai/audio/transcriptions (issue #438, epic #420)
// =============================================================================
//
// The real controller, guards (`AiEnabledGuard`, JWT, `ai:use`) and DTO over
// the #432 harness (`ai-http.helper.ts`): the real gate pipeline and run
// state machine, the REAL `ai.audio.transcribe` handler from the Nest
// container, `FakeAiProvider`'s audio port, and in-memory object storage
// holding the recording. End to end: upload -> 202 -> the job runs ->
// `GET /api/ai/runs/{id}` shows the transcript. The platform-wide invariants
// (kill switch, RBAC, key policy, secret egress) are proven for this route by
// the #435 suites.
//
// Another user's recording answers 403 — the answer `AiStorageInputResolver`
// (and `/api/storage/objects/{id}` itself) gives — not the 404 the issue text
// suggested; an unknown id is 404. Either way nothing is queued.
// =============================================================================

import request from 'supertest';

import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { aiRunSchema, aiRunStartedSchema } from '../../src/ai/http/dto/ai-response.dto';
import {
  HARNESS_MODEL,
  HARNESS_OTHER_USER,
  HARNESS_TRANSCRIPTION_MODEL,
  HARNESS_USER,
} from '../../src/ai/testing/ai-runtime-harness';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { ALL_KEYS, AiHttpTestApp, createAiHttpTestApp } from './ai-http.helper';

const RECORDING = Buffer.from('r'.repeat(3200)); // 3.2 s from the fake

describe('AI audio transcription over HTTP (#438)', () => {
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
  const transcribe = (body: unknown) =>
    request(server()).post('/api/ai/audio/transcriptions').set(authHeader(token)).send(body as object);
  const getRun = (runId: string) => request(server()).get(`/api/ai/runs/${runId}`).set(authHeader(token));
  const recording = (patch: Partial<Parameters<AiHttpTestApp['harness']['storage']['addObject']>[0]> = {}) =>
    t.harness.storage.addObject({ uploadedById: HARNESS_USER, bytes: RECORDING, mimeType: 'audio/mpeg', name: 'memo.mp3', ...patch });

  /** Runs the queued job through the real handler the app registered. */
  async function runJob(handle: { runId: string; jobId: string }, attempts = 1): Promise<void> {
    const handler = t.context.app.get(JobHandlerRegistry).get('ai.audio.transcribe');

    expect(handler).toBeDefined();
    await handler!.process({ id: handle.jobId, attempts, payload: { runId: handle.runId } } as never);
  }

  it('answers 202 { runId, jobId }; once the job runs, the run carries the transcript', async () => {
    const object = recording();

    const started = await transcribe({
      storageObjectId: object.id,
      model: HARNESS_TRANSCRIPTION_MODEL,
      language: 'en',
      timestampGranularities: ['segment', 'word'],
    }).expect(202);

    expect(aiRunStartedSchema.safeParse(started.body.data).success).toBe(true);

    const pending = await getRun(started.body.data.runId).expect(200);
    expect(pending.body.data).toMatchObject({ status: 'pending', output: null, modelId: HARNESS_TRANSCRIPTION_MODEL });

    await runJob(started.body.data);

    const done = await getRun(started.body.data.runId).expect(200);

    expect(aiRunSchema.safeParse(done.body.data).success).toBe(true);
    expect(done.body.data).toMatchObject({
      status: 'succeeded',
      output: {
        type: 'transcription',
        provider: 'openai',
        model: HARNESS_TRANSCRIPTION_MODEL,
        storageObjectId: object.id,
        text: 'fake transcript of 3200 bytes',
        language: 'en',
        durationSeconds: 3.2,
        segments: [expect.objectContaining({ startSeconds: 0, endSeconds: 3.2 })],
      },
    });
    expect(done.body.data.output.words.length).toBeGreaterThan(0);

    // The recording streamed to the provider byte for byte; no key anywhere in the answers.
    const [call] = t.harness.fake.callsTo('audio.transcribe');
    expect(call.audioBytes!.equals(RECORDING)).toBe(true);
    expect(call.transcriptionRequest?.audio.streamed).toBe(true);

    const serialised = JSON.stringify(done.body) + JSON.stringify(started.body);
    for (const key of ALL_KEYS) expect(serialised).not.toContain(key);

    expect(t.harness.usageEvents).toEqual([
      expect.objectContaining({
        userId: HARNESS_USER,
        operation: 'audio.transcribe',
        units: { audioSeconds: 3.2 },
        keySource: 'user',
        status: 'succeeded',
      }),
    ]);
  });

  it('with no model named, uses the first usable transcription model', async () => {
    const started = await transcribe({ storageObjectId: recording().id }).expect(202);

    const run = await getRun(started.body.data.runId).expect(200);
    expect(run.body.data.modelId).toBe(HARNESS_TRANSCRIPTION_MODEL);
  });

  it.each([['video/mp4'], ['video/webm'], ['audio/x-m4a'], ['audio/ogg; codecs=opus']])('accepts %s', async (mimeType) => {
    await transcribe({ storageObjectId: recording({ mimeType }).id }).expect(202);
  });

  it('a non-audio object is 400 AI_INVALID_REQUEST, nothing queued, no provider call', async () => {
    const pdf = recording({ mimeType: 'application/pdf', name: 'notes.pdf' });

    const res = await transcribe({ storageObjectId: pdf.id }).expect(400);

    expect(res.body.details.reason).toBe('AI_INVALID_REQUEST');
    expect(t.harness.runRows).toEqual([]);
    expect(t.harness.fake.calls).toEqual([]);
  });

  it('an oversized recording (over the provider limit) is 400 AI_INVALID_REQUEST without any provider call', async () => {
    const big = recording({ size: 25 * 1024 * 1024 + 1 });
    (t.harness.storage.provider.download as jest.Mock).mockClear();

    const res = await transcribe({ storageObjectId: big.id, model: HARNESS_TRANSCRIPTION_MODEL }).expect(400);

    expect(res.body.details).toMatchObject({ reason: 'AI_INVALID_REQUEST', maxBytes: 25 * 1024 * 1024 });
    expect(t.harness.runRows).toEqual([]);
    expect(t.harness.fake.calls).toEqual([]);
    expect(t.harness.storage.provider.download).not.toHaveBeenCalled();
  });

  it("another user's recording is 403 (the storage API's answer), and nothing is queued", async () => {
    const foreign = t.harness.storage.addObject({ uploadedById: HARNESS_OTHER_USER, mimeType: 'audio/mpeg' });

    const res = await transcribe({ storageObjectId: foreign.id }).expect(403);

    expect(res.body.details).toMatchObject({ storageObjectId: foreign.id });
    expect(t.harness.runRows).toEqual([]);
    expect(t.harness.fake.calls).toEqual([]);
  });

  it('an unknown recording is 404', async () => {
    await transcribe({ storageObjectId: '33333333-3333-4333-8333-333333333333' }).expect(404);

    expect(t.harness.runRows).toEqual([]);
  });

  it('a model without audio_transcription is 400 AI_CAPABILITY_UNSUPPORTED', async () => {
    const res = await transcribe({ storageObjectId: recording().id, model: HARNESS_MODEL }).expect(400);

    expect(res.body.details.reason).toBe('AI_CAPABILITY_UNSUPPORTED');
    expect(t.harness.runRows).toEqual([]);
  });

  it.each([
    ['no storageObjectId', {}],
    ['a non-uuid storageObjectId', { storageObjectId: 'nope' }],
    ['a language that is not an ISO code', { language: 'English' }],
    ['an over-long prompt', { prompt: 'x'.repeat(4001) }],
    ['an unknown granularity', { timestampGranularities: ['sentence'] }],
    ['repeated granularities', { timestampGranularities: ['word', 'word'] }],
    ['an unknown field', { response_format: 'srt' }],
  ])('%s is a 400 validation error, nothing queued', async (_name, patch) => {
    const body = 'storageObjectId' in patch || _name === 'no storageObjectId' ? patch : { storageObjectId: recording().id, ...patch };

    await transcribe(body).expect(400);

    expect(t.harness.runRows).toEqual([]);
  });

  it('a recording deleted before the job runs fails the run AI_INVALID_REQUEST', async () => {
    const started = await transcribe({ storageObjectId: recording().id }).expect(202);

    t.harness.storage.objects.length = 0;
    await runJob(started.body.data);

    const res = await getRun(started.body.data.runId).expect(200);
    expect(res.body.data).toMatchObject({ status: 'failed', errorCode: 'AI_INVALID_REQUEST', output: null });
    expect(t.harness.fake.calls).toEqual([]);
  });

  it('can be cancelled like any run: a cancelled transcription never calls the provider', async () => {
    const started = await transcribe({ storageObjectId: recording().id }).expect(202);

    await request(server()).post(`/api/ai/runs/${started.body.data.runId}/cancel`).set(authHeader(token)).expect(200);
    await runJob(started.body.data);

    expect(t.harness.fake.calls).toEqual([]);
    expect((await getRun(started.body.data.runId).expect(200)).body.data.status).toBe('cancelled');
  });

  it("another user's transcription run is a 404", async () => {
    const started = await transcribe({ storageObjectId: recording().id }).expect(202);
    const other = await createMockTestUser(t.context, { id: HARNESS_OTHER_USER, roleName: 'contributor' });

    await request(server()).get(`/api/ai/runs/${started.body.data.runId}`).set(authHeader(other.accessToken)).expect(404);
  });

  it('is behind the kill switch (403 AI_DISABLED, unauthenticated)', async () => {
    t.harness.setPolicy({ enabled: false });

    const res = await request(server())
      .post('/api/ai/audio/transcriptions')
      .send({ storageObjectId: '33333333-3333-4333-8333-333333333333' })
      .expect(403);

    expect(res.body.details.reason).toBe('AI_DISABLED');
  });

  it('requires authentication', async () => {
    await request(server())
      .post('/api/ai/audio/transcriptions')
      .send({ storageObjectId: '33333333-3333-4333-8333-333333333333' })
      .expect(401);
  });
});
