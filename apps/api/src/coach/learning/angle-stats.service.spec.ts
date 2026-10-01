import { AngleStatsService, aggregateAngleRewards, eligibleOfRow, type AngleRewardRow } from './angle-stats.service';
import { ANGLE_REWARD_CACHE_TTL_MS, ANGLE_REWARD_MATURITY_HOURS, ANGLE_REWARD_WINDOW_DAYS } from './learning.constants';

// E7.11 (#251), spec §2.8: global per-angle rewards.

const NOW = new Date('2026-10-01T12:00:00Z');

describe('aggregateAngleRewards', () => {
  it('AC7: counts sends for the sent angle and eligible-but-not-sent for every other eligible angle', () => {
    const rows: AngleRewardRow[] = [
      { angle: 'challenge', eligible: ['identity', 'challenge', 'data'], register: 'clean', sent: 10, converted: 4 },
      { angle: 'identity', eligible: ['identity', 'challenge'], register: 'clean', sent: 5n, converted: 1n },
    ];
    expect(aggregateAngleRewards(rows)).toEqual({
      challenge: { sent: 10, sentConverted: 4, notSent: 5, notSentConverted: 1 },
      identity: { sent: 5, sentConverted: 1, notSent: 10, notSentConverted: 4 },
      data: { sent: 0, sentConverted: 0, notSent: 10, notSentConverted: 4 },
    });
  });

  it('reconstructs eligibility from the register when the set was not recorded (E7.5 messages)', () => {
    expect(eligibleOfRow({ eligible: null, register: 'supportive' })).toEqual(['identity', 'future_self']);
    expect(eligibleOfRow({ eligible: null, register: 'clean' })).toHaveLength(7);
    expect(eligibleOfRow({ eligible: ['identity', 'nonsense', 3], register: null })).toEqual(['identity']);
  });

  it('ignores rows with an unknown angle', () => {
    expect(aggregateAngleRewards([{ angle: 'retired', eligible: null, register: null, sent: 3, converted: 1 }])).toEqual({});
  });
});

describe('AngleStatsService', () => {
  function setup(rows: AngleRewardRow[] | Error = []) {
    const prisma = {
      $queryRaw: jest.fn(async () => {
        if (rows instanceof Error) throw rows;
        return rows;
      }),
    };
    return { prisma, service: new AngleStatsService(prisma as never) };
  }

  it('queries delivered, matured, targeted messages over the window, grouped (no user ids)', async () => {
    const t = setup([{ angle: 'data', eligible: ['data', 'identity'], register: 'clean', sent: 2, converted: 1 }]);
    await expect(t.service.rewards(NOW)).resolves.toEqual({
      data: { sent: 2, sentConverted: 1, notSent: 0, notSentConverted: 0 },
      identity: { sent: 0, sentConverted: 0, notSent: 2, notSentConverted: 1 },
    });
    const sql = (t.prisma.$queryRaw.mock.calls[0] as unknown[])[0] as { sql: string; values: unknown[] };
    expect(sql.sql).toMatch(/GROUP BY/);
    expect(sql.sql).not.toMatch(/user_id/);
    expect(sql.sql).toMatch(/"angle" IS NOT NULL/);
    expect(sql.values).toEqual(
      expect.arrayContaining([
        new Date(NOW.getTime() - ANGLE_REWARD_WINDOW_DAYS * 86_400_000),
        new Date(NOW.getTime() - ANGLE_REWARD_MATURITY_HOURS * 3_600_000),
        'photo_prompt',
        'missed_twice',
      ]),
    );
    // Celebrations and reviews have no target: never in the moment list.
    expect(sql.values).not.toContain('pr');
    expect(sql.values).not.toContain('weekly_review');
  });

  it('caches for the TTL, then recomputes', async () => {
    const t = setup([]);
    await t.service.rewards(NOW);
    await t.service.rewards(new Date(NOW.getTime() + ANGLE_REWARD_CACHE_TTL_MS - 1));
    expect(t.prisma.$queryRaw).toHaveBeenCalledTimes(1);
    await t.service.rewards(new Date(NOW.getTime() + ANGLE_REWARD_CACHE_TTL_MS));
    expect(t.prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('answers {} (cold start) when the aggregate fails, never throws', async () => {
    const t = setup(new Error('db down'));
    await expect(t.service.rewards(NOW)).resolves.toEqual({});
  });
});
