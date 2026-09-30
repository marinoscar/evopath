/**
 * Shared worker-node VITALS fixtures — issue #131 (API side #129).
 *
 * Shapes follow `NodeVitalsDto` in `apps/api/src/nodes/dto/node-admin.dto.ts`;
 * types are the web client's own (`services/nodes.ts`). Every field of a vitals
 * snapshot is optional on the wire, so `partialVitals` exists to prove the UI
 * renders an ABSENT field as "not reported", never as zero.
 *
 * Numbers are chosen so the rendered text is unambiguous in assertions:
 * 512 MB RSS, heap 256 MB of 1 GB (25%), disk 50 GB free of 100 GB (50%),
 * slots 1/4.
 */
import type { NodeVitals, WorkerNode } from '../../../services/nodes';

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** A full, healthy snapshot — every field reported. */
export const fullVitals: NodeVitals = {
  cpuPercent: 42,
  rssBytes: 512 * MB,
  heapUsedBytes: 256 * MB,
  heapLimitBytes: 1 * GB,
  eventLoopDelayP99Ms: 12.6,
  stateDirFreeBytes: 50 * GB,
  stateDirTotalBytes: 100 * GB,
  slotsUsed: 1,
  slotsTotal: 4,
  uptimeSeconds: 2 * 86_400 + 3 * 3_600,
  counters: {
    claims: 120,
    emptyPolls: 3456,
    claimFailures: 2,
    succeeded: 110,
    failed: 7,
    rateLimited: 3,
    leaseRenewals: 900,
    leaseRenewFailures: 1,
    heartbeatFailures: 4,
    watchdogTrips: 5,
  },
  cliVersion: '1.9.0',
  nodeVersion: 'v24.1.0',
  pgDumpVersion: '16.4',
};

/** State directory 5 GB free of 100 GB (5%) — under the 10% "low disk" line. */
export const lowDiskVitals: NodeVitals = {
  ...fullVitals,
  stateDirFreeBytes: 5 * GB,
  stateDirTotalBytes: 100 * GB,
};

/** CPU and slots only: memory, disk, counters and versions all absent. */
export const partialVitals: NodeVitals = {
  cpuPercent: 3.25,
  slotsUsed: 0,
  slotsTotal: 2,
};

/** A reported snapshot with nothing the compact cell shows (versions only). */
export const versionsOnlyVitals: NodeVitals = {
  cliVersion: '1.9.0',
  nodeVersion: 'v24.1.0',
};

/** A node row, healthy, with no vitals unless overridden. */
export function vitalsNode(overrides: Partial<WorkerNode> = {}): WorkerNode {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'worker-a',
    hostname: 'build-box-01',
    platform: 'linux-x64',
    cliVersion: '1.9.0',
    eligibleTypes: ['image.thumbnail'],
    concurrency: 4,
    status: 'online',
    health: 'healthy',
    capabilities: null,
    registeredAt: '2026-01-01T00:00:00.000Z',
    lastHeartbeatAt: '2026-01-01T11:59:00.000Z',
    owner: { id: 'u1', email: 'ops@example.com', name: 'Ops' },
    jobCounts: { running: 1, pending: 2, succeeded: 30, failed: 3, total: 36 },
    lastVitals: null,
    lastVitalsAt: null,
    ...overrides,
  };
}
