// =============================================================================
// POST /api/coach/voice-preview over HTTP (E7.6, #246)
// =============================================================================
//
// Over the AI runtime harness (fake speech model, voices alloy and echo): the
// 202 run handle, the static sample line actually spoken (never user data),
// profanity censoring by the caller's register, 403 COACH_AUDIO_DISABLED,
// 409 when `coach.voice` cannot resolve, the per-user rate limit (11th call
// 429 with Retry-After and no provider run), 400 for an unknown persona.
// RBAC and the kill switch are covered by the `test/ai/` suites, which
// discover this route automatically.
// =============================================================================

import request from 'supertest';

import { AiFeatureModelResolver } from '../../src/ai/assignments/ai-feature-model-resolver.service';
import { HARNESS_USER } from '../../src/ai/testing/ai-runtime-harness';
import { CoachPreviewRateLimiter, COACH_PREVIEW_LIMIT } from '../../src/coach/audio/coach-preview-rate-limiter';
import { COACH_PREVIEW_FILL } from '../../src/coach/audio/coach-voice-preview.service';
import { COACH_PERSONAS } from '../../src/coach/personas';
import { fillPlaceholders } from '../../src/coach/nudges/static-fallback';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { authHeader, createMockTestUser, type TestUser } from '../helpers/auth-mock.helper';
import { ALL_KEYS, createAiHttpTestApp, type AiHttpTestApp } from '../ai/ai-http.helper';
import { ADULT_DOB, useSystemCoachPolicy } from './coach-test.helper';

const PATH = '/api/coach/voice-preview';

function persona(id: string) {
  return COACH_PERSONAS.find((p) => p.id === id)!;
}

describe('POST /api/coach/voice-preview (E7.6)', () => {
  let t: AiHttpTestApp;
  let alice: TestUser;
  let setPolicy: ReturnType<typeof useSystemCoachPolicy>;

  beforeAll(async () => {
    t = await createAiHttpTestApp({}, { harnessFeatureResolver: true });
  }, 60_000);

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.reset();
    t.context.app.get(CoachPreviewRateLimiter).reset();
    alice = await createMockTestUser(t.context, { id: HARNESS_USER, roleName: 'contributor' });
    setPolicy = useSystemCoachPolicy(t.context);
    userSettings({});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** The caller's stored `coach` namespace and date of birth, as the preview reads them. */
  function userSettings(coach: Record<string, unknown>, dateOfBirth: string | null = null) {
    (t.context.prismaMock as any).userSettings.findUnique.mockResolvedValue({
      userId: HARNESS_USER,
      value: { coach },
      version: 1,
      user: { healthProfile: { dateOfBirth: dateOfBirth ? new Date(`${dateOfBirth}T00:00:00.000Z`) : null } },
    });
  }

  const server = () => t.context.app.getHttpServer();
  const post = (body: unknown, user: TestUser = alice) =>
    request(server()).post(PATH).set(authHeader(user.accessToken)).send(body as object);

  /** Runs the queued speech job and returns the text the fake provider spoke. */
  async function spoken(handle: { runId: string; jobId: string }): Promise<string> {
    const handler = t.context.app.get(JobHandlerRegistry).get('ai.audio.speech')!;
    await handler.process({ id: handle.jobId, attempts: 1, payload: { runId: handle.runId } } as never);
    const run = await request(server()).get(`/api/ai/runs/${handle.runId}`).set(authHeader(alice.accessToken)).expect(200);
    expect(run.body.data).toMatchObject({ status: 'succeeded', output: { type: 'speech', aiGenerated: true } });
    const object = t.harness.storage.objects.find((o) => o.id === run.body.data.output.storageObjectId)!;
    expect(object.uploadedById).toBe(HARNESS_USER);
    // The fake provider stores `FAKE-<format>:<voice>:<input>`.
    return t.harness.storage.blobs.get(object.storageKey)!.toString().replace(/^FAKE-mp3:[a-z]+:/, '');
  }

  it('answers 202 with the run; the run speaks the persona\'s static sample line with demo values, never user data', async () => {
    userSettings({ why: 'SECRET-WHY-CANARY', personaId: 'stoic' });
    const res = await post({ personaId: 'coach', voice: 'alloy', moment: 'missed_twice' }).expect(202);

    expect(res.body.data).toEqual({
      runId: expect.any(String),
      jobId: expect.any(String),
      personaId: 'coach',
      intensity: 2,
      moment: 'missed_twice',
      voice: 'alloy',
      censored: false,
    });

    const text = await spoken(res.body.data);
    expect(text).toBe(fillPlaceholders(persona('coach').sampleLines.missed_twice[2], COACH_PREVIEW_FILL));
    expect(text).not.toContain('SECRET-WHY-CANARY');

    const serialised = JSON.stringify(res.body);
    for (const key of ALL_KEYS) expect(serialised).not.toContain(key);
  });

  it('defaults the moment and uses the caller\'s saved intensity', async () => {
    userSettings({ intensity: 1 });
    const res = await post({ personaId: 'coach', voice: 'alloy' }).expect(202);
    expect(res.body.data).toMatchObject({ moment: 'streak_at_risk', intensity: 1 });
  });

  it('locked register: Sarge L3 speaks the clean L2 line and answers censored', async () => {
    const res = await post({ personaId: 'drill_sergeant', intensity: 3, voice: 'alloy', moment: 'missed_session' }).expect(202);

    expect(res.body.data).toMatchObject({ intensity: 2, censored: true });
    const text = await spoken(res.body.data);
    const sarge = persona('drill_sergeant');
    expect(text).toBe(fillPlaceholders(sarge.sampleLines.missed_session[2], COACH_PREVIEW_FILL));
    expect(text).not.toBe(fillPlaceholders(sarge.sampleLines.missed_session[3], COACH_PREVIEW_FILL));
  });

  it('unlocked register: Sarge L3 speaks the L3 line', async () => {
    setPolicy({ allowProfanePersonas: true });
    userSettings({ profanity: true, personaId: 'drill_sergeant', intensity: 3 }, ADULT_DOB);

    const res = await post({ personaId: 'drill_sergeant', intensity: 3, voice: 'alloy', moment: 'missed_session' }).expect(202);

    expect(res.body.data).toMatchObject({ intensity: 3, censored: false });
    expect(await spoken(res.body.data)).toBe(
      fillPlaceholders(persona('drill_sergeant').sampleLines.missed_session[3], COACH_PREVIEW_FILL),
    );
  });

  it('403 COACH_AUDIO_DISABLED while the deployment disallows audio; nothing is queued', async () => {
    setPolicy({ allowAudio: false });
    const res = await post({ personaId: 'coach', voice: 'alloy' }).expect(403);
    expect(res.body.details).toMatchObject({ code: 'COACH_AUDIO_DISABLED' });
    expect(t.harness.runRows).toEqual([]);
  });

  it('409 AI_FEATURE_UNAVAILABLE when coach.voice cannot resolve; nothing is queued', async () => {
    jest
      .spyOn(t.context.app.get(AiFeatureModelResolver), 'resolve')
      .mockResolvedValue({ featureId: 'coach.voice', state: 'missing_capability', fix: 'admin' } as never);

    const res = await post({ personaId: 'coach', voice: 'alloy' }).expect(409);
    expect(res.body.details).toMatchObject({ reason: 'AI_FEATURE_UNAVAILABLE', featureId: 'coach.voice' });
    expect(t.harness.runRows).toEqual([]);
  });

  it('400 COACH_PERSONA_UNKNOWN for a persona outside the registry; 400 for a bad body', async () => {
    const res = await post({ personaId: 'sensei' }).expect(400);
    expect(res.body.details).toMatchObject({ code: 'COACH_PERSONA_UNKNOWN' });
    await post({ personaId: 'coach', speed: 3 }).expect(400);
    await post({ personaId: 'coach', text: 'say this instead' }).expect(400);
    expect(t.harness.runRows).toEqual([]);
  });

  it(`the ${COACH_PREVIEW_LIMIT + 1}th preview inside the window is 429 with Retry-After, and makes no provider run`, async () => {
    for (let i = 0; i < COACH_PREVIEW_LIMIT; i += 1) {
      await post({ personaId: 'coach', voice: 'alloy' }).expect(202);
    }
    const runsBefore = t.harness.runRows.length;

    const res = await post({ personaId: 'coach', voice: 'alloy' }).expect(429);

    expect(res.body.details).toMatchObject({ code: 'COACH_PREVIEW_RATE_LIMITED', reason: 'COACH_PREVIEW_RATE_LIMITED' });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(t.harness.runRows.length).toBe(runsBefore);
  });

  it('the limit is per user', async () => {
    for (let i = 0; i < COACH_PREVIEW_LIMIT; i += 1) await post({ personaId: 'coach', voice: 'alloy' }).expect(202);
    const bob = await createMockTestUser(t.context, { roleName: 'contributor' });
    const res = await post({ personaId: 'coach', voice: 'alloy' }, bob);
    expect(res.status).not.toBe(429);
  });

  it('401 without a token', async () => {
    await request(server()).post(PATH).send({ personaId: 'coach' }).expect(401);
  });
});
