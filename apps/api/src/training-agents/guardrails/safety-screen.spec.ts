import { conservativeModeOf, normalizeForScreen, readinessReasons, screenFreeText } from './safety-screen';
import { SAFETY_STOP_GUIDANCE, URGENT_SYMPTOM_RULES } from './safety-keywords';

describe('screenFreeText (guardrail G0)', () => {
  it.each([
    ['chest pain and dizzy', ['urgent:chest_pain', 'urgent:dizziness']],
    ['CHEST PAIN', ['urgent:chest_pain']],
    ['I get chestpain on stairs', ['urgent:chest_pain']],
    ['a pressure in my chest when lifting', ['urgent:chest_pain']],
    ['chest pian sometimes', ['urgent:chest_pain']],
    ['trouble breathing even at rest', ['urgent:breathing_at_rest']],
    ["I can't breathe when lying down", ['urgent:breathing_at_rest']],
    ['short of breath while at rest', ['urgent:breathing_at_rest']],
    ['I fainted after a set', ['urgent:fainting']],
    ['passed out twice', ['urgent:fainting']],
    ['severe dizziness', ['urgent:dizziness']],
    ['feeling dizy', ['urgent:dizziness']],
    ['numbness in my left arm', ['urgent:numbness_arm_face']],
    ['my face feels tingly', ['urgent:numbness_arm_face']],
    ['sudden severe headache during deadlifts', ['urgent:sudden_severe_headache']],
    ['coughing up blood', ['urgent:coughing_blood']],
    ['I think I fractured my wrist', ['urgent:fracture_dislocation']],
    ['shoulder dislocation last month', ['urgent:fracture_dislocation']],
    ['broke my ankle', ['urgent:fracture_dislocation']],
    ['I cannot move my arm', ['urgent:cannot_move']],
    ['cant move my leg', ['urgent:cannot_move']],
    ['dolor de pecho y mareos', ['urgent:chest_pain', 'urgent:dizziness']],
    ['Me desmayé ayer', ['urgent:fainting']],
  ])('%s -> blocked', (text, reasons) => {
    expect(screenFreeText([text])).toEqual({ level: 'blocked', reasons });
  });

  it('negations are not special-cased: "no chest pain" still blocks (fail-safe)', () => {
    expect(screenFreeText(['no chest pain, never fainted']).level).toBe('blocked');
  });

  it('screens every field and blocked wins over conservative', () => {
    const outcome = screenFreeText(['knee pain', null, undefined, '', 'and I passed out']);
    expect(outcome).toEqual({ level: 'blocked', reasons: ['urgent:fainting'] });
  });

  it.each([
    ['knee pain', ['stem:pain']],
    ['old injury in my shoulder', ['stem:injury']],
    ['hamstring strain', ['stem:strain']],
    ['ankle sprain last year', ['stem:sprain']],
    ['achilles tendinopathy', ['stem:tendon']],
    ['my joints are stiff', ['stem:joint']],
    ['recovering from surgery', ['stem:recovering']],
    ['I am pregnant', ['stem:pregnant']],
  ])('%s -> conservative', (text, reasons) => {
    expect(screenFreeText([text])).toEqual({ level: 'conservative', reasons });
  });

  it.each(['Build muscle and get stronger', 'I prefer dumbbells and short sessions', 'Train for a 10k in spring', 'headache-free chestnut lover'])(
    '%s -> ok',
    (text) => {
      expect(screenFreeText([text])).toEqual({ level: 'ok', reasons: [] });
    },
  );

  it('matches on word boundaries only', () => {
    expect(screenFreeText(['chestnut dizzily']).reasons).toEqual(['urgent:dizziness']);
    expect(screenFreeText(['chestnut']).level).toBe('ok');
  });

  it('normalises case, diacritics and punctuation', () => {
    expect(normalizeForScreen('  Dolor-de PÉCHO!! ')).toBe(' dolor de pecho ');
  });

  it('every urgent rule has patterns and the guidance diagnoses nothing and echoes nothing', () => {
    for (const rule of URGENT_SYMPTOM_RULES) expect(rule.patterns.length).toBeGreaterThan(0);
    expect(SAFETY_STOP_GUIDANCE).toMatch(/stop exercising/i);
    expect(SAFETY_STOP_GUIDANCE).toMatch(/urgent medical care/i);
    expect(SAFETY_STOP_GUIDANCE).not.toMatch(/you have|diagnos(?!is)/i);
  });
});

describe('conservative mode', () => {
  it.each([
    [{ energy: 2, sleepQuality: 4, soreness: 2, stress: 2 }, ['readiness:low_energy']],
    [{ energy: 3, sleepQuality: 2, soreness: 2, stress: 2 }, ['readiness:poor_sleep']],
    [{ energy: 3, sleepQuality: 3, soreness: 4, stress: 2 }, ['readiness:high_soreness']],
    [{ energy: 3, sleepQuality: 3, soreness: 2, stress: 4.2 }, ['readiness:high_stress']],
    [{ energy: 2.5, sleepQuality: 2.5, soreness: 3.9, stress: 3.9 }, []],
    [{ energy: null, sleepQuality: null, soreness: null, stress: null }, []],
  ])('readiness %j -> %j', (readiness, reasons) => {
    expect(readinessReasons(readiness)).toEqual(reasons);
  });

  it('a declared limitation, a stem or low readiness each switch it on; nothing leaves it off', () => {
    expect(conservativeModeOf({ texts: ['build muscle'], limitationCount: 0 })).toEqual({ conservative: false, reasons: [] });
    expect(conservativeModeOf({ texts: [], limitationCount: 1 })).toEqual({ conservative: true, reasons: ['limitation_declared'] });
    expect(conservativeModeOf({ texts: ['knee pain'], limitationCount: 0 })).toEqual({ conservative: true, reasons: ['stem:pain'] });
    expect(
      conservativeModeOf({ texts: [], limitationCount: 0, readiness: { energy: 1, sleepQuality: 5, soreness: 1, stress: 1 } }),
    ).toEqual({ conservative: true, reasons: ['readiness:low_energy'] });
  });
});
