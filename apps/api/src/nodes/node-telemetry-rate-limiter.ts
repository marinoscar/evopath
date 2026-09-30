// =============================================================================
// Per-node rate limit for the span relay (issue #133)
// =============================================================================
//
// Two token buckets per node — one for REQUESTS, one for SPANS — because the
// two costs are different: a request costs a database lookup, a span costs a
// trip through the exporter. A node that batches well stays under both; a
// node in a hot loop (a bug, or a stolen credential used as a firehose) hits
// one of them and is answered 429 until it refills.
//
// IN MEMORY, PER REPLICA, ON PURPOSE. This repository has no shared
// rate-limit store (no Redis), and a relay for best-effort spans does not
// justify one. With N replicas a node can reach N times the budget, which
// bounds the damage at a known multiple; the budget exists to stop a runaway,
// not to meter a customer.
//
// KEYED BY THE PATH NODE ID *AFTER* OWNERSHIP IS PROVEN (the service asks
// only then), so a caller cannot drain another owner's node's budget, and the
// key space is bounded by the number of registered nodes. `MAX_BUCKETS` is a
// second bound regardless: past it, full (idle) buckets are forgotten first,
// which loses nothing because a fresh bucket starts full.
//
// REJECTED: a partial accept when the span budget covers only part of a
// batch. The CLI drops a batch on 429 anyway, and "some of these were
// accepted" is a second response shape for a node to get wrong.
// =============================================================================

import { Injectable } from '@nestjs/common';

/** Requests per node per minute. A node sends about one batch per settled job. */
export const NODE_TELEMETRY_REQUESTS_PER_MINUTE = 60;

/** Spans per node per minute. */
export const NODE_TELEMETRY_SPANS_PER_MINUTE = 1000;

/** Cap on tracked nodes, independent of the fleet's size. */
const MAX_BUCKETS = 10_000;

interface Bucket {
  requests: number;
  spans: number;
  updatedAtMs: number;
}

/** What a refused request is told: when it is worth trying again. */
export interface NodeTelemetryRateLimitVerdict {
  allowed: boolean;
  /** Milliseconds until the refused request would fit; 0 when allowed. */
  retryAfterMs: number;
}

@Injectable()
export class NodeTelemetryRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  /**
   * Charges one request and `spanCount` spans against `nodeId`'s buckets, or
   * charges nothing and refuses. Never throws.
   */
  take(nodeId: string, spanCount: number): NodeTelemetryRateLimitVerdict {
    const now = Date.now();
    const bucket = this.refill(nodeId, now);

    if (bucket.requests >= 1 && bucket.spans >= spanCount) {
      bucket.requests -= 1;
      bucket.spans -= spanCount;
      return { allowed: true, retryAfterMs: 0 };
    }

    const requestWaitMs =
      bucket.requests >= 1
        ? 0
        : ((1 - bucket.requests) * 60_000) / NODE_TELEMETRY_REQUESTS_PER_MINUTE;
    const spanWaitMs =
      bucket.spans >= spanCount
        ? 0
        : ((spanCount - bucket.spans) * 60_000) / NODE_TELEMETRY_SPANS_PER_MINUTE;

    return { allowed: false, retryAfterMs: Math.ceil(Math.max(requestWaitMs, spanWaitMs)) };
  }

  private refill(nodeId: string, now: number): Bucket {
    let bucket = this.buckets.get(nodeId);

    if (!bucket) {
      if (this.buckets.size >= MAX_BUCKETS) this.evictIdle(now);
      bucket = {
        requests: NODE_TELEMETRY_REQUESTS_PER_MINUTE,
        spans: NODE_TELEMETRY_SPANS_PER_MINUTE,
        updatedAtMs: now,
      };
      this.buckets.set(nodeId, bucket);
      return bucket;
    }

    const elapsedMinutes = Math.max(0, now - bucket.updatedAtMs) / 60_000;
    bucket.requests = Math.min(
      NODE_TELEMETRY_REQUESTS_PER_MINUTE,
      bucket.requests + elapsedMinutes * NODE_TELEMETRY_REQUESTS_PER_MINUTE
    );
    bucket.spans = Math.min(
      NODE_TELEMETRY_SPANS_PER_MINUTE,
      bucket.spans + elapsedMinutes * NODE_TELEMETRY_SPANS_PER_MINUTE
    );
    bucket.updatedAtMs = now;

    return bucket;
  }

  /**
   * Forgets every bucket that would be full by now (a fresh one is identical),
   * and, if that frees nothing, the oldest one.
   */
  private evictIdle(now: number): void {
    for (const [nodeId, bucket] of this.buckets) {
      if (now - bucket.updatedAtMs >= 60_000) this.buckets.delete(nodeId);
    }

    if (this.buckets.size >= MAX_BUCKETS) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
  }
}
