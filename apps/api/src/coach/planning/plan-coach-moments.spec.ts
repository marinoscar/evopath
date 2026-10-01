import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { coachNow, type CoachNow } from './coach-time';
import {
  COACH_MOMENT_PRIORITY,
  type CoachMoment,
  type CoachPlanningSettings,
  type CoachPlanningSignals,
  type CoachPlanningState,
  effectiveDailyCap,
  planCoachMoments,
  type PlannedMoment,
  silencesCoach,
  topNudge,
  weeklyReviewOf,
} from './plan-coach-moments';

// =============================================================================
// planCoachMoments: one table per gate (E7.4 acceptance criteria 1-12)
// =============================================================================
//
// Wednesday 2026-09-30 is the default day. `missed_twice` is the probe moment:
// its trigger has no time anchor, so only the gate under test can remove it.
// =============================================================================

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] };

function signalsOf(overrides: Partial<CoachPlanningSignals> = {}): CoachPlanningSignals {
  return {
    missedStreak: 0,
    sessionToday: 'none',
    loggedToday: false,
    missedYesterday: false,
    lastCompletedWorkoutDate: '2026-09-28',
    lastActivityAt: null,
    lastProgressPhotoDate: null,
    safety: { safetyStop: false, painStreak: false, lowReadinessStreak: false },
    event: null,
    ...overrides,
  };
}

function stateOf(overrides: Partial<CoachPlanningState> = {}): CoachPlanningState {
  return {
    lastNudgeAt: null,
    nudgesToday: 0,
    nudgeDayLocal: null,
    consecutiveIgnored: 0,
    pausedUntil: null,
    silencedAt: null,
    usualWorkoutMinuteLocal: null,
    lastWeeklyReviewWeek: null,
    momentsSentToday: [],
    ...overrides,
  };
}

function settingsOf(overrides: DeepPartial<CoachPlanningSettings> = {}): CoachPlanningSettings {
  return {
    aiEnabled: overrides.aiEnabled ?? true,
    system: {
      enabled: true,
      maxNudgesPerDayCeiling: 4,
      autoSilenceAfterIgnored: 3,
      inactiveStopDays: 7,
      ...overrides.system,
    },
    user: {
      enabled: true,
      quietHours: { start: '21:30', end: '07:30' },
      maxNudgesPerDay: 2,
      photoCadence: 'off',
      preferredTime: null,
      ...overrides.user,
    },
    eventEnabled: { ...overrides.eventEnabled },
  };
}

/** The clock at UTC wall time `HH:mm` on `date` (default the Wednesday). */
function utcAt(time: string, date = '2026-09-30'): CoachNow {
  return coachNow(new Date(`${date}T${time}:00Z`), 'UTC');
}

const MISSED_TWICE = signalsOf({ missedStreak: 2 });

function find(plan: PlannedMoment[], moment: CoachMoment): PlannedMoment | undefined {
  return plan.find((m) => m.moment === moment);
}

function outcomeOf(plan: PlannedMoment[], moment: CoachMoment): string {
  const planned = find(plan, moment);
  if (!planned) return 'not_triggered';
  return planned.suppressedBy ?? 'eligible';
}

describe('planCoachMoments', () => {
  describe('quiet hours 21:30 to 07:30, across midnight (AC 1)', () => {
    it.each([
      ['23:00', 'quiet_hours'],
      ['02:00', 'quiet_hours'],
      ['07:29', 'quiet_hours'],
      ['21:30', 'quiet_hours'],
      ['00:00', 'quiet_hours'],
      ['07:30', 'eligible'],
      ['21:29', 'eligible'],
      ['12:00', 'eligible'],
    ])('at %s the moment is %s', (time, expected) => {
      const plan = planCoachMoments(MISSED_TWICE, stateOf(), settingsOf(), utcAt(time));
      expect(outcomeOf(plan, 'missed_twice')).toBe(expected);
    });

    it.each([
      ['18:00', 'eligible'],
      ['21:29', 'eligible'],
      ['21:30', 'quiet_hours'],
      ['23:00', 'quiet_hours'],
    ])('the weekly review lane obeys them too: Sunday %s is %s', (time, expected) => {
      const plan = planCoachMoments(signalsOf(), stateOf(), settingsOf(), utcAt(time, '2026-10-04'));
      expect(outcomeOf(plan, 'weekly_review')).toBe(expected);
    });

    it('a window that does not wrap (13:00 to 15:00) holds only inside it', () => {
      const settings = settingsOf({ user: { quietHours: { start: '13:00', end: '15:00' } } });
      expect(outcomeOf(planCoachMoments(MISSED_TWICE, stateOf(), settings, utcAt('14:00')), 'missed_twice')).toBe('quiet_hours');
      expect(outcomeOf(planCoachMoments(MISSED_TWICE, stateOf(), settings, utcAt('23:00')), 'missed_twice')).toBe('eligible');
    });
  });

  describe('daily cap = min(user, system ceiling) (AC 2)', () => {
    it.each([
      // user, ceiling, nudgesToday, expected
      [4, 2, 2, 'daily_cap'],
      [4, 2, 1, 'eligible'],
      [1, 4, 1, 'daily_cap'],
      [1, 4, 0, 'eligible'],
      [2, 2, 2, 'daily_cap'],
    ])('user %i, ceiling %i, %i sent today: %s', (user, ceiling, sent, expected) => {
      const settings = settingsOf({ user: { maxNudgesPerDay: user }, system: { maxNudgesPerDayCeiling: ceiling } });
      expect(effectiveDailyCap(settings)).toBe(Math.min(user, ceiling));
      const state = stateOf({ nudgesToday: sent, nudgeDayLocal: '2026-09-30' });
      expect(outcomeOf(planCoachMoments(MISSED_TWICE, state, settings, utcAt('12:00')), 'missed_twice')).toBe(expected);
    });

    it('a counter from an earlier local day does not count', () => {
      const state = stateOf({ nudgesToday: 4, nudgeDayLocal: '2026-09-29' });
      expect(outcomeOf(planCoachMoments(MISSED_TWICE, state, settingsOf(), utcAt('12:00')), 'missed_twice')).toBe('eligible');
    });

    it('the weekly review lane is not subject to the cap', () => {
      const state = stateOf({ nudgesToday: 2, nudgeDayLocal: '2026-10-04' });
      const plan = planCoachMoments(MISSED_TWICE, state, settingsOf(), utcAt('18:30', '2026-10-04'));
      expect(outcomeOf(plan, 'missed_twice')).toBe('daily_cap');
      expect(outcomeOf(plan, 'weekly_review')).toBe('eligible');
      expect(weeklyReviewOf(plan)?.isoWeek).toBe('2026-W40');
    });
  });

  describe('3-hour spacing (AC 3)', () => {
    const now = utcAt('12:00');
    it.each([
      [2 * 60 + 59, 'spacing'],
      [3 * 60, 'eligible'],
      [10, 'spacing'],
      [5 * 60, 'eligible'],
    ])('last nudge %i minutes ago: %s', (minutesAgo, expected) => {
      const state = stateOf({ lastNudgeAt: new Date(now.instant.getTime() - minutesAgo * 60_000) });
      expect(outcomeOf(planCoachMoments(MISSED_TWICE, state, settingsOf(), now), 'missed_twice')).toBe(expected);
    });

    it('does not apply to the weekly review lane', () => {
      const now2 = utcAt('19:00', '2026-10-04');
      const state = stateOf({ lastNudgeAt: new Date(now2.instant.getTime() - 60_000) });
      expect(outcomeOf(planCoachMoments(signalsOf(), state, settingsOf(), now2), 'weekly_review')).toBe('eligible');
    });
  });

  describe('auto-silence after N ignored nudges (AC 4)', () => {
    it('at the threshold, exactly one back-off moment and nothing else in the nudge lane', () => {
      const plan = planCoachMoments(MISSED_TWICE, stateOf({ consecutiveIgnored: 3 }), settingsOf(), utcAt('12:00'));
      const nudges = plan.filter((m) => m.lane === 'nudge');
      expect(nudges.map((m) => [m.moment, m.suppressedBy])).toEqual([['back_off', null]]);
      expect(topNudge(plan)?.moment).toBe('back_off');
      expect(silencesCoach('back_off')).toBe(true);
    });

    it('honours a deployment threshold other than 3', () => {
      const settings = settingsOf({ system: { autoSilenceAfterIgnored: 5 } });
      expect(topNudge(planCoachMoments(MISSED_TWICE, stateOf({ consecutiveIgnored: 4 }), settings, utcAt('12:00')))?.moment).toBe('missed_twice');
      expect(topNudge(planCoachMoments(MISSED_TWICE, stateOf({ consecutiveIgnored: 5 }), settings, utcAt('12:00')))?.moment).toBe('back_off');
    });

    it('below the threshold, the ordinary moments', () => {
      const plan = planCoachMoments(MISSED_TWICE, stateOf({ consecutiveIgnored: 2 }), settingsOf(), utcAt('12:00'));
      expect(topNudge(plan)?.moment).toBe('missed_twice');
    });

    it('once silenced, every later pass answers silenced (the back-off is not repeated)', () => {
      const state = stateOf({ consecutiveIgnored: 3, silencedAt: new Date('2026-09-29T12:00:00Z') });
      const plan = planCoachMoments(MISSED_TWICE, state, settingsOf(), utcAt('12:00'));
      expect(find(plan, 'back_off')).toBeUndefined();
      expect(outcomeOf(plan, 'missed_twice')).toBe('silenced');
      expect(topNudge(plan)).toBeNull();
    });

    it.each([
      ['quiet hours', stateOf({ consecutiveIgnored: 3 }), utcAt('23:00'), 'quiet_hours'],
      ['spacing', stateOf({ consecutiveIgnored: 3, lastNudgeAt: new Date('2026-09-30T11:00:00Z') }), utcAt('12:00'), 'spacing'],
      ['the cap (never)', stateOf({ consecutiveIgnored: 3, nudgesToday: 2, nudgeDayLocal: '2026-09-30' }), utcAt('12:00'), 'eligible'],
      ['paused', stateOf({ consecutiveIgnored: 3, pausedUntil: new Date('2026-10-02T00:00:00Z') }), utcAt('12:00'), 'paused'],
    ])('the back-off message obeys %s', (_label, state, now, expected) => {
      expect(outcomeOf(planCoachMoments(MISSED_TWICE, state, settingsOf(), now), 'back_off')).toBe(expected);
    });

    it('preferences never hold the back-off back', () => {
      const settings = settingsOf({ eventEnabled: { 'coach.nudge': false } });
      expect(outcomeOf(planCoachMoments(MISSED_TWICE, stateOf({ consecutiveIgnored: 3 }), settings, utcAt('12:00')), 'back_off')).toBe('eligible');
    });
  });

  describe('win-back stop after inactiveStopDays (AC 5)', () => {
    const now = utcAt('12:00');
    const daysAgo = (days: number, extraMs = 0) => new Date(now.instant.getTime() - days * 86_400_000 + extraMs);

    it('exactly one win_back moment at 7 days of inactivity', () => {
      const plan = planCoachMoments(signalsOf({ missedStreak: 3, lastActivityAt: daysAgo(7) }), stateOf(), settingsOf(), now);
      expect(plan.filter((m) => m.lane === 'nudge').map((m) => m.moment)).toEqual(['win_back']);
      expect(topNudge(plan)?.moment).toBe('win_back');
      expect(silencesCoach('win_back')).toBe(true);
    });

    it('not before (6 days 23:59)', () => {
      const plan = planCoachMoments(signalsOf({ missedStreak: 3, lastActivityAt: daysAgo(7, 60_000) }), stateOf(), settingsOf(), now);
      expect(topNudge(plan)?.moment).toBe('missed_twice');
    });

    it('nothing further once silenced', () => {
      const plan = planCoachMoments(
        signalsOf({ missedStreak: 3, lastActivityAt: daysAgo(10) }),
        stateOf({ silencedAt: daysAgo(3) }),
        settingsOf(),
        now,
      );
      expect(plan.filter((m) => m.suppressedBy === null)).toEqual([]);
    });

    it('honours inactiveStopDays', () => {
      const settings = settingsOf({ system: { inactiveStopDays: 14 } });
      const plan = planCoachMoments(signalsOf({ lastActivityAt: daysAgo(10) }), stateOf(), settings, now);
      expect(find(plan, 'win_back')).toBeUndefined();
    });

    it('unknown activity never counts as inactive', () => {
      const plan = planCoachMoments(signalsOf({ lastActivityAt: null }), stateOf(), settingsOf(), now);
      expect(find(plan, 'win_back')).toBeUndefined();
    });
  });

  describe('safety: supportive moments only (AC 6)', () => {
    const triggers = [
      ['an active safety stop', { safetyStop: true, painStreak: false, lowReadinessStreak: false }],
      ['a pain streak', { safetyStop: false, painStreak: true, lowReadinessStreak: false }],
      ['a low-readiness streak', { safetyStop: false, painStreak: false, lowReadinessStreak: true }],
    ] as const;

    it.each(triggers)('%s suppresses the pushy moments', (_label, safety) => {
      const plan = planCoachMoments(
        signalsOf({ missedStreak: 2, sessionToday: 'planned', missedYesterday: true, safety: { ...safety } }),
        stateOf(),
        settingsOf(),
        utcAt('18:00'),
      );
      expect(outcomeOf(plan, 'missed_twice')).toBe('safety_supportive_only');
      expect(outcomeOf(plan, 'streak_at_risk')).toBe('safety_supportive_only');
      expect(outcomeOf(plan, 'missed_session')).toBe('safety_supportive_only');
      expect(topNudge(plan)).toBeNull();
    });

    it.each(triggers)('%s suppresses win_back', (_label, safety) => {
      const plan = planCoachMoments(
        signalsOf({ lastActivityAt: new Date('2026-09-01T00:00:00Z'), safety: { ...safety } }),
        stateOf(),
        settingsOf(),
        utcAt('12:00'),
      );
      expect(outcomeOf(plan, 'win_back')).toBe('safety_supportive_only');
    });

    it.each(triggers)('%s lets the supportive moments through', (_label, safety) => {
      const event = planCoachMoments(
        signalsOf({ safety: { ...safety }, event: { comeback: true, pr: true, weeklyTargetHit: true } }),
        stateOf(),
        settingsOf(),
        utcAt('12:00'),
      );
      expect(event.filter((m) => m.suppressedBy === null).map((m) => m.moment)).toEqual(['comeback', 'pr', 'weekly_target_hit']);

      const monday = planCoachMoments(
        signalsOf({ lastCompletedWorkoutDate: '2026-09-20', safety: { ...safety } }),
        stateOf(),
        settingsOf(),
        utcAt('10:00', '2026-10-05'),
      );
      expect(outcomeOf(monday, 'fresh_start')).toBe('eligible');
    });
  });

  describe('priority (AC 7)', () => {
    it('ranks the moments in the spec order', () => {
      const order: CoachMoment[] = [
        'missed_twice',
        'streak_at_risk',
        'comeback',
        'pr',
        'missed_session',
        'fresh_start',
        'photo_prompt',
        'win_back',
      ];
      const priorities = order.map((m) => COACH_MOMENT_PRIORITY[m]);
      expect([...priorities].sort((a, b) => a - b)).toEqual(priorities);
      expect(new Set(priorities).size).toBe(priorities.length);
      expect(COACH_MOMENT_PRIORITY.weekly_target_hit).toBe(COACH_MOMENT_PRIORITY.pr);
    });

    it('every clock-driven moment at once: ranked, and only the top one is the nudge', () => {
      // Monday 08:00, preferred 06:00 (so streak, morning and photo anchors are all past), after a lapse.
      const plan = planCoachMoments(
        signalsOf({
          missedStreak: 2,
          sessionToday: 'planned',
          missedYesterday: true,
          lastCompletedWorkoutDate: '2026-09-25',
          lastProgressPhotoDate: null,
        }),
        stateOf(),
        settingsOf({ user: { preferredTime: '06:00', photoCadence: 'weekly' } }),
        utcAt('08:00', '2026-10-05'),
      );
      const eligible = plan.filter((m) => m.lane === 'nudge' && m.suppressedBy === null).map((m) => m.moment);
      expect(eligible).toEqual(['missed_twice', 'streak_at_risk', 'missed_session', 'fresh_start', 'photo_prompt']);
      expect(topNudge(plan)?.moment).toBe('missed_twice');
    });

    it('the event moments in order: comeback, then pr and weekly_target_hit', () => {
      const plan = planCoachMoments(
        signalsOf({ event: { comeback: true, pr: true, weeklyTargetHit: true } }),
        stateOf(),
        settingsOf(),
        utcAt('12:00'),
      );
      expect(plan.map((m) => m.moment)).toEqual(['comeback', 'pr', 'weekly_target_hit']);
    });

    it('lists eligible moments before suppressed ones', () => {
      const plan = planCoachMoments(
        signalsOf({ missedStreak: 2, missedYesterday: true }),
        stateOf({ momentsSentToday: ['missed_twice'] }),
        settingsOf(),
        utcAt('12:00'),
      );
      expect(plan.map((m) => [m.moment, m.suppressedBy])).toEqual([
        ['missed_session', null],
        ['missed_twice', 'already_sent'],
      ]);
    });

    it('an event pass plans no clock-driven moment and no weekly review', () => {
      const plan = planCoachMoments(
        signalsOf({ missedStreak: 2, event: { comeback: true, pr: false, weeklyTargetHit: false } }),
        stateOf(),
        settingsOf(),
        utcAt('18:30', '2026-10-04'),
      );
      expect(plan.map((m) => m.moment)).toEqual(['comeback']);
    });
  });

  describe('streak_at_risk: the 23.5-hour rule (AC 8)', () => {
    const planned = signalsOf({ sessionToday: 'planned' });
    it.each([
      // usual minute, preferred, time, expected
      [18 * 60, null, '17:29', 'not_triggered'],
      [18 * 60, null, '17:30', 'eligible'],
      [18 * 60, '12:00', '17:29', 'not_triggered'],
      [null, '12:00', '11:59', 'not_triggered'],
      [null, '12:00', '12:00', 'eligible'],
      [null, null, '16:59', 'not_triggered'],
      [null, null, '17:00', 'eligible'],
      [15, null, '07:30', 'eligible'],
    ])('usual %p, preferred %p, at %s: %s', (usual, preferred, time, expected) => {
      const plan = planCoachMoments(
        planned,
        stateOf({ usualWorkoutMinuteLocal: usual }),
        settingsOf({ user: { preferredTime: preferred } }),
        utcAt(time),
      );
      expect(outcomeOf(plan, 'streak_at_risk')).toBe(expected);
    });

    it.each([
      ['the session is done', signalsOf({ sessionToday: 'done' })],
      ['a workout was logged today', signalsOf({ sessionToday: 'planned', loggedToday: true })],
      ['no session is planned today', signalsOf({ sessionToday: 'none' })],
    ])('is not due when %s', (_label, signals) => {
      expect(outcomeOf(planCoachMoments(signals, stateOf(), settingsOf(), utcAt('18:00')), 'streak_at_risk')).toBe('not_triggered');
    });
  });

  describe('missed_session: anchor and deferral (AC 9)', () => {
    const missed = signalsOf({ missedYesterday: true });
    it.each([
      [null, '08:59', 'not_triggered'],
      [null, '09:00', 'eligible'],
      ['07:00', '06:59', 'not_triggered'],
      ['07:00', '07:00', 'quiet_hours'],
      ['07:00', '07:29', 'quiet_hours'],
      ['07:00', '07:30', 'eligible'],
      ['10:15', '10:14', 'not_triggered'],
      ['10:15', '10:15', 'eligible'],
    ])('preferred %p at %s: %s', (preferred, time, expected) => {
      // An anchor inside quiet hours (07:00) is deferred to their end (07:30), never sent early.
      const plan = planCoachMoments(missed, stateOf(), settingsOf({ user: { preferredTime: preferred } }), utcAt(time));
      expect(outcomeOf(plan, 'missed_session')).toBe(expected);
    });

    it('is never sent before its anchor, even outside quiet hours', () => {
      const plan = planCoachMoments(missed, stateOf(), settingsOf({ user: { quietHours: { start: '00:00', end: '00:00' } } }), utcAt('08:00'));
      expect(find(plan, 'missed_session')).toBeUndefined();
    });
  });

  describe('fresh_start and photo_prompt', () => {
    it.each([
      ['Monday after a lapse', '2026-10-05', '2026-09-27', 'eligible'],
      ['Monday without a lapse', '2026-10-05', '2026-10-01', 'not_triggered'],
      ['the 1st of a month after a lapse', '2026-10-01', '2026-09-20', 'eligible'],
      ['a Wednesday after a lapse', '2026-09-30', '2026-09-20', 'not_triggered'],
      ['Monday with no workout ever', '2026-10-05', null, 'eligible'],
    ])('fresh_start on %s: %s', (_label, date, last, expected) => {
      const plan = planCoachMoments(signalsOf({ lastCompletedWorkoutDate: last }), stateOf(), settingsOf(), utcAt('10:00', date));
      expect(outcomeOf(plan, 'fresh_start')).toBe(expected);
    });

    it.each([
      ['weekly, never taken, planned day, morning', 'weekly', null, 'planned', '10:00', 'eligible'],
      ['off', 'off', null, 'planned', '10:00', 'not_triggered'],
      ['a rest day', 'weekly', null, 'none', '10:00', 'not_triggered'],
      ['the afternoon', 'weekly', null, 'planned', '13:00', 'not_triggered'],
      ['biweekly, 13 days since the last', 'biweekly', '2026-09-17', 'planned', '10:00', 'not_triggered'],
      ['biweekly, 14 days since the last', 'biweekly', '2026-09-16', 'planned', '10:00', 'eligible'],
    ])('photo_prompt %s: %s', (_label, cadence, last, today, time, expected) => {
      const plan = planCoachMoments(
        signalsOf({ lastProgressPhotoDate: last, sessionToday: today as CoachPlanningSignals['sessionToday'] }),
        stateOf(),
        settingsOf({ user: { photoCadence: cadence as CoachPlanningSettings['user']['photoCadence'] } }),
        utcAt(time),
      );
      expect(outcomeOf(plan, 'photo_prompt')).toBe(expected);
    });
  });

  describe('time zones and DST, by fixed instants (AC 10)', () => {
    it.each([
      // instant, zone, expected outcome for missed_twice (quiet 21:30-07:30)
      ['2026-03-08T11:29:00Z', 'America/New_York', 'quiet_hours'], // 07:29 EDT, the spring-forward day
      ['2026-03-08T11:30:00Z', 'America/New_York', 'eligible'], // 07:30 EDT (06:30 had it still been EST)
      ['2026-11-01T11:30:00Z', 'America/New_York', 'quiet_hours'], // 06:30 EST, the fall-back day
      ['2026-11-01T12:30:00Z', 'America/New_York', 'eligible'], // 07:30 EST
      ['2026-09-30T01:59:00Z', 'Asia/Kolkata', 'quiet_hours'], // 07:29 IST
      ['2026-09-30T02:00:00Z', 'Asia/Kolkata', 'eligible'], // 07:30 IST
      ['2026-09-30T16:00:00Z', 'Asia/Kolkata', 'quiet_hours'], // 21:30 IST
    ])('quiet hours at %s in %s: %s', (instant, zone, expected) => {
      const plan = planCoachMoments(MISSED_TWICE, stateOf(), settingsOf(), coachNow(new Date(instant), zone));
      expect(outcomeOf(plan, 'missed_twice')).toBe(expected);
    });

    it.each([
      // The local day boundary of nudgesToday (2 of 2 sent on the stored day); no quiet hours.
      ['2026-03-08T04:59:00Z', 'America/New_York', '2026-03-07', 'daily_cap'], // 23:59 EST on the 7th
      ['2026-03-08T05:00:00Z', 'America/New_York', '2026-03-07', 'eligible'], // 00:00 on the 8th
      ['2026-09-30T18:29:00Z', 'Asia/Kolkata', '2026-09-30', 'daily_cap'], // 23:59 IST
      ['2026-09-30T18:30:00Z', 'Asia/Kolkata', '2026-09-30', 'eligible'], // 00:00 IST on the 1st
    ])('the cap day at %s in %s (stored %s): %s', (instant, zone, day, expected) => {
      const settings = settingsOf({ user: { quietHours: { start: '00:00', end: '00:00' } } });
      const state = stateOf({ nudgesToday: 2, nudgeDayLocal: day });
      const plan = planCoachMoments(MISSED_TWICE, state, settings, coachNow(new Date(instant), zone));
      expect(outcomeOf(plan, 'missed_twice')).toBe(expected);
    });

    it.each([
      ['2026-03-08T21:29:00Z', 'America/New_York', 'not_triggered'], // 17:29 EDT
      ['2026-03-08T21:30:00Z', 'America/New_York', 'eligible'], // 17:30 EDT
      ['2026-11-01T22:29:00Z', 'America/New_York', 'not_triggered'], // 17:29 EST
      ['2026-11-01T22:30:00Z', 'America/New_York', 'eligible'], // 17:30 EST
      ['2026-09-30T11:59:00Z', 'Asia/Kolkata', 'not_triggered'], // 17:29 IST
      ['2026-09-30T12:00:00Z', 'Asia/Kolkata', 'eligible'], // 17:30 IST
    ])('the usual-time anchor (18:00) at %s in %s: %s', (instant, zone, expected) => {
      const plan = planCoachMoments(
        signalsOf({ sessionToday: 'planned' }),
        stateOf({ usualWorkoutMinuteLocal: 18 * 60 }),
        settingsOf(),
        coachNow(new Date(instant), zone),
      );
      expect(outcomeOf(plan, 'streak_at_risk')).toBe(expected);
    });

    it.each([
      ['2026-10-04T12:29:00Z', 'Asia/Kolkata', 'not_triggered'], // Sunday 17:59 IST
      ['2026-10-04T12:30:00Z', 'Asia/Kolkata', 'eligible'], // Sunday 18:00 IST
      ['2026-11-01T22:59:00Z', 'America/New_York', 'not_triggered'], // Sunday 17:59 EST, fall-back day
      ['2026-11-01T23:00:00Z', 'America/New_York', 'eligible'], // Sunday 18:00 EST
      ['2026-03-08T21:59:00Z', 'America/New_York', 'not_triggered'], // Sunday 17:59 EDT, spring-forward day
      ['2026-03-08T22:00:00Z', 'America/New_York', 'eligible'], // Sunday 18:00 EDT
    ])('Sunday 18:00 at %s in %s: %s', (instant, zone, expected) => {
      const plan = planCoachMoments(signalsOf(), stateOf(), settingsOf(), coachNow(new Date(instant), zone));
      expect(outcomeOf(plan, 'weekly_review')).toBe(expected);
    });

    it('catches the weekly review up until Monday 18:00, keyed by the Sunday\'s ISO week', () => {
      const mondayMorning = planCoachMoments(signalsOf(), stateOf(), settingsOf(), utcAt('09:00', '2026-10-05'));
      expect(weeklyReviewOf(mondayMorning)?.isoWeek).toBe('2026-W40');
      const mondayEvening = planCoachMoments(signalsOf(), stateOf(), settingsOf(), utcAt('18:00', '2026-10-05'));
      expect(find(mondayEvening, 'weekly_review')).toBeUndefined();
      const saturday = planCoachMoments(signalsOf(), stateOf(), settingsOf(), utcAt('18:30', '2026-10-03'));
      expect(find(saturday, 'weekly_review')).toBeUndefined();
    });

    it('an invalid zone falls back to UTC and never throws', () => {
      const now = coachNow(new Date('2026-09-30T12:00:00Z'), 'Mars/Olympus_Mons');
      expect(now).toMatchObject({ timeZone: 'UTC', zoneFallback: true, date: '2026-09-30', minuteOfDay: 12 * 60 });
      expect(() => planCoachMoments(MISSED_TWICE, stateOf(), settingsOf(), now)).not.toThrow();
      expect(coachNow(new Date('2026-09-30T12:00:00Z'), null).zoneFallback).toBe(false);
    });
  });

  describe('preferences and deduplication (AC 12)', () => {
    it.each([
      ['coach.nudge', 'missed_twice', MISSED_TWICE, utcAt('12:00')],
      ['coach.celebration', 'pr', signalsOf({ event: { comeback: false, pr: true, weeklyTargetHit: false } }), utcAt('12:00')],
      ['coach.weekly_review', 'weekly_review', signalsOf(), utcAt('18:30', '2026-10-04')],
      ['coach.photo_prompt', 'photo_prompt', signalsOf({ sessionToday: 'planned' }), utcAt('10:00')],
    ] as const)('%s turned off: %s is pref_off', (eventKey, moment, signals, now) => {
      const settings = settingsOf({ eventEnabled: { [eventKey]: false }, user: { photoCadence: 'weekly' } });
      expect(outcomeOf(planCoachMoments(signals, stateOf(), settings, now), moment)).toBe('pref_off');
    });

    it('an event turned on explicitly or left absent passes', () => {
      const settings = settingsOf({ eventEnabled: { 'coach.nudge': true } });
      expect(outcomeOf(planCoachMoments(MISSED_TWICE, stateOf(), settings, utcAt('12:00')), 'missed_twice')).toBe('eligible');
    });

    it('the same moment already sent today is already_sent; another moment is not', () => {
      const plan = planCoachMoments(MISSED_TWICE, stateOf({ momentsSentToday: ['missed_twice'] }), settingsOf(), utcAt('12:00'));
      expect(outcomeOf(plan, 'missed_twice')).toBe('already_sent');
      const other = planCoachMoments(MISSED_TWICE, stateOf({ momentsSentToday: ['pr'] }), settingsOf(), utcAt('12:00'));
      expect(outcomeOf(other, 'missed_twice')).toBe('eligible');
    });

    it('the weekly review of a week already reviewed is already_sent', () => {
      const plan = planCoachMoments(signalsOf(), stateOf({ lastWeeklyReviewWeek: '2026-W40' }), settingsOf(), utcAt('18:30', '2026-10-04'));
      expect(outcomeOf(plan, 'weekly_review')).toBe('already_sent');
    });
  });

  describe('switches and pauses', () => {
    it.each([
      ['AI off', settingsOf({ aiEnabled: false })],
      ['the system coach off', settingsOf({ system: { enabled: false } })],
      ['the user coach off', settingsOf({ user: { enabled: false } })],
    ])('%s: every moment is coach_off, the weekly review included', (_label, settings) => {
      const plan = planCoachMoments(MISSED_TWICE, stateOf(), settings, utcAt('18:30', '2026-10-04'));
      expect(plan.map((m) => m.suppressedBy)).toEqual(['coach_off', 'coach_off']);
    });

    it.each([
      [new Date('2026-09-30T12:01:00Z'), 'paused'],
      [new Date('2026-09-30T12:00:00Z'), 'eligible'],
      [new Date('2026-09-29T00:00:00Z'), 'eligible'],
    ])('pausedUntil %s: %s', (pausedUntil, expected) => {
      const plan = planCoachMoments(MISSED_TWICE, stateOf({ pausedUntil }), settingsOf(), utcAt('12:00'));
      expect(outcomeOf(plan, 'missed_twice')).toBe(expected);
    });

    it('a pause holds the weekly review too', () => {
      const plan = planCoachMoments(signalsOf(), stateOf({ pausedUntil: new Date('2026-10-10T00:00:00Z') }), settingsOf(), utcAt('18:30', '2026-10-04'));
      expect(outcomeOf(plan, 'weekly_review')).toBe('paused');
    });
  });

  it('is pure: imports no Nest, no Prisma and reads no clock', () => {
    const source = readFileSync(join(__dirname, 'plan-coach-moments.ts'), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    expect(imports.filter((path) => /@nestjs|@prisma|prisma\.service/.test(path))).toEqual([]);
    expect(source).not.toMatch(/new Date\(\)|Date\.now\(/);
    const time = readFileSync(join(__dirname, 'coach-time.ts'), 'utf8');
    expect([...time.matchAll(/from '([^']+)'/g)].map((m) => m[1]).filter((p) => /@nestjs|@prisma/.test(p))).toEqual([]);
  });
});
