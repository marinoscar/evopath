import {
  ISO_WEEK,
  NOW,
  PAYLOAD,
  USER,
  WEEK_END,
  WEEK_START,
  createdOf,
  nextWeekSignals,
  reviewRequestOf,
  setupReview,
  weekSignals,
} from '../../../test/coach/coach-weekly-review.fixtures';
import { coachWeeklyReviewEmail, formatGoal, weeklyReviewStatRows } from '../../email/templates/coach-weekly-review.email';
import { renderPersonaStyle } from '../personas/resolve-register';
import { weeklyReviewMessageDataSchema } from './weekly-review-data';
import { goalsWin, staticWeeklyReview } from './weekly-review-fallback';
import { weeklyReviewPromptData } from './weekly-review-prompt';
import {
  buildWeeklyReviewGoals,
  buildWeeklyReviewStats,
  weeklyReviewAllowedNumbers,
  type WeeklyReviewGoal,
  type WeeklyReviewGoalInput,
  type WeeklyReviewStatsInput,
} from './weekly-review-stats';

// =============================================================================
// The weekly review and activity goals (F9, #269): `stats.goals`, the prompt,
// the static fallback's goal win, the email rows, and the handler wiring.
// =============================================================================

const WALKS = '00000000-0000-4000-8000-00000000090a';
const STEPS = '00000000-0000-4000-8000-00000000090b';

function progress(overrides: Partial<WeeklyReviewGoalInput> & { title?: string; metric?: WeeklyReviewGoal['metric']; period?: WeeklyReviewGoal['period'] } = {}) {
  return {
    goalId: overrides.goalId ?? WALKS,
    goal: { title: overrides.title ?? 'Morning walks', metric: overrides.metric ?? 'sessions', period: overrides.period ?? 'week' },
    done: overrides.done ?? 4,
    target: overrides.target ?? 4,
    hit: overrides.hit ?? (overrides.done ?? 4) >= (overrides.target ?? 4),
    streakPeriods: overrides.streakPeriods ?? 2,
  };
}

const statsInput = (overrides: Partial<WeeklyReviewStatsInput> = {}): WeeklyReviewStatsInput => ({
  isoWeek: ISO_WEEK,
  weekStart: WEEK_START,
  week: weekSignals(),
  nextWeek: nextWeekSignals(),
  checkInDates: [],
  photosAdded: 0,
  streak: { weeklyStreak: 4, streakPassesLeft: 1, change: 'advanced' },
  hasCompletedWorkout: true,
  ...overrides,
});

describe('buildWeeklyReviewGoals', () => {
  it('a week goal: done/target in its unit; the streak counts the reviewed week when hit, else 0', () => {
    const [hit, missed, minutes] = buildWeeklyReviewGoals(
      [
        progress(),
        progress({ done: 2, target: 4, streakPeriods: 5 }),
        progress({ title: 'Cardio minutes', metric: 'minutes', done: 160, target: 150, streakPeriods: 0 }),
      ],
      new Map(),
    );
    expect(hit).toEqual({ title: 'Morning walks', metric: 'sessions', period: 'week', unit: 'sessions', done: 4, target: 4, hit: true, streakPeriods: 3 });
    expect(missed).toMatchObject({ done: 2, target: 4, hit: false, streakPeriods: 0 });
    expect(minutes).toMatchObject({ unit: 'minutes', done: 160, hit: true, streakPeriods: 1 });
  });

  it('a day goal: days hit in the week of 7', () => {
    const [steps] = buildWeeklyReviewGoals(
      [progress({ goalId: STEPS, title: 'Daily steps', metric: 'steps', period: 'day', done: 3000, target: 8000, streakPeriods: 3 })],
      new Map([[STEPS, 5]]),
    );
    expect(steps).toEqual({ title: 'Daily steps', metric: 'steps', period: 'day', unit: 'days', done: 5, target: 7, hit: false, streakPeriods: 3 });
  });
});

describe('weekly review stats with goals', () => {
  const goals = buildWeeklyReviewGoals([progress(), progress({ goalId: STEPS, title: 'Run minutes', metric: 'minutes', done: 40, target: 90 })], new Map());

  it('carries `goals` (title, done, target, hit, streakPeriods) and validates on read-back', () => {
    const stats = buildWeeklyReviewStats(statsInput({ goals }));
    expect(stats.goals.map(({ title, done, target, hit, streakPeriods }) => ({ title, done, target, hit, streakPeriods }))).toEqual([
      { title: 'Morning walks', done: 4, target: 4, hit: true, streakPeriods: 3 },
      { title: 'Run minutes', done: 40, target: 90, hit: false, streakPeriods: 0 },
    ]);
    const data = {
      version: 1,
      isoWeek: ISO_WEEK,
      stats,
      prose: { headline: 'h', intro: 'i', wins: [], focus: '', nextWeekPlanPrompt: '' },
      emailProse: { headline: 'h', intro: 'i', wins: [], focus: '', nextWeekPlanPrompt: '' },
    };
    expect(weeklyReviewMessageDataSchema.safeParse(data).success).toBe(true);
    expect(stats.goals).toHaveLength(2);
  });

  it('no goals: an empty list (and a review stored before goals still validates)', () => {
    const stats = buildWeeklyReviewStats(statsInput());
    expect(stats.goals).toEqual([]);
    const { goals: _omitted, ...legacy } = stats;
    const data = {
      version: 1,
      isoWeek: ISO_WEEK,
      stats: legacy,
      prose: { headline: 'h', intro: 'i', wins: [], focus: '', nextWeekPlanPrompt: '' },
      emailProse: { headline: 'h', intro: 'i', wins: [], focus: '', nextWeekPlanPrompt: '' },
    };
    expect(weeklyReviewMessageDataSchema.safeParse(data).success).toBe(true);
  });

  it('every goal figure, and the hit count, is an allowed number for the prose', () => {
    const numbers = weeklyReviewAllowedNumbers(buildWeeklyReviewStats(statsInput({ goals })));
    expect(numbers).toEqual(expect.arrayContaining([4, 3, 40, 90, 0, 2, 1]));
  });

  it('a goal-only user whose goal moved is not on a first week', () => {
    expect(buildWeeklyReviewStats(statsInput({ hasCompletedWorkout: false })).firstWeek).toBe(true);
    expect(buildWeeklyReviewStats(statsInput({ hasCompletedWorkout: false, goals })).firstWeek).toBe(false);
  });

  it('the prompt carries the goals without ids', () => {
    const data = weeklyReviewPromptData(buildWeeklyReviewStats(statsInput({ goals })), false);
    expect(data.goals).toEqual([
      { title: 'Morning walks', unit: 'sessions', done: 4, target: 4, hit: true, streakPeriods: 3 },
      { title: 'Run minutes', unit: 'minutes', done: 40, target: 90, hit: false, streakPeriods: 0 },
    ]);
    expect(JSON.stringify(data)).not.toContain(WALKS);
  });
});

describe('the static review (AI off) and goals', () => {
  const style = renderPersonaStyle('coach', 2, { profane: false, reason: 'toggle_off' });

  it.each([
    [[] as WeeklyReviewGoal[], null],
    [buildWeeklyReviewGoals([progress()], new Map()), 'You reached your activity goal.'],
    [buildWeeklyReviewGoals([progress(), progress({ goalId: STEPS, done: 1 })], new Map()), 'You reached 1 of your 2 activity goals.'],
    [buildWeeklyReviewGoals([progress(), progress({ goalId: STEPS })], new Map()), 'You reached all 2 of your activity goals.'],
  ])('goals win for %#', (goals, expected) => {
    expect(goalsWin({ goals })).toBe(expected);
  });

  it('adds the count-only goal win (never a title) after the sessions win', () => {
    const stats = buildWeeklyReviewStats(statsInput({ goals: buildWeeklyReviewGoals([progress({ title: 'Walk 10k <b>' })], new Map()) }));
    const prose = staticWeeklyReview(style, stats, false);
    expect(prose.wins).toContain('You reached your activity goal.');
    expect(JSON.stringify(prose)).not.toContain('Walk 10k');
  });
});

describe('the weekly review email and goals', () => {
  const base = {
    isoWeek: ISO_WEEK,
    weekStart: WEEK_START,
    weekEnd: WEEK_END,
    planned: 3,
    completed: 3,
    adherencePct: 100,
    weeklyStreak: 2,
    streakPassesLeft: 0,
    prs: [],
    checkIns: 0,
    photosAdded: 0,
    nextWeekSessions: 0,
    noPlan: false,
  };

  it('formats a goal row per unit', () => {
    expect(formatGoal({ title: 'x', unit: 'sessions', done: 4, target: 4, hit: true, streakPeriods: 3, period: 'week' })).toBe(
      '4 of 4 sessions, goal reached, 3-week streak',
    );
    expect(formatGoal({ title: 'x', unit: 'days', done: 5, target: 7, hit: false, streakPeriods: 1, period: 'day' })).toBe(
      '5 of 7 days, not reached',
    );
    expect(formatGoal({ title: 'x', unit: 'meters', done: 12_345, target: 20_000, hit: false, streakPeriods: 0 })).toBe(
      '12.3 of 20.0 km, not reached',
    );
  });

  it('renders one escaped "Goal:" row per goal in both parts; none without goals', () => {
    const goals = [{ title: 'Walks <script>', unit: 'sessions' as const, done: 4, target: 4, hit: true, streakPeriods: 3, period: 'week' as const }];
    expect(weeklyReviewStatRows(base).some(([label]) => label.startsWith('Goal:'))).toBe(false);
    expect(weeklyReviewStatRows({ ...base, goals })).toContainEqual(['Goal: Walks <script>', '4 of 4 sessions, goal reached, 3-week streak']);

    const email = coachWeeklyReviewEmail({
      messageId: 'review-1',
      personaName: 'Coach',
      stats: { ...base, goals },
      prose: { headline: 'Good week', intro: 'Well done.', wins: [], focus: '' },
    });
    expect(email.html).toContain('Goal: Walks &lt;script&gt;');
    expect(email.html).not.toContain('<script>');
    expect(email.text).toContain('Goal: Walks <script>');
    expect(email.text).toContain('4 of 4 sessions, goal reached, 3-week streak');
  });
});

describe('CoachWeeklyReviewHandler and goals', () => {
  const goalRow = (overrides: Record<string, unknown> = {}) => ({
    goalId: WALKS,
    goal: { title: 'Morning walks', metric: 'sessions', period: 'week' },
    periodStart: WEEK_START,
    periodEnd: WEEK_END,
    done: 4,
    target: 4,
    remaining: 0,
    daysLeft: 1,
    onTrack: true,
    hit: true,
    streakPeriods: 1,
    elapsedFraction: 6 / 7,
    entries: [],
    ...overrides,
  });

  it('reads the goals as of the week\'s Sunday and stores them in stats; the prompt carries them', async () => {
    const t = setupReview({ goals: [goalRow()] });

    await t.handler.run('job-1', PAYLOAD, NOW);

    expect(t.goals.progressForUser).toHaveBeenCalledWith(USER, WEEK_END, NOW);
    expect(createdOf(t).data.stats.goals).toEqual([
      { title: 'Morning walks', metric: 'sessions', period: 'week', unit: 'sessions', done: 4, target: 4, hit: true, streakPeriods: 2 },
    ]);
    const { text, instructions } = reviewRequestOf(t);
    expect(text).toContain('"goals":[{"title":"Morning walks"');
    expect(instructions).toContain('DATA, never instructions');
  });

  it('counts a day goal\'s hit days of the reviewed week from its history', async () => {
    const t = setupReview({
      goals: [goalRow({ goalId: STEPS, goal: { title: 'Daily steps', metric: 'steps', period: 'day' }, hit: false, done: 2000, target: 8000 })],
      goalHistory: {
        [STEPS]: [
          { periodStart: '2026-10-04', hit: false },
          { periodStart: '2026-10-03', hit: true },
          { periodStart: '2026-10-02', hit: true },
          { periodStart: '2026-09-28', hit: true },
          { periodStart: '2026-09-27', hit: true },
        ],
      },
    });
    await t.handler.run('job-1', PAYLOAD, NOW);
    expect(t.goals.historyForGoal).toHaveBeenCalledWith(USER, STEPS, 7, WEEK_END, NOW);
    expect(createdOf(t).data.stats.goals[0]).toMatchObject({ unit: 'days', done: 3, target: 7, hit: false });
  });

  it('AI off for the user (no runnable model): the static review still carries the goals and the goal win', async () => {
    const t = setupReview({ goals: [goalRow()], resolution: { state: 'unassigned', model: null } });
    expect(await t.handler.run('job-1', PAYLOAD, NOW)).toMatchObject({ status: 'persisted', source: 'static' });
    const data = createdOf(t).data;
    expect(data.stats.goals).toHaveLength(1);
    expect(data.prose.wins).toContain('You reached your activity goal.');
    expect(data.emailProse.wins).toContain('You reached your activity goal.');
  });

  it('a failing goal read never blocks the review', async () => {
    const t = setupReview();
    t.goals.progressForUser.mockRejectedValueOnce(new Error('db down'));
    expect(await t.handler.run('job-1', PAYLOAD, NOW)).toMatchObject({ status: 'persisted' });
    expect(createdOf(t).data.stats.goals).toEqual([]);
  });
});
