// =============================================================================
// GET|POST /api/coach/messages/:id/audio over HTTP (on-demand Listen, #259)
// =============================================================================
//
// Over the AI runtime harness (fake speech model, voices alloy and echo) with
// a stateful mocked `coach_messages` row: owner and role scoping (404), the
// audio switches (403 COACH_AUDIO_DISABLED), ready -> 200 with no run,
// pending -> 202 with no second run, none/failed -> one queued speech run
// (the stored script, links read as labels, `data.audioOnDemand`), two
// concurrent presses -> one run, the per-user limit (429 with Retry-After,
// no run), an unresolved `coach.voice` (409, no run), a refused `speak()`
// (200 failed), and the kill switch. RBAC and the kill switch over every
// route are also covered by the `test/ai/` suites, which discover these.
// =============================================================================

import request from 'supertest';

import { AiFeatureModelResolver } from '../../src/ai/assignments/ai-feature-model-resolver.service';
import { HARNESS_USER } from '../../src/ai/testing/ai-runtime-harness';
import { COACH_LISTEN_LIMIT, CoachListenRateLimiter } from '../../src/coach/audio/coach-listen-rate-limiter';
import { CoachPreviewRateLimiter } from '../../src/coach/audio/coach-preview-rate-limiter';
import { JobsService } from '../../src/jobs/jobs.service';
import { authHeader, createMockTestUser, createMockViewerUser, type TestUser } from '../helpers/auth-mock.helper';
import { ALL_KEYS, createAiHttpTestApp, type AiHttpTestApp } from '../ai/ai-http.helper';
import { useSystemCoachPolicy } from './coach-test.helper';

const MESSAGE = '00000000-0000-4000-8000-0000000000a1';
const OBJECT = '00000000-0000-4000-8000-0000000000c1';
const RUN = '00000000-0000-4000-8000-0000000000d1';
const PATH = `/api/coach/messages/${MESSAGE}/audio`;

interface StoredMessage {
  id: string;
  userId: string;
  role: string;
  kind: string;
  body: string;
  personaId: string | null;
  intensity: number | null;
  audioStatus: string;
  audioStorageObjectId: string | null;
  audioRunId: string | null;
  data: Record<string, unknown> | null;
}

/** A tiny matcher for the `where` shapes the audio service uses. */
function matches(row: StoredMessage, where: Record<string, any>): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(cond as Record<string, any>[]).some((alt) => matches(row, alt))) return false;
      continue;
    }
    const value = (row as unknown as Record<string, unknown>)[key];
    if (cond && typeof cond === 'object' && 'in' in cond) {
      if (!(cond.in as unknown[]).includes(value)) return false;
    } else if (value !== cond) {
      return false;
    }
  }
  return true;
}

describe('GET|POST /api/coach/messages/:id/audio (#259)', () => {
  let t: AiHttpTestApp;
  let alice: TestUser;
  let setPolicy: ReturnType<typeof useSystemCoachPolicy>;
  let stored: StoredMessage;
  let enqueue: jest.SpyInstance;

  beforeAll(async () => {
    t = await createAiHttpTestApp({}, { harnessFeatureResolver: true });
  }, 60_000);

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.reset();
    t.context.app.get(CoachListenRateLimiter).reset();
    t.context.app.get(CoachPreviewRateLimiter).reset();
    alice = await createMockTestUser(t.context, { id: HARNESS_USER, roleName: 'contributor' });
    setPolicy = useSystemCoachPolicy(t.context, { allowAudio: true });
    userCoach({ audio: { enabled: true, voice: 'alloy', speed: 1.1 } });
    stored = {
      id: MESSAGE,
      userId: HARNESS_USER,
      role: 'coach',
      kind: 'nudge',
      body: 'Two sessions slipped. See [your plan](/programs/123) and go.',
      personaId: 'coach',
      intensity: 2,
      audioStatus: 'none',
      audioStorageObjectId: null,
      audioRunId: null,
      data: { momentKey: 'k', audioScript: 'Two sessions slipped. Want a short one today?', audioInstructions: 'Warm.' },
    };
    const prisma = t.context.prismaMock as any;
    prisma.coachMessage.findFirst.mockImplementation(async ({ where }: any) => (matches(stored, where) ? { ...stored } : null));
    prisma.coachMessage.findUnique.mockImplementation(async ({ where }: any) => (where.id === stored.id ? { ...stored } : null));
    prisma.coachMessage.updateMany.mockImplementation(async ({ where, data }: any) => {
      if (!matches(stored, where)) return { count: 0 };
      stored = { ...stored, ...data };
      return { count: 1 };
    });
    prisma.aiRun.findUnique.mockResolvedValue(null);
    enqueue = jest.spyOn(t.context.app.get(JobsService), 'enqueue').mockResolvedValue({ id: 'job-1' } as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function userCoach(coach: Record<string, unknown>) {
    (t.context.prismaMock as any).userSettings.findUnique.mockResolvedValue({
      userId: HARNESS_USER,
      value: { coach },
      version: 1,
      user: { healthProfile: { dateOfBirth: null } },
    });
  }

  const server = () => t.context.app.getHttpServer();
  const post = (user: TestUser = alice, path = PATH) => request(server()).post(path).set(authHeader(user.accessToken)).send();
  const get = (user: TestUser = alice, path = PATH) => request(server()).get(path).set(authHeader(user.accessToken));
  const settleJobs = () =>
    enqueue.mock.calls.map(([input]) => input as Record<string, any>).filter((input) => input.type === 'coach.audio.settle');

  it('none -> 202 pending with the run id; one speech run of the stored script; the row is marked on demand', async () => {
    const res = await post().expect(202);

    expect(res.body.data).toEqual({ status: 'pending', runId: expect.any(String) });
    expect(t.harness.runRows).toHaveLength(1);
    const run = t.harness.runRows[0];
    expect(res.body.data.runId).toBe(run.id);
    const spoken = JSON.stringify(run.request);
    expect(spoken).toContain('Two sessions slipped. Want a short one today?');
    expect(spoken).toContain('alloy');

    expect(stored).toMatchObject({ audioStatus: 'pending', audioRunId: run.id });
    expect(stored.data).toMatchObject({ momentKey: 'k', audioOnDemand: true, audioRequestedAt: expect.any(String) });

    // The 2-minute wait cap, pinned to this run; never a delivery.
    expect(settleJobs()).toEqual([
      expect.objectContaining({ payload: { messageId: MESSAGE, cause: 'timeout', runId: run.id }, skipDedup: true }),
    ]);
    expect(enqueue.mock.calls.map(([input]) => (input as { type: string }).type)).not.toContain('coach.message.deliver');

    const serialised = JSON.stringify(res.body);
    for (const key of ALL_KEYS) expect(serialised).not.toContain(key);

    // The poll route reads the same state, with no side effect.
    const poll = await get().expect(200);
    expect(poll.body.data).toEqual({ status: 'pending', runId: run.id });
    expect(t.harness.runRows).toHaveLength(1);
  });

  it('speaks the body (links read as labels) when the message has no audioScript', async () => {
    stored.data = { momentKey: 'k' };
    await post().expect(202);
    const spoken = JSON.stringify(t.harness.runRows[0].request);
    expect(spoken).toContain('See your plan and go.');
    expect(spoken).not.toContain('/programs/123');
  });

  it('failed -> a fresh attempt: the previous failure record is cleared', async () => {
    stored = { ...stored, audioStatus: 'failed', data: { ...stored.data, audioFailure: { reason: 'refusal', code: null, at: 'x' } } };
    await post().expect(202);
    expect(stored.audioStatus).toBe('pending');
    expect(stored.data).not.toHaveProperty('audioFailure');
  });

  it('ready -> 200 with the object and voice; no new run, no rate-limit token', async () => {
    stored = { ...stored, audioStatus: 'ready', audioStorageObjectId: OBJECT, data: { voice: 'echo' } };
    const res = await post().expect(200);
    expect(res.body.data).toEqual({ status: 'ready', storageObjectId: OBJECT, voice: 'echo' });
    expect(t.harness.runRows).toEqual([]);

    const poll = await get().expect(200);
    expect(poll.body.data).toEqual({ status: 'ready', storageObjectId: OBJECT, voice: 'echo' });
  });

  it('pending -> 202 with the existing run; no second speak()', async () => {
    stored = { ...stored, audioStatus: 'pending', audioRunId: RUN };
    const res = await post().expect(202);
    expect(res.body.data).toEqual({ status: 'pending', runId: RUN });
    expect(t.harness.runRows).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('two concurrent presses start exactly one speech run', async () => {
    const [a, b] = await Promise.all([post(), post()]);
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(a.body.data.status).toBe('pending');
    expect(b.body.data.status).toBe('pending');
    expect(t.harness.runRows).toHaveLength(1);
  });

  it("404 COACH_MESSAGE_NOT_FOUND for another user's message, a user turn, an unknown and a malformed id", async () => {
    stored.userId = '00000000-0000-4000-8000-0000000000b2';
    const res = await post().expect(404);
    expect(res.body.details).toMatchObject({ code: 'COACH_MESSAGE_NOT_FOUND' });
    await get().expect(404);

    stored.userId = HARNESS_USER;
    stored.role = 'user';
    await post().expect(404);
    await get().expect(404);

    stored.role = 'coach';
    await post(alice, '/api/coach/messages/00000000-0000-4000-8000-0000000000ff/audio').expect(404);
    await post(alice, '/api/coach/messages/not-a-uuid/audio').expect(404);
    expect(t.harness.runRows).toEqual([]);
  });

  it('403 COACH_AUDIO_DISABLED when the deployment disallows audio or the user has it off; nothing is queued', async () => {
    setPolicy({ allowAudio: false });
    const system = await post().expect(403);
    expect(system.body.details).toMatchObject({ code: 'COACH_AUDIO_DISABLED' });

    setPolicy({ allowAudio: true });
    userCoach({ audio: { enabled: false, voice: 'alloy' } });
    const user = await post().expect(403);
    expect(user.body.details).toMatchObject({ code: 'COACH_AUDIO_DISABLED' });

    expect(t.harness.runRows).toEqual([]);
    expect(stored.audioStatus).toBe('none');
  });

  it('409 AI_FEATURE_UNAVAILABLE when coach.voice cannot resolve; nothing is queued or marked', async () => {
    jest
      .spyOn(t.context.app.get(AiFeatureModelResolver), 'resolve')
      .mockResolvedValue({ featureId: 'coach.voice', state: 'missing_capability', fix: 'admin' } as never);

    const res = await post().expect(409);
    expect(res.body.details).toMatchObject({ reason: 'AI_FEATURE_UNAVAILABLE', featureId: 'coach.voice' });
    expect(t.harness.runRows).toEqual([]);
    expect(stored.audioStatus).toBe('none');
  });

  it('a speak() the provider refuses to queue (unknown voice) answers 200 failed and records it', async () => {
    userCoach({ audio: { enabled: true, voice: 'cedar' } });
    const res = await post().expect(200);
    expect(res.body.data).toEqual({ status: 'failed' });
    expect(stored.audioStatus).toBe('failed');
    expect(stored.data).toMatchObject({ audioFailure: expect.objectContaining({ reason: 'provider_error' }) });
  });

  it(`the ${COACH_LISTEN_LIMIT + 1}th new run inside the window is 429 with Retry-After and no run; its own bucket`, async () => {
    for (let i = 0; i < COACH_LISTEN_LIMIT; i += 1) {
      stored = { ...stored, audioStatus: 'none', audioRunId: null };
      await post().expect(202);
    }
    stored = { ...stored, audioStatus: 'none', audioRunId: null };
    const runsBefore = t.harness.runRows.length;

    const res = await post().expect(429);
    expect(res.body.details).toMatchObject({ code: 'COACH_AUDIO_RATE_LIMITED', reason: 'COACH_AUDIO_RATE_LIMITED' });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(t.harness.runRows.length).toBe(runsBefore);
    expect(stored.audioStatus).toBe('none');

    // The voice preview's bucket is untouched.
    await request(server())
      .post('/api/coach/voice-preview')
      .set(authHeader(alice.accessToken))
      .send({ personaId: 'coach', voice: 'alloy' })
      .expect(202);
  });

  it('403 AI_DISABLED for both routes while AI is off, before authentication', async () => {
    t.harness.setPolicy({ enabled: false });
    const res = await post().expect(403);
    expect(res.body.details).toMatchObject({ reason: 'AI_DISABLED' });
    await request(server()).get(PATH).expect(403);
    expect(t.harness.runRows).toEqual([]);
  });

  it('refuses a viewer (no ai:use) and an unauthenticated caller', async () => {
    const viewer = await createMockViewerUser(t.context);
    await post(viewer).expect(403);
    await get(viewer).expect(403);
    await request(server()).post(PATH).expect(401);
    await request(server()).get(PATH).expect(401);
    expect(t.harness.runRows).toEqual([]);
  });
});
