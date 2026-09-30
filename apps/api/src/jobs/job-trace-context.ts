// =============================================================================
// Job trace context (issue #132)
// =============================================================================
//
// A job is enqueued inside one request (or cron tick) and runs later, on
// another slot or another machine. Without something carried on the row, the
// span that runs it is a fresh root and the trace that queued it simply stops
// at the INSERT. This module is the whole of that carriage:
//
//   - `captureJobTraceContext()` — called by `JobsService` at insert time.
//     Reads the ACTIVE context through the globally registered propagator and
//     keeps only the W3C `traceparent` value.
//   - `normalizeTraceparent()` — the single validator: the exact W3C version
//     `00` shape, bounded, or `null`.
//   - `jobParentContext()` — called by the server worker. Turns a stored value
//     back into a context whose span is the enqueuing span, so the job's span
//     can be its CHILD.
//
// WHY ONLY `traceparent`. `tracestate` is vendor-defined, unbounded in
// practice (up to 32 list members) and nothing in this stack sets it. The
// parent identity is all a child span needs; a fixed-width value also keeps
// the column's bound trivially honest.
//
// WHY NONE OF THIS CAN THROW. Tracing is an observer. Every function here
// catches and degrades to "no trace context" — an enqueue or a job must never
// fail because a propagator misbehaved. With the OTel SDK off the global
// propagator is the API's no-op, `inject` writes nothing, and the answer is
// `null` without any special-casing.
// =============================================================================

import { Context, ROOT_CONTEXT, context, propagation } from '@opentelemetry/api';

/** The W3C trace-context header name, and the one key this module keeps. */
export const TRACEPARENT_HEADER = 'traceparent';

/**
 * The upper bound on a stored value. A valid version-`00` traceparent is
 * exactly 55 characters, so the pattern below already implies this; the
 * explicit bound is the column's contract and is checked FIRST so a
 * pathological input is rejected before a regex ever sees it.
 */
export const MAX_TRACE_CONTEXT_LENGTH = 256;

/**
 * Version `00`, a 32-hex trace id, a 16-hex parent span id, 2-hex flags.
 * Lower-case only, as the W3C spec requires of senders.
 */
export const TRACEPARENT_PATTERN = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

const ALL_ZERO_TRACE_ID = '0'.repeat(32);
const ALL_ZERO_SPAN_ID = '0'.repeat(16);

/**
 * `value` if it is a well-formed, bounded W3C traceparent naming a real
 * (non-zero) trace and span, otherwise `null`. Never throws.
 */
export function normalizeTraceparent(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_TRACE_CONTEXT_LENGTH) {
    return null;
  }

  if (!TRACEPARENT_PATTERN.test(value)) {
    return null;
  }

  // All-zero ids are explicitly invalid in the W3C spec; storing one would
  // hand a node (or the extractor below) a parent that names nothing.
  const [, traceId, spanId] = value.split('-');
  if (traceId === ALL_ZERO_TRACE_ID || spanId === ALL_ZERO_SPAN_ID) {
    return null;
  }

  return value;
}

/**
 * The active span's traceparent, for storing on a job row being inserted now,
 * or `null` when nothing is being traced. Never throws.
 */
export function captureJobTraceContext(): string | null {
  try {
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    return normalizeTraceparent(carrier[TRACEPARENT_HEADER]);
  } catch {
    return null;
  }
}

/**
 * The context a job's span should be started under: the enqueuing span's,
 * when the row carries a valid traceparent, otherwise `ROOT_CONTEXT`.
 *
 * ROOT, NOT `context.active()`, for the no-context case. The worker's slot
 * loop has no meaningful ambient span, and a job without a stored parent is a
 * trace of its own — inheriting whatever happened to be active in the loop
 * would attach unrelated jobs to one another. Never throws.
 */
export function jobParentContext(traceContext: string | null | undefined): Context {
  const traceparent = normalizeTraceparent(traceContext);
  if (!traceparent) {
    return ROOT_CONTEXT;
  }

  try {
    return propagation.extract(ROOT_CONTEXT, { [TRACEPARENT_HEADER]: traceparent });
  } catch {
    return ROOT_CONTEXT;
  }
}
