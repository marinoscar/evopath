import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';

import { CLI_VERSION } from '../package-info.js';
import type { NodeVitals, NodeVitalsCounters } from './node-api.js';

// =============================================================================
// Heartbeat vitals  (issue #130; server side #129)
// =============================================================================
//
// What a worker measures about ITSELF and carries on every heartbeat, so the
// fleet page can show a node that is alive but unwell — a pinned CPU, a heap
// creeping toward its limit, a state volume filling up — before it stops
// heartbeating altogether.
//
// -----------------------------------------------------------------------------
// EVERY FIELD IS BEST-EFFORT, AND NOTHING HERE THROWS
// -----------------------------------------------------------------------------
//
// A vitals read that fails OMITS THAT FIELD. It never throws, and it never
// omits the heartbeat: a heartbeat is how the server knows this node is alive,
// and trading that for a disk-usage number would be exactly backwards.
//
// -----------------------------------------------------------------------------
// VALUES ARE CLAMPED OR OMITTED ON THIS SIDE, BEFORE THEY ARE SENT
// -----------------------------------------------------------------------------
//
// The server's `nodeVitalsSchema` is `.strict()` and bounded, and one value out
// of range fails the WHOLE heartbeat with a 400 — which, repeated, gets this
// node swept offline. So the bounds below MIRROR THE SERVER'S EXACTLY
// (`apps/api/src/nodes/dto/node-control-plane.dto.ts`), a number that is not
// finite or is negative is dropped, and one past its ceiling is clamped to it.
// A version string is reduced to the server's character class and length.
// =============================================================================

/** Mirrors `MAX_VITALS_COUNTER`. */
export const MAX_VITALS_COUNTER = 1e12;
/** Mirrors `MAX_VITALS_MEMORY_BYTES` (1 PiB). */
export const MAX_VITALS_MEMORY_BYTES = 2 ** 50;
/** Mirrors `MAX_VITALS_DISK_BYTES`. Not an integer bound — see the server DTO. */
export const MAX_VITALS_DISK_BYTES = 2 ** 64;
/** Mirrors `MAX_VITALS_CPU_PERCENT`: 100% per core, up to 128 cores. */
export const MAX_VITALS_CPU_PERCENT = 12_800;
/** Mirrors `MAX_VITALS_EVENT_LOOP_DELAY_MS` (one hour). */
export const MAX_VITALS_EVENT_LOOP_DELAY_MS = 3_600_000;
/** Mirrors `MAX_VITALS_UPTIME_SECONDS` (ten years). */
export const MAX_VITALS_UPTIME_SECONDS = 10 * 365 * 24 * 60 * 60;
/** Mirrors `MAX_VITALS_VERSION_LENGTH`. */
export const MAX_VITALS_VERSION_LENGTH = 64;
/** Mirrors `MAX_NODE_CONCURRENCY`, the ceiling on `slotsUsed`/`slotsTotal`. */
export const MAX_VITALS_SLOTS = 64;

/** What the engine knows and this module does not: slots and loop counters. */
export interface EngineVitalsInput {
  slotsUsed: number;
  slotsTotal: number;
  /** Everything but `watchdogTrips`, which the watchdog owns. */
  counters: Omit<NodeVitalsCounters, 'watchdogTrips'>;
}

/** A vitals collector, as the engine sees it. MUST NOT throw (the engine guards anyway). */
export type VitalsCollector = (input: EngineVitalsInput) => NodeVitals;

/** The machine readings. Every one is injectable, so tests need no real process. */
export interface VitalsSources {
  /** Monotonic milliseconds, for the CPU interval. */
  monotonicMs(): number;
  /** Microseconds of process CPU, as `process.cpuUsage()`. */
  cpuUsage(): { user: number; system: number };
  memoryUsage(): { rss: number; heapUsed: number };
  heapLimit(): number;
  /** p99 event-loop delay since the last call, in NANOSECONDS; resets the window. `undefined` when there were no samples. */
  eventLoopDelayP99Ns(): number | undefined;
  /** `statfs` of a path. Throws when the path is unreachable. */
  statfs(path: string): { bavail: number; blocks: number; bsize: number };
  uptimeSeconds(): number;
}

export interface NodeVitalsProviderOptions {
  /** The worker's state directory; its filesystem is what is reported. */
  stateDir?: string | undefined;
  /**
   * The watchdog's state, read at collection time. A GETTER because the
   * watchdog is built after the engine (see `start.ts`); `undefined` means
   * "no watchdog", which reports no `watchdogTrips` at all.
   */
  watchdogState?: (() => { fired: boolean } | undefined) | undefined;
  cliVersion?: string | undefined;
  nodeVersion?: string | undefined;
  /**
   * The `pg_dump` banner, when something already has it. Nothing runs
   * `pg_dump --version` for this — a heartbeat must never spawn a process.
   */
  pgDumpVersion?: string | undefined;
  /** Test seam. Missing members fall back to the real process. */
  sources?: Partial<VitalsSources> | undefined;
}

// -----------------------------------------------------------------------------
// Clamping — pure, exported for the tests
// -----------------------------------------------------------------------------

/** A finite, non-negative number clamped to `max`; anything else is `undefined`. */
export function clampNumber(value: unknown, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(value, max);
}

/** As `clampNumber`, rounded to a whole number (the server checks `.int()`). */
export function clampInt(value: unknown, max: number): number | undefined {
  const clamped = clampNumber(value, max);
  return clamped === undefined ? undefined : Math.min(Math.round(clamped), Math.floor(max));
}

/**
 * Reduce a version banner to what the server accepts: `[0-9A-Za-z .+\-_()~]`,
 * trimmed, at most 64 characters. `undefined` when nothing is left.
 */
export function sanitizeVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value
    .replace(/[^0-9A-Za-z .+\-_()~]/g, '')
    .trim()
    .slice(0, MAX_VITALS_VERSION_LENGTH)
    .trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function clampCounters(counters: NodeVitalsCounters): NodeVitalsCounters | undefined {
  const out: NodeVitalsCounters = {};
  for (const [key, value] of Object.entries(counters) as Array<[keyof NodeVitalsCounters, unknown]>) {
    const clamped = clampInt(value, MAX_VITALS_COUNTER);
    if (clamped !== undefined) out[key] = clamped;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Run `fn`; `undefined` on a throw. The whole of "best-effort" in one line. */
function attempt<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

// -----------------------------------------------------------------------------
// The real sources
// -----------------------------------------------------------------------------

function realEventLoopDelay(): { read: () => number | undefined; stop: () => void } {
  let histogram: IntervalHistogram | undefined;
  try {
    histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
  } catch {
    histogram = undefined;
  }
  return {
    read: () => {
      if (histogram === undefined) return undefined;
      // An empty window reports nonsense (`min` is 2^63), not zero: omit it.
      const value = histogram.count > 0 ? histogram.percentile(99) : undefined;
      histogram.reset();
      return value;
    },
    stop: () => histogram?.disable(),
  };
}

// -----------------------------------------------------------------------------
// The provider
// -----------------------------------------------------------------------------

export class NodeVitalsProvider {
  private readonly sources: VitalsSources;
  private readonly stopLoopMonitor: () => void;
  private readonly options: NodeVitalsProviderOptions;
  private lastCpu: { user: number; system: number } | undefined;
  private lastMonotonicMs: number | undefined;

  constructor(options: NodeVitalsProviderOptions = {}) {
    this.options = options;
    const injected = options.sources ?? {};

    let loop: { read: () => number | undefined; stop: () => void } | undefined;
    if (injected.eventLoopDelayP99Ns === undefined) loop = realEventLoopDelay();
    this.stopLoopMonitor = () => loop?.stop();

    this.sources = {
      monotonicMs: injected.monotonicMs ?? (() => performance.now()),
      cpuUsage: injected.cpuUsage ?? (() => process.cpuUsage()),
      memoryUsage: injected.memoryUsage ?? (() => process.memoryUsage()),
      heapLimit: injected.heapLimit ?? (() => getHeapStatistics().heap_size_limit),
      eventLoopDelayP99Ns: injected.eventLoopDelayP99Ns ?? (() => loop?.read()),
      statfs: injected.statfs ?? ((path) => statfsSync(path)),
      uptimeSeconds: injected.uptimeSeconds ?? (() => process.uptime()),
    };

    // The CPU baseline, so the FIRST heartbeat already reports an interval
    // (since the provider was built) rather than nothing.
    this.lastCpu = attempt(() => this.sources.cpuUsage());
    this.lastMonotonicMs = attempt(() => this.sources.monotonicMs());
  }

  /** Stop the event-loop monitor. Idempotent. */
  stop(): void {
    attempt(() => this.stopLoopMonitor());
  }

  /** One snapshot. NEVER THROWS; a field that cannot be read is absent. */
  collect(input: EngineVitalsInput): NodeVitals {
    const vitals: NodeVitals = {};
    const set = <K extends keyof NodeVitals>(key: K, value: NodeVitals[K] | undefined): void => {
      if (value !== undefined) vitals[key] = value;
    };

    set('cpuPercent', attempt(() => this.cpuPercent()));

    const memory = attempt(() => this.sources.memoryUsage());
    set('rssBytes', clampInt(memory?.rss, MAX_VITALS_MEMORY_BYTES));
    set('heapUsedBytes', clampInt(memory?.heapUsed, MAX_VITALS_MEMORY_BYTES));
    set('heapLimitBytes', clampInt(attempt(() => this.sources.heapLimit()), MAX_VITALS_MEMORY_BYTES));

    const delayNs = attempt(() => this.sources.eventLoopDelayP99Ns());
    set('eventLoopDelayP99Ms', clampNumber(delayNs === undefined ? undefined : delayNs / 1e6, MAX_VITALS_EVENT_LOOP_DELAY_MS));

    const disk = attempt(() => this.disk());
    if (disk !== undefined) {
      set('stateDirFreeBytes', clampNumber(disk.bavail * disk.bsize, MAX_VITALS_DISK_BYTES));
      set('stateDirTotalBytes', clampNumber(disk.blocks * disk.bsize, MAX_VITALS_DISK_BYTES));
    }

    set('slotsUsed', clampInt(input.slotsUsed, MAX_VITALS_SLOTS));
    set('slotsTotal', clampInt(input.slotsTotal, MAX_VITALS_SLOTS));
    set('uptimeSeconds', clampNumber(attempt(() => this.sources.uptimeSeconds()), MAX_VITALS_UPTIME_SECONDS));

    const watchdog = attempt(() => this.options.watchdogState?.());
    set(
      'counters',
      clampCounters({
        ...input.counters,
        // The valve fires at most once per process (it drains and exits), so
        // "trips since start" is exactly 0 or 1.
        ...(watchdog !== undefined ? { watchdogTrips: watchdog.fired ? 1 : 0 } : {}),
      }),
    );

    set('cliVersion', sanitizeVersion(this.options.cliVersion ?? CLI_VERSION));
    set('nodeVersion', sanitizeVersion(this.options.nodeVersion ?? process.versions.node));
    set('pgDumpVersion', sanitizeVersion(this.options.pgDumpVersion));

    return vitals;
  }

  /**
   * Process CPU over the interval since the last sample: CPU µs / wall µs ×100.
   * Per-process, so a multi-threaded process can exceed 100 on several cores.
   */
  private cpuPercent(): number | undefined {
    const cpu = this.sources.cpuUsage();
    const nowMs = this.sources.monotonicMs();
    const previousCpu = this.lastCpu;
    const previousMs = this.lastMonotonicMs;
    this.lastCpu = cpu;
    this.lastMonotonicMs = nowMs;
    if (previousCpu === undefined || previousMs === undefined) return undefined;

    const wallMs = nowMs - previousMs;
    if (!(wallMs > 0)) return undefined;
    const cpuMs = (cpu.user - previousCpu.user + (cpu.system - previousCpu.system)) / 1000;
    return clampNumber((cpuMs / wallMs) * 100, MAX_VITALS_CPU_PERCENT);
  }

  /**
   * `statfs` of the state directory — or, before it exists, of its nearest
   * existing ancestor, which is the filesystem it WILL live on.
   */
  private disk(): { bavail: number; blocks: number; bsize: number } | undefined {
    let path = this.options.stateDir;
    while (path !== undefined && path.length > 0) {
      const current: string = path;
      const result = attempt(() => this.sources.statfs(current));
      if (result !== undefined) return result;
      const parent = dirname(current);
      if (parent === current) return undefined;
      path = parent;
    }
    return undefined;
  }
}
