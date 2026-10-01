// =============================================================================
// Profanity unlock tripwire (E7.2, #242; docs/specs/ai-coach.md §2.4, §5)
// =============================================================================
//
// Profanity is impossible unless ALL FOUR unlock conditions hold. This suite
// walks the whole condition space and checks every consumer of
// `resolveRegister` agrees with it:
//
//   - the settings route (`effective.register`, and the 403 on a profanity write)
//   - the personas route (uncensored Sarge L3 lines only when unlocked)
//   - the prompt builder's persona style (`renderPersonaStyle`: L3 rubric only when unlocked)
//   - the content guard (profane text passes only when unlocked)
//
// E7.5 (generator) and E7.6 (voice preview) extend it.
// =============================================================================

import request from 'supertest';

import { guardCoachMessage } from '../../src/coach/guard/coach-content-guard';
import { COACH_INTENSITIES, COACH_PERSONAS, getCoachPersona } from '../../src/coach/personas';
import { renderPersonaStyle, resolveRegister, type CoachRegister } from '../../src/coach/personas/resolve-register';
import { setupMockUserSettings } from '../fixtures/mock-setup.helper';
import { authHeader, createMockTestUser, type TestUser } from '../helpers/auth-mock.helper';
import { createAiHttpTestApp, type AiHttpTestApp } from '../ai/ai-http.helper';
import { ADULT_DOB, MINOR_DOB, useDateOfBirth, useSystemCoachPolicy } from './coach-test.helper';

const AGES = {
  adult_dob: { dateOfBirth: ADULT_DOB, adultConfirmedAt: null },
  attested: { dateOfBirth: null, adultConfirmedAt: '2026-01-01T00:00:00.000Z' },
  minor_dob_attested: { dateOfBirth: MINOR_DOB, adultConfirmedAt: '2026-01-01T00:00:00.000Z' },
  unverified: { dateOfBirth: null, adultConfirmedAt: null },
} as const;

type AgeKey = keyof typeof AGES;

interface Case {
  allow: boolean;
  age: AgeKey;
  toggle: boolean;
  personaId: string;
  intensity: 1 | 2 | 3;
}

const HTTP_PERSONAS = ['coach', 'drill_sergeant', 'nana'];

function allCases(personaIds: readonly string[]): Case[] {
  const cases: Case[] = [];
  for (const allow of [true, false])
    for (const age of Object.keys(AGES) as AgeKey[])
      for (const toggle of [true, false])
        for (const personaId of personaIds)
          for (const intensity of COACH_INTENSITIES) cases.push({ allow, age, toggle, personaId, intensity });
  return cases;
}

function expected(c: Case): boolean {
  const adult = c.age === 'adult_dob' || c.age === 'attested';
  return c.allow && adult && c.toggle && c.personaId === 'drill_sergeant' && c.intensity === 3;
}

function registerOf(c: Case): CoachRegister {
  const age = AGES[c.age];
  return resolveRegister(
    { personaId: c.personaId, intensity: c.intensity, profanity: c.toggle, adultConfirmedAt: age.adultConfirmedAt },
    { allowProfanePersonas: c.allow },
    { dateOfBirth: age.dateOfBirth },
  );
}

const PROFANE_MESSAGE = {
  title: 'Recruit',
  body: 'Get off your ass and get to the bar, recruit. No fucking excuses.',
  pushTitle: 'Recruit',
  pushBody: 'Your hour.',
  audioScript: 'Get off your ass and get to the bar.',
};

describe('profanity unlock tripwire: every consumer agrees with resolveRegister', () => {
  describe('pure consumers, every persona', () => {
    it.each(allCases(COACH_PERSONAS.map((p) => p.id)).map((c) => [c] as const))('%o', (c) => {
      const register = registerOf(c);
      expect(register.profane).toBe(expected(c));

      // The prompt builder's persona style: a profane rubric only when unlocked.
      const style = renderPersonaStyle(c.personaId, c.intensity, register);
      const persona = getCoachPersona(c.personaId);
      expect(persona.profaneIntensities.includes(style.intensity)).toBe(register.profane);

      // The guard: profane text passes only when unlocked.
      const result = guardCoachMessage(PROFANE_MESSAGE, {
        personaId: c.personaId,
        intensity: c.intensity,
        register,
        lockScreenSafe: true,
        allowedNumbers: [],
      });
      expect(result.ok).toBe(register.profane);
      if (!register.profane) expect(result.reasons).toContain('profanity');
    });
  });

  describe('the routes', () => {
    let t: AiHttpTestApp;
    let user: TestUser;
    let setPolicy: ReturnType<typeof useSystemCoachPolicy>;

    beforeAll(async () => {
      t = await createAiHttpTestApp();
      t.reset();
      user = await createMockTestUser(t.context, { roleName: 'contributor' });
      setPolicy = useSystemCoachPolicy(t.context);
    }, 60_000);

    afterAll(async () => {
      await t.close();
    });

    it('settings, personas and the profanity write agree over the whole condition space', async () => {
      const server = t.context.app.getHttpServer();
      const failures: string[] = [];

      for (const c of allCases(HTTP_PERSONAS)) {
        const age = AGES[c.age];
        const label = JSON.stringify(c);
        setPolicy({ allowProfanePersonas: c.allow });
        useDateOfBirth(t.context, age.dateOfBirth);
        setupMockUserSettings(user.id, {
          theme: 'system',
          profile: { imageSource: 'none' },
          coach: { personaId: c.personaId, intensity: c.intensity, profanity: c.toggle, adultConfirmedAt: age.adultConfirmedAt },
        });
        const want = expected(c);

        const settings = await request(server).get('/api/coach/settings').set(authHeader(user.accessToken));
        if (settings.body.data?.effective?.register?.profane !== want) failures.push(`${label}: settings register ${JSON.stringify(settings.body.data?.effective?.register)}`);

        const personas = await request(server).get('/api/coach/personas').set(authHeader(user.accessToken));
        const sarge = personas.body.data?.find((p: any) => p.id === 'drill_sergeant');
        if (sarge?.censored !== !want) failures.push(`${label}: personas censored=${sarge?.censored}`);
        if (!want && /fuck|shit|damn/i.test(JSON.stringify(personas.body))) failures.push(`${label}: profane line served`);

        // A profanity write is accepted exactly when conditions 1, 2 and 4 hold.
        const writable = expected({ ...c, toggle: true });
        const write = await request(server)
          .put('/api/coach/settings')
          .set(authHeader(user.accessToken))
          .send({ profanity: true });
        if (writable && write.status !== 200) failures.push(`${label}: write refused ${write.status}`);
        if (!writable && (write.status !== 403 || write.body.details?.code !== 'COACH_PROFANITY_LOCKED')) {
          failures.push(`${label}: write not locked (${write.status})`);
        }
        if (!writable && write.body.details?.reason !== registerOf({ ...c, toggle: true }).reason) {
          failures.push(`${label}: reason ${write.body.details?.reason}`);
        }
      }

      expect(failures).toEqual([]);
    }, 120_000);
  });
});
