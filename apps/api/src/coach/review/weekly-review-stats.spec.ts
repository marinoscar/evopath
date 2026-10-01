import { nextWeekSignals, weekSignals } from '../../../test/coach/coach-weekly-review.fixtures';
import { isoWeekKey } from '../planning/coach-time';
import { renderPersonaStyle } from '../personas/resolve-register';
import { guardWeeklyReviewProse, weeklyReviewMessageDataSchema } from './weekly-review-data';
import { staticWeeklyReview } from './weekly-review-fallback';
import {
  buildWeeklyReviewStats,
  isoWeekMonday,
  weeklyReviewAllowedNumbers,
  type WeeklyReviewStatsInput,
} from './weekly-review-stats';

// =============================================================================
// The weekly review's deterministic block, the prose guard and the static
// review (E7.10; spec §2.10)
// =============================================================================

const input = (overrides: Partial<WeeklyReviewStatsInput> = {}): WeeklyReviewStatsInput => ({
  isoWeek: '2026-W40',
  weekStart: '2026-09-28',
  week: weekSignals(),
  nextWeek: nextWeekSignals(),
  checkInDates: ['2026-10-05', '2026-10-04', '2026-10-04', '2026-09-28', '2026-09-27'],
  photosAdded: 2,
  streak: { weeklyStreak: 4, streakPassesLeft: 1, change: 'advanced' },
  hasCompletedWorkout: true,
  ...overrides,
});

describe('isoWeekMonday', () => {
  it.each([
    ['2026-W40', '2026-09-28'],
    ['2026-W01', '2025-12-29'],
    ['2026-W53', '2026-12-28'],
    ['2021-W01', '2021-01-04'],
    ['2020-W53', '2020-12-28'],
  ])('%s starts on %s', (week, monday) => {
    expect(isoWeekMonday(week)).toBe(monday);
    expect(isoWeekKey(monday)).toBe(week);
  });

  it.each(['2025-W53', '2026-W00', '2026-W54', '2026-40', 'W40', ''])('%s is not a real ISO week', (week) => {
    expect(isoWeekMonday(week)).toBeNull();
  });
});

describe('buildWeeklyReviewStats', () => {
  it('takes planned, completed, missed and adherence from the week totals', () => {
    const stats = buildWeeklyReviewStats(input());
    const totals = weekSignals().adherence.totals;
    expect(stats).toMatchObject({
      planned: totals.planned,
      completed: totals.completed,
      missed: totals.missed,
      adherencePct: totals.adherencePct,
      weekEnd: '2026-10-04',
      noPlan: false,
      firstWeek: false,
    });
  });

  it('counts distinct check-in days inside the week only', () => {
    expect(buildWeeklyReviewStats(input()).checkIns).toBe(2);
  });

  it('lists only PR lifts; an unweighted PR is counted in reps', () => {
    const week = weekSignals();
    week.performance.push({
      ...week.performance[0],
      exerciseId: '00000000-0000-4000-8000-000000000303',
      name: 'Pull-up',
      best: { weightKg: null, reps: 12, e1rmKg: null },
      prInRange: true,
    });
    expect(buildWeeklyReviewStats(input({ week })).prs).toEqual([
      { exercise: 'Bench Press', value: 82.5, unit: 'kg', reps: 5 },
      { exercise: 'Pull-up', value: 12, unit: 'reps', reps: null },
    ]);
  });

  it('next week: sessions of the following ISO week only, in date order, with weekday names', () => {
    const next = nextWeekSignals();
    next.sessions.push({ ...next.sessions[0], plannedFor: '2026-10-12', name: 'Too late' });
    const stats = buildWeeklyReviewStats(input({ nextWeek: next }));
    expect(stats.nextWeekSessions).toBe(3);
    expect(stats.nextWeek.map((s) => `${s.weekday} ${s.name}`)).toEqual(['Monday Push', 'Wednesday Pull', 'Friday Legs']);
  });

  it('a week with nothing planned has no adherence (null, never 0) and is flagged noPlan', () => {
    const week = weekSignals({
      adherence: {
        weeks: [],
        totals: { planned: 0, completed: 0, partialSessions: 0, missed: 0, extra: 1, adherencePct: null },
        missedStreak: 0,
        completedStreak: 0,
      },
    });
    expect(buildWeeklyReviewStats(input({ week }))).toMatchObject({ adherencePct: null, noPlan: true });
  });

  it('firstWeek when the user has never completed a workout', () => {
    expect(buildWeeklyReviewStats(input({ hasCompletedWorkout: false })).firstWeek).toBe(true);
  });

  it('the allowed numbers are exactly the figures of the block', () => {
    const stats = buildWeeklyReviewStats(input());
    expect(new Set(weeklyReviewAllowedNumbers(stats))).toEqual(new Set([3, 0, 4, 1, 2, 100, 82.5, 5]));
  });
});

describe('guardWeeklyReviewProse', () => {
  const stats = buildWeeklyReviewStats(input());
  const ctx = {
    personaId: 'coach',
    intensity: 2,
    register: { profane: false },
    lockScreenSafe: true,
    allowedNumbers: weeklyReviewAllowedNumbers(stats),
  };
  const prose = { headline: 'A good week', intro: 'Three of three. Lovely.', wins: [], focus: '', nextWeekPlanPrompt: '' };

  it('passes clean prose with stats numbers', () => {
    expect(guardWeeklyReviewProse({ ...prose, wins: ['3 sessions done', 'Bench at 82.5 kg'] }, ctx).ok).toBe(true);
  });

  it.each([
    ['an invented number in a win', { wins: ['You lifted 10,000 kg this week'] }, 'invented_number'],
    ['an invented number in the focus', { focus: 'Aim for 6 sessions next week.' }, 'invented_number'],
    ['an empty headline', { headline: '  ' }, 'length'],
    ['an empty intro', { intro: '' }, 'length'],
    ['profanity in the clean register', { intro: 'Damn good week.' }, 'profanity'],
  ])('rejects %s', (_label, patch, reason) => {
    expect(guardWeeklyReviewProse({ ...prose, ...patch }, ctx).reasons).toContain(reason);
  });

  it('profanity never passes on the email surface, even unlocked', () => {
    const unlocked = { ...ctx, personaId: 'drill_sergeant', intensity: 3, register: { profane: true } };
    const profane = { ...prose, intro: 'Damn good week, recruit.' };
    expect(guardWeeklyReviewProse(profane, { ...unlocked, surface: 'app' as const }).ok).toBe(true);
    expect(guardWeeklyReviewProse(profane, { ...unlocked, surface: 'email' as const }).reasons).toContain('profanity');
  });
});

describe('staticWeeklyReview', () => {
  const clean = { profane: false, reason: 'toggle_off' as const };
  const stats = buildWeeklyReviewStats(input());
  const ctx = {
    personaId: 'coach',
    intensity: 2,
    register: clean,
    lockScreenSafe: true,
    allowedNumbers: weeklyReviewAllowedNumbers(stats),
    surface: 'email' as const,
  };

  it.each(['coach', 'drill_sergeant', 'stoic', 'analyst', 'butler', 'hype', 'nana'])(
    '%s: every intensity passes the email guard, in every week shape',
    (personaId) => {
      for (const intensity of [1, 2, 3] as const) {
        const style = renderPersonaStyle(personaId, intensity, clean);
        for (const shape of [
          stats,
          { ...stats, noPlan: true, planned: 0, adherencePct: null },
          { ...stats, firstWeek: true, completed: 0 },
        ]) {
          for (const supportive of [false, true]) {
            const result = guardWeeklyReviewProse(staticWeeklyReview(style, shape, supportive), {
              ...ctx,
              personaId,
              intensity: style.intensity,
              supportive,
              allowedNumbers: weeklyReviewAllowedNumbers(shape),
            });
            expect(result.reasons).toEqual([]);
          }
        }
      }
    },
  );
});

describe('weeklyReviewMessageDataSchema', () => {
  it('parses what the job stores', () => {
    const stats = buildWeeklyReviewStats(input());
    const prose = staticWeeklyReview(renderPersonaStyle('coach', 2, { profane: false, reason: 'toggle_off' }), stats, false);
    const parsed = weeklyReviewMessageDataSchema.safeParse({
      version: 1,
      isoWeek: stats.isoWeek,
      stats,
      prose,
      emailProse: prose,
      register: 'clean',
      fallback: { app: true, email: true },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects another version or a missing block', () => {
    expect(weeklyReviewMessageDataSchema.safeParse({ version: 2 }).success).toBe(false);
    expect(weeklyReviewMessageDataSchema.safeParse({ momentKey: 'x' }).success).toBe(false);
  });
});
