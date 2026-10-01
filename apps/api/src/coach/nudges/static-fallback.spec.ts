import { guardCoachMessage } from '../guard/coach-content-guard';
import { COACH_INTENSITIES, COACH_MOMENTS, COACH_PERSONAS } from '../personas';
import { renderPersonaStyle } from '../personas/resolve-register';
import { kindForMoment, eventForKind } from './coach-message-kinds';
import { COACH_MOMENT_EVENT } from '../planning/plan-coach-moments';
import { fillPlaceholders, staticFallbackMessage, SUPPORTIVE_FALLBACK_LINE } from './static-fallback';

// =============================================================================
// The static fallback (E7.5, #245) cannot fail the guard: every persona, every
// moment, every intensity, both registers, lock screen on and off.
// =============================================================================

const FILL = { n: 3, streak: 4, lift: 'Bench press', time: '18:30' };
const ALLOWED = [3, 4, '18:30'];

describe('staticFallbackMessage', () => {
  for (const persona of COACH_PERSONAS) {
    for (const level of COACH_INTENSITIES) {
      for (const profane of [false, true]) {
        it(`${persona.id} L${level} ${profane ? 'unlocked' : 'locked'}: every moment passes the guard`, () => {
          const register = { profane: profane && persona.id === 'drill_sergeant' && level === 3, reason: null };
          const style = renderPersonaStyle(persona.id, level, register);
          for (const moment of COACH_MOMENTS) {
            for (const lockScreenSafe of [true, false]) {
              const text = staticFallbackMessage({ style, moment, fill: FILL, lockScreenSafe, supportive: false });
              const result = guardCoachMessage(text, {
                personaId: persona.id,
                intensity: style.intensity,
                register,
                lockScreenSafe,
                allowedNumbers: ALLOWED,
              });
              expect({ moment, lockScreenSafe, reasons: result.reasons }).toEqual({ moment, lockScreenSafe, reasons: [] });
            }
          }
        });
      }
    }
  }

  it('uses the calm supportive line under the safety register, and it passes the supportive guard', () => {
    const style = renderPersonaStyle('drill_sergeant', 2, { profane: false, reason: 'toggle_off' });
    const text = staticFallbackMessage({ style, moment: 'missed_twice', fill: FILL, lockScreenSafe: true, supportive: true });
    expect(text.body).toBe(SUPPORTIVE_FALLBACK_LINE);
    const result = guardCoachMessage(text, {
      personaId: 'drill_sergeant',
      intensity: 2,
      register: { profane: false },
      lockScreenSafe: true,
      allowedNumbers: [],
      supportive: true,
      angle: 'identity',
    });
    expect(result.reasons).toEqual([]);
  });

  it('fills every placeholder', () => {
    expect(fillPlaceholders('{n} {streak} {lift} {time} {n}', FILL)).toBe('3 4 Bench press 18:30 3');
  });
});

describe('moment -> kind -> event', () => {
  it('agrees with the planner\'s COACH_MOMENT_EVENT (the pref_off gate) for every planned moment', () => {
    for (const [moment, event] of Object.entries(COACH_MOMENT_EVENT)) {
      expect({ moment, event: eventForKind(kindForMoment(moment as never)) }).toEqual({ moment, event });
    }
  });

  it('maps the kinds of spec §2.2', () => {
    expect(kindForMoment('pr')).toBe('celebration');
    expect(kindForMoment('weekly_target_hit')).toBe('celebration');
    expect(kindForMoment('comeback')).toBe('comeback');
    expect(kindForMoment('photo_prompt')).toBe('photo_prompt');
    expect(kindForMoment('kickoff')).toBe('kickoff');
    expect(kindForMoment('back_off')).toBe('system');
    expect(kindForMoment('missed_twice')).toBe('nudge');
    expect(eventForKind('kickoff')).toBe('coach.nudge');
  });
});
