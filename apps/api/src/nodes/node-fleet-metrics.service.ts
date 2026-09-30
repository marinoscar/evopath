// =============================================================================
// Worker-node fleet gauges (issue #131, B3)
// =============================================================================
//
// The `app.nodes.*` observable gauges: how many nodes there are by status and
// derived health, each live node's last reported vitals, and which offered job
// types have work waiting but no healthy node able to take it.
//
// -----------------------------------------------------------------------------
// WHY A SIBLING OF `AppMetricsService`, NOT PART OF IT
// -----------------------------------------------------------------------------
//
// The callback needs `NodeOffloadService` (jobs module) and the fleet policy
// (`NodeLifecycleService`, settings module). `AppMetricsModule` is global and
// depends on nothing but Prisma and config; teaching it either service would
// make every module that records a metric transitively depend on the queue.
// So this provider lives in `NodesModule` (which already imports both) and
// borrows the conventions from `AppMetricsService.gaugeContext()`: the same
// `app` meter, the same clock, the same export gate, the same names table.
// Registration happens only when that context exists (`OTEL_ENABLED`), and the
// callback queries nothing while the gate is closed.
//
// -----------------------------------------------------------------------------
// ONE CACHED READ
// -----------------------------------------------------------------------------
//
// One `worker_nodes` `findMany`, one `groupBy(type)` over runnable pending jobs,
// the fleet policy and the offered-type list, in parallel — cached for
// `GAUGE_CACHE_TTL_MS` with one read in flight, exactly as the queue gauges.
//
// -----------------------------------------------------------------------------
// CARDINALITY
// -----------------------------------------------------------------------------
//
//   - `app.nodes.count`: status x health, at most 7 series (an `offline` row is
//     always `offline` health; every other status is `healthy` or `stale`).
//     All 7 are observed on every collection, zeros included, so a series drops
//     to 0 rather than disappearing.
//   - Per-node gauges: only nodes whose status is not `offline` and whose
//     vitals are fresh (`lastVitalsAt` within `VITALS_FRESHNESS_MULTIPLIER` x
//     the stale window), newest first, capped at `MAX_EXPORTED_NODES`. `node_id`
//     is the row's UUID (not free-form; anything not UUID-shaped is `other`) and
//     is bounded by that cap per collection rather than by the per-process
//     distinct budget, which would fold nodes into `other` as the fleet churns.
//     `node_name` is functionally dependent on `node_id`, so it adds no series;
//     it is operator-chosen, so it is sanitised (runs of disallowed characters
//     become `_`, truncated to 64) and shape-checked (`shapeLabel`: an
//     address-shaped name is `other`).
//   - `app.nodes.types.no_eligible_node`: one series per OFFERED type with
//     runnable pending work — a handful.
//
// A node (or type) that leaves the exported set DISAPPEARS from the next
// export rather than freezing at its last value: `GatedPushMetricExporter`
// selects delta temporality for gauges (see `telemetry-gate.ts`), without which
// the SDK would re-export every attribute set ever observed. The SDK still
// remembers each attribute set it has seen, up to its per-instrument
// cardinality limit (2000); a process that sees more distinct nodes than that
// over its lifetime folds the excess into `otel.metric.overflow`.
//
// -----------------------------------------------------------------------------
// UNITS (chosen for the verified GreptimeDB table rules, §11.13)
// -----------------------------------------------------------------------------
//
// Only `s`, `By` and curly-brace units are used, because only those map to a
// verified table name. CPU is exported in CORES (`{core}`: `cpuPercent / 100`,
// 1.5 = one and a half cores busy) rather than as `%` or ratio `1`, whose
// suffixes were never verified; the event-loop p99 is converted from ms to `s`.
//
// -----------------------------------------------------------------------------
// "NO ELIGIBLE NODE", NOT "STARVED"
// -----------------------------------------------------------------------------
//
// In the default `JOBS_WORKER_MODE=all` the in-process worker claims every
// registered type, offered ones included, so a 1 here does not mean the work
// will not run — it means no healthy, `online` node lists the type as
// eligible, and the server (if its worker is on) is the only claimer. Under
// `JOBS_WORKER_MODE=system` or `off` the server does NOT claim offered types
// (it runs their complement), so a 1 held for long is genuine starvation.
//
// Per-node lease reaps are NOT here: the reaper clears `claimed_by_node_id` in
// the same statement that recovers the row (and requeues in bulk), so the node
// is not known at the point it records `app.jobs.reaped`.
// =============================================================================

import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import type { BatchObservableResult, Meter, ObservableGauge } from '@opentelemetry/api';

import {
  APP_METRIC_NAMES,
  AppMetricsService,
  GAUGE_CACHE_TTL_MS,
  OTHER_LABEL,
  fallbackAppMetrics,
  shapeLabel,
  type AppGaugeContext,
} from '../common/otel/app-metrics.service';
import { NodeOffloadService } from '../jobs/node-offload.service';
import { PrismaService } from '../prisma/prisma.service';
import { deriveNodeHealth, NodeLifecycleService, type NodeHealth } from './node-lifecycle.service';

/** Vitals older than this many stale windows are not exported. */
export const VITALS_FRESHNESS_MULTIPLIER = 3;

/** At most this many nodes' vitals are exported per collection (newest vitals first). */
export const MAX_EXPORTED_NODES = 200;

const NODE_STATUSES = ['online', 'draining', 'offline', 'disabled'] as const;
const NODE_HEALTHS: readonly NodeHealth[] = ['healthy', 'stale', 'offline'];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DISALLOWED_LABEL_CHARS = /[^A-Za-z0-9_.:/@+-]+/g;
const MAX_NAME_LABEL_LENGTH = 64;

/** Node-reported cumulative counter key → the `counter` label value. */
export const NODE_COUNTER_LABELS: Readonly<Record<string, string>> = {
  claims: 'claims',
  emptyPolls: 'empty_polls',
  claimFailures: 'claim_failures',
  succeeded: 'succeeded',
  failed: 'failed',
  rateLimited: 'rate_limited',
  leaseRenewals: 'lease_renewals',
  leaseRenewFailures: 'lease_renew_failures',
  heartbeatFailures: 'heartbeat_failures',
  watchdogTrips: 'watchdog_trips',
};

/** The numeric vitals, already in the exported unit. */
export interface ExportedVitals {
  cpuUtilization?: number;
  memoryRssBytes?: number;
  heapUsedBytes?: number;
  heapLimitBytes?: number;
  eventLoopDelayP99Seconds?: number;
  stateDirFreeBytes?: number;
  stateDirTotalBytes?: number;
  slotsUsed?: number;
  slotsTotal?: number;
  uptimeSeconds?: number;
  counters: Array<{ counter: string; value: number }>;
}

export interface FleetSnapshot {
  counts: Array<{ status: string; health: NodeHealth; count: number }>;
  nodes: Array<{ nodeId: string; nodeName: string; vitals: ExportedVitals }>;
  /** `null` when the offered-type list could not be read. */
  noEligibleNode: Array<{ jobType: string; value: 0 | 1 }> | null;
}

type Gauges = Record<
  | 'count'
  | 'cpu'
  | 'rss'
  | 'heapUsed'
  | 'heapLimit'
  | 'eventLoop'
  | 'stateFree'
  | 'stateTotal'
  | 'slotsUsed'
  | 'slotsTotal'
  | 'uptime'
  | 'counter'
  | 'noEligibleNode',
  ObservableGauge
>;

/** Non-negative finite number, or `undefined`. */
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * A stored `last_vitals` document, read tolerantly field by field (it was
 * validated by `nodeVitalsSchema` on the way in, but a row written by an older
 * or newer API must never break a collection).
 */
export function exportedVitals(raw: unknown): ExportedVitals {
  const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const cpu = num(v.cpuPercent);
  const loop = num(v.eventLoopDelayP99Ms);

  const counters: ExportedVitals['counters'] = [];
  const c = v.counters && typeof v.counters === 'object' ? (v.counters as Record<string, unknown>) : {};
  for (const [key, label] of Object.entries(NODE_COUNTER_LABELS)) {
    const value = num(c[key]);
    if (value !== undefined) counters.push({ counter: label, value });
  }

  return {
    cpuUtilization: cpu === undefined ? undefined : cpu / 100,
    memoryRssBytes: num(v.rssBytes),
    heapUsedBytes: num(v.heapUsedBytes),
    heapLimitBytes: num(v.heapLimitBytes),
    eventLoopDelayP99Seconds: loop === undefined ? undefined : loop / 1000,
    stateDirFreeBytes: num(v.stateDirFreeBytes),
    stateDirTotalBytes: num(v.stateDirTotalBytes),
    slotsUsed: num(v.slotsUsed),
    slotsTotal: num(v.slotsTotal),
    uptimeSeconds: num(v.uptimeSeconds),
    counters,
  };
}

/** An operator-chosen node name as a label value (see the header). */
export function nodeNameLabel(name: unknown): string {
  if (typeof name !== 'string') return shapeLabel(name);
  const sanitised = name
    .trim()
    .replace(DISALLOWED_LABEL_CHARS, '_')
    .slice(0, MAX_NAME_LABEL_LENGTH);
  return shapeLabel(sanitised);
}

function nodeIdLabel(id: unknown): string {
  return typeof id === 'string' && UUID_PATTERN.test(id) ? id.toLowerCase() : OTHER_LABEL;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

@Injectable()
export class NodeFleetMetrics implements OnModuleInit {
  private readonly logger = new Logger(NodeFleetMetrics.name);
  private readonly metrics: AppMetricsService;

  private registered = false;
  private context: AppGaugeContext | null = null;
  private cache: { at: number; value: FleetSnapshot } | null = null;
  private inFlight: Promise<FleetSnapshot | null> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: NodeLifecycleService,
    private readonly offload: NodeOffloadService,
    @Optional() metrics?: AppMetricsService,
  ) {
    this.metrics = metrics ?? fallbackAppMetrics();
  }

  onModuleInit(): void {
    this.registerGauges();
  }

  /** Registers the fleet gauges once, only when `AppMetricsService` says gauges are on. */
  registerGauges(): void {
    if (this.registered) return;

    try {
      const context = this.metrics.gaugeContext();
      if (!context) return;
      this.context = context;

      const gauges = this.createGauges(context.meter);
      context.meter.addBatchObservableCallback(
        (result) => this.observe(result, gauges),
        Object.values(gauges),
      );
      this.registered = true;
    } catch (error) {
      this.logger.debug(`Could not register node fleet gauges: ${describe(error)}`);
    }
  }

  private createGauges(meter: Meter): Gauges {
    const N = APP_METRIC_NAMES;
    const g = (name: string, unit: string, description: string) =>
      meter.createObservableGauge(name, { unit, description });

    return {
      count: g(N.nodesCount, '{node}', 'Registered worker nodes, by status and derived health.'),
      cpu: g(N.nodesCpuUtilization, '{core}', 'Node process CPU over the last heartbeat interval, in cores (1 = one full core).'),
      rss: g(N.nodesMemoryRss, 'By', 'Node process resident set size.'),
      heapUsed: g(N.nodesHeapUsed, 'By', 'Node process V8 heap in use.'),
      heapLimit: g(N.nodesHeapLimit, 'By', 'Node process V8 heap limit.'),
      eventLoop: g(N.nodesEventLoopDelayP99, 's', 'Node process event-loop delay, p99 over the last interval.'),
      stateFree: g(N.nodesStateDirFree, 'By', "Free bytes on the filesystem holding the node's state directory."),
      stateTotal: g(N.nodesStateDirTotal, 'By', "Size of the filesystem holding the node's state directory."),
      slotsUsed: g(N.nodesSlotsUsed, '{slot}', 'Job slots in use on the node.'),
      slotsTotal: g(N.nodesSlotsTotal, '{slot}', 'Job slots the node offers.'),
      uptime: g(N.nodesUptime, 's', 'Node process uptime.'),
      counter: g(
        N.nodesCounter,
        '{event}',
        'Node-reported cumulative counters since the node process started (reset on restart), by counter.',
      ),
      noEligibleNode: g(
        N.nodesTypesNoEligibleNode,
        '{type}',
        '1 when an offered job type has runnable pending jobs and no healthy online node lists it as eligible.',
      ),
    };
  }

  /** The batch callback. Never throws; observes nothing when the snapshot is unavailable. */
  async observe(result: BatchObservableResult, gauges: Gauges): Promise<void> {
    try {
      const snap = await this.snapshot();
      if (!snap) return;

      for (const row of snap.counts) {
        result.observe(gauges.count, row.count, { status: row.status, health: row.health });
      }

      for (const node of snap.nodes) {
        const attrs = { node_id: node.nodeId, node_name: node.nodeName };
        const v = node.vitals;
        const pairs: Array<[ObservableGauge, number | undefined]> = [
          [gauges.cpu, v.cpuUtilization],
          [gauges.rss, v.memoryRssBytes],
          [gauges.heapUsed, v.heapUsedBytes],
          [gauges.heapLimit, v.heapLimitBytes],
          [gauges.eventLoop, v.eventLoopDelayP99Seconds],
          [gauges.stateFree, v.stateDirFreeBytes],
          [gauges.stateTotal, v.stateDirTotalBytes],
          [gauges.slotsUsed, v.slotsUsed],
          [gauges.slotsTotal, v.slotsTotal],
          [gauges.uptime, v.uptimeSeconds],
        ];
        for (const [gauge, value] of pairs) {
          if (value !== undefined) result.observe(gauge, value, attrs);
        }
        for (const c of v.counters) {
          result.observe(gauges.counter, c.value, { ...attrs, counter: c.counter });
        }
      }

      for (const row of snap.noEligibleNode ?? []) {
        result.observe(gauges.noEligibleNode, row.value, { job_type: row.jobType });
      }
    } catch (error) {
      this.logger.debug(`Node fleet gauge callback skipped: ${describe(error)}`);
    }
  }

  /**
   * The cached snapshot: `null` while the export gate is closed (nothing is
   * queried) or when the read failed; reused for `GAUGE_CACHE_TTL_MS`, one
   * read in flight.
   */
  async snapshot(): Promise<FleetSnapshot | null> {
    const context = this.context ?? this.metrics.gaugeContext();
    if (!context || !context.gateOpen()) return null;

    const cached = this.cache;
    if (cached && context.now() - cached.at < GAUGE_CACHE_TTL_MS) return cached.value;

    if (!this.inFlight) {
      this.inFlight = this.read(context.now())
        .then((value) => {
          this.cache = { at: context.now(), value };
          return value;
        })
        .catch((error: unknown) => {
          this.logger.debug(`Node fleet gauge read failed: ${describe(error)}`);
          return null;
        })
        .finally(() => {
          this.inFlight = null;
        });
    }

    return this.inFlight;
  }

  private async read(nowMs: number): Promise<FleetSnapshot> {
    const now = new Date(nowMs);

    const [policy, nodes, pending, offered] = await Promise.all([
      this.lifecycle.getPolicy(),
      this.prisma.workerNode.findMany({
        select: {
          id: true,
          name: true,
          status: true,
          lastHeartbeatAt: true,
          eligibleTypes: true,
          lastVitals: true,
          lastVitalsAt: true,
        },
      }),
      this.prisma.job.groupBy({
        by: ['type'],
        where: {
          status: 'pending',
          OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }],
        },
        _count: { _all: true },
      }),
      // `offeredTypes()` is contracted never to throw, but a gauge must not
      // lose the whole snapshot to one part: `null` omits only that gauge.
      this.offload.offeredTypes().catch((error: unknown) => {
        this.logger.debug(`Offered node types unavailable for metrics: ${describe(error)}`);
        return null;
      }),
    ]);

    const stale = policy.staleHeartbeatSeconds;

    // ---- app.nodes.count ----------------------------------------------------
    const counts = new Map<string, number>();
    const key = (status: string, health: NodeHealth) => `${status}|${health}`;
    for (const status of NODE_STATUSES) {
      for (const health of NODE_HEALTHS) {
        if ((status === 'offline') === (health === 'offline')) counts.set(key(status, health), 0);
      }
    }

    const healthOf = new Map<string, NodeHealth>();
    for (const node of nodes) {
      const health = deriveNodeHealth(node, stale, now);
      healthOf.set(node.id, health);
      const k = key(String(node.status), health);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }

    const countRows: FleetSnapshot['counts'] = [];
    for (const [k, count] of counts) {
      const [status, health] = k.split('|') as [string, NodeHealth];
      countRows.push({ status, health, count });
    }

    // ---- per-node vitals ------------------------------------------------------
    const freshAfter = nowMs - stale * VITALS_FRESHNESS_MULTIPLIER * 1000;
    const exported = nodes
      .filter(
        (node) =>
          healthOf.get(node.id) !== 'offline' &&
          node.lastVitalsAt instanceof Date &&
          node.lastVitalsAt.getTime() > freshAfter &&
          node.lastVitals !== null,
      )
      .sort(
        (a, b) =>
          (b.lastVitalsAt as Date).getTime() - (a.lastVitalsAt as Date).getTime() ||
          a.id.localeCompare(b.id),
      )
      .slice(0, MAX_EXPORTED_NODES)
      .map((node) => ({
        nodeId: nodeIdLabel(node.id),
        nodeName: nodeNameLabel(node.name),
        vitals: exportedVitals(node.lastVitals),
      }));

    // ---- app.nodes.types.no_eligible_node ------------------------------------
    let noEligibleNode: FleetSnapshot['noEligibleNode'] = null;
    if (offered) {
      const offeredSet = new Set(offered);
      const served = new Set<string>();
      for (const node of nodes) {
        if (node.status !== 'online' || healthOf.get(node.id) !== 'healthy') continue;
        for (const type of node.eligibleTypes ?? []) served.add(type);
      }

      noEligibleNode = [];
      for (const row of pending) {
        if (!offeredSet.has(row.type) || countOf(row._count) < 1) continue;
        noEligibleNode.push({
          jobType: this.metrics.boundLabel('job_type', row.type),
          value: served.has(row.type) ? 0 : 1,
        });
      }
    }

    return { counts: countRows, nodes: exported, noEligibleNode };
  }
}

function countOf(count: unknown): number {
  if (typeof count === 'number') return count;
  if (count && typeof count === 'object' && '_all' in count) {
    const all = (count as { _all: unknown })._all;
    return typeof all === 'number' ? all : 0;
  }
  return 0;
}
