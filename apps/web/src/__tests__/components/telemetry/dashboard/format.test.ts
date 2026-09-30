/**
 * Unit-aware formatting for the `/metrics` tiles and tables (issue #127):
 * every unit the API may send, `null` as "—".
 */
import { describe, expect, it } from 'vitest';
import {
  formatMetricValue,
  formatSeconds,
  formatTileValue,
  tileDirection,
} from '../../../../components/telemetry/dashboard/format';

describe('metric unit formatting', () => {
  it.each([
    [35.64, '%', '35.64%'],
    [1536, 'bytes', '1.5 KB'],
    [2 * 1024 ** 2, 'bytes/s', '2 MB/s'],
    [42.4, 'count', '42'],
    [12.345, 'per_s', '12.35/s'],
    [3, 'per_min', '3/min'],
    [1500, 'ms', '1.5 s'],
    [42, 'seconds', '42 s'],
    [900, 'seconds', '15 min'],
    [5400, 'seconds', '1.5 h'],
    [30, 'hours', '30 h'],
    [72, 'hours', '3 d'],
    [12, 'days', '12 days'],
    [1, 'days', '1 day'],
    [-2, 'days', '-2 days'],
    [0.35, 'cores', '0.35 cores'],
    [0.82, 'load', '0.82'],
    ['200', 'text', '200'],
    [true, 'boolean', 'Yes'],
    [false, 'boolean', 'No'],
    [1, 'boolean', 'Yes'],
  ] as const)('%s %s → %s', (value, unit, expected) => {
    expect(formatMetricValue(value, unit)).toBe(expected);
  });

  it('reads null, undefined and an unparsable number as "—"', () => {
    expect(formatMetricValue(null, '%')).toBe('—');
    expect(formatMetricValue(undefined, 'bytes')).toBe('—');
    expect(formatMetricValue('', 'text')).toBe('—');
    expect(formatMetricValue('abc', 'count')).toBe('—');
  });

  it('formats a timestamp as a relative time', () => {
    const now = Date.parse('2026-09-27T11:00:00.000Z');
    expect(formatMetricValue('2026-09-27T10:58:00.000Z', 'timestamp', now)).toBe('2m ago');
  });

  it('splits a tile value from its unit and keeps the summary units unchanged', () => {
    expect(formatTileValue(900, 'seconds')).toEqual({ value: '15', unit: 'min' });
    expect(formatTileValue(12.5, 'req/min')).toEqual({ value: '12.5', unit: 'req/min' });
    expect(formatSeconds(0.25)).toBe('250 ms');
    expect(formatSeconds(3 * 86_400)).toBe('3 d');
  });

  it('knows which direction is bad for the metric tiles', () => {
    expect(tileDirection('cpuUtilization')).toBe('up-is-bad');
    expect(tileDirection('dbCacheHitRatio')).toBe('down-is-bad');
    expect(tileDirection('nodesByHealth.healthy')).toBe('down-is-bad');
    expect(tileDirection('tlsDaysLeft')).toBe('down-is-bad');
    expect(tileDirection('dbCommits')).toBe('neutral');
  });
});
