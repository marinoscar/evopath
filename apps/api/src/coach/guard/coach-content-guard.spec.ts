import {
  COACH_REQUIRED_FIELDS,
  bannedCategories,
  extractNumbers,
  guardCoachMessage,
  guardCoachText,
  type CoachGuardContext,
  type CoachMessageText,
} from './coach-content-guard';
import { CoachContentGuard } from './coach-content-guard.service';

// =============================================================================
// The coach content guard (E7.2; docs/specs/ai-coach.md §2.6)
// =============================================================================

const CLEAN: CoachGuardContext = {
  personaId: 'coach',
  intensity: 2,
  register: { profane: false },
  lockScreenSafe: true,
  allowedNumbers: [3, 12, '17:30'],
};

const SARGE_L3_UNLOCKED: CoachGuardContext = {
  personaId: 'drill_sergeant',
  intensity: 3,
  register: { profane: true },
  lockScreenSafe: true,
  allowedNumbers: [3, 12, '17:30'],
};

const GOOD: CoachMessageText = {
  title: 'Back at it',
  body: 'You are 3 sessions from your 12-week goal. Your usual slot is 17:30.',
  pushTitle: 'Coach',
  pushBody: 'Your usual slot is coming up.',
  audioScript: 'You are 3 sessions from your goal.',
  audioInstructions: 'Warm and clear.',
};

const PROFANE_LINE = 'Get off your ass and get to the bar, recruit. No fucking excuses.';

function reasons(message: CoachMessageText, ctx: CoachGuardContext): string[] {
  return guardCoachMessage(message, ctx).reasons;
}

describe('coach content guard', () => {
  it('passes a clean, well-formed message', () => {
    expect(guardCoachMessage(GOOD, CLEAN)).toEqual({ ok: true, violations: [], reasons: [] });
  });

  describe('profanity', () => {
    it.each(['title', 'body', 'pushTitle', 'pushBody', 'audioScript'] as const)(
      'fails `profanity` in %s while the register is clean',
      (field) => {
        const ctx = { ...CLEAN, lockScreenSafe: false };
        const result = guardCoachMessage({ ...GOOD, [field]: 'Move it, damn it.' }, ctx);
        expect(result.violations).toContainEqual({ reason: 'profanity', field });
      },
    );

    it('passes the same text for Sarge L3 with the register unlocked', () => {
      expect(guardCoachMessage({ ...GOOD, body: PROFANE_LINE }, SARGE_L3_UNLOCKED).ok).toBe(true);
    });

    it('fails it for any other persona or level even with a profane register', () => {
      for (const [personaId, intensity] of [
        ['drill_sergeant', 2],
        ['drill_sergeant', 1],
        ['coach', 3],
        ['nana', 3],
      ] as const) {
        expect(reasons({ ...GOOD, body: PROFANE_LINE }, { ...SARGE_L3_UNLOCKED, personaId, intensity })).toContain(
          'profanity',
        );
      }
    });

    it('fails it in an email (always clean) and in a supportive register', () => {
      expect(reasons({ ...GOOD, body: PROFANE_LINE }, { ...SARGE_L3_UNLOCKED, surface: 'email' })).toContain('profanity');
      expect(reasons({ ...GOOD, body: PROFANE_LINE }, { ...SARGE_L3_UNLOCKED, supportive: true })).toContain('profanity');
    });

    it('does not mistake innocent words for profanity', () => {
      for (const text of ['Pass the class assessment', 'Hello there', 'A shift in schedule', 'Scrap that plan']) {
        expect(guardCoachText('body', text, CLEAN)).toEqual([]);
      }
    });
  });

  describe('banned terms and topics (every register)', () => {
    const FIXTURES: Array<[string, string]> = [
      ['slur', 'Stop acting like a retard and train.'],
      ['slur', 'Quit being a fag about it.'],
      ['protected_trait', 'You throw like a girl, recruit.'],
      ['protected_trait', 'Man up and get to the bar.'],
      ['protected_trait', 'Even the immigrants train harder than you.'],
      ['body_shaming', 'Time to burn off that fat.'],
      ['body_shaming', 'Your belly will thank you.'],
      ['body_shaming', 'Let us lose some weight before summer.'],
      ['body_shaming', 'Beach body season is coming.'],
      ['sexual', 'Get sexy for the summer.'],
      ['sexual', 'Nobody wants to see you naked.'],
      ['self_harm', 'Skip it again and you might as well kill yourself.'],
      ['self_harm', 'Thoughts of self-harm are weakness.'],
      ['diet_restriction', 'Skip dinner tonight and you will be fine.'],
      ['diet_restriction', 'You have to earn that pizza.'],
      ['diet_restriction', 'A calorie deficit is the answer.'],
      ['extreme_exercise', 'No pain, no gain, recruit.'],
      ['extreme_exercise', 'Train through the pain today.'],
      ['extreme_exercise', 'Keep going until you puke.'],
      ['medical_claim', 'Training will cure your diabetes.'],
      ['medical_claim', 'This session boosts your immunity.'],
      ['medical_claim', 'You can stop your medication if you train.'],
    ];

    it.each(FIXTURES)('rejects %s: %s', (category, text) => {
      for (const ctx of [CLEAN, SARGE_L3_UNLOCKED]) {
        const violations = guardCoachText('body', text, ctx);
        expect(violations).toContainEqual({ reason: 'banned_term', field: 'body', category });
      }
    });

    it('reports the category, never the text', () => {
      const result = guardCoachMessage({ ...GOOD, body: 'Lose that belly fat.' }, CLEAN);
      expect(JSON.stringify(result)).not.toContain('belly');
      expect(bannedCategories('Lose that belly fat.')).toEqual(['body_shaming']);
    });
  });

  describe('insult target', () => {
    it('fails an insult aimed at the body in the profane register', () => {
      const violations = guardCoachText('body', 'Your fucking legs are pathetic, recruit.', SARGE_L3_UNLOCKED);
      expect(violations).toContainEqual({ reason: 'insult_target', field: 'body' });
    });

    it('fails an insult aimed at health in the profane register', () => {
      expect(guardCoachText('body', 'Your shitty knees are no excuse, you lazy recruit.', SARGE_L3_UNLOCKED)).toContainEqual({
        reason: 'insult_target',
        field: 'body',
      });
    });

    it('fails an insult aimed at the person\'s worth, in any register', () => {
      expect(guardCoachText('body', "You're worthless, recruit.", CLEAN)).toContainEqual({ reason: 'insult_target', field: 'body' });
    });

    it('passes an insult aimed at effort and excuses', () => {
      expect(guardCoachText('body', 'Your excuses are lazy as shit. Get to the bar.', SARGE_L3_UNLOCKED)).toEqual([]);
    });
  });

  describe('lock screen', () => {
    it.each([
      ['profanity', 'Move your ass, recruit.'],
      ['a health term', 'Log your weight today.'],
      ['a digit', 'Session at 17:30.'],
    ])('fails `lock_screen` when pushBody carries %s', (_what, pushBody) => {
      expect(guardCoachMessage({ ...GOOD, pushBody }, SARGE_L3_UNLOCKED).violations).toContainEqual({
        reason: 'lock_screen',
        field: 'pushBody',
      });
    });

    it('applies to pushTitle too', () => {
      expect(reasons({ ...GOOD, pushTitle: '3 sessions left' }, CLEAN)).toContain('lock_screen');
    });

    it('with lockScreenSafe off, an unlocked register may put profanity in pushBody', () => {
      const ctx = { ...SARGE_L3_UNLOCKED, lockScreenSafe: false };
      expect(guardCoachMessage({ ...GOOD, pushBody: 'Move your ass, recruit.' }, ctx).ok).toBe(true);
    });

    it('the in-app body may stay profane while the push fields are clean', () => {
      expect(guardCoachMessage({ ...GOOD, body: PROFANE_LINE, pushBody: 'Recruit. Your hour.' }, SARGE_L3_UNLOCKED).ok).toBe(true);
    });
  });

  describe('length', () => {
    it.each([
      ['pushBody', 141],
      ['title', 61],
      ['body', 321],
      ['pushTitle', 61],
      ['audioScript', 601],
      ['audioInstructions', 301],
    ] as const)('fails `length` when %s is %s characters', (field, size) => {
      expect(guardCoachMessage({ ...GOOD, [field]: 'a'.repeat(size) }, CLEAN).violations).toContainEqual({
        reason: 'length',
        field,
      });
    });

    it('accepts exactly the limit', () => {
      expect(guardCoachMessage({ ...GOOD, pushBody: 'a'.repeat(140), title: 'a'.repeat(60), body: 'a'.repeat(320) }, CLEAN).ok).toBe(
        true,
      );
    });

    it.each(COACH_REQUIRED_FIELDS)('fails `length` when %s is empty or missing', (field) => {
      expect(guardCoachMessage({ ...GOOD, [field]: '  ' }, CLEAN).violations).toContainEqual({ reason: 'length', field });
      const { [field]: _omitted, ...rest } = GOOD;
      expect(guardCoachMessage(rest, CLEAN).violations).toContainEqual({ reason: 'length', field });
    });
  });

  describe('invented numbers', () => {
    it.each(['title', 'body', 'audioScript'] as const)('fails a figure in %s that is not in the context', (field) => {
      expect(guardCoachMessage({ ...GOOD, [field]: 'You did 7 sessions.' }, CLEAN).violations).toContainEqual({
        reason: 'invented_number',
        field,
      });
    });

    it('accepts figures from the context, including a time and a formatted number', () => {
      const ctx = { ...CLEAN, allowedNumbers: [82.5, 1000, '18:00'] };
      expect(guardCoachText('body', 'From 82.5 to 1,000 at 18:00.', ctx)).toEqual([]);
    });

    it('admits the persona\'s own lexicon figures', () => {
      expect(guardCoachText('body', 'Your mind quits at 40 percent.', { ...SARGE_L3_UNLOCKED, allowedNumbers: [] })).toEqual([]);
      expect(guardCoachText('body', 'Your mind quits at 40 percent.', { ...CLEAN, allowedNumbers: [] })).toContainEqual({
        reason: 'invented_number',
        field: 'body',
      });
    });

    it('extracts tokens', () => {
      expect(extractNumbers('3 sets at 17:30, 82.5 kg, 1,000 reps')).toEqual(['3', '17:30', '82.5', '1,000']);
    });
  });

  describe('supportive register', () => {
    const SUPPORTIVE: CoachGuardContext = { ...CLEAN, supportive: true };

    it.each([
      'No excuses today.',
      "Don't let the streak slip.",
      'Push yourself harder tonight.',
      'You missed Monday. Get to the gym.',
    ])('fails a challenge phrasing: %s', (body) => {
      expect(reasons({ ...GOOD, body }, SUPPORTIVE)).toContain('supportive_register');
    });

    it('fails a pushy angle and passes a supportive one', () => {
      expect(reasons(GOOD, { ...SUPPORTIVE, angle: 'loss_aversion' })).toContain('supportive_register');
      expect(guardCoachMessage(GOOD, { ...SUPPORTIVE, angle: 'identity' }).ok).toBe(true);
      expect(guardCoachMessage(GOOD, { ...SUPPORTIVE, angle: 'future_self' }).ok).toBe(true);
    });

    it('the same challenge phrasing passes outside the supportive register', () => {
      expect(guardCoachMessage({ ...GOOD, body: 'No excuses today.' }, CLEAN).ok).toBe(true);
    });
  });

  describe('CoachContentGuard (counter)', () => {
    it('counts each failed rule once, by reason only', () => {
      const metrics = { coachGuardRejection: jest.fn() };
      const guard = new CoachContentGuard(metrics as never);

      const result = guard.check({ ...GOOD, title: 'Damn', body: 'Damn, 9 sessions.', pushBody: 'a'.repeat(200) }, CLEAN);

      expect(result.ok).toBe(false);
      expect(metrics.coachGuardRejection.mock.calls).toEqual([['profanity'], ['invented_number'], ['length']]);
    });

    it('counts nothing for a passing message', () => {
      const metrics = { coachGuardRejection: jest.fn() };
      new CoachContentGuard(metrics as never).check(GOOD, CLEAN);
      expect(metrics.coachGuardRejection).not.toHaveBeenCalled();
    });
  });
});
