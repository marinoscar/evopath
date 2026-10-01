import { BadRequestException } from '@nestjs/common';

import { CoachAdminStatsService, resolveCoachStatsRange, rollUpFunnel, type CoachFunnelGroup } from './coach-admin-stats.service';

// E7.11 (#251): engagement aggregates for the admin Coach page.

const NOW = new Date('2026-10-01T15:30:00Z');

const g = (
  angle: string | null,
  personaId: string | null,
  moment: string | null,
  feedback: string | null,
  all: number,
  openedAt: number,
  convertedAt: number,
): CoachFunnelGroup => ({ angle, personaId, moment, feedback, _count: { _all: all, openedAt, convertedAt } });

describe('resolveCoachStatsRange', () => {
  it('defaults to the last 30 UTC days ending today, both inclusive', () => {
    expect(resolveCoachStatsRange({}, NOW)).toEqual({
      from: '2026-09-02',
      to: '2026-10-01',
      days: 30,
      start: new Date('2026-09-02T00:00:00Z'),
      end: new Date('2026-10-02T00:00:00Z'),
    });
  });

  it('days is a shorthand for the window ending `to`', () => {
    expect(resolveCoachStatsRange({ days: 7, to: '2026-09-30' }, NOW)).toMatchObject({ from: '2026-09-24', to: '2026-09-30', days: 7 });
  });

  it('refuses a reversed or over-long range with COACH_STATS_RANGE_INVALID', () => {
    for (const q of [{ from: '2026-10-02', to: '2026-10-01' }, { from: '2025-01-01', to: '2026-10-01' }, { from: '2026-02-30' }]) {
      try {
        resolveCoachStatsRange(q, NOW);
        throw new Error('expected a refusal');
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        expect((err as BadRequestException).getResponse()).toMatchObject({ details: { reason: 'COACH_STATS_RANGE_INVALID' } });
      }
    }
    expect(resolveCoachStatsRange({ from: '2025-10-02', to: '2026-10-01' }, NOW).days).toBe(365);
  });
});

describe('rollUpFunnel', () => {
  const groups = [
    g('identity', 'coach', 'missed_twice', null, 10, 6, 3),
    g('identity', 'coach', 'missed_twice', 'up', 2, 2, 1),
    g('challenge', 'drill_sergeant', 'streak_at_risk', 'down', 4, 1, 0),
    // A celebration: no conversion target.
    g(null, 'coach', 'pr', 'up', 5, 5, 0),
    // A supportive low-readiness message converted by a check-in: convertible by its conversion.
    g('future_self', 'stoic', 'comeback', null, 3, 2, 1),
  ];

  it('totals equal manual counts; rates use the right denominators', () => {
    const { totals } = rollUpFunnel(groups);
    expect(totals).toEqual({
      sent: 24,
      opened: 16,
      convertible: 10 + 2 + 4 + 0 + 1,
      converted: 5,
      up: 7,
      down: 4,
      openRate: Math.round((16 / 24) * 10_000) / 10_000,
      convertRate: Math.round((5 / 17) * 10_000) / 10_000,
    });
  });

  it('breaks down by angle, persona and moment, sorted by sent; `none` for a missing key', () => {
    const { byAngle, byPersona, byMoment } = rollUpFunnel(groups);
    expect(byAngle.map((r) => [r.key, r.sent])).toEqual([
      ['identity', 12],
      ['none', 5],
      ['challenge', 4],
      ['future_self', 3],
    ]);
    expect(byAngle[0]).toMatchObject({ opened: 8, converted: 4, convertible: 12, up: 2, openRate: 0.6667, convertRate: 0.3333 });
    expect(byPersona.map((r) => [r.key, r.sent])).toEqual([
      ['coach', 17],
      ['drill_sergeant', 4],
      ['stoic', 3],
    ]);
    expect(byMoment.find((r) => r.key === 'pr')).toMatchObject({ convertible: 0, convertRate: null, openRate: 1 });
  });

  it('empty input: zero counts and null rates', () => {
    expect(rollUpFunnel([])).toEqual({
      totals: { sent: 0, opened: 0, convertible: 0, converted: 0, up: 0, down: 0, openRate: null, convertRate: null },
      byAngle: [],
      byPersona: [],
      byMoment: [],
    });
  });
});

describe('CoachAdminStatsService', () => {
  function setup(kpi: Record<string, number> | undefined) {
    const prisma = {
      coachMessage: { groupBy: jest.fn(async () => [g('identity', 'coach', 'missed_twice', null, 4, 2, 1)]) },
      $queryRaw: jest.fn(async () => (kpi ? [kpi] : [])),
    };
    return { prisma, service: new CoachAdminStatsService(prisma as never) };
  }

  it('groups delivered non-chat coach messages in the range, and derives the KPIs', async () => {
    const t = setup({ weeklyActiveUsers: 8, chatSessions: 12, photoDue: 4, photoOnCadence: 3, enabled: 9, optedOut: 1 });
    const stats = await t.service.stats({}, NOW);

    expect(t.prisma.coachMessage.groupBy).toHaveBeenCalledWith({
      by: ['angle', 'personaId', 'moment', 'feedback'],
      where: {
        role: 'coach',
        kind: { not: 'chat' },
        deliveredAt: { gte: new Date('2026-09-02T00:00:00Z'), lt: new Date('2026-10-02T00:00:00Z') },
      },
      _count: { _all: true, openedAt: true, convertedAt: true },
    });
    expect(stats.range).toEqual({ from: '2026-09-02', to: '2026-10-01', days: 30 });
    expect(stats.kpis).toEqual({
      nudgeOpenRate: 0.5,
      conversionRate: 0.25,
      weeklyActiveUsers: 8,
      chatSessionsPerWau: 1.5,
      photoCadenceAdherencePct: 75,
      weeklyAdherencePct: null,
      optedOut: 1,
      enabled: 9,
      optOutRate: 0.1,
    });
  });

  it('the KPI SQL returns counts only (no user id column)', async () => {
    const t = setup(undefined);
    const stats = await t.service.stats({}, NOW);
    const sql = (t.prisma.$queryRaw.mock.calls[0] as unknown[])[0] as { sql: string };
    expect(sql.sql).toMatch(/SELECT\s+\(SELECT COUNT/);
    expect(stats.kpis).toMatchObject({ weeklyActiveUsers: 0, chatSessionsPerWau: null, photoCadenceAdherencePct: null, optOutRate: null });
  });

  it('no user id or text anywhere in the answer', async () => {
    const t = setup({ weeklyActiveUsers: 1, chatSessions: 1, photoDue: 0, photoOnCadence: 0, enabled: 1, optedOut: 0 });
    const body = JSON.stringify(await t.service.stats({}, NOW));
    expect(body).not.toMatch(/userId|user_id|title|body/);
  });
});
