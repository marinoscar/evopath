import type { NodeApi, NodeSpan, NodeSpanAttributes, NodeSpanName } from './node-api.js';
import { ApiError } from '../errors.js';

// =============================================================================
// Job phase spans, recorded here and relayed to the server  (issue #133)
// =============================================================================
//
// A worker records WHEN each phase of a job ran (download, execute, upload,
// submit, secret) and hands those timings to `POST /api/nodes/:id/telemetry`.
// The server re-emits them as OpenTelemetry spans under the job's enqueuing
// trace. The node never talks to a collector, holds no exporter endpoint, and
// takes no new dependency: a span here is five numbers and a name.
//
// ⚠ TELEMETRY NEVER DELAYS OR FAILS A JOB. Recording is synchronous
// arithmetic that cannot throw into the job; SENDING happens after the job has
// settled, off the job's promise, through a bounded queue. Every failure of
// the relay is swallowed:
//
//   - 404: the server predates the relay (or forgot this node). Span sending
//     is DISABLED for the rest of the process and announced once — retrying a
//     route that does not exist on every job would be a steady trickle of
//     pointless requests.
//   - 400 / 403 / 429 / anything else: this batch is dropped, silently. A 400
//     is a contract mismatch no retry fixes; a 429 is the server asking for
//     less, and resending is the opposite.
//
// ⚠ NO MESSAGE EVER LEAVES AS A SPAN. An errored phase carries `errorType` —
// the error's class name, plus an HTTP status or an errno-style code when
// there is one — sanitised to the server's identifier-only shape. Messages
// carry paths, hosts and signed URLs; the server would refuse them anyway,
// and this side does not offer.
// =============================================================================

/** Spans the server accepts per request. Mirrors `MAX_NODE_SPANS_PER_REQUEST`. */
export const MAX_SPANS_PER_BATCH = 50;

/** Spans held while waiting to send. Past this the OLDEST are dropped. */
export const DEFAULT_MAX_QUEUED_SPANS = 500;

/** Mirrors the server's `NODE_SPAN_ERROR_TYPE_PATTERN` and length cap. */
const ERROR_TYPE_MAX_LENGTH = 64;

/** The server's `durationMs` ceiling (one day). */
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

/**
 * An identifier-shaped error type for `error`: its class name, plus an HTTP
 * status (`ApiError.409`) or a string `code` (`Error.ECONNRESET`). Never its
 * message. Characters outside `[A-Za-z0-9_.-]` are replaced, and the result
 * is capped at 64. Never throws.
 */
export function errorTypeOf(error: unknown): string {
  try {
    let name = 'Error';
    let suffix: string | undefined;

    if (error instanceof ApiError) {
      name = 'ApiError';
      suffix = String(error.status);
    } else if (error instanceof Error) {
      name = error.name && error.name !== 'Error' ? error.name : error.constructor?.name || 'Error';
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string' || typeof code === 'number') suffix = String(code);
    } else {
      name = typeof error;
    }

    const raw = suffix === undefined ? name : `${name}.${suffix}`;
    const clean = raw.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, ERROR_TYPE_MAX_LENGTH);
    return clean.length > 0 ? clean : 'Error';
  } catch {
    return 'Error';
  }
}

/** Keeps only safe, non-negative-where-required integers the server will take. */
function cleanAttributes(attributes: NodeSpanAttributes | undefined): NodeSpanAttributes | undefined {
  if (attributes === undefined) return undefined;
  const out: NodeSpanAttributes = {};
  const { bytes, attempt, exitCode, httpStatus } = attributes;
  if (Number.isSafeInteger(bytes) && (bytes as number) >= 0) out.bytes = bytes;
  if (Number.isSafeInteger(attempt) && (attempt as number) >= 0 && (attempt as number) <= 10_000) out.attempt = attempt;
  if (Number.isSafeInteger(exitCode) && Math.abs(exitCode as number) <= 1024) out.exitCode = exitCode;
  if (Number.isSafeInteger(httpStatus) && (httpStatus as number) >= 100 && (httpStatus as number) <= 599) out.httpStatus = httpStatus;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The spans of ONE job, recorded as it runs. Every method is synchronous and
 * swallows its own faults: recording must never be the reason a job failed.
 */
export class JobSpanRecorder {
  private readonly spans: NodeSpan[] = [];

  constructor(
    readonly jobId: string,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Times `work` as phase `name`, recording `ok` or `error`, and returns (or
   * rethrows) exactly what `work` did. `attributes` may be a function of the
   * result, for a phase whose byte count is only known at the end.
   */
  async phase<T>(
    name: NodeSpanName,
    work: () => Promise<T>,
    attributes?: NodeSpanAttributes | ((result: T) => NodeSpanAttributes | undefined),
  ): Promise<T> {
    const start = this.now();
    let result: T;
    try {
      result = await work();
    } catch (error) {
      this.record(name, start, 'error', errorTypeOf(error), typeof attributes === 'function' ? undefined : attributes);
      throw error;
    }
    let resolved: NodeSpanAttributes | undefined;
    try {
      resolved = typeof attributes === 'function' ? attributes(result) : attributes;
    } catch {
      resolved = undefined;
    }
    this.record(name, start, 'ok', undefined, resolved);
    return result;
  }

  /** Records a phase that has already happened. Never throws. */
  record(
    name: NodeSpanName,
    startTimeUnixMs: number,
    status: 'ok' | 'error',
    errorType?: string,
    attributes?: NodeSpanAttributes,
  ): void {
    try {
      const durationMs = Math.min(MAX_DURATION_MS, Math.max(0, Math.round(this.now() - startTimeUnixMs)));
      const clean = cleanAttributes(attributes);
      this.spans.push({
        jobId: this.jobId,
        name,
        startTimeUnixMs: Math.round(startTimeUnixMs),
        durationMs,
        status,
        ...(status === 'error' && errorType !== undefined ? { errorType } : {}),
        ...(clean !== undefined ? { attributes: clean } : {}),
      });
    } catch {
      // Best-effort; see the header.
    }
  }

  /** Everything recorded so far, in order. */
  drain(): NodeSpan[] {
    return this.spans.splice(0, this.spans.length);
  }
}

export interface NodeSpanRelayOptions {
  api: NodeApi;
  nodeId: string;
  maxQueuedSpans?: number | undefined;
  /** Called ONCE, when a 404 disables the relay for this process. */
  onDisabled?: ((reason: string) => void) | undefined;
}

/**
 * The bounded, best-effort sender. One send in flight at a time; batches of at
 * most `MAX_SPANS_PER_BATCH`; the oldest spans dropped when the queue is full.
 */
export class NodeSpanRelay {
  private readonly api: NodeApi;
  private readonly nodeId: string;
  private readonly maxQueuedSpans: number;
  private readonly onDisabled: ((reason: string) => void) | undefined;
  private readonly queue: NodeSpan[] = [];
  private pumping: Promise<void> | undefined;
  private disabled: boolean;

  /** Spans discarded because the queue was full. For tests and diagnostics. */
  droppedForCapacity = 0;

  constructor(options: NodeSpanRelayOptions) {
    this.api = options.api;
    this.nodeId = options.nodeId;
    this.maxQueuedSpans = Math.max(1, options.maxQueuedSpans ?? DEFAULT_MAX_QUEUED_SPANS);
    this.onDisabled = options.onDisabled;
    // A `NodeApi` without the method (a test fake, an embedding that opted
    // out) is simply a relay that is off.
    this.disabled = typeof this.api.telemetry !== 'function';
  }

  get enabled(): boolean {
    return !this.disabled;
  }

  get queued(): number {
    return this.queue.length;
  }

  /** Queues `spans` and starts sending if idle. Never throws, never awaits. */
  enqueue(spans: NodeSpan[]): void {
    if (this.disabled || spans.length === 0) return;
    this.queue.push(...spans);
    const overflow = this.queue.length - this.maxQueuedSpans;
    if (overflow > 0) {
      this.queue.splice(0, overflow);
      this.droppedForCapacity += overflow;
    }
    if (this.pumping === undefined) {
      this.pumping = this.pump().finally(() => {
        this.pumping = undefined;
      });
    }
  }

  /** Resolves once the queue is empty (or the relay disabled). Never rejects. */
  async flush(): Promise<void> {
    while (this.pumping !== undefined) {
      await this.pumping;
    }
  }

  private async pump(): Promise<void> {
    while (!this.disabled && this.queue.length > 0) {
      const batch = this.queue.splice(0, MAX_SPANS_PER_BATCH);
      try {
        await this.api.telemetry!(this.nodeId, { spans: batch });
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          this.disabled = true;
          this.queue.length = 0;
          try {
            this.onDisabled?.(`${error.status}: ${error.serverMessage}`);
          } catch {
            // An observer must not break the relay.
          }
          return;
        }
        // Any other failure: this batch is gone. See the header.
      }
    }
  }
}
