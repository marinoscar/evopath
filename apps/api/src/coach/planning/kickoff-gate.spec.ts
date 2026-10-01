import { coachNow } from './coach-time';
import { kickoffGate, type KickoffGateInput } from './plan-coach-moments';

// =============================================================================
// kickoffGate (E7.12): the kickoff passes the gates, but "not now" DEFERS it
// to the next allowed instant instead of dropping it. UTC clock throughout.
// =============================================================================

const at = (iso: string) => coachNow(new Date(iso), 'UTC');

function input(overrides: { user?: Partial<KickoffGateInput['user']>; state?: Partial<KickoffGateInput['state']>; system?: Partial<KickoffGateInput['system']>; aiEnabled?: boolean } = {}): KickoffGateInput {
  return {
    aiEnabled: overrides.aiEnabled ?? true,
    system: { enabled: true, maxNudgesPerDayCeiling: 4, ...overrides.system },
    user: {
      enabled: true,
      quietHours: { start: '21:30', end: '07:30' },
      maxNudgesPerDay: 2,
      preferredTime: null,
      ...overrides.user,
    },
    state: { lastNudgeAt: null, nudgesToday: 0, nudgeDayLocal: null, pausedUntil: null, ...overrides.state },
  };
}

describe('kickoffGate', () => {
  it('sends at an ordinary time with nothing in the way', () => {
    expect(kickoffGate(input(), at('2026-10-01T12:00:00Z'))).toEqual({ action: 'send' });
  });

  it.each([
    ['AI off', { aiEnabled: false }],
    ['system coach off', { system: { enabled: false } }],
    ['user coach off', { user: { enabled: false } }],
  ])('%s: suppressed (coach_off), never deferred', (_label, overrides) => {
    expect(kickoffGate(input(overrides as never), at('2026-10-01T12:00:00Z'))).toEqual({ action: 'suppress', reason: 'coach_off' });
  });

  describe('quiet hours defer to the end of the window', () => {
    it.each([
      ['before midnight', '2026-10-01T23:00:00Z', '2026-10-02T07:30:00Z'],
      ['after midnight', '2026-10-02T03:15:00Z', '2026-10-02T07:30:00Z'],
      ['at the start', '2026-10-01T21:30:00Z', '2026-10-02T07:30:00Z'],
    ])('%s', (_label, now, until) => {
      expect(kickoffGate(input(), at(now))).toEqual({ action: 'defer', reason: 'quiet_hours', until: new Date(until) });
    });

    it('a same-day window (13:00 to 14:00)', () => {
      const decision = kickoffGate(input({ user: { quietHours: { start: '13:00', end: '14:00' } } }), at('2026-10-01T13:20:00Z'));
      expect(decision).toEqual({ action: 'defer', reason: 'quiet_hours', until: new Date('2026-10-01T14:00:00Z') });
    });

    it('the end of the window is allowed', () => {
      expect(kickoffGate(input(), at('2026-10-02T07:30:00Z'))).toEqual({ action: 'send' });
    });
  });

  describe('the daily cap defers to the next local morning anchor', () => {
    it('cap = min(user, system); 09:00 without a preferred time', () => {
      const decision = kickoffGate(
        input({ user: { maxNudgesPerDay: 4 }, system: { maxNudgesPerDayCeiling: 1 }, state: { nudgesToday: 1, nudgeDayLocal: '2026-10-01' } }),
        at('2026-10-01T15:00:00Z'),
      );
      expect(decision).toEqual({ action: 'defer', reason: 'daily_cap', until: new Date('2026-10-02T09:00:00Z') });
    });

    it('the preferred time is the anchor when set', () => {
      const decision = kickoffGate(
        input({ user: { preferredTime: '06:45' }, state: { nudgesToday: 2, nudgeDayLocal: '2026-10-01' } }),
        at('2026-10-01T15:00:00Z'),
      );
      expect(decision).toEqual({ action: 'defer', reason: 'daily_cap', until: new Date('2026-10-02T06:45:00Z') });
    });

    it("a stale day's count does not apply", () => {
      expect(kickoffGate(input({ state: { nudgesToday: 9, nudgeDayLocal: '2026-09-30' } }), at('2026-10-01T15:00:00Z'))).toEqual({
        action: 'send',
      });
    });
  });

  it('spacing defers to three hours after the last nudge', () => {
    const decision = kickoffGate(input({ state: { lastNudgeAt: new Date('2026-10-01T11:00:00Z') } }), at('2026-10-01T12:00:00Z'));
    expect(decision).toEqual({ action: 'defer', reason: 'spacing', until: new Date('2026-10-01T14:00:00Z') });
  });

  it('a pause defers to its end; an expired pause does not', () => {
    const pausedUntil = new Date('2026-10-03T00:00:00Z');
    expect(kickoffGate(input({ state: { pausedUntil } }), at('2026-10-01T12:00:00Z'))).toEqual({
      action: 'defer',
      reason: 'paused',
      until: pausedUntil,
    });
    expect(kickoffGate(input({ state: { pausedUntil: new Date('2026-10-01T11:00:00Z') } }), at('2026-10-01T12:00:00Z'))).toEqual({
      action: 'send',
    });
  });
});
