// =============================================================================
// NodeTelemetryRateLimiter + NodeSettlementLedger (issue #133)
// =============================================================================

import {
  NODE_SETTLEMENT_GRACE_MS,
  NODE_SETTLEMENT_LEDGER_MAX_ENTRIES,
  NodeSettlementLedger,
} from './node-settlement-ledger';
import {
  NODE_TELEMETRY_REQUESTS_PER_MINUTE,
  NODE_TELEMETRY_SPANS_PER_MINUTE,
  NodeTelemetryRateLimiter,
} from './node-telemetry-rate-limiter';

describe('NodeTelemetryRateLimiter', () => {
  let now: number;

  beforeEach(() => {
    now = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('allows up to the request budget, then refuses with a retry hint', () => {
    const limiter = new NodeTelemetryRateLimiter();

    for (let i = 0; i < NODE_TELEMETRY_REQUESTS_PER_MINUTE; i += 1) {
      expect(limiter.take('node-a', 1).allowed).toBe(true);
    }

    const refused = limiter.take('node-a', 1);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBeGreaterThan(0);
  });

  it('refuses a batch the span budget cannot cover, charging nothing', () => {
    const limiter = new NodeTelemetryRateLimiter();

    expect(limiter.take('node-a', NODE_TELEMETRY_SPANS_PER_MINUTE - 10).allowed).toBe(true);
    expect(limiter.take('node-a', 50).allowed).toBe(false);
    // Nothing was charged by the refusal: the 10 that remain still fit.
    expect(limiter.take('node-a', 10).allowed).toBe(true);
  });

  it('refills over time', () => {
    const limiter = new NodeTelemetryRateLimiter();
    for (let i = 0; i < NODE_TELEMETRY_REQUESTS_PER_MINUTE; i += 1) limiter.take('node-a', 1);
    expect(limiter.take('node-a', 1).allowed).toBe(false);

    now += 60_000;

    expect(limiter.take('node-a', 1).allowed).toBe(true);
  });

  it('keeps one node’s budget independent of another’s', () => {
    const limiter = new NodeTelemetryRateLimiter();
    for (let i = 0; i < NODE_TELEMETRY_REQUESTS_PER_MINUTE; i += 1) limiter.take('node-a', 1);

    expect(limiter.take('node-a', 1).allowed).toBe(false);
    expect(limiter.take('node-b', 1).allowed).toBe(true);
  });
});

describe('NodeSettlementLedger', () => {
  let now: number;

  beforeEach(() => {
    now = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('attributes a recent settle to the node that made it, and to no other', () => {
    const ledger = new NodeSettlementLedger();
    ledger.record('job-1', 'node-a');

    expect(ledger.settledRecentlyBy('job-1', 'node-a')).toBe(true);
    expect(ledger.settledRecentlyBy('job-1', 'node-b')).toBe(false);
    expect(ledger.settledRecentlyBy('job-2', 'node-a')).toBe(false);
  });

  it('forgets a settle once the grace window has passed', () => {
    const ledger = new NodeSettlementLedger();
    ledger.record('job-1', 'node-a');

    now += NODE_SETTLEMENT_GRACE_MS + 1;

    expect(ledger.settledRecentlyBy('job-1', 'node-a')).toBe(false);
    expect(ledger.size).toBe(0);
  });

  it('a later settle by another node replaces the earlier attribution', () => {
    const ledger = new NodeSettlementLedger();
    ledger.record('job-1', 'node-a');
    ledger.record('job-1', 'node-b');

    expect(ledger.settledRecentlyBy('job-1', 'node-a')).toBe(false);
    expect(ledger.settledRecentlyBy('job-1', 'node-b')).toBe(true);
  });

  it('is bounded, evicting the oldest settle first', () => {
    const ledger = new NodeSettlementLedger();
    for (let i = 0; i <= NODE_SETTLEMENT_LEDGER_MAX_ENTRIES; i += 1) {
      ledger.record(`job-${i}`, 'node-a');
    }

    expect(ledger.size).toBe(NODE_SETTLEMENT_LEDGER_MAX_ENTRIES);
    expect(ledger.settledRecentlyBy('job-0', 'node-a')).toBe(false);
    expect(ledger.settledRecentlyBy(`job-${NODE_SETTLEMENT_LEDGER_MAX_ENTRIES}`, 'node-a')).toBe(
      true
    );
  });
});
