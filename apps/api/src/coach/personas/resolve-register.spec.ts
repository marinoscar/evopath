import { COACH_INTENSITIES, COACH_PERSONA_IDS, COACH_PERSONAS, getCoachPersona } from './index';
import {
  adultCheck,
  ageInYears,
  renderIntensity,
  renderPersonaStyle,
  resolveRegister,
  type CoachRegister,
} from './resolve-register';

const NOW = new Date('2026-10-01T12:00:00Z');
const ADULT_DOB = '1990-05-05';
const MINOR_DOB = '2010-05-05';

describe('resolveRegister (E7.2, docs/specs/ai-coach.md §2.4)', () => {
  describe('the full truth table', () => {
    const systems = [true, false];
    const ages = ['adult_dob', 'attested', 'minor_dob', 'unverified'] as const;
    const toggles = [true, false];

    const cases: Array<[boolean, (typeof ages)[number], boolean, string, number]> = [];
    for (const allow of systems)
      for (const age of ages)
        for (const toggle of toggles)
          for (const personaId of COACH_PERSONA_IDS)
            for (const intensity of COACH_INTENSITIES) cases.push([allow, age, toggle, personaId, intensity]);

    it('covers every combination', () => {
      expect(cases).toHaveLength(2 * 4 * 2 * 7 * 3);
    });

    it.each(cases)('allow=%s age=%s toggle=%s persona=%s L%s', (allow, age, toggle, personaId, intensity) => {
      const dateOfBirth = age === 'adult_dob' ? ADULT_DOB : age === 'minor_dob' ? MINOR_DOB : null;
      const adultConfirmedAt = age === 'attested' || age === 'minor_dob' ? '2026-09-01T00:00:00.000Z' : null;

      const register = resolveRegister(
        { personaId, intensity, profanity: toggle, adultConfirmedAt },
        { allowProfanePersonas: allow },
        { dateOfBirth },
        NOW,
      );

      const adult = age === 'adult_dob' || age === 'attested';
      const combo = personaId === 'drill_sergeant' && intensity === 3;
      const expectedReason = !allow
        ? 'system_disabled'
        : !adult
          ? age === 'minor_dob'
            ? 'underage'
            : 'age_unverified'
          : !toggle
            ? 'toggle_off'
            : !combo
              ? 'persona_or_intensity'
              : null;

      expect(register).toEqual({ profane: expectedReason === null, reason: expectedReason });
    });
  });

  it('profane only for (true, adult, true, drill_sergeant at 3)', () => {
    expect(
      resolveRegister(
        { personaId: 'drill_sergeant', intensity: 3, profanity: true, adultConfirmedAt: null },
        { allowProfanePersonas: true },
        { dateOfBirth: ADULT_DOB },
        NOW,
      ),
    ).toEqual({ profane: true, reason: null });
  });

  it('a DOB under 18 wins over adultConfirmedAt: reason underage', () => {
    expect(
      resolveRegister(
        { personaId: 'drill_sergeant', intensity: 3, profanity: true, adultConfirmedAt: NOW.toISOString() },
        { allowProfanePersonas: true },
        { dateOfBirth: MINOR_DOB },
        NOW,
      ),
    ).toEqual({ profane: false, reason: 'underage' });
  });

  it('no DOB and adultConfirmedAt set: condition 2 passes; no DOB and no attestation: age_unverified', () => {
    expect(adultCheck({ adultConfirmedAt: NOW.toISOString() }, { dateOfBirth: null }, NOW)).toBeNull();
    expect(adultCheck({ adultConfirmedAt: NOW.toISOString() }, null, NOW)).toBeNull();
    expect(adultCheck({ adultConfirmedAt: null }, { dateOfBirth: null }, NOW)).toBe('age_unverified');
  });

  it('an adult DOB passes without any attestation; an unreadable DOB fails closed', () => {
    expect(adultCheck({ adultConfirmedAt: null }, { dateOfBirth: ADULT_DOB }, NOW)).toBeNull();
    expect(adultCheck({ adultConfirmedAt: NOW.toISOString() }, { dateOfBirth: 'not-a-date' }, NOW)).toBe('age_unverified');
  });

  it('ageInYears turns 18 on the birthday, not the day before', () => {
    expect(ageInYears('2008-10-01', NOW)).toBe(18);
    expect(ageInYears('2008-10-02', NOW)).toBe(17);
    expect(adultCheck({ adultConfirmedAt: null }, { dateOfBirth: '2008-10-02' }, NOW)).toBe('underage');
  });

  it('the six other personas are never profane at any level', () => {
    for (const personaId of COACH_PERSONA_IDS.filter((id) => id !== 'drill_sergeant')) {
      for (const intensity of COACH_INTENSITIES) {
        const r = resolveRegister(
          { personaId, intensity, profanity: true, adultConfirmedAt: NOW.toISOString() },
          { allowProfanePersonas: true },
          { dateOfBirth: ADULT_DOB },
          NOW,
        );
        expect(r.profane).toBe(false);
      }
    }
  });
});

describe('renderIntensity / renderPersonaStyle: failing closed', () => {
  const locked: CoachRegister = { profane: false, reason: 'system_disabled' };
  const unlocked: CoachRegister = { profane: true, reason: null };

  it('a locked Sarge L3 receives the L2 (clean) rubric, voice and instructions', () => {
    const style = renderPersonaStyle('drill_sergeant', 3, locked);
    const sarge = getCoachPersona('drill_sergeant');

    expect(style.intensity).toBe(2);
    expect(style.rubric).toEqual(sarge.rubric[2]);
    expect(style.voice).toBe('onyx');
    expect(style.ttsInstructions).toBe(sarge.voice.instructions);
  });

  it('an unlocked Sarge L3 receives the L3 rubric, the ash voice and the extra instructions', () => {
    const style = renderPersonaStyle('drill_sergeant', 3, unlocked);

    expect(style.intensity).toBe(3);
    expect(style.voice).toBe('ash');
    expect(style.ttsInstructions).toContain('profane word');
  });

  it('every other persona and level renders as requested', () => {
    for (const persona of COACH_PERSONAS) {
      for (const level of COACH_INTENSITIES) {
        if (persona.id === 'drill_sergeant' && level === 3) continue;
        expect(renderIntensity(persona, level, locked)).toBe(level);
      }
    }
  });

  it('an unknown persona id renders as the default persona', () => {
    expect(renderPersonaStyle('gone', 2, locked).persona.id).toBe('coach');
  });
});
