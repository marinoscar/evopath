// =============================================================================
// GET /api/admin/coach/stats over HTTP (E7.11, #251)
// =============================================================================
//
// `ai_config:read`, NOT behind `AiEnabledGuard`: works while AI is off.
// Rates equal manual counts over a fixture; aggregates only.
// =============================================================================

import request from 'supertest';

import { authHeader, createMockTestUser, type TestUser } from '../helpers/auth-mock.helper';
import { createAiHttpTestApp, type AiHttpTestApp } from '../ai/ai-http.helper';
import { useSystemCoachPolicy } from './coach-test.helper';

const PATH = '/api/admin/coach/stats';

const group = (angle: string | null, personaId: string, moment: string, feedback: string | null, all: number, opened: number, converted: number) => ({
  angle,
  personaId,
  moment,
  feedback,
  _count: { _all: all, openedAt: opened, convertedAt: converted },
});

const FIXTURE = [
  group('identity', 'coach', 'missed_twice', null, 6, 3, 2),
  group('identity', 'coach', 'missed_twice', 'up', 2, 2, 1),
  group('challenge', 'drill_sergeant', 'streak_at_risk', 'down', 2, 1, 0),
];

describe('/api/admin/coach/stats (E7.11)', () => {
  let t: AiHttpTestApp;
  let admin: TestUser;
  let contributor: TestUser;

  const server = () => t.context.app.getHttpServer();

  beforeAll(async () => {
    t = await createAiHttpTestApp();
  }, 60_000);

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.reset();
    admin = await createMockTestUser(t.context, { roleName: 'admin' });
    contributor = await createMockTestUser(t.context, { roleName: 'contributor' });
    useSystemCoachPolicy(t.context);
    const prisma = t.context.prismaMock as any;
    prisma.coachMessage.groupBy.mockResolvedValue(FIXTURE);
    prisma.$queryRaw.mockResolvedValue([
      { weeklyActiveUsers: 4, chatSessions: 6, photoDue: 2, photoOnCadence: 1, enabled: 3, optedOut: 1 },
    ]);
  });

  it('answers counts and rates equal to manual counts over the fixture', async () => {
    const res = await request(server()).get(PATH).set(authHeader(admin.accessToken)).expect(200);
    const data = res.body.data;

    expect(data.range.days).toBe(30);
    expect(data.totals).toEqual({
      sent: 10,
      opened: 6,
      convertible: 10,
      converted: 3,
      up: 2,
      down: 2,
      openRate: 0.6,
      convertRate: 0.3,
    });
    expect(data.byAngle).toEqual([
      { key: 'identity', sent: 8, opened: 5, convertible: 8, converted: 3, up: 2, down: 0, openRate: 0.625, convertRate: 0.375 },
      { key: 'challenge', sent: 2, opened: 1, convertible: 2, converted: 0, up: 0, down: 2, openRate: 0.5, convertRate: 0 },
    ]);
    expect(data.byPersona.map((r: { key: string }) => r.key)).toEqual(['coach', 'drill_sergeant']);
    expect(data.kpis).toEqual({
      nudgeOpenRate: 0.6,
      conversionRate: 0.3,
      weeklyActiveUsers: 4,
      chatSessionsPerWau: 1.5,
      photoCadenceAdherencePct: 50,
      weeklyAdherencePct: null,
      optedOut: 1,
      enabled: 3,
      optOutRate: 0.25,
    });
    // Aggregates only.
    expect(JSON.stringify(res.body)).not.toContain(admin.id);
  });

  it('accepts a bounded range and refuses a reversed or over-long one', async () => {
    const ok = await request(server()).get(`${PATH}?from=2026-09-01&to=2026-09-07`).set(authHeader(admin.accessToken)).expect(200);
    expect(ok.body.data.range).toEqual({ from: '2026-09-01', to: '2026-09-07', days: 7 });

    const reversed = await request(server()).get(`${PATH}?from=2026-09-08&to=2026-09-07`).set(authHeader(admin.accessToken)).expect(400);
    expect(reversed.body.details.reason).toBe('COACH_STATS_RANGE_INVALID');
    await request(server()).get(`${PATH}?from=2024-01-01&to=2026-09-07`).set(authHeader(admin.accessToken)).expect(400);
    await request(server()).get(`${PATH}?days=0`).set(authHeader(admin.accessToken)).expect(400);
    await request(server()).get(`${PATH}?from=yesterday`).set(authHeader(admin.accessToken)).expect(400);
  });

  it('works while AI is switched off', async () => {
    t.harness.setPolicy({ enabled: false });
    await request(server()).get(PATH).set(authHeader(admin.accessToken)).expect(200);
  });

  it('403 without ai_config:read; 401 unauthenticated', async () => {
    await request(server()).get(PATH).set(authHeader(contributor.accessToken)).expect(403);
    await request(server()).get(PATH).expect(401);
  });
});
