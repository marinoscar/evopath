import { computeVerdict, DASHBOARD_VERDICT_THRESHOLDS, type VerdictInput } from './telemetry-dashboard.verdict';

// =============================================================================
// Dashboard verdict boundaries (issue #577)
// =============================================================================

const NOW = new Date('2026-09-27T22:00:00.000Z');

function input(overrides: Partial<VerdictInput> = {}): VerdictInput {
  return {
    now: NOW,
    lastDataAt: new Date(NOW.getTime() - 30_000),
    requests: 1000,
    errors5xx: 0,
    p95Ms: 100,
    errorLogs: 0,
    previousErrorLogs: 0,
    ...overrides,
  };
}

describe('computeVerdict', () => {
  it('is healthy when nothing fires', () => {
    expect(computeVerdict(input())).toEqual({ level: 'healthy', reasons: [] });
  });

  it('pins the thresholds', () => {
    expect(DASHBOARD_VERDICT_THRESHOLDS).toEqual({
      minRequests: 20,
      errorRatePct: { degraded: 2, critical: 5 },
      p95Ms: { degraded: 1000, critical: 3000 },
      errorLogs: { minCurrent: 10, degradedRatio: 3, criticalRatio: 10 },
      noDataMinutes: 5,
    });
  });

  describe('5xx rate', () => {
    it.each([
      [20, 'healthy'], // exactly 2 % is not > 2 %
      [21, 'degraded'],
      [50, 'degraded'], // exactly 5 % is not > 5 %
      [51, 'critical'],
    ])('%d errors of 1000 → %s', (errors5xx, level) => {
      expect(computeVerdict(input({ errors5xx })).level).toBe(level);
    });

    it('names the rate, the threshold and the worst route', () => {
      expect(computeVerdict(input({ errors5xx: 72, topErrorRoute: 'POST /api/jobs' })).reasons).toEqual([
        '5xx rate 7.2% (> 5%) — top: POST /api/jobs',
      ]);
    });

    it('needs at least 20 requests', () => {
      expect(computeVerdict(input({ requests: 19, errors5xx: 19 })).level).toBe('healthy');
      // 1/20 = 5 %: over 2 %, not over 5 %.
      expect(computeVerdict(input({ requests: 20, errors5xx: 1 })).level).toBe('degraded');
      expect(computeVerdict(input({ requests: 20, errors5xx: 2 })).level).toBe('critical');
    });
  });

  describe('p95 latency', () => {
    it.each([
      [1000, 'healthy'],
      [1000.1, 'degraded'],
      [3000, 'degraded'],
      [3000.1, 'critical'],
    ])('%d ms → %s', (p95Ms, level) => {
      expect(computeVerdict(input({ p95Ms })).level).toBe(level);
    });

    it('needs at least 20 requests', () => {
      expect(computeVerdict(input({ requests: 19, p95Ms: 9000 })).level).toBe('healthy');
      expect(computeVerdict(input({ requests: 20, p95Ms: 9000 })).level).toBe('critical');
    });

    it('names the slowest route', () => {
      expect(computeVerdict(input({ p95Ms: 3450, slowestRoute: 'GET /api/x' })).reasons).toEqual([
        'p95 latency 3450 ms (> 3000 ms) — slowest: GET /api/x',
      ]);
    });

    it('ignores a missing p95', () => {
      expect(computeVerdict(input({ p95Ms: null })).level).toBe('healthy');
    });
  });

  describe('error logs against the previous window', () => {
    it.each([
      [29, 10, 'healthy'], // 2.9×
      [30, 10, 'degraded'], // 3× (>=)
      [99, 10, 'degraded'], // 9.9×
      [100, 10, 'critical'], // 10× (>=)
    ])('%d vs %d → %s', (errorLogs, previousErrorLogs, level) => {
      expect(computeVerdict(input({ errorLogs, previousErrorLogs })).level).toBe(level);
    });

    it('needs at least 10 errors now', () => {
      expect(computeVerdict(input({ errorLogs: 9, previousErrorLogs: 0 })).level).toBe('healthy');
      expect(computeVerdict(input({ errorLogs: 10, previousErrorLogs: 0 })).level).toBe('critical');
    });

    it('treats a previous 0 as 1', () => {
      expect(computeVerdict(input({ errorLogs: 29, previousErrorLogs: 0 })).level).toBe('critical');
      expect(computeVerdict(input({ errorLogs: 10, previousErrorLogs: 1 })).level).toBe('critical');
      expect(computeVerdict(input({ errorLogs: 12, previousErrorLogs: 4 })).level).toBe('degraded');
    });

    it('names the counts, the ratio and the top message', () => {
      expect(
        computeVerdict(input({ errorLogs: 45, previousErrorLogs: 3, topErrorMessage: 'ECONNREFUSED\n  at db' }))
          .reasons,
      ).toEqual(['Error logs 45 vs 3 in the previous window (15× ≥ 10×) — top: ECONNREFUSED at db']);
    });
  });

  it('takes the worst level and keeps one reason per rule', () => {
    const verdict = computeVerdict(input({ errors5xx: 30, p95Ms: 5000, errorLogs: 40, previousErrorLogs: 10 }));
    expect(verdict.level).toBe('critical');
    expect(verdict.reasons).toHaveLength(3);
  });

  it('cuts a long offender', () => {
    const [reason] = computeVerdict(input({ errors5xx: 100, topErrorRoute: `GET /${'a'.repeat(200)}` })).reasons;
    expect(reason.length).toBeLessThan(140);
    expect(reason.endsWith('…')).toBe(true);
  });

  describe('no data', () => {
    it('is fine at exactly 5 minutes', () => {
      expect(computeVerdict(input({ lastDataAt: new Date(NOW.getTime() - 5 * 60_000) })).level).toBe('healthy');
    });

    it('overrides everything past 5 minutes', () => {
      expect(
        computeVerdict(
          input({ lastDataAt: new Date(NOW.getTime() - 12 * 60_000 - 1), errors5xx: 900, p95Ms: 9000 }),
        ),
      ).toEqual({ level: 'no_data', reasons: ['No telemetry received for 12 min'] });
    });

    it('fires when nothing was ever seen', () => {
      expect(computeVerdict(input({ lastDataAt: null }))).toEqual({
        level: 'no_data',
        reasons: ['No telemetry received recently'],
      });
    });
  });
});
