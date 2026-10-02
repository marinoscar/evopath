import request from 'supertest';

import { HARNESS_USER } from '../../src/ai/testing/ai-runtime-harness';
import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';
import type { PlanSignals } from '../../src/programs/signals/plan-signals.contract';
import { TrainingSignalsService } from '../../src/programs/signals/signals.service';
import { SystemSettingsService } from '../../src/settings/system-settings/system-settings.service';
import { authHeader, createMockTestUser, createMockViewerUser, type TestUser } from '../helpers/auth-mock.helper';
import { createAiHttpTestApp, type AiHttpTestApp } from '../ai/ai-http.helper';

// =============================================================================
// GET /api/coach/state (E7.4, AC 16)
// =============================================================================
//
// The header numbers equal the signals service's; the route is refused with AI
// off and without `ai:use`; it only ever reads the caller's own rows.
// =============================================================================

const PATH = '/api/coach/state';

function signalsFor(today: string): PlanSignals {
  const session = (id: string, status: 'done' | 'upcoming', name: string) => ({
    programWorkoutId: id,
    name,
    plannedFor: today,
    status,
    workoutId: null,
    setsPlanned: 5,
    setsDone: status === 'done' ? 5 : 0,
    completionPct: null,
    avgRpe: null,
  });
  return {
    range: { from: today, to: today },
    asOf: today,
    programId: null,
    planVersion: null,
    weeksInRange: 1,
    truncated: false,
    planChangedOn: null,
    adherence: {
      weeks: [],
      totals: { planned: 0, completed: 0, partialSessions: 0, missed: 0, extra: 0, adherencePct: null },
      missedStreak: 0,
      completedStreak: 0,
    },
    frequency: { avgPerWeek: null, perWeek: [] },
    sessions: [
      session('00000000-0000-4000-8000-000000000101', 'done', 'Push'),
      session('00000000-0000-4000-8000-000000000102', 'upcoming', 'Pull'),
    ],
    volume: [],
    performance: [],
    effort: { avgRpe: null, setsAtRpe9Plus: 0, rpeTrend: 'insufficient' },
    pain: [],
    readiness: { days: 0, avg: null, lowDays: 0, lowStreak: 0 },
    body: { weightKg: { latest: null, changePerWeek: null, points: 0 }, bodyFatPct: null },
  };
}

describe('GET /api/coach/state (E7.4)', () => {
  let t: AiHttpTestApp;
  let alice: TestUser;
  let forUser: jest.SpyInstance;

  beforeAll(async () => {
    t = await createAiHttpTestApp();
  }, 60_000);

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.reset();
    alice = await createMockTestUser(t.context, { id: HARNESS_USER, roleName: 'contributor' });
    const prisma = t.context.prismaMock as any;
    prisma.healthProfile.findUnique.mockResolvedValue(null);
    prisma.coachState.findUnique.mockResolvedValue(null);
    prisma.coachMessage.count.mockResolvedValue(0);
    prisma.userSettings.findUnique.mockResolvedValue({ value: { coach: { enabled: true } } });

    jest
      .spyOn(t.context.app.get(SystemSettingsService), 'getCoachPolicy')
      .mockResolvedValue({ ...DEFAULT_SYSTEM_SETTINGS.coach, enabled: true });
    forUser = jest
      .spyOn(t.context.app.get(TrainingSignalsService), 'forUser')
      .mockImplementation(async () => signalsFor(new Date().toISOString().slice(0, 10)));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const server = () => t.context.app.getHttpServer();

  it('answers defaults with no CoachState row, and the ring and next session from the signals', async () => {
    const res = await request(server()).get(PATH).set(authHeader(alice.accessToken)).expect(200);

    expect(res.body.data).toEqual({
      enabled: true,
      pausedUntil: null,
      silencedAt: null,
      weeklyTarget: { done: 1, planned: 2 },
      weeklyStreak: 0,
      streakPassesLeft: 0,
      nextSession: {
        date: new Date().toISOString().slice(0, 10),
        name: 'Pull',
        programWorkoutId: '00000000-0000-4000-8000-000000000102',
      },
      unreadCount: 0,
      chatClearedAt: null,
    });
    const prisma = t.context.prismaMock as any;
    expect(prisma.coachState.create).not.toHaveBeenCalled();
    expect(prisma.coachState.upsert).not.toHaveBeenCalled();
  });

  it('reads the caller\'s CoachState and unread count, and only the caller\'s', async () => {
    const prisma = t.context.prismaMock as any;
    prisma.coachState.findUnique.mockResolvedValue({
      userId: HARNESS_USER,
      pausedUntil: new Date('2026-10-10T00:00:00Z'),
      silencedAt: null,
      weeklyStreak: 5,
      streakPassesLeft: 1,
      chatClearedAt: new Date('2026-10-01T12:00:00Z'),
    });
    prisma.coachMessage.count.mockResolvedValue(3);

    const res = await request(server()).get(PATH).set(authHeader(alice.accessToken)).expect(200);

    expect(res.body.data).toMatchObject({
      pausedUntil: '2026-10-10T00:00:00.000Z',
      weeklyStreak: 5,
      streakPassesLeft: 1,
      unreadCount: 3,
      chatClearedAt: '2026-10-01T12:00:00.000Z',
    });
    expect(prisma.coachState.findUnique).toHaveBeenCalledWith({ where: { userId: HARNESS_USER } });
    expect(prisma.coachMessage.count).toHaveBeenCalledWith({
      where: { userId: HARNESS_USER, role: 'coach', deliveredAt: { not: null }, openedAt: null },
    });
    expect(forUser).toHaveBeenCalledWith(HARNESS_USER, expect.any(Object), expect.any(Date));
  });

  it('reports enabled: false while the user coach is off', async () => {
    (t.context.prismaMock as any).userSettings.findUnique.mockResolvedValue({ value: {} });
    const res = await request(server()).get(PATH).set(authHeader(alice.accessToken)).expect(200);
    expect(res.body.data.enabled).toBe(false);
  });

  it('answers 403 AI_DISABLED while AI is off, before authentication', async () => {
    t.harness.setPolicy({ enabled: false });

    const res = await request(server()).get(PATH).set(authHeader(alice.accessToken)).expect(403);
    expect(res.body.details).toMatchObject({ reason: 'AI_DISABLED' });
    await request(server()).get(PATH).expect(403);
  });

  it('refuses a viewer (no ai:use) and an unauthenticated caller', async () => {
    const viewer = await createMockViewerUser(t.context);
    await request(server()).get(PATH).set(authHeader(viewer.accessToken)).expect(403);
    await request(server()).get(PATH).expect(401);
    expect(forUser).not.toHaveBeenCalled();
  });
});
