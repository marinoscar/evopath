// =============================================================================
// Which node recently settled which job — the span relay's grace window (#133)
// =============================================================================
//
// THE PROBLEM. A node relays its phase spans AFTER the job settles (the
// `job.submit` span cannot end before the submission does), and settling
// clears `jobs.claimed_by_node_id` in the same statement that ends the claim.
// So by the time the spans arrive, the row no longer says who ran it — and
// `executor = 'node'` says only THAT a node ran it, not WHICH. Accepting a
// span on "some node of this owner ran this job" would let one node attribute
// spans to another's work, under its own `node.id`.
//
// THE ANSWER, and why it is the simplest correct one: `NodesService` records
// `jobId → nodeId` HERE at the moment a node's result or failure settles the
// row — the one moment the server has just PROVEN (through
// `assertJobHeldByNode` and the claim-guarded settle) that this node held this
// job. The relay accepts a span when the row is held by the node now, or when
// this ledger says the node settled it within `GRACE_MS`.
//
// REJECTED: a durable `settled_by_node_id` column. It would survive restarts
// and replicas, and it is a migration plus a permanent column for a
// best-effort observability feature. The failure mode of this ledger is
// benign by construction: a span that lands on a different API replica than
// the settle did, or after a restart, is DROPPED (counted in the response),
// never mis-attributed. Losing a span is acceptable; accepting a foreign one
// is not.
//
// BOUNDED. `MAX_ENTRIES` caps memory whatever a fleet does; the Map is
// insertion-ordered, so eviction drops the oldest settle first, which is the
// one least likely to still be waiting for its spans.
// =============================================================================

import { Injectable } from '@nestjs/common';

/** How long after a settle the settling node may still relay spans for it. */
export const NODE_SETTLEMENT_GRACE_MS = 10 * 60 * 1000;

/** Cap on remembered settles. At this size the oldest is evicted first. */
export const NODE_SETTLEMENT_LEDGER_MAX_ENTRIES = 10_000;

interface SettlementEntry {
  nodeId: string;
  settledAtMs: number;
}

@Injectable()
export class NodeSettlementLedger {
  private readonly entries = new Map<string, SettlementEntry>();

  /** Records that `nodeId` settled `jobId` just now. Never throws. */
  record(jobId: string, nodeId: string): void {
    // Delete first so a re-settle (a retried job run again by the same node)
    // moves to the young end of the insertion order.
    this.entries.delete(jobId);
    this.entries.set(jobId, { nodeId, settledAtMs: Date.now() });

    while (this.entries.size > NODE_SETTLEMENT_LEDGER_MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Whether `nodeId` settled `jobId` within the grace window. */
  settledRecentlyBy(jobId: string, nodeId: string): boolean {
    const entry = this.entries.get(jobId);
    if (!entry) return false;

    if (Date.now() - entry.settledAtMs > NODE_SETTLEMENT_GRACE_MS) {
      this.entries.delete(jobId);
      return false;
    }

    return entry.nodeId === nodeId;
  }

  /** Current size, for tests and nothing else. */
  get size(): number {
    return this.entries.size;
  }
}
