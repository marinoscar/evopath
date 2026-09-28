/**
 * The dashboard's URL state and pure helpers (issue #578).
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DASHBOARD_STATE,
  bucketWindow,
  dashboardQuery,
  dashboardStateToParams,
  parseDashboardState,
  type DashboardState,
} from '../../../../components/telemetry/dashboard/dashboardState';
import { formatTileValue, tileChange } from '../../../../components/telemetry/dashboard/format';
import { severityKind } from '../../../../components/telemetry/dashboard/severity';

const parse = (query: string) => parseDashboardState(new URLSearchParams(query));

describe('dashboard URL state', () => {
  it('defaults an empty query and leaves defaults out of the URL', () => {
    expect(parse('')).toEqual(DEFAULT_DASHBOARD_STATE);
    expect(dashboardStateToParams(DEFAULT_DASHBOARD_STATE).toString()).toBe('');
  });

  it('round-trips every field', () => {
    const state: DashboardState = {
      range: '24h',
      from: '2026-09-27T10:00:00.000Z',
      to: '2026-09-27T10:30:00.000Z',
      service: 'api',
      instance: 'node-1',
      sev: ['error', 'info'],
      q: 'timeout',
      refresh: false,
    };
    expect(parseDashboardState(dashboardStateToParams(state))).toEqual(state);
  });

  it('replaces invalid values with defaults', () => {
    const state = parse('range=1y&from=2026-09-27T11:00:00Z&to=2026-09-27T10:00:00Z&sev=fatal&refresh=10');
    expect(state.range).toBe('1h');
    expect(state.from).toBeNull();
    expect(state.to).toBeNull();
    expect(state.sev).toEqual(['error', 'warn']);
    expect(state.refresh).toBe(true);
    expect(parse('from=2026-09-27T10:00:00Z').from).toBeNull();
    expect(parse(`q=${'x'.repeat(300)}`).q).toHaveLength(200);
    expect(parse('sev=info,error,info').sev).toEqual(['error', 'info']);
  });

  it('sends from/to instead of range while zoomed', () => {
    const zoomed = parse('range=6h&from=2026-09-27T10:00:00Z&to=2026-09-27T10:30:00Z&service=api');
    expect(dashboardQuery(zoomed)).toEqual({
      from: '2026-09-27T10:00:00.000Z',
      to: '2026-09-27T10:30:00.000Z',
      service: 'api',
    });
    expect(dashboardQuery(parse('range=6h'))).toEqual({ range: '6h' });
  });

  it('maps a bucket selection to a window, clamped to now', () => {
    const starts = ['2026-09-27T10:00:00.000Z', '2026-09-27T10:01:00.000Z', '2026-09-27T10:02:00.000Z'];
    const now = Date.parse('2026-09-27T10:02:30.000Z');
    expect(bucketWindow(starts, 60, 2, 0, now)).toEqual({ from: starts[0], to: '2026-09-27T10:02:30.000Z' });
    expect(bucketWindow(starts, 60, 1, 1, now)).toEqual({ from: starts[1], to: starts[2] });
    expect(bucketWindow([], 60, 0, 0, now)).toBeNull();
  });
});

describe('tile formatting', () => {
  it('colours the change by direction', () => {
    expect(tileChange(2, 1, 'up-is-bad')).toEqual({ pct: 100, trend: 'up', tone: 'bad' });
    expect(tileChange(1, 2, 'up-is-bad')).toEqual({ pct: -50, trend: 'down', tone: 'good' });
    expect(tileChange(12, 10, 'neutral').tone).toBe('neutral');
    expect(tileChange(null, 10, 'up-is-bad').pct).toBeNull();
    expect(tileChange('7', '7', 'up-is-bad')).toEqual({ pct: 0, trend: 'flat', tone: 'neutral' });
  });

  it('formats values by unit', () => {
    expect(formatTileValue(1500, 'ms')).toEqual({ value: '1.5', unit: 's' });
    expect(formatTileValue('42', 'count')).toEqual({ value: '42', unit: '' });
    expect(formatTileValue(null, '%')).toEqual({ value: '—', unit: '' });
    expect(formatTileValue(134217728, 'bytes')).toEqual({ value: '128', unit: 'MB' });
  });

  it('bands severity text', () => {
    expect(severityKind('ERROR')).toBe('error');
    expect(severityKind('fatal')).toBe('error');
    expect(severityKind('warning')).toBe('warn');
    expect(severityKind('info')).toBe('info');
    expect(severityKind('debug')).toBe('other');
  });
});
