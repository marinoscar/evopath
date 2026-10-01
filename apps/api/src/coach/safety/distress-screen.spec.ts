import { DISTRESS_RULES, screenDistress } from './distress-screen';

describe('screenDistress (E7.7)', () => {
  describe.each([
    ['suicidal_ideation', 'I want to kill myself'],
    ['suicidal_ideation', "Honestly I don't want to be alive anymore"],
    ['suicidal_ideation', 'I keep thinking about suicide'],
    ['suicidal_ideation', 'Everyone would be better off without me.'],
    ['suicidal_ideation', "I'm going to end it all"],
    ['suicidal_ideation', 'I wanna die'],
    ['suicidal_ideation', 'There is no reason to live'],
    ['suicidal_ideation', "I'm not safe right now"],
    ['self_harm', 'I have been cutting myself again'],
    ['self_harm', 'I want to hurt myself'],
    ['self_harm', 'self-harm is how I cope'],
    ['self_harm', 'I hurt myself on purpose last night'],
    ['eating_disorder', 'I make myself throw up after dinner'],
    ['eating_disorder', 'Starving myself until the wedding'],
    ['eating_disorder', 'I think I have an eating disorder'],
    ['eating_disorder', "I haven't eaten in 3 days"],
    ['eating_disorder', 'binge and purge every weekend'],
    ['eating_disorder', 'I hate my body'],
    ['eating_disorder', 'ANOREXIA runs in my family and I am relapsing'],
  ])('%s: "%s"', (category, text) => {
    it('is a hit with that category and a rule code', () => {
      const outcome = screenDistress([text]);
      expect(outcome.hit).toBe(true);
      expect(outcome.categories).toContain(category);
      expect(outcome.codes).toContain(`distress:${category}`);
    });
  });

  it.each([
    'This workout is killing me',
    'Leg day is going to kill me',
    'I hurt myself deadlifting, my back is sore',
    'I cut myself some slack this week',
    'I am cutting for summer, how much protein?',
    'How am I doing?',
    "I'm sick for 3 days",
    'My calves are dying after those jumps',
    'I skipped breakfast today',
    'Can you move my workout to Friday?',
    'I purchased new shoes',
    '',
  ])('is not a hit: "%s"', (text) => {
    expect(screenDistress([text])).toEqual({ hit: false, categories: [], codes: [] });
  });

  it('errs on the side of caution for "want to die", even in an idiom', () => {
    expect(screenDistress(['I want to die on this hill']).hit).toBe(true);
  });

  it('ignores null, undefined and blank input', () => {
    expect(screenDistress([null, undefined, '   ']).hit).toBe(false);
  });

  it('reports every category once, in a stable order, across several texts', () => {
    const outcome = screenDistress(['I starve myself', 'and I want to kill myself', 'kill myself']);
    expect(outcome.categories).toEqual(['suicidal_ideation', 'eating_disorder']);
    expect(outcome.codes).toEqual(['distress:suicidal_ideation', 'distress:eating_disorder']);
  });

  it('ignores case, punctuation and diacritics', () => {
    expect(screenDistress(['SÚICIDAL!!!']).hit).toBe(true);
    expect(screenDistress(['self—harm']).hit).toBe(true);
  });

  it('every pattern compiles and is non-empty', () => {
    for (const rule of DISTRESS_RULES) {
      expect(rule.patterns.length).toBeGreaterThan(0);
      for (const p of rule.patterns) expect(() => new RegExp(p)).not.toThrow();
    }
  });
});
