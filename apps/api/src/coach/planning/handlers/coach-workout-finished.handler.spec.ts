import { CoachWorkoutFinishedHandler } from './coach-workout-finished.handler';

const USER = '00000000-0000-4000-8000-000000000001';
const WORKOUT = '00000000-0000-4000-8000-0000000000aa';
const NOW = new Date('2026-09-30T12:00:00Z');

function setup(options: { ai?: boolean; coach?: boolean; row?: unknown } = {}) {
  const row =
    options.row === undefined
      ? { value: { coach: { enabled: true } }, user: { isActive: true, healthProfile: { timeZone: 'Asia/Kolkata' } } }
      : options.row;
  const prisma = { userSettings: { findUnique: jest.fn(async () => row) } };
  const registry = { register: jest.fn() };
  const aiConfig = { isEnabled: jest.fn(async () => options.ai ?? true) };
  const systemSettings = {
    getCoachPolicy: jest.fn(async () => ({ enabled: options.coach ?? true })),
    getNotificationsPolicy: jest.fn(async () => ({ browserEnabled: true, disabledEvents: [] })),
  };
  const planner = { planUser: jest.fn(async () => ({ queued: 'comeback', weeklyReviewQueued: false, suppressed: 0 })) };
  const handler = new CoachWorkoutFinishedHandler(registry as never, prisma as never, aiConfig as never, systemSettings as never, planner as never);
  return { handler, planner, registry };
}

describe('CoachWorkoutFinishedHandler', () => {
  it('is server-only with a 1-minute / 2-attempt profile', () => {
    const { handler, registry } = setup();
    handler.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(handler);
    expect(handler.type).toBe('coach.workout_finished');
    expect(handler.profile).toEqual({ maxRuntimeMs: 60_000, maxAttempts: 2 });
    expect('nodeResultSchema' in handler).toBe(false);
    expect('persistNodeResult' in handler).toBe(false);
  });

  it('plans the event moments for the user in their zone', async () => {
    const t = setup();
    await t.handler.plan({ userId: USER, workoutId: WORKOUT }, NOW);
    expect(t.planner.planUser).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ trigger: 'workout_finished', workoutId: WORKOUT, timeZone: 'Asia/Kolkata', now: NOW }),
    );
  });

  it.each([
    ['AI off', { ai: false }],
    ['the system coach off', { coach: false }],
    ['the user coach off', { row: { value: { coach: { enabled: false } }, user: { isActive: true, healthProfile: null } } }],
    ['no settings row', { row: null }],
    ['an inactive account', { row: { value: { coach: { enabled: true } }, user: { isActive: false, healthProfile: null } } }],
  ])('does nothing with %s', async (_label, options) => {
    const t = setup(options);
    expect(await t.handler.plan({ userId: USER, workoutId: WORKOUT }, NOW)).toBeNull();
    expect(t.planner.planUser).not.toHaveBeenCalled();
  });

  it('ignores a job with an invalid payload', async () => {
    const t = setup();
    await t.handler.process({ id: 'job-1', payload: { userId: 'nope' } } as never);
    expect(t.planner.planUser).not.toHaveBeenCalled();
  });
});
