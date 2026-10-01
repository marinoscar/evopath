/** `utils/goalFormat.ts` (#268): progress text per metric and period, targets, streaks, the form, check-ins. */
import { describe, it, expect } from 'vitest';
import {
  addDays,
  offersWorkoutLog,
  checkInEntry,
  defaultCheckInMode,
  draftFromGoal,
  EMPTY_GOAL_DRAFT,
  formatDaysLeft,
  formatGoalProgress,
  formatGoalTarget,
  formatPeriodRange,
  formatStreak,
  goalStanding,
  historyStreak,
  progressPercent,
  validateGoalDraft,
} from '../../utils/goalFormat';
import { mockGoal } from '../mocks/fixtures/goals';

const p = (
  goal: Parameters<typeof formatGoalProgress>[0]['goal'],
  done: number,
  target: number,
  daysLeft = 3,
) => ({ goal, done, target, daysLeft });

describe('formatGoalProgress', () => {
  it('counts sessions with the activity noun and the days left', () => {
    expect(formatGoalProgress(p({ activityKind: 'walk', metric: 'sessions', period: 'week' }, 2, 4))).toBe(
      '2 of 4 walks · 3 days left',
    );
    expect(formatGoalProgress(p({ activityKind: 'run', metric: 'sessions', period: 'week' }, 0, 1, 1))).toBe(
      '0 of 1 run · Last day',
    );
    expect(formatGoalProgress(p({ activityKind: 'cardio_any', metric: 'sessions', period: 'week' }, 1, 3))).toBe(
      '1 of 3 cardio sessions · 3 days left',
    );
    expect(formatGoalProgress(p({ activityKind: 'workout_any', metric: 'sessions', period: 'week' }, 1, 3))).toBe(
      '1 of 3 workouts · 3 days left',
    );
    expect(formatGoalProgress(p({ activityKind: 'custom', metric: 'sessions', period: 'week' }, 1, 2))).toBe(
      '1 of 2 sessions · 3 days left',
    );
  });

  it('shows daily steps with thousands separators and no days left', () => {
    expect(formatGoalProgress(p({ activityKind: 'walk', metric: 'steps', period: 'day' }, 5240, 8000, 1))).toBe(
      '5,240 / 8,000 steps',
    );
  });

  it('shows minutes and distance (km or mi)', () => {
    expect(formatGoalProgress(p({ activityKind: 'cardio_any', metric: 'minutes', period: 'week' }, 45, 150, 4))).toBe(
      '45 / 150 min · 4 days left',
    );
    expect(formatGoalProgress(p({ activityKind: 'run', metric: 'distance_m', period: 'week' }, 3200, 10000))).toBe(
      '3.2 / 10 km · 3 days left',
    );
    expect(
      formatGoalProgress(p({ activityKind: 'run', metric: 'distance_m', period: 'week' }, 1609.344, 16093.44), 'mi'),
    ).toBe('1 / 10 mi · 3 days left');
    // A sub-kilometre km target reads in metres, done included; miles are unchanged.
    expect(formatGoalProgress(p({ activityKind: 'walk', metric: 'distance_m', period: 'day' }, 350, 800))).toBe('350 / 800 m');
    expect(formatGoalTarget({ activityKind: 'walk', metric: 'distance_m', target: 800, period: 'day' })).toBe('800 m a day');
    expect(formatGoalTarget({ activityKind: 'walk', metric: 'distance_m', target: 800, period: 'day' }, 'mi')).toBe('0.5 mi a day');
  });

  it('drops the days left once the target is met', () => {
    expect(formatGoalProgress(p({ activityKind: 'walk', metric: 'sessions', period: 'week' }, 4, 4))).toBe(
      '4 of 4 walks',
    );
  });
});

describe('small helpers', () => {
  it('formatGoalTarget', () => {
    expect(formatGoalTarget({ activityKind: 'walk', metric: 'sessions', target: 4, period: 'week' })).toBe(
      '4 walks a week',
    );
    expect(formatGoalTarget({ activityKind: 'walk', metric: 'steps', target: 8000, period: 'day' })).toBe(
      '8,000 steps a day',
    );
    expect(formatGoalTarget({ activityKind: 'cardio_any', metric: 'minutes', target: 150, period: 'week' })).toBe(
      '150 min a week',
    );
  });

  it('formatDaysLeft, progressPercent, goalStanding, formatStreak', () => {
    expect(formatDaysLeft(5, 'week')).toBe('5 days left');
    expect(formatDaysLeft(1, 'week')).toBe('Last day');
    expect(formatDaysLeft(1, 'day')).toBe('');
    expect(progressPercent(2, 4)).toBe(50);
    expect(progressPercent(9, 4)).toBe(100);
    expect(progressPercent(1, 0)).toBe(0);
    expect(goalStanding({ hit: true, onTrack: false })).toBe('hit');
    expect(goalStanding({ hit: false, onTrack: true })).toBe('onTrack');
    expect(goalStanding({ hit: false, onTrack: false })).toBe('behind');
    expect(formatStreak(3, 'week')).toBe('3-week streak');
    expect(formatStreak(0, 'week')).toBe('');
  });

  it('addDays and formatPeriodRange work on calendar dates', () => {
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
    expect(addDays('2026-01-01', -7)).toBe('2025-12-25');
    expect(formatPeriodRange('2026-09-21', '2026-09-27')).toBe('Sep 21 – Sep 27');
    expect(formatPeriodRange('2026-09-27', '2026-09-27')).toBe('Sep 27');
  });

  it('historyStreak counts hits newest first, skipping a running period', () => {
    const h = (periodStart: string, periodEnd: string, hit: boolean) => ({ periodStart, periodEnd, hit, done: 0, target: 1 });
    const today = '2026-09-30';
    expect(
      historyStreak(
        [h('2026-09-28', '2026-10-04', false), h('2026-09-21', '2026-09-27', true), h('2026-09-14', '2026-09-20', true), h('2026-09-07', '2026-09-13', false)],
        today,
      ),
    ).toBe(2);
    expect(historyStreak([h('2026-09-21', '2026-09-27', false), h('2026-09-14', '2026-09-20', true)], today)).toBe(0);
  });
});

describe('validateGoalDraft', () => {
  it('builds the create body for a valid custom goal', () => {
    const result = validateGoalDraft(
      { ...EMPTY_GOAL_DRAFT, title: ' Yoga ', activityKind: 'custom', customLabel: 'Yoga', metric: 'minutes', target: '60' },
      'km',
    );
    expect(result.errors).toEqual({});
    expect(result.input).toEqual({
      title: 'Yoga',
      activityKind: 'custom',
      customLabel: 'Yoga',
      metric: 'minutes',
      target: 60,
      period: 'week',
    });
  });

  it('requires a title, a custom label and a positive whole target', () => {
    const result = validateGoalDraft({ ...EMPTY_GOAL_DRAFT, activityKind: 'custom', target: '2.5' }, 'km');
    expect(result.input).toBeNull();
    expect(result.errors.title).toBeTruthy();
    expect(result.errors.customLabel).toBeTruthy();
    expect(result.errors.target).toBe('Enter a whole number.');
    expect(validateGoalDraft({ ...EMPTY_GOAL_DRAFT, title: 'x', target: '0' }, 'km').errors.target).toBeTruthy();
    expect(validateGoalDraft({ ...EMPTY_GOAL_DRAFT, title: 'x', target: '2000000' }, 'km').errors.target).toBeTruthy();
  });

  it('refuses a daily sessions goal (sessions are counted per week)', () => {
    const result = validateGoalDraft({ ...EMPTY_GOAL_DRAFT, title: 'x', target: '1', period: 'day' }, 'km');
    expect(result.errors.period).toBeTruthy();
  });

  it('converts a distance target to meters', () => {
    const km = validateGoalDraft({ ...EMPTY_GOAL_DRAFT, title: 'Run', metric: 'distance_m', target: '5.5' }, 'km');
    expect(km.input?.target).toBe(5500);
    const mi = validateGoalDraft({ ...EMPTY_GOAL_DRAFT, title: 'Run', metric: 'distance_m', target: '1' }, 'mi');
    expect(mi.input?.target).toBe(1609);
  });

  it('round-trips a stored goal into the form', () => {
    const goal = mockGoal({ metric: 'distance_m', target: 10000, title: 'Run 10k' });
    expect(draftFromGoal(goal, 'km')).toMatchObject({ title: 'Run 10k', target: '10', metric: 'distance_m' });
  });
});

describe('check-in helpers', () => {
  it('opens on the mode the goal measures', () => {
    expect(defaultCheckInMode({ metric: 'steps' })).toBe('steps');
    expect(defaultCheckInMode({ metric: 'minutes' })).toBe('minutes');
    expect(defaultCheckInMode({ metric: 'sessions' })).toBe('done');
  });

  it('builds the three entry bodies', () => {
    expect(checkInEntry({ activityKind: 'walk' }, 'done', 0)).toEqual({ activityKind: 'walk' });
    expect(checkInEntry({ activityKind: 'walk' }, 'minutes', 30)).toEqual({ activityKind: 'walk', durationSeconds: 1800 });
    expect(checkInEntry({ activityKind: 'walk' }, 'steps', 8000, '2026-09-28')).toEqual({
      activityKind: 'steps',
      steps: 8000,
      occurredOn: '2026-09-28',
    });
  });

  it('checks in an "any workout" goal as workout_any (the kind the API counts for it)', () => {
    expect(checkInEntry({ activityKind: 'workout_any' }, 'done', 0)).toEqual({ activityKind: 'workout_any' });
    expect(checkInEntry({ activityKind: 'workout_any' }, 'minutes', 45)).toEqual({ activityKind: 'workout_any', durationSeconds: 2700 });
  });

  it('offers "Log a workout" beside the check-in for an "any workout" goal only', () => {
    expect(offersWorkoutLog({ activityKind: 'workout_any', metric: 'sessions' })).toBe(true);
    expect(offersWorkoutLog({ activityKind: 'workout_any', metric: 'steps' })).toBe(false);
    expect(offersWorkoutLog({ activityKind: 'walk', metric: 'sessions' })).toBe(false);
  });
});
