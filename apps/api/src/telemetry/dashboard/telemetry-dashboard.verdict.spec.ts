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
      unknownRoutes: { criticalBearerRequests: 20, criticalDistinctRoutes: 3 },
      diskUtilizationPct: { degraded: 85, critical: 95 },
      memoryUtilizationPct: { degraded: 90, critical: 97 },
      dbConnectionsPct: { degraded: 80, critical: 95 },
      oldestPendingJobMinutes: { degraded: 10, critical: 30 },
      tlsDaysLeft: { degraded: 14, critical: 7 },
      uptimeMinChecksForCritical: 2,
      collectorFailedPct: { critical: 10 },
      backupAgeHours: { degraded: 26, critical: 50 },
    });
  });

  describe('unknown API routes (#258)', () => {
    const unknown = (bearerRequests: number, bearerRoutes: number, topRoute: string | null = 'GET /api/coach/messages') => ({
      unknownRoutes: { bearerRequests, bearerRoutes, topRoute },
    });

    it('stays healthy when the store cannot tell (no matched column)', () => {
      expect(computeVerdict(input({ unknownRoutes: null })).level).toBe('healthy');
      expect(computeVerdict(input({ unknownRoutes: undefined })).level).toBe('healthy');
    });

    it('never fires for anonymous-only unknown routes (scanner noise)', () => {
      // The summary passes only bearer figures: anonymous requests reach the
      // verdict as bearerRequests 0, whatever their count.
      expect(computeVerdict(input(unknown(0, 0, null)))).toEqual({ level: 'healthy', reasons: [] });
    });

    it('degrades on a single bearer request and names the route', () => {
      expect(computeVerdict(input(unknown(1, 1)))).toEqual({
        level: 'degraded',
        reasons: ['1 request to unknown API routes (GET /api/coach/messages)'],
      });
    });

    it('needs no request volume: fires on a quiet deployment too', () => {
      expect(computeVerdict(input({ requests: 3, ...unknown(3, 1) })).reasons).toEqual([
        '3 requests to unknown API routes (GET /api/coach/messages)',
      ]);
    });

    it.each([
      [19, 1, 'degraded'],
      [20, 1, 'critical'],
      [5, 2, 'degraded'],
      [3, 3, 'critical'],
    ])('%d bearer requests over %d routes → %s', (requests, routes, level) => {
      expect(computeVerdict(input(unknown(requests, routes))).level).toBe(level);
    });

    it('says how many routes when there are several', () => {
      expect(computeVerdict(input(unknown(12, 3))).reasons).toEqual([
        '12 requests to unknown API routes across 3 routes (GET /api/coach/messages)',
      ]);
    });

    it('cuts a long route to the offender length', () => {
      const reason = computeVerdict(input(unknown(1, 1, `GET /api/${'x'.repeat(200)}`))).reasons[0];
      expect(reason.length).toBeLessThan(140);
      expect(reason).toMatch(/…\)$/);
    });

    it('is overridden by no_data', () => {
      expect(computeVerdict(input({ lastDataAt: null, ...unknown(50, 5) })).level).toBe('no_data');
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

  // ---- infrastructure rules (#126) ----

  describe('infrastructure rules', () => {
    it('skip every rule whose input is absent or null', () => {
      expect(
        computeVerdict(
          input({
            disk: null,
            memory: null,
            dbConnections: null,
            oldestPendingJob: null,
            nodes: null,
            tls: null,
            uptimeFailures: null,
            collector: null,
            backupAgeHours: null,
          }),
        ),
      ).toEqual({ level: 'healthy', reasons: [] });
    });

    it('are overridden by no data, like every rule', () => {
      expect(
        computeVerdict(input({ lastDataAt: null, disk: { utilizationPct: 99, mountpoint: '/' } })).level,
      ).toBe('no_data');
    });

    describe('disk', () => {
      it.each([
        [84.9, 'healthy'],
        [85, 'degraded'],
        [94.9, 'degraded'],
        [95, 'critical'],
      ])('%d%% → %s', (utilizationPct, level) => {
        expect(computeVerdict(input({ disk: { utilizationPct, mountpoint: '/' } })).level).toBe(level);
      });

      it('names the mountpoint', () => {
        expect(computeVerdict(input({ disk: { utilizationPct: 96.24, mountpoint: '/var/lib/data' } })).reasons).toEqual([
          'Disk 96.2% full (≥ 95%) — mountpoint: /var/lib/data',
        ]);
      });
    });

    describe('memory', () => {
      it.each([
        [89.9, 'healthy'],
        [90, 'degraded'],
        [97, 'critical'],
      ])('%d%% → %s', (utilizationPct, level) => {
        expect(computeVerdict(input({ memory: { utilizationPct, host: 'vm1' } })).level).toBe(level);
      });

      it('names the host', () => {
        expect(computeVerdict(input({ memory: { utilizationPct: 91, host: 'vm1' } })).reasons).toEqual([
          'Memory 91% used (≥ 90%) — host: vm1',
        ]);
      });
    });

    describe('database connections', () => {
      it.each([
        [79.9, 'healthy'],
        [80, 'degraded'],
        [95, 'critical'],
      ])('%d%% of max → %s', (utilizationPct, level) => {
        expect(computeVerdict(input({ dbConnections: { utilizationPct, instance: 'db:5432' } })).level).toBe(level);
      });

      it('names the server', () => {
        expect(computeVerdict(input({ dbConnections: { utilizationPct: 81, instance: 'db:5432' } })).reasons).toEqual([
          'Database connections at 81% of max (≥ 80%) — server: db:5432',
        ]);
      });
    });

    describe('oldest pending job', () => {
      it.each([
        [599, 'healthy'],
        [600, 'degraded'],
        [1799, 'degraded'],
        [1800, 'critical'],
      ])('%d s → %s', (ageSeconds, level) => {
        expect(computeVerdict(input({ oldestPendingJob: { ageSeconds, jobType: 'export.csv' } })).level).toBe(level);
      });

      it('names the job type', () => {
        expect(computeVerdict(input({ oldestPendingJob: { ageSeconds: 900, jobType: 'export.csv' } })).reasons).toEqual([
          'Oldest pending job waiting 15 min (≥ 10 min) — type: export.csv',
        ]);
      });
    });

    describe('worker nodes', () => {
      it('is healthy with no stale node and every type served', () => {
        expect(computeVerdict(input({ nodes: { stale: 0, noEligibleNodeTypes: [] } })).level).toBe('healthy');
      });

      it('is degraded by a stale node', () => {
        expect(computeVerdict(input({ nodes: { stale: 2, noEligibleNodeTypes: [] } }))).toEqual({
          level: 'degraded',
          reasons: ['2 worker node(s) stale (missed heartbeats)'],
        });
      });

      it('is critical when a node-offered type has pending work and no eligible node, naming it', () => {
        expect(
          computeVerdict(input({ nodes: { stale: 0, noEligibleNodeTypes: ['report.pdf', 'export.csv'] } })),
        ).toEqual({
          level: 'critical',
          reasons: ['2 job type(s) have pending work and no eligible worker node — type: export.csv, report.pdf'],
        });
      });
    });

    describe('TLS certificate', () => {
      it.each([
        [14, 'healthy'],
        [13.9, 'degraded'],
        [7, 'degraded'],
        [6.9, 'critical'],
        [-1, 'critical'],
      ])('%d days left → %s', (daysLeft, level) => {
        expect(computeVerdict(input({ tls: { daysLeft, url: 'https://app.example.com/' } })).level).toBe(level);
      });

      it('names the URL, and says when it already expired', () => {
        expect(computeVerdict(input({ tls: { daysLeft: 10, url: 'https://app.example.com/' } })).reasons).toEqual([
          'TLS certificate expires in 10 days (< 14 days) — url: https://app.example.com/',
        ]);
        expect(computeVerdict(input({ tls: { daysLeft: -2.5, url: 'https://app.example.com/' } })).reasons).toEqual([
          'TLS certificate expired 2.5 days ago (< 7 days) — url: https://app.example.com/',
        ]);
      });
    });

    describe('uptime', () => {
      it('is healthy with no failing URL', () => {
        expect(computeVerdict(input({ uptimeFailures: [] })).level).toBe('healthy');
      });

      it('is degraded when only the latest check failed', () => {
        expect(
          computeVerdict(input({ uptimeFailures: [{ url: 'http://nginx/api/health/live', allFailed: false, checks: 20 }] })),
        ).toEqual({
          level: 'degraded',
          reasons: ['Uptime check failed on its latest run (1 URL(s)) — url: http://nginx/api/health/live'],
        });
      });

      it('is critical when every check in the lookback failed, naming a down URL', () => {
        expect(
          computeVerdict(
            input({
              uptimeFailures: [
                { url: 'http://a/', allFailed: false, checks: 20 },
                { url: 'http://b/', allFailed: true, checks: 20 },
              ],
            }),
          ),
        ).toEqual({
          level: 'critical',
          reasons: ['Uptime check failing for every check in the lookback (1 URL(s)) — url: http://b/'],
        });
      });

      it('needs at least two checks before "every check failed" is critical', () => {
        expect(
          computeVerdict(input({ uptimeFailures: [{ url: 'http://b/', allFailed: true, checks: 1 }] })).level,
        ).toBe('degraded');
      });

      it('cuts a long URL like any offender', () => {
        const url = `https://example.com/${'x'.repeat(200)}`;
        const [reason] = computeVerdict(input({ uptimeFailures: [{ url, allFailed: false, checks: 3 }] })).reasons;
        expect(reason.endsWith('…')).toBe(true);
        expect(reason.split('url: ')[1]).toHaveLength(80);
      });
    });

    describe('collector exports', () => {
      it('is healthy without failures', () => {
        expect(computeVerdict(input({ collector: { failed: 0, sent: 1000, exporter: null } })).level).toBe('healthy');
      });

      it('is degraded by any failed point, naming the exporter', () => {
        expect(computeVerdict(input({ collector: { failed: 5, sent: 995, exporter: 'otlphttp/greptime' } }))).toEqual({
          level: 'degraded',
          reasons: ['Collector failed to export 5 points (0.5% of attempted) — exporter: otlphttp/greptime'],
        });
      });

      it('is critical at 10 % of attempted points', () => {
        expect(computeVerdict(input({ collector: { failed: 10, sent: 90, exporter: 'otlphttp/greptime' } }))).toEqual({
          level: 'critical',
          reasons: ['Collector failed to export 10 points (10% of attempted, ≥ 10%) — exporter: otlphttp/greptime'],
        });
      });
    });

    describe('last backup', () => {
      it.each([
        [26, 'healthy'],
        [26.1, 'degraded'],
        [50, 'degraded'],
        [50.1, 'critical'],
      ])('%d h → %s', (backupAgeHours, level) => {
        expect(computeVerdict(input({ backupAgeHours })).level).toBe(level);
      });

      it('says how long ago', () => {
        expect(computeVerdict(input({ backupAgeHours: 30 })).reasons).toEqual(['Last successful backup 30 h ago (> 26 h)']);
      });
    });

    it('reports the worst level and one reason per fired rule', () => {
      const verdict = computeVerdict(
        input({
          disk: { utilizationPct: 90, mountpoint: '/' },
          backupAgeHours: 60,
          memory: { utilizationPct: 10, host: 'vm1' },
        }),
      );
      expect(verdict.level).toBe('critical');
      expect(verdict.reasons).toHaveLength(2);
    });
  });
});
