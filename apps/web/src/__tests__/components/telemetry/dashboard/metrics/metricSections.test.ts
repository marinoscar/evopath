/**
 * The section metadata (issue #127): order, anchors, and which verdict reason
 * (the API's wording, `telemetry-dashboard.verdict.ts`) belongs to which
 * section.
 */
import { describe, expect, it } from 'vitest';
import {
  METRIC_SECTIONS,
  metricSectionAnchor,
  verdictReasonGroup,
} from '../../../../../components/telemetry/dashboard/metrics/metricSections';

describe('metric sections', () => {
  it('lists the six groups in page order', () => {
    expect(METRIC_SECTIONS.map((section) => section.group)).toEqual(['host', 'database', 'queue', 'nodes', 'uptime', 'pipeline']);
    expect(metricSectionAnchor('database')).toBe('telemetry-section-database');
  });

  it.each([
    ['Disk 91.2% full (≥ 85%) — mountpoint: /', 'host'],
    ['Memory 97.5% used (≥ 97%) — host: vps-1', 'host'],
    ['Database connections at 82% of max (≥ 80%) — server: db:5432', 'database'],
    ['Oldest pending job waiting 12 min (≥ 10 min) — job type: export.csv', 'queue'],
    ['Last successful backup 30 h ago (> 26 h)', 'queue'],
    ['2 job type(s) have pending work and no eligible worker node — types: a, b', 'nodes'],
    ['1 worker node(s) stale (missed heartbeats)', 'nodes'],
    ['TLS certificate expires in 12 days (< 14 days) — url: https://app.example.com/', 'uptime'],
    ['TLS certificate expired 2 days ago (< 7 days) — url: https://app.example.com/', 'uptime'],
    ['Uptime check failed on its latest run (1 URL(s)) — url: https://app.example.com/', 'uptime'],
    ['Uptime check failing for every check in the lookback (1 URL(s)) — url: http://nginx/', 'uptime'],
    ['Collector failed to export 12 points (3% of attempted) — exporter: otlphttp', 'pipeline'],
  ])('%s → %s', (reason, group) => {
    expect(verdictReasonGroup(reason)).toBe(group);
  });

  it.each([
    '5xx rate 3.2% (> 2%) — top: GET /api/users/:id',
    'p95 latency 1400 ms (> 1000 ms)',
    'Error logs 40 vs 4 in the previous window (10× ≥ 10×)',
    'No telemetry received for 7 min',
  ])('leaves the traffic and no-data reasons unlinked: %s', (reason) => {
    expect(verdictReasonGroup(reason)).toBeNull();
  });
});
