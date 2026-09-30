import { ConfigService } from '@nestjs/config';
import { MeterProvider, MetricReader, type MetricData } from '@opentelemetry/sdk-metrics';

import { AppMetricsService, GAUGE_CACHE_TTL_MS, OTHER_LABEL } from '../common/otel/app-metrics.service';
import type { NodeOffloadService } from '../jobs/node-offload.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  MAX_EXPORTED_NODES,
  NodeFleetMetrics,
  exportedVitals,
  nodeNameLabel,
} from './node-fleet-metrics.service';
import type { NodeLifecycleService } from './node-lifecycle.service';

// =============================================================================
// NodeFleetMetrics (issue #131)
// =============================================================================
//
// Collected through a REAL in-memory SDK MeterProvider, like
// `app-metrics.service.spec.ts`: names, units and attribute sets are what the
// OTLP exporter would send.
// =============================================================================

class TestReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

async function collect(reader: TestReader): Promise<MetricData[]> {
  const { resourceMetrics, errors } = await reader.collect();
  expect(errors).toEqual([]);
  return resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics);
}

function metric(all: MetricData[], name: string): MetricData | undefined {
  return all.find((m) => m.descriptor.name === name);
}

function points(all: MetricData[], name: string) {
  return (metric(all, name)?.dataPoints ?? []).map((dp) => ({
    attributes: { ...dp.attributes },
    value: dp.value,
  }));
}

const NOW = 1_800_000_000_000;
const STALE_S = 90;
const POLICY = {
  staleHeartbeatSeconds: STALE_S,
  offlineStaleMultiplier: 4,
  offlineRetentionDays: 30,
  jobSecretBrokerEnabled: false,
};

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ago = (s: number) => new Date(NOW - s * 1000);

const VITALS = {
  cpuPercent: 150,
  rssBytes: 100_000_000,
  heapUsedBytes: 40_000_000,
  heapLimitBytes: 2_000_000_000,
  eventLoopDelayP99Ms: 25,
  stateDirFreeBytes: 5e9,
  stateDirTotalBytes: 1e10,
  slotsUsed: 1,
  slotsTotal: 4,
  uptimeSeconds: 3600,
  counters: { claims: 10, emptyPolls: 3, leaseRenewFailures: 1, watchdogTrips: 0 },
  cliVersion: '1.2.3',
};

function node(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: ID(n),
    name: `worker-${n}`,
    status: 'online',
    lastHeartbeatAt: ago(10),
    eligibleTypes: ['example.checksum'],
    lastVitals: VITALS,
    lastVitalsAt: ago(10),
    ...overrides,
  };
}

function setup(
  opts: {
    nodes?: Array<Record<string, unknown>>;
    pending?: Array<{ type: string; _count: { _all: number } }>;
    offered?: string[] | Error;
    otelEnabled?: boolean;
  } = {},
) {
  const reader = new TestReader();
  const provider = new MeterProvider({ readers: [reader] });
  let now = NOW;
  let gate = true;

  const prisma = {
    workerNode: { findMany: jest.fn(async () => opts.nodes ?? []) },
    job: { groupBy: jest.fn(async () => opts.pending ?? []) },
  };
  const lifecycle = { getPolicy: jest.fn(async () => POLICY) };
  const offload = {
    offeredTypes: jest.fn(async () => {
      if (opts.offered instanceof Error) throw opts.offered;
      return opts.offered ?? ['example.checksum'];
    }),
  };
  const config = { get: jest.fn((key: string) => (key === 'otel.enabled' ? opts.otelEnabled ?? true : undefined)) };

  const appMetrics = new AppMetricsService(undefined, config as unknown as ConfigService, {
    meter: provider.getMeter('app'),
    now: () => now,
    gateOpen: () => gate,
  });

  const fleet = new NodeFleetMetrics(
    prisma as unknown as PrismaService,
    lifecycle as unknown as NodeLifecycleService,
    offload as unknown as NodeOffloadService,
    appMetrics,
  );

  return {
    fleet,
    reader,
    prisma,
    offload,
    advance: (ms: number) => {
      now += ms;
    },
    setGate: (open: boolean) => {
      gate = open;
    },
  };
}

describe('NodeFleetMetrics', () => {
  it('counts nodes by status and derived health, observing every possible pair (zeros included)', async () => {
    const { fleet, reader, prisma } = setup({
      nodes: [
        node(1),
        node(2, { lastHeartbeatAt: ago(STALE_S + 1) }), // stale
        node(3, { lastHeartbeatAt: null }), // never phoned home: stale
        node(4, { status: 'draining' }),
        node(5, { status: 'offline', lastHeartbeatAt: ago(1) }), // status wins
        node(6, { status: 'disabled' }),
      ],
    });
    fleet.onModuleInit();

    const all = await collect(reader);
    expect(metric(all, 'app.nodes.count')?.descriptor.unit).toBe('{node}');
    const counts = points(all, 'app.nodes.count');
    expect(counts).toHaveLength(7);
    expect(counts).toEqual(
      expect.arrayContaining([
        { attributes: { status: 'online', health: 'healthy' }, value: 1 },
        { attributes: { status: 'online', health: 'stale' }, value: 2 },
        { attributes: { status: 'draining', health: 'healthy' }, value: 1 },
        { attributes: { status: 'draining', health: 'stale' }, value: 0 },
        { attributes: { status: 'offline', health: 'offline' }, value: 1 },
        { attributes: { status: 'disabled', health: 'healthy' }, value: 1 },
        { attributes: { status: 'disabled', health: 'stale' }, value: 0 },
      ]),
    );
    // One worker_nodes read, one pending groupBy.
    expect(prisma.workerNode.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.job.groupBy).toHaveBeenCalledTimes(1);
  });

  it('exports per-node vitals in their units, with node_id/node_name and snake_case counters', async () => {
    const { fleet, reader } = setup({ nodes: [node(1)] });
    fleet.onModuleInit();

    const all = await collect(reader);
    const attrs = { node_id: ID(1), node_name: 'worker-1' };

    const expectGauge = (name: string, unit: string, value: number) => {
      expect(metric(all, name)?.descriptor.unit).toBe(unit);
      expect(points(all, name)).toEqual([{ attributes: attrs, value }]);
    };
    expectGauge('app.nodes.cpu.utilization', '{core}', 1.5);
    expectGauge('app.nodes.memory.rss', 'By', 100_000_000);
    expectGauge('app.nodes.heap.used', 'By', 40_000_000);
    expectGauge('app.nodes.heap.limit', 'By', 2_000_000_000);
    expectGauge('app.nodes.event_loop.delay.p99', 's', 0.025);
    expectGauge('app.nodes.state_dir.free', 'By', 5e9);
    expectGauge('app.nodes.state_dir.total', 'By', 1e10);
    expectGauge('app.nodes.slots.used', '{slot}', 1);
    expectGauge('app.nodes.slots.total', '{slot}', 4);
    expectGauge('app.nodes.uptime', 's', 3600);

    expect(metric(all, 'app.nodes.counter')?.descriptor.unit).toBe('{event}');
    expect(points(all, 'app.nodes.counter')).toEqual(
      expect.arrayContaining([
        { attributes: { ...attrs, counter: 'claims' }, value: 10 },
        { attributes: { ...attrs, counter: 'empty_polls' }, value: 3 },
        { attributes: { ...attrs, counter: 'lease_renew_failures' }, value: 1 },
        { attributes: { ...attrs, counter: 'watchdog_trips' }, value: 0 },
      ]),
    );
    expect(points(all, 'app.nodes.counter')).toHaveLength(4);
  });

  it('excludes offline nodes, stale vitals (beyond 3x the stale window) and nodes with no vitals', async () => {
    const { fleet, reader } = setup({
      nodes: [
        node(1),
        node(2, { status: 'offline' }),
        node(3, { lastVitalsAt: ago(STALE_S * 3 + 1) }),
        node(4, { lastVitalsAt: ago(STALE_S * 3 - 1), lastHeartbeatAt: ago(STALE_S * 2) }), // stale, still fresh vitals
        node(5, { lastVitals: null, lastVitalsAt: null }),
      ],
    });
    fleet.onModuleInit();

    const all = await collect(reader);
    const ids = points(all, 'app.nodes.uptime').map((p) => p.attributes.node_id).sort();
    expect(ids).toEqual([ID(1), ID(4)]);
  });

  it(`caps exported nodes at ${MAX_EXPORTED_NODES}, newest vitals first`, async () => {
    const nodes = Array.from({ length: MAX_EXPORTED_NODES + 5 }, (_, i) =>
      node(i + 1, { lastVitalsAt: ago(i + 1) }),
    );
    const { fleet, reader } = setup({ nodes });
    fleet.onModuleInit();

    const all = await collect(reader);
    const ids = new Set(points(all, 'app.nodes.uptime').map((p) => p.attributes.node_id));
    expect(ids.size).toBe(MAX_EXPORTED_NODES);
    expect(ids.has(ID(1))).toBe(true);
    expect(ids.has(ID(MAX_EXPORTED_NODES))).toBe(true);
    expect(ids.has(ID(MAX_EXPORTED_NODES + 1))).toBe(false);
  });

  it('flags offered types with runnable pending jobs and no healthy online node listing them', async () => {
    const { fleet, reader, prisma } = setup({
      offered: ['example.checksum', 'db.backup.run', 'example.echo'],
      pending: [
        { type: 'example.checksum', _count: { _all: 2 } }, // served by node 1
        { type: 'db.backup.run', _count: { _all: 1 } }, // only draining/stale/disabled/offline nodes list it
        { type: 'ai.image', _count: { _all: 9 } }, // not offered: never reported
      ],
      nodes: [
        node(1),
        node(2, { status: 'draining', eligibleTypes: ['db.backup.run'] }),
        node(3, { lastHeartbeatAt: ago(STALE_S + 5), eligibleTypes: ['db.backup.run'] }),
        node(4, { status: 'disabled', eligibleTypes: ['db.backup.run'] }),
        node(5, { status: 'offline', eligibleTypes: ['db.backup.run'] }),
      ],
    });
    fleet.onModuleInit();

    const all = await collect(reader);
    expect(metric(all, 'app.nodes.types.no_eligible_node')?.descriptor.unit).toBe('{type}');
    const rows = points(all, 'app.nodes.types.no_eligible_node');
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        { attributes: { job_type: 'example.checksum' }, value: 0 },
        { attributes: { job_type: 'db.backup.run' }, value: 1 },
      ]),
    );

    // Due pending rows only, like the oldest-pending gauge.
    const [args] = prisma.job.groupBy.mock.calls[0] as unknown as [{ where: { status: string; OR: unknown[] } }];
    expect(args.where.status).toBe('pending');
    expect(args.where.OR).toEqual([{ scheduledFor: null }, { scheduledFor: { lte: new Date(NOW) } }]);
  });

  it('omits only the no-eligible-node gauge when the offered types cannot be read', async () => {
    const { fleet, reader } = setup({
      offered: new Error('settings down'),
      pending: [{ type: 'example.checksum', _count: { _all: 1 } }],
      nodes: [node(1)],
    });
    fleet.onModuleInit();

    const all = await collect(reader);
    expect(points(all, 'app.nodes.types.no_eligible_node')).toEqual([]);
    expect(points(all, 'app.nodes.count').length).toBe(7);
  });

  it('queries nothing while the export gate is closed', async () => {
    const { fleet, reader, prisma, offload, setGate } = setup({ nodes: [node(1)] });
    fleet.onModuleInit();
    setGate(false);

    const all = await collect(reader);
    expect(points(all, 'app.nodes.count')).toEqual([]);
    expect(prisma.workerNode.findMany).not.toHaveBeenCalled();
    expect(prisma.job.groupBy).not.toHaveBeenCalled();
    expect(offload.offeredTypes).not.toHaveBeenCalled();
  });

  it('registers nothing (and never queries) when OTel is disabled', async () => {
    const { fleet, reader, prisma } = setup({ nodes: [node(1)], otelEnabled: false });
    fleet.onModuleInit();

    const all = await collect(reader);
    expect(metric(all, 'app.nodes.count')).toBeUndefined();
    expect(await fleet.snapshot()).toBeNull();
    expect(prisma.workerNode.findMany).not.toHaveBeenCalled();
  });

  it('reuses the snapshot within the TTL and shares one in-flight read', async () => {
    const { fleet, prisma, advance } = setup({ nodes: [node(1)] });
    fleet.onModuleInit();

    const [a, b] = await Promise.all([fleet.snapshot(), fleet.snapshot()]);
    expect(a).toBe(b);
    expect(prisma.workerNode.findMany).toHaveBeenCalledTimes(1);

    advance(GAUGE_CACHE_TTL_MS - 1);
    await fleet.snapshot();
    expect(prisma.workerNode.findMany).toHaveBeenCalledTimes(1);

    advance(2);
    await fleet.snapshot();
    expect(prisma.workerNode.findMany).toHaveBeenCalledTimes(2);
  });

  it('never throws from the callback when the read fails', async () => {
    const { fleet, reader, prisma } = setup();
    prisma.workerNode.findMany.mockRejectedValueOnce(new Error('db down'));
    fleet.onModuleInit();

    const all = await collect(reader);
    expect(points(all, 'app.nodes.count')).toEqual([]);
  });

  describe('labels and parsing', () => {
    it('sanitises operator-chosen node names and rejects address-shaped ones', () => {
      expect(nodeNameLabel('gpu box #1')).toBe('gpu_box_1');
      expect(nodeNameLabel('ops@example.com')).toBe(OTHER_LABEL);
      expect(nodeNameLabel('x'.repeat(100))).toBe('x'.repeat(64));
      expect(nodeNameLabel('   ')).toBe('unknown');
    });

    it('maps a non-UUID node id to other', async () => {
      const { fleet, reader } = setup({ nodes: [node(1, { id: 'not-a-uuid' })] });
      fleet.onModuleInit();

      const all = await collect(reader);
      expect(points(all, 'app.nodes.uptime')[0].attributes.node_id).toBe(OTHER_LABEL);
    });

    it('reads a stored vitals document tolerantly', () => {
      expect(exportedVitals(null)).toEqual({
        cpuUtilization: undefined,
        memoryRssBytes: undefined,
        heapUsedBytes: undefined,
        heapLimitBytes: undefined,
        eventLoopDelayP99Seconds: undefined,
        stateDirFreeBytes: undefined,
        stateDirTotalBytes: undefined,
        slotsUsed: undefined,
        slotsTotal: undefined,
        uptimeSeconds: undefined,
        counters: [],
      });
      const v = exportedVitals({ cpuPercent: 'lots', rssBytes: -1, uptimeSeconds: 5, counters: { claims: NaN, failed: 2, bogus: 1 } });
      expect(v.cpuUtilization).toBeUndefined();
      expect(v.memoryRssBytes).toBeUndefined();
      expect(v.uptimeSeconds).toBe(5);
      expect(v.counters).toEqual([{ counter: 'failed', value: 2 }]);
    });
  });
});
