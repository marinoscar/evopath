import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';
import type { PlanSignals } from '../../src/programs/signals/plan-signals.contract';
import { CoachContentGuard } from '../../src/coach/guard/coach-content-guard.service';
import {
  CoachWeeklyReviewHandler,
  type CoachWeeklyReviewPayload,
} from '../../src/coach/review/handlers/coach-weekly-review.handler';
import type { CoachWeeklyReviewProse } from '../../src/coach/review/weekly-review-schema';
import { nudgeSignals, USER } from './coach-nudge.fixtures';

// =============================================================================
// Shared fixtures for the ai.coach.weekly_review suites (E7.10, #250): a
// handler with every dependency mocked, signals for the reviewed ISO week and
// the next one, and a guard-passing answer.
//
// The reviewed week is 2026-W40 (Monday 2026-09-28 to Sunday 2026-10-04); the
// user is in Europe/Madrid, and NOW is Sunday 18:30 local.
// =============================================================================

export { USER };
export const ISO_WEEK = '2026-W40';
export const WEEK_START = '2026-09-28';
export const WEEK_END = '2026-10-04';
export const NOW = new Date('2026-10-04T16:30:00Z'); // Sunday 18:30 in Madrid (CEST)

export const PAYLOAD: CoachWeeklyReviewPayload = { userId: USER, isoWeek: ISO_WEEK };

const session = (id: string, plannedFor: string, status: 'done' | 'missed' | 'upcoming', name: string) => ({
  programWorkoutId: `00000000-0000-4000-8000-0000000002${id}`,
  name,
  plannedFor,
  status,
  workoutId: null,
  setsPlanned: 5,
  setsDone: status === 'done' ? 5 : 0,
  completionPct: null,
  avgRpe: null,
});

/** Signals over exactly the reviewed week: 3 planned and completed (target hit), one bench PR. */
export function weekSignals(overrides: Partial<PlanSignals> = {}): PlanSignals {
  return nudgeSignals({
    range: { from: WEEK_START, to: WEEK_END },
    asOf: WEEK_END,
    adherence: {
      weeks: [
        {
          weekStart: WEEK_START,
          planned: 3,
          completed: 3,
          partialSessions: 0,
          missed: 0,
          extra: 0,
          adherencePct: 100,
          partial: false,
        },
      ],
      totals: { planned: 3, completed: 3, partialSessions: 0, missed: 0, extra: 0, adherencePct: 100 },
      missedStreak: 0,
      completedStreak: 2,
    },
    sessions: [
      session('01', '2026-09-28', 'done', 'Push'),
      session('02', '2026-09-30', 'done', 'Pull'),
      session('03', '2026-10-02', 'done', 'Legs'),
    ],
    performance: [
      {
        exerciseId: '00000000-0000-4000-8000-000000000301',
        slug: 'bench-press',
        name: 'Bench Press',
        sessions: 2,
        best: { weightKg: 82.5, reps: 5, e1rmKg: 96.3 },
        lastTopSets: [{ date: '2026-10-02', weightKg: 82.5, reps: 5, rpe: 8 }],
        trend: 'up',
        trendPct: 3,
        prInRange: true,
      },
      {
        exerciseId: '00000000-0000-4000-8000-000000000302',
        slug: 'squat',
        name: 'Squat',
        sessions: 1,
        best: { weightKg: 100, reps: 5, e1rmKg: 116.7 },
        lastTopSets: [{ date: '2026-10-03', weightKg: 100, reps: 5, rpe: 8 }],
        trend: 'flat',
        trendPct: 0,
        prInRange: false,
      },
    ],
    ...overrides,
  });
}

/** Signals over the following week: three upcoming sessions. */
export function nextWeekSignals(overrides: Partial<PlanSignals> = {}): PlanSignals {
  return nudgeSignals({
    range: { from: '2026-10-05', to: '2026-10-11' },
    asOf: WEEK_END,
    adherence: {
      weeks: [],
      totals: { planned: 0, completed: 0, partialSessions: 0, missed: 0, extra: 0, adherencePct: null },
      missedStreak: 0,
      completedStreak: 0,
    },
    sessions: [
      session('11', '2026-10-07', 'upcoming', 'Pull'),
      session('10', '2026-10-05', 'upcoming', 'Push'),
      session('12', '2026-10-09', 'upcoming', 'Legs'),
    ],
    performance: [],
    ...overrides,
  });
}

export const GOOD_REVIEW: CoachWeeklyReviewProse = {
  headline: 'A solid week of work',
  intro: 'You showed up for most of your plan and set a new best on the bench. That is the kind of week that adds up.',
  wins: ['A new best on Bench Press', 'Three sessions done'],
  focus: 'Protect your Wednesday session next week.',
  nextWeekPlanPrompt: 'Help me plan next week around a busy Wednesday.',
};

export interface ReviewSetupOptions {
  ai?: boolean;
  coach?: Record<string, unknown>;
  system?: Record<string, unknown>;
  state?: Record<string, unknown> | null;
  existing?: { id: string; deliveredAt: Date | null } | null;
  answers?: Array<CoachWeeklyReviewProse | Error>;
  resolution?: { state: string; model: { provider: string; modelId: string } | null };
  week?: PlanSignals;
  nextWeek?: PlanSignals;
  checkInDates?: string[];
  photos?: number;
  everCompleted?: boolean;
  dob?: Date | null;
  /** `updateMany` count inside the transaction (0 = another run recorded the week). */
  advancedCount?: number;
  program?: { autonomyPausedAt: Date | null; autonomyPausedReason: string | null } | null;
  /** `GoalProgressService.progressForUser` as of the week's Sunday (F9); [] by default. */
  goals?: unknown[];
  /** `GoalProgressService.historyForGoal` per goal id (day goals). */
  goalHistory?: Record<string, unknown[]>;
  /** The user's memory block (#325); absent: no memory service. */
  memoryBlock?: string;
}

export function setupReview(options: ReviewSetupOptions = {}) {
  const answers = [...(options.answers ?? [GOOD_REVIEW, GOOD_REVIEW])];
  const respondStructured = jest.fn(async (_req: unknown, _opts?: unknown) => {
    const next = answers.shift() ?? GOOD_REVIEW;
    if (next instanceof Error) throw next;
    return { parsed: next, usage: {} };
  });
  const forUser = jest.fn(() => ({ respondStructured }));

  const coachState = {
    findUnique: jest.fn(async () =>
      options.state === undefined
        ? { pausedUntil: null, weeklyStreak: 3, streakPassesLeft: 0, lastWeeklyReviewWeek: '2026-W39' }
        : options.state,
    ),
    upsert: jest.fn(async () => ({})),
    updateMany: jest.fn(async (_args: { where: unknown; data: Record<string, unknown> }) => ({
      count: options.advancedCount ?? 1,
    })),
  };
  const coachMessage = {
    findFirst: jest.fn(async () => options.existing ?? null),
    create: jest.fn(async (_args: { data: Record<string, any>; select?: unknown }) => ({ id: 'review-1' })),
  };
  const prisma = {
    userSettings: {
      findUnique: jest.fn(async () => ({
        value: { coach: { enabled: true, ...(options.coach ?? {}) } },
        user: { isActive: true, healthProfile: { timeZone: 'Europe/Madrid', dateOfBirth: options.dob ?? null } },
      })),
    },
    coachState,
    coachMessage,
    workout: { findFirst: jest.fn(async () => (options.everCompleted === false ? null : { id: 'w-1' })) },
    program: { findFirst: jest.fn(async () => options.program ?? null) },
    trainingPlanRun: { findFirst: jest.fn(async () => null) },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ coachState, coachMessage })),
  };
  const features = {
    resolve: jest.fn(async () => options.resolution ?? { state: 'ready', model: { provider: 'openai', modelId: 'gpt-test' } }),
  };
  const aiConfig = { isEnabled: jest.fn(async () => options.ai ?? true) };
  const systemSettings = {
    getCoachPolicy: jest.fn(async () => ({ ...DEFAULT_SYSTEM_SETTINGS.coach, enabled: true, ...(options.system ?? {}) })),
  };
  const signals = {
    forUser: jest.fn(async (_userId: string, request: { from: string }) =>
      request.from === WEEK_START ? (options.week ?? weekSignals()) : (options.nextWeek ?? nextWeekSignals()),
    ),
  };
  const checkIns = {
    list: jest.fn(async () => ({
      items: (options.checkInDates ?? ['2026-10-04', '2026-10-02', '2026-09-29', '2026-09-26']).map((date) => ({ date })),
    })),
  };
  const photos = { countInRange: jest.fn(async () => options.photos ?? 1) };
  const jobs = { enqueue: jest.fn(async () => ({ id: 'job-deliver' })) };
  const registry = { register: jest.fn() };
  const reviewMetrics = { sent: jest.fn(), skipped: jest.fn(), fallback: jest.fn(), streak: jest.fn() };
  const appMetrics = { coachGuardRejection: jest.fn() };

  const goals = {
    progressForUser: jest.fn(async (_userId: string, _date?: string, _now?: Date) => options.goals ?? []),
    historyForGoal: jest.fn(async (_userId: string, goalId: string) => options.goalHistory?.[goalId] ?? []),
  };
  const memoryContext =
    options.memoryBlock === undefined ? undefined : { buildBlock: jest.fn(async () => options.memoryBlock as string) };
  const handler = new CoachWeeklyReviewHandler(
    registry as never,
    prisma as never,
    { forUser } as never,
    features as never,
    aiConfig as never,
    systemSettings as never,
    signals as never,
    checkIns as never,
    photos as never,
    new CoachContentGuard(appMetrics as never),
    jobs as never,
    reviewMetrics as never,
    appMetrics as never,
    goals as never,
    memoryContext as never,
  );
  return { handler, prisma, respondStructured, forUser, jobs, registry, features, signals, photos, reviewMetrics, appMetrics, goals, memoryContext };
}

/** The `data` (and the whole row) of the n-th persisted message. */
export function createdOf(t: ReturnType<typeof setupReview>, n = 0): Record<string, any> {
  return t.prisma.coachMessage.create.mock.calls[n][0].data;
}

/** The `instructions` and user text of the n-th model request. */
export function reviewRequestOf(t: ReturnType<typeof setupReview>, n = 0): { instructions: string; text: string } {
  const req = t.respondStructured.mock.calls[n][0] as { instructions: string; input: Array<{ content: Array<{ text: string }> }> };
  return { instructions: req.instructions, text: req.input[0].content[0].text };
}
