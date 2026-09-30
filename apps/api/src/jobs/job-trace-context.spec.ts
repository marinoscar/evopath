// =============================================================================
// Unit tests for the job trace-context helpers (issue #132)
// =============================================================================

import { ROOT_CONTEXT, context, propagation, trace } from '@opentelemetry/api';

import { installTestTracing, TestTracing } from '../../test/helpers/otel-tracing.helper';
import {
  captureJobTraceContext,
  jobParentContext,
  MAX_TRACE_CONTEXT_LENGTH,
  normalizeTraceparent,
} from './job-trace-context';

const VALID = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('normalizeTraceparent', () => {
  it('keeps a well-formed version-00 traceparent verbatim', () => {
    expect(normalizeTraceparent(VALID)).toBe(VALID);
    expect(normalizeTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00')).toBe(
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00'
    );
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['an empty string', ''],
    ['upper-case hex', VALID.toUpperCase()],
    ['another version', VALID.replace(/^00/, '01')],
    ['a short trace id', '00-4bf92f3577b34da6a3ce929d0e0e473-00f067aa0ba902b7-01'],
    ['a short span id', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b-01'],
    ['trailing data', `${VALID}-extra`],
    ['surrounding whitespace', ` ${VALID} `],
    ['an all-zero trace id', `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`],
    ['an all-zero span id', `00-4bf92f3577b34da6a3ce929d0e0e4736-${'0'.repeat(16)}-01`],
    ['an over-long value', 'a'.repeat(MAX_TRACE_CONTEXT_LENGTH + 1)],
  ])('drops %s', (_label, value) => {
    expect(normalizeTraceparent(value)).toBeNull();
  });
});

describe('captureJobTraceContext', () => {
  describe('with no tracing installed (OTel off)', () => {
    it('returns null — the API no-op propagator writes nothing', () => {
      expect(captureJobTraceContext()).toBeNull();
    });
  });

  describe('with tracing installed', () => {
    let tracing: TestTracing;

    beforeEach(() => {
      tracing = installTestTracing();
    });

    afterEach(() => {
      tracing.uninstall();
      jest.restoreAllMocks();
    });

    it('returns the ACTIVE span as a traceparent', () => {
      tracing.tracer.startActiveSpan('request', (span) => {
        const { traceId, spanId } = span.spanContext();
        expect(captureJobTraceContext()).toBe(`00-${traceId}-${spanId}-01`);
        span.end();
      });
    });

    it('follows the active span across an await', async () => {
      await tracing.tracer.startActiveSpan('request', async (span) => {
        await Promise.resolve();
        expect(captureJobTraceContext()).toContain(span.spanContext().spanId);
        span.end();
      });
    });

    it('returns null when no span is active', () => {
      expect(captureJobTraceContext()).toBeNull();
    });

    it('drops a propagator value that is not a valid traceparent', () => {
      jest.spyOn(propagation, 'inject').mockImplementation((_ctx, carrier) => {
        (carrier as Record<string, string>).traceparent = 'garbage';
      });
      expect(captureJobTraceContext()).toBeNull();
    });

    it('never throws, even when the propagator does', () => {
      jest.spyOn(propagation, 'inject').mockImplementation(() => {
        throw new Error('propagator exploded');
      });
      expect(captureJobTraceContext()).toBeNull();
    });
  });
});

describe('jobParentContext', () => {
  let tracing: TestTracing;

  beforeEach(() => {
    tracing = installTestTracing();
  });

  afterEach(() => {
    tracing.uninstall();
    jest.restoreAllMocks();
  });

  it('returns a context whose span is the stored parent', () => {
    const parent = trace.getSpanContext(jobParentContext(VALID));
    expect(parent).toMatchObject({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      isRemote: true,
    });
  });

  it.each([null, undefined, 'garbage'])('returns ROOT_CONTEXT for %p', (value) => {
    expect(jobParentContext(value)).toBe(ROOT_CONTEXT);
  });

  it('does not inherit the ambient active span when the row has no context', () => {
    tracing.tracer.startActiveSpan('slot-loop', (span) => {
      expect(trace.getSpanContext(jobParentContext(null))).toBeUndefined();
      expect(trace.getSpanContext(context.active())).toBeDefined();
      span.end();
    });
  });

  it('never throws, even when the propagator does', () => {
    jest.spyOn(propagation, 'extract').mockImplementation(() => {
      throw new Error('propagator exploded');
    });
    expect(jobParentContext(VALID)).toBe(ROOT_CONTEXT);
  });
});
