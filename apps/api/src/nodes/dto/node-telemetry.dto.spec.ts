// =============================================================================
// The span relay body (issue #133): strict, bounded, allowlisted
// =============================================================================

import {
  MAX_NODE_SPAN_AGE_MS,
  MAX_NODE_SPAN_DURATION_MS,
  MAX_NODE_SPAN_FUTURE_SKEW_MS,
  MAX_NODE_SPANS_PER_REQUEST,
  NODE_SPAN_NAMES,
  nodeTelemetrySchema,
} from './node-telemetry.dto';

describe('nodeTelemetrySchema', () => {
  const JOB_ID = '22222222-2222-4222-8222-222222222222';

  const span = (overrides: Record<string, unknown> = {}) => ({
    jobId: JOB_ID,
    name: 'job.execute',
    startTimeUnixMs: Date.now() - 5_000,
    durationMs: 1_200,
    status: 'ok',
    ...overrides,
  });

  const parse = (body: unknown) => nodeTelemetrySchema.safeParse(body);

  it('accepts a minimal span and a fully populated one', () => {
    expect(parse({ spans: [span()] }).success).toBe(true);
    expect(
      parse({
        spans: [
          span({
            name: 'job.download',
            status: 'error',
            errorType: 'MissingJobInputError',
            attributes: { bytes: 1024, attempt: 2, exitCode: 1, httpStatus: 404 },
          }),
        ],
      }).success
    ).toBe(true);
  });

  it.each(NODE_SPAN_NAMES)('accepts the phase name %s', (name) => {
    expect(parse({ spans: [span({ name })] }).success).toBe(true);
  });

  it.each(['job.other', 'http.request', 'job.execute ', 'JOB.EXECUTE', ''])(
    'refuses the span name %p',
    (name) => {
      expect(parse({ spans: [span({ name })] }).success).toBe(false);
    }
  );

  it('refuses an empty batch and one over the cap', () => {
    expect(parse({ spans: [] }).success).toBe(false);
    expect(
      parse({ spans: Array.from({ length: MAX_NODE_SPANS_PER_REQUEST + 1 }, () => span()) }).success
    ).toBe(false);
    expect(
      parse({ spans: Array.from({ length: MAX_NODE_SPANS_PER_REQUEST }, () => span()) }).success
    ).toBe(true);
  });

  it('refuses unknown keys at every level', () => {
    expect(parse({ spans: [span()], nodeId: 'x' }).success).toBe(false);
    expect(parse({ spans: [span({ traceId: 'a'.repeat(32) })] }).success).toBe(false);
    expect(parse({ spans: [span({ message: 'boom' })] }).success).toBe(false);
    expect(parse({ spans: [span({ attributes: { url: 1 } })] }).success).toBe(false);
  });

  it('refuses a string attribute value, even under an allowlisted key', () => {
    expect(parse({ spans: [span({ attributes: { bytes: '1024' } })] }).success).toBe(false);
  });

  it('refuses out-of-range attributes', () => {
    expect(parse({ spans: [span({ attributes: { bytes: -1 } })] }).success).toBe(false);
    expect(parse({ spans: [span({ attributes: { bytes: 1.5 } })] }).success).toBe(false);
    expect(parse({ spans: [span({ attributes: { httpStatus: 99 } })] }).success).toBe(false);
  });

  it('refuses a free-form errorType — no spaces, slashes, colons or overlong names', () => {
    for (const errorType of [
      'connect ECONNREFUSED 10.0.0.1:5432',
      'https://bucket/key?X-Amz-Signature=abc',
      '/var/lib/node/state',
      'x'.repeat(65),
      '',
    ]) {
      expect(parse({ spans: [span({ status: 'error', errorType })] }).success).toBe(false);
    }
    expect(parse({ spans: [span({ status: 'error', errorType: 'ApiError.409' })] }).success).toBe(
      true
    );
  });

  it('refuses a non-uuid jobId and an unknown status', () => {
    expect(parse({ spans: [span({ jobId: 'job-1' })] }).success).toBe(false);
    expect(parse({ spans: [span({ status: 'unset' })] }).success).toBe(false);
  });

  it('refuses a span that starts more than a day ago', () => {
    expect(
      parse({ spans: [span({ startTimeUnixMs: Date.now() - MAX_NODE_SPAN_AGE_MS - 60_000 })] })
        .success
    ).toBe(false);
  });

  it('refuses a span that ends too far in the future, but tolerates small skew', () => {
    expect(
      parse({
        spans: [span({ startTimeUnixMs: Date.now() + MAX_NODE_SPAN_FUTURE_SKEW_MS + 60_000 })],
      }).success
    ).toBe(false);
    expect(parse({ spans: [span({ startTimeUnixMs: Date.now() + 30_000 })] }).success).toBe(true);
  });

  it('refuses a negative, fractional or over-long duration', () => {
    expect(parse({ spans: [span({ durationMs: -1 })] }).success).toBe(false);
    expect(parse({ spans: [span({ durationMs: 1.5 })] }).success).toBe(false);
    expect(
      parse({ spans: [span({ durationMs: MAX_NODE_SPAN_DURATION_MS + 1 })] }).success
    ).toBe(false);
  });
});
