// =============================================================================
// Heartbeat vitals (#129): the wire contract a node's health snapshot must meet
// =============================================================================
//
// Vitals are self-reported by a machine this deployment may not own and are
// stored verbatim, so the schema is CLOSED (unknown keys refused at both
// levels) and every value BOUNDED. These cases pin both halves, plus the one
// compatibility promise that matters most: a heartbeat from a node that
// predates vitals still parses.
// =============================================================================

import { heartbeatNodeSchema, MAX_NODE_CONCURRENCY, nodeVitalsSchema } from './node-control-plane.dto';

/** A complete, realistic snapshot. */
const FULL_VITALS = {
  cpuPercent: 142.5,
  rssBytes: 180_000_000,
  heapUsedBytes: 60_000_000,
  heapLimitBytes: 4_345_298_944,
  eventLoopDelayP99Ms: 12.4,
  stateDirFreeBytes: 40_000_000_000,
  stateDirTotalBytes: 100_000_000_000,
  slotsUsed: 1,
  slotsTotal: 2,
  uptimeSeconds: 3600.5,
  counters: {
    claims: 10,
    emptyPolls: 500,
    claimFailures: 0,
    succeeded: 9,
    failed: 1,
    rateLimited: 0,
    leaseRenewals: 40,
    leaseRenewFailures: 0,
    heartbeatFailures: 2,
    watchdogTrips: 0,
  },
  cliVersion: '1.4.0',
  nodeVersion: 'v24.3.0',
  pgDumpVersion: 'pg_dump (PostgreSQL) 16.4',
};

describe('nodeVitalsSchema', () => {
  it('accepts a complete snapshot unchanged', () => {
    expect(nodeVitalsSchema.parse(FULL_VITALS)).toEqual(FULL_VITALS);
  });

  it('accepts an empty snapshot — every field is optional', () => {
    expect(nodeVitalsSchema.parse({})).toEqual({});
  });

  it('accepts a network filesystem that reports exabytes free', () => {
    // Some network filesystems report ~8 EiB. Refusing it would 400 the
    // whole heartbeat and let the node go stale over a disk figure.
    const eightEiB = 8 * 2 ** 60;

    expect(
      nodeVitalsSchema.safeParse({ stateDirFreeBytes: eightEiB, stateDirTotalBytes: eightEiB })
        .success
    ).toBe(true);
  });

  it.each([
    ['an unknown top-level key', { loadAverage: 1.2 }],
    ['an unknown counter', { counters: { bogus: 1 } }],
  ])('refuses %s', (_label, vitals) => {
    expect(nodeVitalsSchema.safeParse(vitals).success).toBe(false);
  });

  it.each([
    ['negative cpuPercent', { cpuPercent: -1 }],
    ['cpuPercent past 128 cores', { cpuPercent: 12_800.1 }],
    ['fractional rssBytes', { rssBytes: 1.5 }],
    ['rssBytes past 1 PiB', { rssBytes: 2 ** 50 + 1 }],
    ['negative heapUsedBytes', { heapUsedBytes: -1 }],
    ['an event-loop delay past an hour', { eventLoopDelayP99Ms: 3_600_001 }],
    ['negative stateDirFreeBytes', { stateDirFreeBytes: -1 }],
    ['stateDirTotalBytes past 2^64', { stateDirTotalBytes: 2 ** 65 }],
    ['slotsUsed past the concurrency ceiling', { slotsUsed: MAX_NODE_CONCURRENCY + 1 }],
    ['slotsTotal past the concurrency ceiling', { slotsTotal: MAX_NODE_CONCURRENCY + 1 }],
    ['fractional slotsUsed', { slotsUsed: 0.5 }],
    ['uptime past ten years', { uptimeSeconds: 10 * 365 * 24 * 3600 + 1 }],
    ['a negative counter', { counters: { claims: -1 } }],
    ['a fractional counter', { counters: { failed: 0.5 } }],
    ['a counter past 1e12', { counters: { emptyPolls: 1e12 + 1 } }],
    ['a numeric string', { rssBytes: '100' }],
    ['a version longer than 64 characters', { cliVersion: '1'.repeat(65) }],
    ['an empty version', { nodeVersion: '' }],
    ['a version that is not version-shaped', { pgDumpVersion: '<script>alert(1)</script>' }],
    ['a multi-line version', { cliVersion: '1.0.0\nINJECTED' }],
  ])('refuses %s', (_label, vitals) => {
    expect(nodeVitalsSchema.safeParse(vitals).success).toBe(false);
  });
});

describe('heartbeatNodeSchema', () => {
  it('still accepts a pre-vitals payload, leaving `vitals` absent', () => {
    const parsed = heartbeatNodeSchema.parse({ status: 'online', concurrency: 2 });

    expect(parsed).toEqual({ status: 'online', concurrency: 2 });
    expect(parsed).not.toHaveProperty('vitals');
  });

  it('accepts an empty heartbeat', () => {
    expect(heartbeatNodeSchema.parse({})).toEqual({});
  });

  it('carries a valid vitals snapshot through', () => {
    expect(heartbeatNodeSchema.parse({ vitals: FULL_VITALS }).vitals).toEqual(FULL_VITALS);
  });

  it('refuses the whole heartbeat when vitals carry an unknown key', () => {
    expect(heartbeatNodeSchema.safeParse({ vitals: { cpuPercent: 1, extra: true } }).success).toBe(
      false
    );
  });

  it('refuses the whole heartbeat when a vital is out of range', () => {
    expect(heartbeatNodeSchema.safeParse({ vitals: { slotsUsed: 1000 } }).success).toBe(false);
  });
});
