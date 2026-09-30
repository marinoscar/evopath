import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MAX_VITALS_COUNTER,
  MAX_VITALS_CPU_PERCENT,
  MAX_VITALS_EVENT_LOOP_DELAY_MS,
  MAX_VITALS_MEMORY_BYTES,
  MAX_VITALS_SLOTS,
  MAX_VITALS_UPTIME_SECONDS,
  NodeVitalsProvider,
  clampInt,
  clampNumber,
  sanitizeVersion,
  type EngineVitalsInput,
  type VitalsSources,
} from './node-vitals.js';

// =============================================================================
// Heartbeat vitals  (issue #130)
// =============================================================================
//
// Every source is injected, so nothing here reads the real process except the
// one smoke test at the end. The two properties that matter most: a value is
// never sent outside the server's bounds (a single one fails the WHOLE
// heartbeat), and a source that throws costs its own field and nothing else.
// =============================================================================

/** The server's version pattern, copied from `nodeVitalsSchema`. */
const VERSION_PATTERN = /^[0-9A-Za-z .+\-_()~]+$/;

const input: EngineVitalsInput = {
  slotsUsed: 1,
  slotsTotal: 4,
  counters: { claims: 3, emptyPolls: 2, succeeded: 2, failed: 1 },
};

/** Fixed, deterministic sources. `cpu` and `clock` are mutable by the test. */
function fakeSources(overrides: Partial<VitalsSources> = {}): {
  sources: VitalsSources;
  state: { cpuUs: number; clockMs: number };
} {
  const state = { cpuUs: 0, clockMs: 1_000 };
  const sources: VitalsSources = {
    monotonicMs: () => state.clockMs,
    cpuUsage: () => ({ user: state.cpuUs, system: 0 }),
    memoryUsage: () => ({ rss: 200_000_000, heapUsed: 50_000_000 }),
    heapLimit: () => 4_000_000_000,
    eventLoopDelayP99Ns: () => 12_500_000,
    statfs: () => ({ bavail: 1_000, blocks: 4_000, bsize: 4_096 }),
    uptimeSeconds: () => 3_600,
    ...overrides,
  };
  return { sources, state };
}

function provider(overrides: Partial<VitalsSources> = {}, extra: Partial<ConstructorParameters<typeof NodeVitalsProvider>[0]> = {}) {
  const { sources, state } = fakeSources(overrides);
  const vitals = new NodeVitalsProvider({
    stateDir: '/var/lib/worker',
    cliVersion: '1.2.3',
    nodeVersion: '24.3.0',
    sources,
    ...extra,
  });
  return { vitals, state };
}

describe('clamping helpers', () => {
  it('drops non-finite and negative numbers and clamps past the ceiling', () => {
    expect(clampNumber(5, 10)).toBe(5);
    expect(clampNumber(50, 10)).toBe(10);
    expect(clampNumber(-1, 10)).toBeUndefined();
    expect(clampNumber(Number.NaN, 10)).toBeUndefined();
    expect(clampNumber(Number.POSITIVE_INFINITY, 10)).toBeUndefined();
    expect(clampNumber('5', 10)).toBeUndefined();
    expect(clampNumber(undefined, 10)).toBeUndefined();
  });

  it('rounds integers and never rounds past the ceiling', () => {
    expect(clampInt(4.6, 10)).toBe(5);
    expect(clampInt(9.9, 9.5)).toBe(9);
    expect(clampInt(2 ** 60, MAX_VITALS_MEMORY_BYTES)).toBe(MAX_VITALS_MEMORY_BYTES);
  });

  it('reduces a version banner to the server’s character class and length', () => {
    expect(sanitizeVersion('pg_dump (PostgreSQL) 16.4')).toBe('pg_dump (PostgreSQL) 16.4');
    expect(sanitizeVersion('v24.3.0\n')).toBe('v24.3.0');
    expect(sanitizeVersion('1.0.0-beta+build.5 "quoted" <x>')).toBe('1.0.0-beta+build.5 quoted x');
    expect(sanitizeVersion('   ')).toBeUndefined();
    expect(sanitizeVersion('!!!')).toBeUndefined();
    expect(sanitizeVersion(42)).toBeUndefined();

    const long = sanitizeVersion('1'.repeat(200));
    expect(long).toHaveLength(64);
    expect(long).toMatch(VERSION_PATTERN);
  });
});

describe('NodeVitalsProvider', () => {
  it('reports every field from its sources, in the server’s units', () => {
    const { vitals, state } = provider({}, { watchdogState: () => ({ fired: false }), pgDumpVersion: 'pg_dump (PostgreSQL) 16.4' });

    // 500 ms of CPU across 1 000 ms of wall time → 50%.
    state.cpuUs += 500_000;
    state.clockMs += 1_000;

    expect(vitals.collect(input)).toEqual({
      cpuPercent: 50,
      rssBytes: 200_000_000,
      heapUsedBytes: 50_000_000,
      heapLimitBytes: 4_000_000_000,
      eventLoopDelayP99Ms: 12.5,
      stateDirFreeBytes: 1_000 * 4_096,
      stateDirTotalBytes: 4_000 * 4_096,
      slotsUsed: 1,
      slotsTotal: 4,
      uptimeSeconds: 3_600,
      counters: { claims: 3, emptyPolls: 2, succeeded: 2, failed: 1, watchdogTrips: 0 },
      cliVersion: '1.2.3',
      nodeVersion: '24.3.0',
      pgDumpVersion: 'pg_dump (PostgreSQL) 16.4',
    });
  });

  it('measures CPU over the interval since the LAST sample, not since start', () => {
    const { vitals, state } = provider();

    state.cpuUs += 2_000_000; // 2 s of CPU over 1 s: two cores busy
    state.clockMs += 1_000;
    expect(vitals.collect(input).cpuPercent).toBe(200);

    state.cpuUs += 100_000;
    state.clockMs += 1_000;
    expect(vitals.collect(input).cpuPercent).toBe(10);
  });

  it('omits CPU when no wall time has passed, rather than dividing by zero', () => {
    const { vitals } = provider();
    expect(vitals.collect(input)).not.toHaveProperty('cpuPercent');
  });

  it('clamps every value to the server’s ceiling', () => {
    const { vitals, state } = provider({
      memoryUsage: () => ({ rss: 2 ** 60, heapUsed: 2 ** 60 }),
      heapLimit: () => 2 ** 60,
      eventLoopDelayP99Ns: () => 1e20,
      uptimeSeconds: () => 1e12,
      statfs: () => ({ bavail: 2 ** 60, blocks: 2 ** 60, bsize: 2 ** 20 }),
    });
    state.cpuUs += 1e12;
    state.clockMs += 1;

    const snapshot = vitals.collect({
      slotsUsed: 500,
      slotsTotal: 500,
      counters: { claims: 1e15, emptyPolls: 3.7 },
    });

    expect(snapshot.cpuPercent).toBe(MAX_VITALS_CPU_PERCENT);
    expect(snapshot.rssBytes).toBe(MAX_VITALS_MEMORY_BYTES);
    expect(snapshot.heapUsedBytes).toBe(MAX_VITALS_MEMORY_BYTES);
    expect(snapshot.heapLimitBytes).toBe(MAX_VITALS_MEMORY_BYTES);
    expect(snapshot.eventLoopDelayP99Ms).toBe(MAX_VITALS_EVENT_LOOP_DELAY_MS);
    expect(snapshot.uptimeSeconds).toBe(MAX_VITALS_UPTIME_SECONDS);
    expect(snapshot.stateDirFreeBytes).toBe(2 ** 64);
    expect(snapshot.stateDirTotalBytes).toBe(2 ** 64);
    expect(snapshot.slotsUsed).toBe(MAX_VITALS_SLOTS);
    expect(snapshot.slotsTotal).toBe(MAX_VITALS_SLOTS);
    expect(snapshot.counters).toEqual({ claims: MAX_VITALS_COUNTER, emptyPolls: 4 });
  });

  it('omits a field whose source throws — and only that field', () => {
    const boom = (): never => {
      throw new Error('boom');
    };
    const { vitals } = provider({
      memoryUsage: boom,
      heapLimit: boom,
      eventLoopDelayP99Ns: boom,
      statfs: boom,
      uptimeSeconds: boom,
    });

    const snapshot = vitals.collect(input);
    for (const key of ['rssBytes', 'heapUsedBytes', 'heapLimitBytes', 'eventLoopDelayP99Ms', 'stateDirFreeBytes', 'stateDirTotalBytes', 'uptimeSeconds']) {
      expect(snapshot).not.toHaveProperty(key);
    }
    expect(snapshot.slotsTotal).toBe(4);
    expect(snapshot.cliVersion).toBe('1.2.3');
  });

  it('survives a throwing CPU source, even in the constructor', () => {
    const { vitals } = provider({
      cpuUsage: () => {
        throw new Error('no cpu');
      },
    });
    const snapshot = vitals.collect(input);
    expect(snapshot).not.toHaveProperty('cpuPercent');
    expect(snapshot.rssBytes).toBe(200_000_000);
  });

  it('omits the event-loop delay when the window had no samples', () => {
    const { vitals } = provider({ eventLoopDelayP99Ns: () => undefined });
    expect(vitals.collect(input)).not.toHaveProperty('eventLoopDelayP99Ms');
  });

  it('reads the state dir’s nearest existing ancestor before it exists', () => {
    const asked: string[] = [];
    const { vitals } = provider({
      statfs: (path) => {
        asked.push(path);
        if (path !== '/var') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return { bavail: 10, blocks: 20, bsize: 1 };
      },
    });

    const snapshot = vitals.collect(input);
    expect(asked).toEqual(['/var/lib/worker', '/var/lib', '/var']);
    expect(snapshot.stateDirFreeBytes).toBe(10);
    expect(snapshot.stateDirTotalBytes).toBe(20);
  });

  it('reports watchdogTrips only when there is a watchdog, and 1 once it fired', () => {
    expect(provider().vitals.collect(input).counters).not.toHaveProperty('watchdogTrips');
    expect(provider({}, { watchdogState: () => undefined }).vitals.collect(input).counters).not.toHaveProperty('watchdogTrips');
    expect(provider({}, { watchdogState: () => ({ fired: true }) }).vitals.collect(input).counters?.watchdogTrips).toBe(1);

    const throwing = provider({}, {
      watchdogState: () => {
        throw new Error('nope');
      },
    });
    expect(throwing.vitals.collect(input).counters).toEqual(input.counters);
  });

  it('sanitizes the version strings, and omits one with nothing left', () => {
    const { vitals } = provider({}, { cliVersion: '1.0.0\u0000<script>', nodeVersion: '???' });
    const snapshot = vitals.collect(input);
    expect(snapshot.cliVersion).toBe('1.0.0script');
    expect(snapshot).not.toHaveProperty('nodeVersion');
    expect(snapshot).not.toHaveProperty('pgDumpVersion');
  });

  it('omits counters entirely when there are none to report', () => {
    const { vitals } = provider();
    expect(vitals.collect({ slotsUsed: 0, slotsTotal: 1, counters: {} })).not.toHaveProperty('counters');
  });

  it('collects real readings from this process, all within bounds', () => {
    const vitals = new NodeVitalsProvider({ stateDir: join(tmpdir(), 'does-not-exist-yet', 'node') });
    try {
      const snapshot = vitals.collect(input);
      expect(snapshot.rssBytes).toBeGreaterThan(0);
      expect(snapshot.heapLimitBytes).toBeGreaterThan(0);
      expect(snapshot.stateDirTotalBytes).toBeGreaterThan(0);
      expect(snapshot.uptimeSeconds).toBeGreaterThanOrEqual(0);
      expect(snapshot.nodeVersion).toBe(process.versions.node);
      expect(snapshot.cliVersion).toMatch(VERSION_PATTERN);
    } finally {
      vitals.stop();
      vitals.stop(); // idempotent
    }
  });
});
