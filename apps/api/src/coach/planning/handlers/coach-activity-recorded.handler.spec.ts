import { CoachActivityRecordedHandler } from './coach-activity-recorded.handler';

// F9 (#269): planning right after a manual check-in.

const USER = '00000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-09-30T12:00:00Z');
const SINCE = '2026-09-30T11:59:58.000Z';

function setup(options: { ai?: boolean; coach?: boolean; row?: unknown } = {}) {
  const row =
    options.row === undefined
      ? { value: { coach: { enabled: true } }, user: { isActive: true, healthProfile: { timeZone: 'Europe/Madrid' } } }
      : options.row;
  const prisma = { userSettings: { findUnique: jest.fn(async () => row) } };
  const registry = { register: jest.fn() };
  const aiConfig = { isEnabled: jest.fn(async () => options.ai ?? true) };
  const systemSettings = {
    getCoachPolicy: jest.fn(async () => ({ enabled: options.coach ?? true })),
    getNotificationsPolicy: jest.fn(async () => ({ browserEnabled: true, disabledEvents: [] })),
  };
  const planner = { planUser: jest.fn(async () => ({ queued: 'goal_hit', weeklyReviewQueued: false, suppressed: 0 })) };
  const handler = new CoachActivityRecordedHandler(
    registry as never,
    prisma as never,
    aiConfig as never,
    systemSettings as never,
    planner as never,
  );
  return { handler, planner, registry };
}

describe('CoachActivityRecordedHandler', () => {
  it('is server-only with a 1-minute / 2-attempt profile', () => {
    const { handler, registry } = setup();
    handler.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(handler);
    expect(handler.type).toBe('coach.activity_recorded');
    expect(handler.profile).toEqual({ maxRuntimeMs: 60_000, maxAttempts: 2 });
    expect('nodeResultSchema' in handler).toBe(false);
    expect('persistNodeResult' in handler).toBe(false);
  });

  it('plans the check-in pass for the user in their zone', async () => {
    const t = setup();
    await t.handler.plan({ userId: USER, recordedSince: SINCE }, NOW);
    expect(t.planner.planUser).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ trigger: 'activity_recorded', recordedSince: new Date(SINCE), timeZone: 'Europe/Madrid', now: NOW }),
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
    expect(await t.handler.plan({ userId: USER, recordedSince: SINCE }, NOW)).toBeNull();
    expect(t.planner.planUser).not.toHaveBeenCalled();
  });

  it('ignores a job with an invalid payload', async () => {
    const t = setup();
    await t.handler.process({ id: 'job-1', payload: { userId: USER, recordedSince: 'yesterday' } } as never);
    expect(t.planner.planUser).not.toHaveBeenCalled();
  });
});
