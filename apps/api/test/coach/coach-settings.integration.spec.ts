// =============================================================================
// /api/coach/personas and /api/coach/settings over HTTP (E7.2, #242)
// =============================================================================
//
// Routes, RBAC (`ai:use` behind `AiEnabledGuard`), the unlock rules (DOB over
// attestation, the four profanity conditions), clamping, the audio and coach
// switches, validation. Mocked Prisma, with a stateful user settings registry
// (mock-setup.helper) and a stateful system settings row (coach-test.helper).
// =============================================================================

import request from 'supertest';

import { authHeader, createMockTestUser, createMockViewerUser, type TestUser } from '../helpers/auth-mock.helper';
import { createAiHttpTestApp, type AiHttpTestApp } from '../ai/ai-http.helper';
import { ADULT_DOB, MINOR_DOB, SARGE_L3_PROFANE, useDateOfBirth, useSystemCoachPolicy } from './coach-test.helper';

const SETTINGS = '/api/coach/settings';
const PERSONAS = '/api/coach/personas';

describe('/api/coach/settings and /api/coach/personas (E7.2)', () => {
  let t: AiHttpTestApp;
  let alice: TestUser;
  let setPolicy: ReturnType<typeof useSystemCoachPolicy>;

  const server = () => t.context.app.getHttpServer();
  const get = (path: string) => request(server()).get(path).set(authHeader(alice.accessToken));
  const put = (body: unknown) => request(server()).put(SETTINGS).set(authHeader(alice.accessToken)).send(body as object);

  beforeAll(async () => {
    t = await createAiHttpTestApp();
  }, 60_000);

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.reset();
    alice = await createMockTestUser(t.context, { roleName: 'contributor' });
    setPolicy = useSystemCoachPolicy(t.context);
    useDateOfBirth(t.context, null);
  });

  describe('GET /api/coach/settings', () => {
    it('answers the defaults, the effective values and the policy', async () => {
      const res = await get(SETTINGS).expect(200);

      expect(res.body.data).toEqual({
        settings: {
          enabled: false,
          personaId: 'coach',
          intensity: 2,
          profanity: false,
          adultConfirmedAt: null,
          audio: { enabled: false, voice: null, speed: 1 },
          quietHours: { start: '21:30', end: '07:30' },
          maxNudgesPerDay: 2,
          lockScreenSafe: true,
          photoCadence: 'biweekly',
          why: null,
          preferredTime: null,
        },
        effective: {
          maxNudgesPerDay: 2,
          register: { profane: false, reason: 'system_disabled' },
          intensity: 2,
          voice: 'coral',
        },
        policy: { enabled: true, allowProfanePersonas: false, allowAudio: true, maxNudgesPerDayCeiling: 4 },
      });
    });
  });

  describe('PUT /api/coach/settings', () => {
    it('stores a change and returns it; an omitted field keeps its value, null resets it', async () => {
      await put({ enabled: true, personaId: 'stoic', intensity: 3, why: 'Keep up with my kids' }).expect(200);
      const res = await put({ intensity: null }).expect(200);

      expect(res.body.data.settings).toMatchObject({ enabled: true, personaId: 'stoic', intensity: 2, why: 'Keep up with my kids' });
      expect(res.body.data.effective.voice).toBe('sage');
      expect((await get(SETTINGS).expect(200)).body.data.settings.personaId).toBe('stoic');
    });

    it('400 COACH_PERSONA_UNKNOWN for a personaId outside the registry, and nothing is stored', async () => {
      const prisma = t.context.prismaMock as any;
      const res = await put({ personaId: 'sensei' }).expect(400);

      expect(res.body.details).toMatchObject({ code: 'COACH_PERSONA_UNKNOWN', reason: 'COACH_PERSONA_UNKNOWN' });
      expect(prisma.userSettings.update).not.toHaveBeenCalled();
    });

    it('400 with Zod issues for an intensity outside 1 to 3, an unknown key, or a client-sent adultConfirmedAt', async () => {
      for (const body of [{ intensity: 4 }, { intensity: 0 }, { mood: 'grumpy' }, { adultConfirmedAt: new Date().toISOString() }, { confirmAdult: false }]) {
        const res = await put(body).expect(400);
        expect(res.body.code).toBe('BAD_REQUEST');
      }
      expect((await put({ intensity: 4 }).expect(400)).body.details.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'intensity' })]),
      );
    });

    it('confirmAdult: true stamps adultConfirmedAt server-side', async () => {
      const before = Date.now();
      const res = await put({ confirmAdult: true }).expect(200);

      const stamped = Date.parse(res.body.data.settings.adultConfirmedAt);
      expect(stamped).toBeGreaterThanOrEqual(before - 1000);
      expect(stamped).toBeLessThanOrEqual(Date.now() + 1000);
    });

    describe('profanity: true is refused with COACH_PROFANITY_LOCKED while a condition fails', () => {
      async function expectLocked(body: object, reason: string): Promise<void> {
        const prisma = t.context.prismaMock as any;
        const stored = (await get(SETTINGS).expect(200)).body.data.settings;
        prisma.userSettings.update.mockClear();

        const res = await put(body).expect(403);

        expect(res.body.code).toBe('FORBIDDEN');
        expect(res.body.details).toEqual({ code: 'COACH_PROFANITY_LOCKED', reason });
        expect(prisma.userSettings.update).not.toHaveBeenCalled();
        expect((await get(SETTINGS).expect(200)).body.data.settings).toEqual(stored);
      }

      it('condition 1: system_disabled', async () => {
        await expectLocked({ ...SARGE_L3_PROFANE, confirmAdult: true }, 'system_disabled');
      });

      it('condition 2: age_unverified without a DOB or a confirmation', async () => {
        setPolicy({ allowProfanePersonas: true });
        await expectLocked(SARGE_L3_PROFANE, 'age_unverified');
      });

      it('condition 2: underage when the DOB is under 18, even with confirmAdult in the same call', async () => {
        setPolicy({ allowProfanePersonas: true });
        useDateOfBirth(t.context, MINOR_DOB);
        await expectLocked({ ...SARGE_L3_PROFANE, confirmAdult: true }, 'underage');
      });

      it('condition 2: underage when the DOB is under 18 after an earlier confirmation', async () => {
        setPolicy({ allowProfanePersonas: true });
        useDateOfBirth(t.context, MINOR_DOB);
        const res = await put({ confirmAdult: true }).expect(200);
        expect(res.body.data.settings.adultConfirmedAt).not.toBeNull();

        await expectLocked(SARGE_L3_PROFANE, 'underage');
      });

      it('condition 4: persona_or_intensity for Sarge L2 or any other persona', async () => {
        setPolicy({ allowProfanePersonas: true });
        await put({ confirmAdult: true }).expect(200);

        await expectLocked({ ...SARGE_L3_PROFANE, intensity: 2 }, 'persona_or_intensity');
        await expectLocked({ ...SARGE_L3_PROFANE, personaId: 'nana' }, 'persona_or_intensity');
      });
    });

    it('profanity: true succeeds when all four conditions hold (adult DOB, no confirmation needed)', async () => {
      setPolicy({ allowProfanePersonas: true });
      useDateOfBirth(t.context, ADULT_DOB);

      const res = await put(SARGE_L3_PROFANE).expect(200);

      expect(res.body.data.settings).toMatchObject({ personaId: 'drill_sergeant', intensity: 3, profanity: true });
      expect(res.body.data.effective).toMatchObject({ register: { profane: true, reason: null }, intensity: 3, voice: 'ash' });
    });

    it('profanity: true succeeds with the 18+ confirmation and no DOB, in one call', async () => {
      setPolicy({ allowProfanePersonas: true });

      const res = await put({ ...SARGE_L3_PROFANE, confirmAdult: true }).expect(200);

      expect(res.body.data.effective.register).toEqual({ profane: true, reason: null });
    });

    it('turning the system switch off later silences profanity without touching the stored settings', async () => {
      setPolicy({ allowProfanePersonas: true });
      await put({ ...SARGE_L3_PROFANE, confirmAdult: true }).expect(200);

      setPolicy({ allowProfanePersonas: false });
      const res = await get(SETTINGS).expect(200);

      expect(res.body.data.settings).toMatchObject({ personaId: 'drill_sergeant', intensity: 3, profanity: true });
      expect(res.body.data.effective).toMatchObject({ register: { profane: false, reason: 'system_disabled' }, intensity: 2, voice: 'onyx' });
    });

    it('a DOB under 18 added later silences profanity on the next read', async () => {
      setPolicy({ allowProfanePersonas: true });
      await put({ ...SARGE_L3_PROFANE, confirmAdult: true }).expect(200);

      useDateOfBirth(t.context, MINOR_DOB);

      expect((await get(SETTINGS).expect(200)).body.data.effective.register).toEqual({ profane: false, reason: 'underage' });
    });

    it('profanity: false is always accepted', async () => {
      await put({ profanity: false }).expect(200);
    });

    it('clamps maxNudgesPerDay to the system ceiling in effective, and stores what the user asked for', async () => {
      setPolicy({ maxNudgesPerDayCeiling: 2 });

      const res = await put({ maxNudgesPerDay: 4 }).expect(200);

      expect(res.body.data.settings.maxNudgesPerDay).toBe(4);
      expect(res.body.data.effective.maxNudgesPerDay).toBe(2);
    });

    it('403 COACH_AUDIO_DISABLED to enable audio while the system disallows it', async () => {
      setPolicy({ allowAudio: false });

      const res = await put({ audio: { enabled: true } }).expect(403);
      expect(res.body.details).toMatchObject({ code: 'COACH_AUDIO_DISABLED' });

      await put({ audio: { enabled: false, speed: 1.25 } }).expect(200);
      setPolicy({ allowAudio: true });
      expect((await put({ audio: { enabled: true } }).expect(200)).body.data.settings.audio).toEqual({
        enabled: true,
        voice: null,
        speed: 1.25,
      });
    });

    it('403 COACH_DISABLED to enable the coach while the system switch is off', async () => {
      setPolicy({ enabled: false });

      const res = await put({ enabled: true, personaId: 'hype' }).expect(403);
      expect(res.body.details).toMatchObject({ code: 'COACH_DISABLED' });

      await put({ enabled: false }).expect(200);
    });
  });

  describe('GET /api/coach/personas', () => {
    it('lists the seven personas with every moment at every intensity', async () => {
      const res = await get(PERSONAS).expect(200);

      expect(res.body.data.map((p: any) => p.id)).toEqual(['coach', 'drill_sergeant', 'stoic', 'analyst', 'butler', 'hype', 'nana']);
      for (const persona of res.body.data) {
        expect(Object.keys(persona.sampleLines)).toHaveLength(14);
        expect(persona.intensities.map((i: any) => i.level)).toEqual([1, 2, 3]);
      }
    });

    it('withholds the uncensored Sarge L3 lines from a caller whose register is not profane', async () => {
      const res = await get(PERSONAS).expect(200);
      const sarge = res.body.data.find((p: any) => p.id === 'drill_sergeant');

      expect(sarge.censored).toBe(true);
      expect(sarge.intensities[2]).toMatchObject({ level: 3, label: 'Unhinged', profane: true });
      expect(JSON.stringify(res.body)).not.toMatch(/fuck|shit|goddamn|damn/i);
      for (const moment of Object.keys(sarge.sampleLines)) {
        expect(sarge.sampleLines[moment]['3']).toBe(sarge.sampleLines[moment]['2']);
      }
    });

    it('serves them to an unlocked caller', async () => {
      setPolicy({ allowProfanePersonas: true });
      await put({ ...SARGE_L3_PROFANE, confirmAdult: true }).expect(200);

      const res = await get(PERSONAS).expect(200);
      const sarge = res.body.data.find((p: any) => p.id === 'drill_sergeant');

      expect(sarge.censored).toBe(false);
      expect(sarge.sampleLines.missed_twice['3']).toContain('fucking');
    });
  });

  describe('access', () => {
    it('a viewer (no ai:use) is refused every route; unauthenticated is 401', async () => {
      const viewer = await createMockViewerUser(t.context);

      for (const [method, path] of [
        ['get', PERSONAS],
        ['get', SETTINGS],
        ['put', SETTINGS],
      ] as const) {
        const res = await request(server())[method](path).set(authHeader(viewer.accessToken)).send({});
        expect(res.status).toBe(403);
        expect(res.body.details).toBeUndefined();
        await request(server())[method](path).send({}).expect(401);
      }
    });

    it('while AI is off every route answers 403 AI_DISABLED', async () => {
      t.harness.setPolicy({ enabled: false });

      for (const [method, path] of [
        ['get', PERSONAS],
        ['get', SETTINGS],
        ['put', SETTINGS],
      ] as const) {
        const res = await request(server())[method](path).set(authHeader(alice.accessToken)).send({});
        expect(res.status).toBe(403);
        expect(res.body.details).toMatchObject({ reason: 'AI_DISABLED' });
      }
    });
  });
});
