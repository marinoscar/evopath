import type { TelemetryQueryResult } from '../greptime/greptime.client';
import { VERDICT_FRESH_MS, verdictInputsFrom } from './metric-verdict';

// =============================================================================
// Verdict probe parsing (issue #126)
// =============================================================================
//
// The probe statements themselves are snapshotted in metric-sql.spec.ts; here
// the rows they return become the verdict's infrastructure inputs.
// =============================================================================

const NOW = new Date('2026-09-27T22:00:00.000Z');
const FRESH = '2026-09-27 21:59:30.000000';
const STALE = '2026-09-27 21:50:00.000000';

function result(names: string[], rows: unknown[][]): TelemetryQueryResult {
  return { fields: names.map((name) => ({ name, dataTypeID: 25 })), rows };
}
const latest = (rows: Array<[string, string, number | string, string | null]>) =>
  result(['m', 'k', 'v', 'at'], rows);

describe('verdictInputsFrom', () => {
  it('leaves every input undefined when no probe ran', () => {
    expect(verdictInputsFrom({}, NOW)).toEqual({});
  });

  it('picks the worst fresh mountpoint and host', () => {
    const input = verdictInputsFrom(
      {
        host: latest([
          ['disk', '/', 0.5, FRESH],
          ['disk', '/data', 0.91, FRESH],
          ['disk', '/old', 0.99, STALE], // unmounted since: not current
          ['memory', 'vm1', 0.42, FRESH],
        ]),
      },
      NOW
    );
    expect(input.disk).toEqual({ utilizationPct: 91, mountpoint: '/data' });
    expect(input.memory).toEqual({ utilizationPct: 42, host: 'vm1' });
    expect(VERDICT_FRESH_MS).toBe(150_000);
  });

  it('divides backends by max_connections per server and keeps the worst', () => {
    const input = verdictInputsFrom(
      {
        database: latest([
          ['backends', 'db:5432', '85', FRESH],
          ['max', 'db:5432', '100', FRESH],
          ['backends', 'other:5432', '10', FRESH], // no max known: skipped
        ]),
      },
      NOW
    );
    expect(input.dbConnections).toEqual({ utilizationPct: 85, instance: 'db:5432' });
  });

  it('reads the oldest pending job and the backup age', () => {
    const lastBackup = NOW.getTime() / 1000 - 27 * 3600;
    const input = verdictInputsFrom(
      {
        queue: latest([
          ['oldest', 'export.csv', 900, FRESH],
          ['oldest', 'report.pdf', 5000, STALE], // drained (delta gauge stopped)
          ['backup', '', lastBackup, FRESH],
        ]),
      },
      NOW
    );
    expect(input.oldestPendingJob).toEqual({ ageSeconds: 900, jobType: 'export.csv' });
    expect(input.backupAgeHours).toBeCloseTo(27);
  });

  it('counts stale nodes and lists types without an eligible node', () => {
    const input = verdictInputsFrom(
      {
        nodes: latest([
          ['health', 'healthy', 3, FRESH],
          ['health', 'stale', 2, FRESH],
          ['noEligible', 'export.csv', 1, FRESH],
          ['noEligible', 'report.pdf', 0, FRESH],
        ]),
      },
      NOW
    );
    expect(input.nodes).toEqual({ stale: 2, noEligibleNodeTypes: ['export.csv'] });
  });

  it('lists fresh failing uptime targets, and an empty list when all pass', () => {
    const status = (rows: unknown[][]) =>
      result(['k', 'last_at', 'last_ok_at', 'checks', 'ok_checks', 'ok_now', 'code'], rows);
    expect(
      verdictInputsFrom(
        {
          uptime: status([
            ['http://a/', FRESH, FRESH, '20', '20', '1', '200'],
            ['http://b/', FRESH, null, '20', '0', '0', '503'],
            ['http://c/', FRESH, FRESH, '20', '19', '0', null],
            ['http://gone/', STALE, null, '2', '0', '0', null], // no longer probed
          ]),
        },
        NOW
      ).uptimeFailures
    ).toEqual([
      { url: 'http://b/', checks: 20, allFailed: true },
      { url: 'http://c/', checks: 20, allFailed: false },
    ]);
    expect(
      verdictInputsFrom(
        { uptime: status([['http://a/', FRESH, FRESH, '20', '20', '1', '200']]) },
        NOW
      ).uptimeFailures
    ).toEqual([]);
    expect(verdictInputsFrom({ uptime: status([]) }, NOW).uptimeFailures).toBeUndefined();
  });

  it('reads the soonest certificate expiry in days', () => {
    const input = verdictInputsFrom(
      {
        tls: latest([
          ['tls', 'https://a/', 30 * 86_400, FRESH],
          ['tls', 'https://b/', 5 * 86_400, FRESH],
        ]),
      },
      NOW
    );
    expect(input.tls).toEqual({ daysLeft: 5, url: 'https://b/' });
  });

  it('sums exporter failures and names the worst exporter', () => {
    const input = verdictInputsFrom(
      {
        pipeline: latest([
          ['failed', 'otlphttp/greptime', 12, STALE], // counters are not freshness-filtered
          ['failed', 'otlphttp/other', 0, FRESH],
          ['sent', 'otlphttp/greptime', 988, FRESH],
        ]),
      },
      NOW
    );
    expect(input.collector).toEqual({ failed: 12, sent: 988, exporter: 'otlphttp/greptime' });
  });

  it('names no exporter when nothing failed', () => {
    const input = verdictInputsFrom(
      { pipeline: latest([['sent', 'otlphttp/greptime', 10, FRESH]]) },
      NOW
    );
    expect(input.collector).toEqual({ failed: 0, sent: 10, exporter: null });
  });
});
