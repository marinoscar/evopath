// =============================================================================
// POST /nodes/:id/telemetry — the node span relay's body (issue #133)
// =============================================================================
//
// A worker node records a handful of PHASE spans per job (download, execute,
// upload, submit, secret) and hands them to this server, which re-emits them
// through its own OpenTelemetry pipeline as children of the job's enqueuing
// span (`jobs.trace_context`, #132). A node never talks to the collector: it
// has no collector address, no exporter credential, and no business holding
// either.
//
// EVERY FIELD HERE IS UNTRUSTED, BOUNDED AND ALLOWLISTED — the argument
// `node-control-plane.dto.ts` makes in its header applies unchanged, and one
// step harder, because what arrives here does not just land in a row: it is
// WRITTEN INTO THE DEPLOYMENT'S TRACE STORE, where an operator reads it as
// fact. So:
//
//   - `.strict()` at every level. An unknown key is a 400 for the whole
//     request, never a silently forwarded attribute.
//   - `name` is an ENUM of the five phases the CLI records. A free-form (or
//     even regex-shaped) name would let a node mint arbitrary span names in
//     the trace store, and high-cardinality names are a storage cost.
//   - `errorType` is a short, identifier-shaped CLASS or CODE
//     (`MissingJobInputError`, `ApiError.409`), never a message. Error
//     messages carry paths, hostnames, URLs — the signed URLs of the data
//     plane among them — and nothing here may carry one.
//   - `attributes` is a CLOSED set of integers. No strings at all, so no
//     key, token, URL or path can ride along in one.
//   - Times are bounded on both ends: no span older than a day, none that
//     ends more than a few minutes in the future (clock skew), none longer
//     than a day. A span outside that window is not a clock problem worth
//     tolerating, it is garbage that would distort every latency chart.
//
// WHAT IS DELIBERATELY *NOT* HERE: `nodeId`, `traceId`, `spanId`, a parent.
// Identity comes from the PATH, after ownership is proven; the parent comes
// from the job row the server already holds. A node that could name its own
// trace could graft spans onto any trace it had ever seen an id for.
// =============================================================================

import { ApiProperty } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** The phase spans a node may relay. Adding one is an API change, on purpose. */
export const NODE_SPAN_NAMES = [
  'job.download',
  'job.execute',
  'job.upload',
  'job.submit',
  'job.secret',
] as const;

export type NodeSpanName = (typeof NODE_SPAN_NAMES)[number];

/** Spans per request. A job produces about five; this is ten jobs' worth. */
export const MAX_NODE_SPANS_PER_REQUEST = 50;

/** One day, in milliseconds — the longest span, and the oldest start, accepted. */
export const MAX_NODE_SPAN_DURATION_MS = 24 * 60 * 60 * 1000;
export const MAX_NODE_SPAN_AGE_MS = 24 * 60 * 60 * 1000;

/** How far a span may END in the future: node clock skew, nothing more. */
export const MAX_NODE_SPAN_FUTURE_SKEW_MS = 5 * 60 * 1000;

/** Cap on `errorType`. A class or code name, not a sentence. */
export const MAX_NODE_SPAN_ERROR_TYPE_LENGTH = 64;

/** Identifier-shaped only: no spaces, slashes, colons or quotes, so no URL or path fits. */
export const NODE_SPAN_ERROR_TYPE_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * The closed attribute set. Integers only — see the header. `bytes` is capped
 * at 2^53-1 so it survives JSON exactly; a larger transfer is reported as
 * that ceiling's absence (the CLI omits it) rather than as a rounded number.
 */
export const nodeSpanAttributesSchema = z
  .object({
    bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    attempt: z.number().int().min(0).max(10_000).optional(),
    exitCode: z.number().int().min(-1024).max(1024).optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
  })
  .strict();

export type NodeSpanAttributes = z.infer<typeof nodeSpanAttributesSchema>;

export const nodeSpanSchema = z
  .object({
    jobId: z.uuid(),
    name: z.enum(NODE_SPAN_NAMES),
    startTimeUnixMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    durationMs: z.number().int().min(0).max(MAX_NODE_SPAN_DURATION_MS),
    status: z.enum(['ok', 'error']),
    errorType: z
      .string()
      .min(1)
      .max(MAX_NODE_SPAN_ERROR_TYPE_LENGTH)
      .regex(NODE_SPAN_ERROR_TYPE_PATTERN, 'Must be an identifier-shaped error class or code')
      .optional(),
    attributes: nodeSpanAttributesSchema.optional(),
  })
  .strict()
  // THE TIME WINDOW, read against the server's clock at parse time. It is a
  // refinement rather than a `.min()` because the bound moves; the static
  // bounds above are what the published schema can state.
  .superRefine((span, ctx) => {
    const now = Date.now();

    if (span.startTimeUnixMs < now - MAX_NODE_SPAN_AGE_MS) {
      ctx.addIssue({
        code: 'custom',
        path: ['startTimeUnixMs'],
        message: `Span starts more than ${MAX_NODE_SPAN_AGE_MS / 3_600_000}h in the past`,
      });
    }

    if (span.startTimeUnixMs + span.durationMs > now + MAX_NODE_SPAN_FUTURE_SKEW_MS) {
      ctx.addIssue({
        code: 'custom',
        path: ['startTimeUnixMs'],
        message: `Span ends more than ${MAX_NODE_SPAN_FUTURE_SKEW_MS / 60_000} minutes in the future`,
      });
    }
  });

export type NodeSpan = z.infer<typeof nodeSpanSchema>;

export const nodeTelemetrySchema = z
  .object({
    spans: z.array(nodeSpanSchema).min(1).max(MAX_NODE_SPANS_PER_REQUEST),
  })
  .strict();

export class NodeTelemetryDto extends createZodDto(nodeTelemetrySchema) {}

/** The response to `POST /nodes/:id/telemetry`. */
export class NodeTelemetryResponseDto {
  @ApiProperty({
    description:
      'Spans attributed to this node and handed to the server’s tracing pipeline. Emission is ' +
      'best-effort: with tracing off, an accepted span is simply discarded by the no-op tracer.',
    minimum: 0,
  })
  accepted!: number;

  @ApiProperty({
    description:
      'Spans refused because their job does not exist or is not attributable to this node ' +
      '(neither held by it now nor settled by it within the grace window). Dropped spans are ' +
      'not an error and must not be resent.',
    minimum: 0,
  })
  dropped!: number;
}
