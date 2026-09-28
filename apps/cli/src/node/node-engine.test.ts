import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExecutorRegistry, type JobExecutionContext, type JobExecutor } from './executors/index.js';
import { ExampleChecksumExecutor } from './executors/example-checksum.js';
import type { ClaimToken, JobFailureReport, NodeApi, NodeJobAssignment } from './node-api.js';
import type { NodeEngineEvent } from './node-events.js';
import { HISTORY_LIMIT, NodeEngine, type EngineScheduler } from './node-engine.js';
import { MissingJobInputError, ProviderRateLimitError } from './node-errors.js';
import { ApiError } from '../errors.js';

// =============================================================================
// NodeEngine  (issue #274, epic #254)
// =============================================================================
//
// Everything is driven by an INJECTED clock, scheduler and sleep rather than by
// real timers. The properties under test — "a fast job never waits behind a
// slow one", "the cap change takes effect on the next iteration" — are about
// ORDERING, and ordering asserted against a wall clock is a flaky test that
// passes on a fast machine. Deferreds make it exact.
// =============================================================================

/**
 * The injected sleep.
 *
 * A REAL (1 ms) timer rather than `async () => {}`, deliberately: an
 * immediately-resolving sleep makes the claim loop a microtask-only spin that
 * never yields to the timer phase, so `vi.waitFor` can never run and the
 * process climbs to an OOM instead of failing. One millisecond is enough to
 * hand the loop back and still keep the suite fast.
 */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

/** A promise plus its resolver, so a test decides exactly when a job finishes. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A scheduler whose timers only fire when a test says so. */
function fakeScheduler(): EngineScheduler & {
  fireAll(): void;
  count(): number;
  /** Every interval the engine asked for, in the order it asked. */
  intervals: number[];
} {
  const timers = new Map<number, () => void>();
  const intervals: number[] = [];
  let next = 1;
  return {
    intervals,
    setInterval(fn: () => void, ms?: number) {
      intervals.push(ms as number);
      const id = next++;
      timers.set(id, fn);
      return id;
    },
    clearInterval(handle: unknown) {
      timers.delete(handle as number);
    },
    fireAll() {
      for (const fn of [...timers.values()]) fn();
    },
    count: () => timers.size,
  };
}

/** A claim token shaped like the uuid the server mints per claimed row (#364). */
const CLAIM_TOKEN = '7b0d9a1e-3c5f-4a8b-9d2e-6f1c4b8a0e35';

function assignment(id: string, type = 'test.job', overrides: Partial<NodeJobAssignment['job']> = {}): NodeJobAssignment {
  return {
    job: {
      id,
      type,
      subjectType: null,
      subjectId: null,
      priority: 0,
      attempts: 1,
      startedAt: '2026-01-01T00:00:00.000Z',
      leaseExpiresAt: '2026-01-01T00:05:00.000Z',
      ...overrides,
    },
    params: {},
  };
}

interface Recorder {
  claims: Array<{ limit: number | undefined; types: string[] | undefined }>;
  results: Array<{ jobId: string; result: unknown }>;
  failures: Array<{ jobId: string; body: JobFailureReport }>;
  heartbeats: Array<{ concurrency: number | undefined }>;
  renews: string[];
  deregisters: number;
  /**
   * Every claim token the engine quoted, per call it made against a held job
   * (#364). `undefined` is recorded as such rather than dropped — "the engine
   * passed nothing" and "the engine never called" are different facts, and
   * only one of them is a bug.
   */
  tokens: Array<{ call: 'renew' | 'result' | 'failure' | 'download'; jobId: string; token: ClaimToken }>;
}

function fakeApi(
  queue: NodeJobAssignment[][],
  recorder: Recorder,
  overrides: Partial<NodeApi> = {},
): NodeApi {
  return {
    async claim(_nodeId, body) {
      recorder.claims.push({ limit: body.limit, types: body.types });
      return queue.shift() ?? [];
    },
    async submitResult(_nodeId, jobId, _type, result, claimToken) {
      recorder.results.push({ jobId, result });
      recorder.tokens.push({ call: 'result', jobId, token: claimToken });
      return { jobId, outcome: 'succeeded', willRetry: false };
    },
    async reportJobFailure(_nodeId, jobId, body, claimToken) {
      recorder.failures.push({ jobId, body });
      recorder.tokens.push({ call: 'failure', jobId, token: claimToken });
      return { jobId, outcome: 'failed', willRetry: body.willRetry ?? true };
    },
    async heartbeat(_nodeId, body) {
      recorder.heartbeats.push({ concurrency: body.concurrency });
      return {} as never;
    },
    async renewLease(_nodeId, jobId, claimToken) {
      recorder.renews.push(jobId);
      recorder.tokens.push({ call: 'renew', jobId, token: claimToken });
      return { jobId, leaseExpiresAt: '2026-01-01T00:10:00.000Z' };
    },
    async deregister() {
      recorder.deregisters += 1;
    },
    register: async () => {
      throw new Error('unexpected');
    },
    jobTypes: async () => [],
    listNodes: async () => [],
    getNode: async () => {
      throw new Error('unexpected');
    },
    downloadUrl: async () => {
      throw new Error('unexpected downloadUrl');
    },
    uploadUrl: async () => {
      throw new Error('unexpected');
    },
    ...overrides,
  } as NodeApi;
}

function recorder(): Recorder {
  return { claims: [], results: [], failures: [], heartbeats: [], renews: [], deregisters: 0, tokens: [] };
}

/** An executor whose every run is externally controlled. */
class ControlledExecutor implements JobExecutor {
  readonly requiresInput: boolean;
  readonly started: string[] = [];
  /** Every context the engine handed in, so a test can read what it carried. */
  readonly contexts: JobExecutionContext[] = [];
  private readonly gates = new Map<string, ReturnType<typeof deferred<unknown>>>();

  constructor(
    readonly type = 'test.job',
    options: { requiresInput?: boolean } = {},
  ) {
    this.requiresInput = options.requiresInput ?? false;
  }

  gate(jobId: string): ReturnType<typeof deferred<unknown>> {
    let gate = this.gates.get(jobId);
    if (gate === undefined) {
      gate = deferred<unknown>();
      this.gates.set(jobId, gate);
    }
    return gate;
  }

  async execute(context: JobExecutionContext): Promise<unknown> {
    this.started.push(context.job.id);
    this.contexts.push(context);
    return this.gate(context.job.id).promise;
  }
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'appctl-engine-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('NodeEngine — the top-up pool', () => {
  it('never makes a fast job wait behind a slow one', async () => {
    const rec = recorder();
    const executor = new ControlledExecutor();
    const registry = new ExecutorRegistry().register(executor);
    const scheduler = fakeScheduler();

    const engine = new NodeEngine({
      api: fakeApi([[assignment('slow'), assignment('fast-1'), assignment('fast-2'), assignment('fast-3')]], rec),
      nodeId: 'node-1',
      concurrency: 4,
      executors: registry,
      scheduler,
      tmpDir: tmp,
      sleep: tick,
      pollIntervalMs: 1,
    });

    const run = engine.run();
    await vi.waitFor(() => expect(executor.started).toHaveLength(4));

    // The three fast jobs settle while `slow` is still executing. Under a
    // batch-and-await loop none of them could report until the batch ended.
    executor.gate('fast-1').resolve({ ok: true });
    executor.gate('fast-2').resolve({ ok: true });
    executor.gate('fast-3').resolve({ ok: true });

    await vi.waitFor(() => expect(rec.results.map((entry) => entry.jobId).sort()).toEqual(['fast-1', 'fast-2', 'fast-3']));
    expect(engine.getSnapshot().activeJobs.map((job) => job.jobId)).toEqual(['slow']);

    executor.gate('slow').resolve({ ok: true });
    await engine.drain();
    await run;
  });

  it('refills freed slots without waiting for the batch, asking for exactly the free count', async () => {
    const rec = recorder();
    const executor = new ControlledExecutor();
    const scheduler = fakeScheduler();

    const engine = new NodeEngine({
      api: fakeApi([[assignment('a'), assignment('b')], [assignment('c')]], rec),
      nodeId: 'node-1',
      concurrency: 2,
      executors: new ExecutorRegistry().register(executor),
      scheduler,
      tmpDir: tmp,
      sleep: tick,
      pollIntervalMs: 1,
    });

    const run = engine.run();
    await vi.waitFor(() => expect(executor.started).toHaveLength(2));
    expect(rec.claims[0]?.limit).toBe(2);

    executor.gate('a').resolve({ ok: true });
    await vi.waitFor(() => expect(executor.started).toContain('c'));
    // Second claim asked for ONE slot, not two: the pool tops up, it does not
    // drain and refill.
    expect(rec.claims.some((claim) => claim.limit === 1)).toBe(true);

    executor.gate('b').resolve({ ok: true });
    executor.gate('c').resolve({ ok: true });
    await engine.drain();
    await run;
  });

  it('claims only types it has an executor for, even when more were requested', () => {
    const engine = new NodeEngine({
      api: fakeApi([], recorder()),
      nodeId: 'node-1',
      concurrency: 1,
      eligibleTypes: ['test.job', 'video.transcode'],
      executors: new ExecutorRegistry().register(new ControlledExecutor()),
      scheduler: fakeScheduler(),
      tmpDir: tmp,
    });

    expect(engine.claimableTypes()).toEqual(['test.job']);
  });
});

describe('NodeEngine — concurrency changes', () => {
  it('takes effect on the next iteration and triggers an immediate heartbeat', async () => {
    const rec = recorder();
    const executor = new ControlledExecutor();
    const engine = new NodeEngine({
      api: fakeApi([[assignment('a')], [assignment('b'), assignment('c')]], rec),
      nodeId: 'node-1',
      concurrency: 1,
      executors: new ExecutorRegistry().register(executor),
      scheduler: fakeScheduler(),
      tmpDir: tmp,
      sleep: tick,
      pollIntervalMs: 1,
    });

    const run = engine.run();
    await vi.waitFor(() => expect(executor.started).toEqual(['a']));

    const beatsBefore = rec.heartbeats.length;
    engine.setConcurrency(3);
    await vi.waitFor(() => expect(rec.heartbeats.length).toBeGreaterThan(beatsBefore));
    expect(rec.heartbeats.at(-1)?.concurrency).toBe(3);

    // The cap is re-read each pass, so the loop now claims two more without a
    // restart.
    await vi.waitFor(() => expect(executor.started.sort()).toEqual(['a', 'b', 'c']));

    for (const id of ['a', 'b', 'c']) executor.gate(id).resolve({ ok: true });
    await engine.drain();
    await run;
  });

  it('persists the change best-effort and refuses an out-of-range value', () => {
    const persisted: number[] = [];
    const engine = new NodeEngine({
      api: fakeApi([], recorder()),
      nodeId: 'node-1',
      concurrency: 2,
      executors: new ExecutorRegistry().register(new ControlledExecutor()),
      scheduler: fakeScheduler(),
      tmpDir: tmp,
      persistConcurrency: (value) => persisted.push(value),
    });

    engine.setConcurrency(8);
    expect(persisted).toEqual([8]);
    expect(() => engine.setConcurrency(0)).toThrow(RangeError);
    expect(() => engine.setConcurrency(65)).toThrow(RangeError);
  });
});

describe('NodeEngine — leases', () => {
  it('renews the lease of a job that outlives one window, and survives a renew failure', async () => {
    const rec = recorder();
    const executor = new ControlledExecutor();
    const scheduler = fakeScheduler();
    const events: NodeEngineEvent[] = [];
    let failNext = false;

    const engine = new NodeEngine({
      api: fakeApi([[assignment('long')]], rec, {
        async renewLease(_nodeId, jobId) {
          if (failNext) throw new Error('lease renew exploded');
          rec.renews.push(jobId);
          return { jobId, leaseExpiresAt: '2026-01-01T00:10:00.000Z' };
        },
      }),
      nodeId: 'node-1',
      concurrency: 1,
      executors: new ExecutorRegistry().register(executor),
      scheduler,
      tmpDir: tmp,
      sleep: tick,
      pollIntervalMs: 1,
      onEvent: (event) => events.push(event),
    });

    const run = engine.run();
    await vi.waitFor(() => expect(executor.started).toEqual(['long']));

    scheduler.fireAll();
    await vi.waitFor(() => expect(rec.renews).toContain('long'));

    failNext = true;
    scheduler.fireAll();
    await vi.waitFor(() => expect(events.some((event) => event.kind === 'lease-renew-failed')).toBe(true));

    // The job is STILL running: a renew failure logs and continues, because
    // the server's reaper is the backstop.
    expect(engine.getSnapshot().activeJobs).toHaveLength(1);

    executor.gate('long').resolve({ ok: true });
    await engine.drain();
    await run;
  });

  it('renews on the SERVER-DERIVED interval when the assignment carries one', async () => {
    // #347. The server derived `renewIntervalMs` from the lease it granted
    // THIS job, so it is the only cadence that is right for a type whose
    // lease is not the deployment default. A six-hour-lease job renewed on
    // the local 30-second default is 720 pointless round trips.
    const rec = recorder();
    const executor = new ControlledExecutor();
    const scheduler = fakeScheduler();

    const engine = new NodeEngine({
      api: fakeApi([[{ ...assignment('slow'), renewIntervalMs: 60_000 }]], rec),
      nodeId: 'node-1',
      concurrency: 1,
      executors: new ExecutorRegistry().register(executor),
      scheduler,
      tmpDir: tmp,
      sleep: tick,
      pollIntervalMs: 1,
      // Deliberately different from the server's number, so a pass cannot be
      // an accident of the two agreeing.
      leaseRenewIntervalMs: 1_000,
    });

    const run = engine.run();
    await vi.waitFor(() => expect(executor.started).toEqual(['slow']));

    expect(scheduler.intervals).toContain(60_000);
    expect(scheduler.intervals).not.toContain(1_000);

    executor.gate('slow').resolve({ ok: true });
    await engine.drain();
    await run;
  });

  it('falls back to its own cadence when the server sends none, or nonsense', async () => {
    // ADDITIVE AND BACKWARD-COMPATIBLE: an older control plane sends no
    // `renewIntervalMs` at all, and a broken one could send a zero — which,
    // taken literally, is a renewal timer firing flat out. Both take the
    // local default and stay correct.
    const rec = recorder();
    const executor = new ControlledExecutor();
    const scheduler = fakeScheduler();

    const engine = new NodeEngine({
      api: fakeApi(
        [[{ ...assignment('a'), renewIntervalMs: 0 }, assignment('b')]],
        rec
      ),
      nodeId: 'node-1',
      concurrency: 2,
      executors: new ExecutorRegistry().register(executor),
      scheduler,
      tmpDir: tmp,
      sleep: tick,
      pollIntervalMs: 1,
      leaseRenewIntervalMs: 7_000,
    });

    const run = engine.run();
    await vi.waitFor(() => expect(executor.started.sort()).toEqual(['a', 'b']));

    expect(scheduler.intervals.filter((ms) => ms === 7_000)).toHaveLength(2);
    expect(scheduler.intervals).not.toContain(0);

    executor.gate('a').resolve({ ok: true });
    executor.gate('b').resolve({ ok: true });
    await engine.drain();
    await run;
  });
});

describe('NodeEngine — failure classification', () => {
  it('reports a rate limit with rateLimited and retryAfterMs', async () => {
    const rec = recorder();
    const executor = new ControlledExecutor();
    const engine = new NodeEngine({
      api: fakeApi([[assignment('throttled')]], rec),
      nodeId: 'node-1',
      concurrency: 1,
      executors: new ExecutorRegistry().register(executor),
      scheduler: fakeScheduler(),
      tmpDir: tmp,
      sleep: tick,
      pollIntervalMs: 1,
    });

    const run = engine.run();
    await vi.waitFor(() => expect(executor.started).toEqual(['throttled']));
    executor.gate('throttled').reject(
      new ProviderRateLimitError('provider said 429', { retryAfterMs: 30_000, provider: 'example' }),
    );

    await vi.waitFor(() => expect(rec.failures).toHaveLength(1));
    expect(rec.failures[0]?.body).toMatchObject({ rateLimited: true, retryAfterMs: 30_000 });
    expect(engine.getSnapshot().counters.rateLimited).toBe(1);

    await engine.drain();
    await run;
  });

  it('does NOT set rateLimited for any other error', async () => {
    const rec = recorder();
    const executor = new ControlledExecutor();
    const engine = new NodeEngine({
      api: fakeApi([[assignment('broken')]], rec),
      nodeId: 'node-1',
      concurrency: 1,
      executors: new ExecutorRegistry().register(executor),
      scheduler: fakeScheduler(),
      tmpDir: tmp,
      sleep: tick,
      pollIntervalMs: 1,
    });

    const run = engine.run();
    await vi.waitFor(() => expect(executor.started).toEqual(['broken']));
    // A message that MENTIONS a rate limit but is not the typed error. The
    // engine must not sniff text.
    executor.gate('broken').reject(new Error('429 rate limit exceeded'));

    await vi.waitFor(() => expect(rec.failures).toHaveLength(1));
    expect(rec.failures[0]?.body.rateLimited).toBeUndefined();
    expect(rec.failures[0]?.body.retryAfterMs).toBeUndefined();

    await engine.drain();
    await run;
  });

  it('clamps an absurd retryAfterMs on our side of the boundary', () => {
    expect(new ProviderRateLimitError('x', { retryAfterMs: 1e15 }).retryAfterMs).toBe(86_400_000);
    expect(new ProviderRateLimitError('x', { retryAfterMs: -5 }).retryAfterMs).toBe(0);
  });

  it('fails an unknown type by naming what this node can run', async () => {
    const rec = recorder();
    const engine = new NodeEngine({
      api: fakeApi([[assignment('mystery', 'video.transcode')]], rec),
      nodeId: 'node-1',
      concurrency: 1,
      executors: new ExecutorRegistry().register(new ControlledExecutor()),
      scheduler: fakeScheduler(),
      tmpDir: tmp,
      sleep: tick,
      pollIntervalMs: 1,
    });

    const run = engine.run();
    await vi.waitFor(() => expect(rec.failures).toHaveLength(1));
    expect(rec.failures[0]?.body.error).toMatch(/video\.transcode[\s\S]*test\.job/);

    await engine.drain();
    await run;
  });
});

describe('NodeEngine — input handling', () => {
  it('produces a NAMED error when an input-requiring type gets no download URL', async () => {
    const rec = recorder();
    const engine = new NodeEngine({
      api: fakeApi([[assignment('needs-input')]], rec, {
        downloadUrl: async () => {
          throw new Error('404 no input object');
        },
      }),
      nodeId: 'node-1',
      concurrency: 1,
      executors: new ExecutorRegistry().register(new ControlledExecutor('test.job', { requiresInput: true })),
      scheduler: fakeScheduler(),
      tmpDir: tmp,
      sleep: tick,
      pollIntervalMs: 1,
    });

    const run = engine.run();
    await vi.waitFor(() => expect(rec.failures).toHaveLength(1));
    // Names the job AND the type — never an empty path surfacing later as
    // `ENOENT ... open ''`.
    expect(rec.failures[0]?.body.error).toContain('needs-input');
    expect(rec.failures[0]?.body.error).toContain('test.job');
    expect(new MissingJobInputError('j', 't').message).toContain('requires an input object');

    await engine.drain();
    await run;
  });

  it('streams the input to a temp file, runs the checksum executor, and removes the file', async () => {
    const rec = recorder();
    const payload = 'the quick brown fox';
    const source = join(tmp, 'source.bin');
    writeFileSync(source, payload);

    const engine = new NodeEngine({
      api: fakeApi([[assignment('sum', 'example.checksum')]], rec, {
        downloadUrl: async () => ({
          url: 'https://storage.example/signed',
          expiresIn: 60,
          expiresAt: '2026-01-01T00:01:00.000Z',
          objectId: 'obj-1',
          size: String(payload.length),
          mimeType: 'application/octet-stream',
        }),
      }),
      nodeId: 'node-1',
      concurrency: 1,
      executors: new ExecutorRegistry().register(new ExampleChecksumExecutor()),
      scheduler: fakeScheduler(),
      tmpDir: join(tmp, 'work'),
      sleep: tick,
      pollIntervalMs: 1,
      fetch: (async () => new Response(payload, { status: 200 })) as typeof globalThis.fetch,
    });

    const run = engine.run();
    await vi.waitFor(() => expect(rec.results).toHaveLength(1));

    const result = rec.results[0]?.result as { sha256: string; bytes: number; computedBy: string };
    expect(result.bytes).toBe(payload.length);
    expect(result.computedBy).toBe('node');
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);

    // ⚠ WAITED FOR, NOT ASSERTED IMMEDIATELY, and the reason is the thing
    // under test. The unlink happens in the engine's `finally`, which runs
    // AFTER the result is submitted -- so `waitFor(results)` above resolves
    // while the temp file may still be on disk. Asserting straight after it
    // raced the cleanup and failed intermittently in CI on a leftover
    // `sum.<id>.input`.
    //
    // The invariant is "the temp file is eventually removed", so waiting for
    // it is the honest assertion. Asserting after `drain()` would also pass,
    // and would quietly test something weaker: that the file is gone once the
    // engine has fully stopped, rather than that each job cleans up after
    // itself.
    await vi.waitFor(() => expect(readdirSync(join(tmp, 'work'))).toEqual([]));

    await engine.drain();
    await run;
  });

  it('removes the temp file when the job FAILS too', async () => {
    const rec = recorder();
    const failing: JobExecutor = {
      type: 'example.checksum',
      requiresInput: true,
      execute: async () => {
        throw new Error('boom');
      },
    };

    const engine = new NodeEngine({
      api: fakeApi([[assignment('sum', 'example.checksum')]], rec, {
        downloadUrl: async () => ({
          url: 'https://storage.example/signed',
          expiresIn: 60,
          expiresAt: '2026-01-01T00:01:00.000Z',
          objectId: 'obj-1',
          size: '4',
          mimeType: 'application/octet-stream',
        }),
      }),
      nodeId: 'node-1',
      concurrency: 1,
      executors: new ExecutorRegistry().register(failing),
      scheduler: fakeScheduler(),
      tmpDir: join(tmp, 'work'),
      sleep: tick,
      pollIntervalMs: 1,
      fetch: (async () => new Response('data', { status: 200 })) as typeof globalThis.fetch,
    });

    const run = engine.run();
    await vi.waitFor(() => expect(rec.failures).toHaveLength(1));
    // Same race as the success case above: the unlink is in the `finally`,
    // which runs after the failure is reported.
    await vi.waitFor(() => expect(readdirSync(join(tmp, 'work'))).toEqual([]));

    await engine.drain();
    await run;
  });
});

describe('NodeEngine — lifecycle and snapshot', () => {
  it('drain finishes in-flight work and stops claiming, WITHOUT deregistering', async () => {
    const rec = recorder();
    const executor = new ControlledExecutor();
    const engine = new NodeEngine({
      api: fakeApi([[assignment('a')]], rec),
      nodeId: 'node-1',
      concurrency: 1,
      executors: new ExecutorRegistry().register(executor),
      scheduler: fakeScheduler(),
      tmpDir: tmp,
      sleep: tick,
      pollIntervalMs: 1,
    });

    const run = engine.run();
    await vi.waitFor(() => expect(executor.started).toEqual(['a']));

    const drained = engine.drain();
    executor.gate('a').resolve({ ok: true });
    await drained;
    await run;

    expect(rec.results).toHaveLength(1);
    expect(rec.deregisters).toBe(0);
  });

  it('stop deregisters by default and does not when told not to', async () => {
    const recA = recorder();
    const engineA = new NodeEngine({
      api: fakeApi([], recA),
      nodeId: 'node-1',
      concurrency: 1,
      executors: new ExecutorRegistry().register(new ControlledExecutor()),
      scheduler: fakeScheduler(),
      tmpDir: tmp,
    });
    await engineA.stop();
    expect(recA.deregisters).toBe(1);
    expect(engineA.getSnapshot().status).toBe('stopped');

    const recB = recorder();
    const engineB = new NodeEngine({
      api: fakeApi([], recB),
      nodeId: 'node-1',
      concurrency: 1,
      executors: new ExecutorRegistry().register(new ControlledExecutor()),
      scheduler: fakeScheduler(),
      tmpDir: tmp,
    });
    await engineB.stop({ deregister: false });
    expect(recB.deregisters).toBe(0);
  });

  it('bounds the history ring at 50', async () => {
    const rec = recorder();
    const batches: NodeJobAssignment[][] = [];
    for (let i = 0; i < 60; i += 1) batches.push([assignment(`job-${i}`)]);

    const executor: JobExecutor = {
      type: 'test.job',
      requiresInput: false,
      execute: async () => ({ ok: true }),
    };

    const engine = new NodeEngine({
      api: fakeApi(batches, rec),
      nodeId: 'node-1',
      concurrency: 1,
      executors: new ExecutorRegistry().register(executor),
      scheduler: fakeScheduler(),
      tmpDir: tmp,
      sleep: tick,
      pollIntervalMs: 1,
    });

    const run = engine.run();
    await vi.waitFor(() => expect(rec.results.length).toBe(60));
    await engine.drain();
    await run;

    const snapshot = engine.getSnapshot();
    expect(snapshot.history).toHaveLength(HISTORY_LIMIT);
    expect(snapshot.history[0]?.jobId).toBe('job-59');
    expect(snapshot.counters.succeeded).toBe(60);
  });

  it('reports heartbeat age from the injected clock', async () => {
    const rec = recorder();
    let clock = 1_000_000;
    const engine = new NodeEngine({
      api: fakeApi([], rec),
      nodeId: 'node-1',
      concurrency: 1,
      executors: new ExecutorRegistry().register(new ControlledExecutor()),
      scheduler: fakeScheduler(),
      tmpDir: tmp,
      sleep: tick,
      now: () => clock,
    });

    expect(engine.getSnapshot().heartbeatAgeMs).toBeNull();

    const run = engine.run();
    await vi.waitFor(() => expect(rec.heartbeats.length).toBeGreaterThan(0));
    clock += 4_000;
    expect(engine.getSnapshot().heartbeatAgeMs).toBe(4_000);

    await engine.drain();
    await run;
  });

  it('survives a claim failure by backing off rather than exiting', async () => {
    const rec = recorder();
    const events: NodeEngineEvent[] = [];
    let calls = 0;

    const engine = new NodeEngine({
      api: fakeApi([], rec, {
        async claim() {
          calls += 1;
          if (calls === 1) throw new Error('API restarting');
          return [];
        },
      }),
      nodeId: 'node-1',
      concurrency: 1,
      executors: new ExecutorRegistry().register(new ControlledExecutor()),
      scheduler: fakeScheduler(),
      tmpDir: tmp,
      sleep: tick,
      pollIntervalMs: 1,
      onEvent: (event) => events.push(event),
    });

    const run = engine.run();
    await vi.waitFor(() => expect(calls).toBeGreaterThan(1));
    expect(events.some((event) => event.kind === 'claim-failed')).toBe(true);

    await engine.drain();
    await run;
  });

  it('never lets a throwing event consumer take the worker down', async () => {
    const rec = recorder();
    const engine = new NodeEngine({
      api: fakeApi([], rec),
      nodeId: 'node-1',
      concurrency: 1,
      executors: new ExecutorRegistry().register(new ControlledExecutor()),
      scheduler: fakeScheduler(),
      tmpDir: tmp,
      sleep: tick,
      pollIntervalMs: 1,
      onEvent: () => {
        throw new Error('a wedged renderer');
      },
    });

    const run = engine.run();
    await vi.waitFor(() => expect(rec.claims.length).toBeGreaterThan(0));
    await engine.drain();
    await expect(run).resolves.toBeUndefined();
  });
});

// =============================================================================
// The claim token (#364)
// =============================================================================
//
// `claimedByNodeId` tells one node from another; it does NOT tell one node
// from itself. These tests pin the two halves of the fix: the token the server
// handed this assignment reaches EVERY call the run makes on the job's behalf,
// and its absence is an ordinary state that changes nothing.
// =============================================================================

describe('NodeEngine — the claim token', () => {
  it('quotes the assignment’s token on renew, on the executor’s context and on the result', async () => {
    const rec = recorder();
    const executor = new ControlledExecutor();
    const scheduler = fakeScheduler();

    const engine = new NodeEngine({
      api: fakeApi([[{ ...assignment('tok'), claimToken: CLAIM_TOKEN }]], rec),
      nodeId: 'node-1',
      concurrency: 1,
      executors: new ExecutorRegistry().register(executor),
      scheduler,
      tmpDir: tmp,
      sleep: tick,
      pollIntervalMs: 1,
    });

    const run = engine.run();
    await vi.waitFor(() => expect(executor.started).toEqual(['tok']));

    // The ticker captured the token when the run began, which is the lifetime
    // that matters: a later claim of the same job must not be able to change
    // what this slot quotes.
    scheduler.fireAll();
    await vi.waitFor(() => expect(rec.renews).toContain('tok'));

    expect(executor.contexts[0]?.claimToken).toBe(CLAIM_TOKEN);

    executor.gate('tok').resolve({ ok: true });
    await vi.waitFor(() => expect(rec.results).toHaveLength(1));

    expect(rec.tokens.filter((entry) => entry.call === 'renew')).toContainEqual({
      call: 'renew',
      jobId: 'tok',
      token: CLAIM_TOKEN,
    });
    expect(rec.tokens).toContainEqual({ call: 'result', jobId: 'tok', token: CLAIM_TOKEN });

    await engine.drain();
    await run;
  });

  it('quotes it on the FAILURE report as well — a stale slot must not settle a live run', async () => {
    const rec = recorder();
    const failing: JobExecutor = {
      type: 'test.job',
      requiresInput: false,
      execute: async () => {
        throw new Error('boom');
      },
    };

    const engine = new NodeEngine({
      api: fakeApi([[{ ...assignment('tok-fail'), claimToken: CLAIM_TOKEN }]], rec),
      nodeId: 'node-1',
      concurrency: 1,
      executors: new ExecutorRegistry().register(failing),
      scheduler: fakeScheduler(),
      tmpDir: tmp,
      sleep: tick,
      pollIntervalMs: 1,
    });

    const run = engine.run();
    await vi.waitFor(() => expect(rec.failures).toHaveLength(1));

    expect(rec.tokens).toContainEqual({ call: 'failure', jobId: 'tok-fail', token: CLAIM_TOKEN });

    await engine.drain();
    await run;
  });

  it('quotes it when fetching the job’s INPUT, too', async () => {
    const rec = recorder();
    const payload = Buffer.from('input-bytes');
    const seen: Array<ClaimToken> = [];

    const engine = new NodeEngine({
      api: fakeApi([[{ ...assignment('tok-input', 'example.checksum'), claimToken: CLAIM_TOKEN }]], rec, {
        downloadUrl: async (_nodeId, _jobId, claimToken) => {
          seen.push(claimToken);
          return {
            url: 'https://storage.example/signed',
            expiresIn: 60,
            expiresAt: '2026-01-01T00:01:00.000Z',
            objectId: 'obj-1',
            size: String(payload.length),
            mimeType: 'application/octet-stream',
          };
        },
      }),
      nodeId: 'node-1',
      concurrency: 1,
      executors: new ExecutorRegistry().register(new ExampleChecksumExecutor()),
      scheduler: fakeScheduler(),
      tmpDir: join(tmp, 'work'),
      sleep: tick,
      pollIntervalMs: 1,
      fetch: (async () => new Response(payload, { status: 200 })) as typeof globalThis.fetch,
    });

    const run = engine.run();
    await vi.waitFor(() => expect(rec.results).toHaveLength(1));

    expect(seen).toEqual([CLAIM_TOKEN]);

    await engine.drain();
    await run;
  });

  it('passes NOTHING — and warns about nothing — when the server sent no token', async () => {
    // A control plane older than #364, or a row claimed before the column
    // existed. This is a steady state, not a degraded one: every call is the
    // pre-#364 request, the job runs and settles normally, and no failure
    // event is emitted anywhere along the way.
    const rec = recorder();
    const executor = new ControlledExecutor();
    const scheduler = fakeScheduler();
    const events: NodeEngineEvent[] = [];

    const engine = new NodeEngine({
      // Note `assignment()` carries no `claimToken` at all, and the second job
      // carries an explicit `null` — the two ways a server says "nothing".
      api: fakeApi([[assignment('no-tok'), { ...assignment('null-tok'), claimToken: null }]], rec),
      nodeId: 'node-1',
      concurrency: 2,
      executors: new ExecutorRegistry().register(executor),
      scheduler,
      tmpDir: tmp,
      sleep: tick,
      pollIntervalMs: 1,
      onEvent: (event) => events.push(event),
    });

    const run = engine.run();
    await vi.waitFor(() => expect(executor.started.sort()).toEqual(['no-tok', 'null-tok']));

    scheduler.fireAll();
    await vi.waitFor(() => expect(rec.renews.length).toBeGreaterThanOrEqual(2));

    executor.gate('no-tok').resolve({ ok: true });
    executor.gate('null-tok').resolve({ ok: true });
    await vi.waitFor(() => expect(rec.results).toHaveLength(2));

    // `undefined` for the missing field; `null` passed through untouched for
    // the explicit one. Neither is rewritten here — `claimTokenBody` is the
    // single place that decides the key is omitted rather than sent.
    expect(rec.tokens.filter((entry) => entry.jobId === 'no-tok').map((entry) => entry.token)).toEqual([
      undefined,
      undefined,
    ]);
    expect(rec.tokens.filter((entry) => entry.jobId === 'null-tok').map((entry) => entry.token)).toEqual([
      null,
      null,
    ]);

    expect(events.some((event) => event.kind === 'lease-renew-failed')).toBe(false);
    expect(events.some((event) => event.kind === 'job-failed')).toBe(false);

    await engine.drain();
    await run;
  });

  it('treats a 409 on renewal exactly as it already treats a lost lease', async () => {
    // A stale slot quoting a superseded token gets the SAME 409 the route
    // already raised for an expired lease, and it is handled the same way: an
    // event, and the run continues to completion. No new teardown path was
    // invented here, deliberately — see `NodeEngine.renewLease`.
    const rec = recorder();
    const executor = new ControlledExecutor();
    const scheduler = fakeScheduler();
    const events: NodeEngineEvent[] = [];

    const engine = new NodeEngine({
      api: fakeApi([[{ ...assignment('superseded'), claimToken: CLAIM_TOKEN }]], rec, {
        async renewLease(_nodeId, jobId, claimToken) {
          rec.tokens.push({ call: 'renew', jobId, token: claimToken });
          throw new ApiError({
            status: 409,
            serverMessage: 'This node no longer holds the job with a live lease',
            code: 'CONFLICT',
            details: { reason: 'lease_not_held' },
            method: 'POST',
            url: `http://h/api/nodes/node-1/jobs/${jobId}/renew`,
            structured: true,
            rawBody: undefined,
          });
        },
      }),
      nodeId: 'node-1',
      concurrency: 1,
      executors: new ExecutorRegistry().register(executor),
      scheduler,
      tmpDir: tmp,
      sleep: tick,
      pollIntervalMs: 1,
      onEvent: (event) => events.push(event),
    });

    const run = engine.run();
    await vi.waitFor(() => expect(executor.started).toEqual(['superseded']));

    scheduler.fireAll();
    await vi.waitFor(() => expect(events.some((event) => event.kind === 'lease-renew-failed')).toBe(true));

    // Still running, exactly as after any other renew failure.
    expect(engine.getSnapshot().activeJobs).toHaveLength(1);

    executor.gate('superseded').resolve({ ok: true });
    await vi.waitFor(() => expect(rec.results).toHaveLength(1));

    await engine.drain();
    await run;
  });
});
