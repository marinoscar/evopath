import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';
import type { PlanSignals } from '../../src/programs/signals/plan-signals.contract';
import { CoachAudioService } from '../../src/coach/audio/coach-audio.service';
import { CoachContentGuard } from '../../src/coach/guard/coach-content-guard.service';
import { DefaultAnglePicker } from '../../src/coach/nudges/angle-picker';
import type { CoachNudgeOutput } from '../../src/coach/nudges/nudge-schema';
import { CoachNudgeHandler, type CoachNudgePayload } from '../../src/coach/nudges/handlers/coach-nudge.handler';

// =============================================================================
// Shared fixtures for the ai.coach.nudge suites (E7.5, #245): a handler with
// every dependency mocked, a signals fixture and a guard-passing answer.
// =============================================================================

export const USER = '00000000-0000-4000-8000-000000000001';
export const NOW = new Date('2026-10-01T10:00:00Z'); // a Thursday
export const TODAY = '2026-10-01';

export function nudgeSignals(overrides: Partial<PlanSignals> = {}): PlanSignals {
  const session = (id: string, plannedFor: string, status: 'done' | 'missed' | 'upcoming', name: string) => ({
    programWorkoutId: id,
    name,
    plannedFor,
    status,
    workoutId: null,
    setsPlanned: 5,
    setsDone: status === 'done' ? 5 : 0,
    completionPct: null,
    avgRpe: null,
  });
  return {
    range: { from: '2026-09-01', to: '2026-10-08' },
    asOf: TODAY,
    programId: '00000000-0000-4000-8000-0000000000p1',
    planVersion: 1,
    weeksInRange: 5,
    truncated: false,
    planChangedOn: null,
    adherence: {
      weeks: [],
      totals: { planned: 10, completed: 8, partialSessions: 0, missed: 2, extra: 0, adherencePct: 80 },
      missedStreak: 2,
      completedStreak: 0,
    },
    frequency: { avgPerWeek: 3, perWeek: [] },
    sessions: [
      session('00000000-0000-4000-8000-000000000101', '2026-09-29', 'missed', 'Push'),
      session('00000000-0000-4000-8000-000000000102', '2026-09-30', 'missed', 'Pull'),
      session('00000000-0000-4000-8000-000000000103', '2026-10-02', 'upcoming', 'Legs'),
    ],
    volume: [],
    performance: [],
    effort: { avgRpe: null, setsAtRpe9Plus: 0, rpeTrend: 'insufficient' },
    pain: [],
    readiness: { days: 0, avg: null, lowDays: 0, lowStreak: 0 },
    body: { weightKg: { latest: 91.3, changePerWeek: -0.4, points: 5 }, bodyFatPct: null },
    ...overrides,
  };
}

export const GOOD: CoachNudgeOutput = {
  send: true,
  moment: 'missed_twice',
  title: 'Back to it today',
  body: 'Two sessions slipped this week. That is information, not a verdict. Legs is up tomorrow: want a short version today?',
  pushTitle: 'Your coach checked in',
  pushBody: 'Ready for a short session today?',
  audioScript: 'Two sessions slipped this week. Want a short one today?',
  audioInstructions: 'Warm and calm.',
  reason: 'A gentle restart helps after two misses.',
};

export const PAYLOAD: CoachNudgePayload = {
  userId: USER,
  moment: 'missed_twice',
  momentKey: `missed_twice:${TODAY}`,
  candidates: [{ moment: 'missed_twice', priority: 1, reason: 'missed_streak' }],
  trigger: 'sweep',
};

export interface SetupOptions {
  ai?: boolean;
  coach?: Record<string, unknown>;
  system?: Record<string, unknown>;
  state?: Record<string, unknown> | null;
  existing?: { id: string; deliveredAt: Date | null; audioStatus?: string; createdAt?: Date } | null;
  /** `coach.voice` resolution (E7.6); defaults to a runnable speech model. */
  voiceResolution?: { state: string; model: { provider: string; modelId: string } | null };
  /** What `speak()` does (E7.6): resolve a run handle (default) or throw. */
  speak?: Error;
  /** Status of the speech run right after `speak()` (the early-settle check). */
  speechRunStatus?: string;
  answers?: Array<CoachNudgeOutput | Error>;
  resolution?: { state: string; model: { provider: string; modelId: string } | null };
  signals?: PlanSignals;
  dob?: Date | null;
  /** Extra fields merged into the user row and the history rows (canaries). */
  userExtras?: Record<string, unknown>;
  historyExtras?: Record<string, unknown>;
  /** `GoalProgressService.progressForUser` (F9); [] by default. */
  goals?: unknown[];
}

export function setupNudge(options: SetupOptions = {}) {
  const answers = [...(options.answers ?? [GOOD])];
  const respondStructured = jest.fn(async (_req: unknown, _opts?: unknown) => {
    const next = answers.shift() ?? GOOD;
    if (next instanceof Error) throw next;
    return { parsed: next, usage: {} };
  });
  const speak = jest.fn(async (_req: unknown) => {
    if (options.speak) throw options.speak;
    return { runId: '00000000-0000-4000-8000-0000000000a1', jobId: '00000000-0000-4000-8000-0000000000b1' };
  });
  const forUser = jest.fn(() => ({ respondStructured, speak }));
  const prisma = {
    userSettings: {
      findUnique: jest.fn(async () => ({
        value: { coach: { enabled: true, ...(options.coach ?? {}) } },
        user: {
          isActive: true,
          healthProfile: { timeZone: 'Europe/Madrid', dateOfBirth: options.dob ?? null },
          ...(options.userExtras ?? {}),
        },
      })),
    },
    coachState: {
      findUnique: jest.fn(async () =>
        options.state === undefined
          ? { pausedUntil: null, weeklyStreak: 3, streakPassesLeft: 1, usualWorkoutMinuteLocal: 18 * 60 }
          : options.state,
      ),
    },
    coachMessage: {
      findFirst: jest.fn(async () => options.existing ?? null),
      findMany: jest.fn(async () => [
        {
          kind: 'nudge',
          moment: 'streak_at_risk',
          title: 'Your usual time is coming up',
          createdAt: new Date('2026-09-29T10:00:00Z'),
          ...(options.historyExtras ?? {}),
        },
      ]),
      create: jest.fn(async (_args: { data: Record<string, any>; select?: unknown }) => ({ id: 'msg-1' })),
      findUnique: jest.fn(async () => ({ data: {} })),
      updateMany: jest.fn(async (_args: { where: Record<string, any>; data: Record<string, any> }) => ({ count: 1 })),
    },
    aiRun: {
      findUnique: jest.fn(async () => ({ status: options.speechRunStatus ?? 'pending' })),
    },
    program: { findFirst: jest.fn(async () => null) },
    trainingPlanRun: { findFirst: jest.fn(async () => null) },
  };
  const features = {
    resolve: jest.fn(async (_userId: string, featureId: string) =>
      featureId === 'coach.voice'
        ? (options.voiceResolution ?? { state: 'ready', model: { provider: 'openai', modelId: 'tts-test' } })
        : (options.resolution ?? { state: 'ready', model: { provider: 'openai', modelId: 'gpt-test' } }),
    ),
  };
  const aiConfig = { isEnabled: jest.fn(async () => options.ai ?? true) };
  const systemSettings = {
    getCoachPolicy: jest.fn(async () => ({ ...DEFAULT_SYSTEM_SETTINGS.coach, enabled: true, ...(options.system ?? {}) })),
  };
  const signals = { forUser: jest.fn(async () => options.signals ?? nudgeSignals()) };
  const jobs = { enqueue: jest.fn(async () => ({ id: 'job-deliver' })) };
  const registry = { register: jest.fn() };
  const metrics = {
    coachNudgeSuppression: jest.fn(),
    coachNudgeFallbackUsed: jest.fn(),
    coachGuardRejection: jest.fn(),
    coachAudioFailure: jest.fn(),
    coachAudioReady: jest.fn(),
  };
  // Records every Prisma model the handler touches (the never-send canary
  // asserts the job never reads a forbidden source at all).
  const accessedModels = new Set<string>();
  const trackedPrisma = new Proxy(prisma, {
    get(target, prop, receiver) {
      if (typeof prop === 'string') accessedModels.add(prop);
      return Reflect.get(target, prop, receiver);
    },
  });
  const runs = { cancel: jest.fn(async () => ({})) };
  const goals = { progressForUser: jest.fn(async () => options.goals ?? []) };
  const audio = new CoachAudioService(
    trackedPrisma as never,
    { forUser } as never,
    runs as never,
    features as never,
    jobs as never,
    metrics as never,
  );
  const handler = new CoachNudgeHandler(
    registry as never,
    trackedPrisma as never,
    { forUser } as never,
    features as never,
    aiConfig as never,
    systemSettings as never,
    signals as never,
    new CoachContentGuard(metrics as never),
    jobs as never,
    audio,
    new DefaultAnglePicker(),
    metrics as never,
    goals as never,
  );
  return { handler, prisma, respondStructured, forUser, speak, jobs, metrics, registry, features, accessedModels, goals };
}

/** The `instructions` and user text of the n-th model request. */
export function requestOf(respondStructured: jest.Mock<any, any>, n = 0): { instructions: string; text: string; raw: string } {
  const req = respondStructured.mock.calls[n][0] as { instructions: string; input: Array<{ content: Array<{ text: string }> }> };
  return { instructions: req.instructions, text: req.input[0].content[0].text, raw: JSON.stringify(req) };
}

