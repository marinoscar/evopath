import { APP_SLUG } from '@app/shared';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { resourceFromAttributes, type Resource } from '@opentelemetry/resources';
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type LogRecordExporter,
  type ReadableLogRecord,
} from '@opentelemetry/sdk-logs';
import {
  AggregationTemporality,
  InstrumentType,
  type PushMetricExporter,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
// Transitive (it is what every OTLP HTTP exporter serializes with), imported
// here on purpose: the grouping behaviour under test lives in it.
import { JsonLogsSerializer, JsonTraceSerializer } from '@opentelemetry/otlp-transformer';

import { ATTR_APP_INSTANCE_ID } from './instance-id';
import {
  GatedLogRecordExporter,
  GatedPushMetricExporter,
  GatedSpanExporter,
  stampResource,
  telemetryGate,
} from './telemetry-gate';

// =============================================================================
// Runtime telemetry gate (issue #532, epic #528)
// =============================================================================
//
// The gate is the only thing standing between an installed SDK (OTEL_ENABLED)
// and an administrator who switched telemetry off, so the properties proven
// here are: it starts CLOSED, a closed gate never reaches the inner exporter
// yet acknowledges the batch as SUCCESS (dropping is intended, not an error to
// retry), an open gate delegates the callback verbatim, and lifecycle calls
// always delegate whatever the gate says — a shutdown must flush even when
// export is off.
//
// And, since #565, that everything an open gate lets through carries the
// current `app.instance.id` on its resource — `APP_SLUG` until told otherwise
// — WITHOUT losing the resource's other attributes, without mutating the
// record the rest of the SDK still holds, and without splitting one batch into
// one OTLP `ResourceSpans`/`ResourceLogs` per record (the transformer groups
// by resource identity).
// =============================================================================

const RESOURCE = resourceFromAttributes({ 'service.name': 'my-app-api', 'deployment.environment': 'test' });

type Case = {
  name: string;
  make: () => {
    gated: { export(items: unknown, cb: (r: ExportResult) => void): void; shutdown(): Promise<void>; forceFlush(): Promise<void> };
    inner: { export: jest.Mock; shutdown: jest.Mock; forceFlush: jest.Mock };
    payload: unknown;
    /** The resource(s) the inner exporter received, in order. */
    exportedResources: (call: unknown[]) => Resource[];
  };
};

function innerMock() {
  return {
    export: jest.fn((_items: unknown, cb: (r: ExportResult) => void) =>
      cb({ code: ExportResultCode.SUCCESS }),
    ),
    shutdown: jest.fn().mockResolvedValue(undefined),
    forceFlush: jest.fn().mockResolvedValue(undefined),
  };
}

const cases: Case[] = [
  {
    name: 'GatedSpanExporter',
    make: () => {
      const inner = innerMock();
      const gated = new GatedSpanExporter(inner as unknown as SpanExporter);
      return {
        gated: gated as never,
        inner,
        payload: [{ name: 'span', resource: RESOURCE }] as unknown as ReadableSpan[],
        exportedResources: (call) => (call[0] as ReadableSpan[]).map((span) => span.resource),
      };
    },
  },
  {
    name: 'GatedLogRecordExporter',
    make: () => {
      const inner = innerMock();
      const gated = new GatedLogRecordExporter(inner as unknown as LogRecordExporter);
      return {
        gated: gated as never,
        inner,
        payload: [{ body: 'log', resource: RESOURCE }],
        exportedResources: (call) => (call[0] as ReadableLogRecord[]).map((log) => log.resource),
      };
    },
  },
  {
    name: 'GatedPushMetricExporter',
    make: () => {
      const inner = innerMock();
      const gated = new GatedPushMetricExporter(inner as unknown as PushMetricExporter);
      return {
        gated: gated as never,
        inner,
        payload: { resource: RESOURCE, scopeMetrics: [] } as unknown as ResourceMetrics,
        exportedResources: (call) => [(call[0] as ResourceMetrics).resource],
      };
    },
  },
];

function resetGate(): void {
  telemetryGate.setEnabled(false);
  telemetryGate.setInstanceId(APP_SLUG);
}

describe('telemetryGate', () => {
  afterEach(resetGate);

  it('starts closed', () => {
    // Evaluated in a fresh module registry so an earlier test's setEnabled()
    // cannot mask the initial state.
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fresh = require('./telemetry-gate') as typeof import('./telemetry-gate');
      expect(fresh.telemetryGate.isEnabled()).toBe(false);
    });
  });

  it('starts with APP_SLUG as the instance id, so the first batch is never unlabelled', () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fresh = require('./telemetry-gate') as typeof import('./telemetry-gate');
      expect(fresh.telemetryGate.instanceId()).toBe(APP_SLUG);
    });
  });

  it('reflects setInstanceId', () => {
    telemetryGate.setInstanceId('prod-eu');
    expect(telemetryGate.instanceId()).toBe('prod-eu');
  });

  it('reflects setEnabled', () => {
    telemetryGate.setEnabled(true);
    expect(telemetryGate.isEnabled()).toBe(true);
    telemetryGate.setEnabled(false);
    expect(telemetryGate.isEnabled()).toBe(false);
  });
});

describe.each(cases)('$name', ({ make }) => {
  afterEach(resetGate);

  it('drops the batch while the gate is closed, reporting SUCCESS', () => {
    const { gated, inner, payload } = make();
    const cb = jest.fn();

    gated.export(payload, cb);

    expect(inner.export).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ code: ExportResultCode.SUCCESS });
  });

  it('delegates the batch and the callback verbatim while the gate is open', () => {
    const { gated, inner, payload } = make();
    const cb = jest.fn();
    telemetryGate.setEnabled(true);

    gated.export(payload, cb);

    expect(inner.export).toHaveBeenCalledTimes(1);
    expect(inner.export.mock.calls[0][1]).toBe(cb);
    expect(cb).toHaveBeenCalledWith({ code: ExportResultCode.SUCCESS });
  });

  it('stamps app.instance.id = APP_SLUG by default, keeping every other resource attribute', () => {
    const { gated, inner, payload, exportedResources } = make();
    telemetryGate.setEnabled(true);

    gated.export(payload, jest.fn());

    const [resource] = exportedResources(inner.export.mock.calls[0]);
    expect(resource.attributes).toEqual({
      'service.name': 'my-app-api',
      'deployment.environment': 'test',
      [ATTR_APP_INSTANCE_ID]: APP_SLUG,
    });
  });

  it('stamps an administrator-set id, and a change applies to the very next batch', () => {
    const { gated, inner, payload, exportedResources } = make();
    telemetryGate.setEnabled(true);
    telemetryGate.setInstanceId('prod-eu');

    gated.export(payload, jest.fn());
    telemetryGate.setInstanceId('staging');
    gated.export(payload, jest.fn());

    expect(exportedResources(inner.export.mock.calls[0])[0].attributes[ATTR_APP_INSTANCE_ID]).toBe('prod-eu');
    expect(exportedResources(inner.export.mock.calls[1])[0].attributes[ATTR_APP_INSTANCE_ID]).toBe('staging');
  });

  it('never mutates the original resource or batch', () => {
    const { gated, payload } = make();
    telemetryGate.setEnabled(true);
    telemetryGate.setInstanceId('prod-eu');

    gated.export(payload, jest.fn());

    expect(RESOURCE.attributes).not.toHaveProperty(ATTR_APP_INSTANCE_ID);
    const originals = Array.isArray(payload) ? payload : [payload];
    for (const original of originals as Array<{ resource: Resource }>) {
      expect(original.resource).toBe(RESOURCE);
    }
  });

  it('observes the gate per call, not at construction', () => {
    const { gated, inner, payload } = make();

    gated.export(payload, jest.fn());
    telemetryGate.setEnabled(true);
    gated.export(payload, jest.fn());

    expect(inner.export).toHaveBeenCalledTimes(1);
  });

  it('delegates shutdown and forceFlush even while closed', async () => {
    const { gated, inner } = make();

    await gated.shutdown();
    await gated.forceFlush();

    expect(inner.shutdown).toHaveBeenCalledTimes(1);
    expect(inner.forceFlush).toHaveBeenCalledTimes(1);
  });
});

describe('GatedSpanExporter without an inner forceFlush', () => {
  it('resolves forceFlush instead of throwing', async () => {
    const inner = { export: jest.fn(), shutdown: jest.fn().mockResolvedValue(undefined) };
    const gated = new GatedSpanExporter(inner as unknown as SpanExporter);

    await expect(gated.forceFlush()).resolves.toBeUndefined();
  });
});

describe('GatedPushMetricExporter aggregation selectors', () => {
  it('delegates selectAggregationTemporality and selectAggregation when the inner has them', () => {
    const inner = {
      ...innerMock(),
      selectAggregationTemporality: jest.fn(() => AggregationTemporality.DELTA),
      selectAggregation: jest.fn(() => ({ type: 'DEFAULT' })),
    };
    const gated = new GatedPushMetricExporter(inner as unknown as PushMetricExporter);

    expect(gated.selectAggregationTemporality?.(InstrumentType.COUNTER)).toBe(
      AggregationTemporality.DELTA,
    );
    expect(inner.selectAggregationTemporality).toHaveBeenCalledWith(InstrumentType.COUNTER);
    expect(gated.selectAggregation?.(InstrumentType.HISTOGRAM)).toEqual({ type: 'DEFAULT' });
    expect(inner.selectAggregation).toHaveBeenCalledWith(InstrumentType.HISTOGRAM);
  });

  it('leaves the selectors undefined when the inner lacks them, so the reader keeps its defaults', () => {
    const gated = new GatedPushMetricExporter(innerMock() as unknown as PushMetricExporter);

    expect(gated.selectAggregationTemporality).toBeUndefined();
    expect(gated.selectAggregation).toBeUndefined();
  });
});

describe('stampResource', () => {
  afterEach(resetGate);

  it('lets the stamped id win over an app.instance.id already on the resource', () => {
    const preset = resourceFromAttributes({ 'service.name': 'x', [ATTR_APP_INSTANCE_ID]: 'from-env' });
    telemetryGate.setInstanceId('prod-eu');

    expect(stampResource(preset).attributes).toEqual({ 'service.name': 'x', [ATTR_APP_INSTANCE_ID]: 'prod-eu' });
  });

  it('returns the SAME object for the same source and id, and a new one when the id changes', () => {
    const first = stampResource(RESOURCE);
    expect(stampResource(RESOURCE)).toBe(first);

    telemetryGate.setInstanceId('staging');
    const second = stampResource(RESOURCE);
    expect(second).not.toBe(first);
    expect(stampResource(RESOURCE)).toBe(second);
  });
});

// -----------------------------------------------------------------------------
// Against the real SDK and the real OTLP transformer
// -----------------------------------------------------------------------------
//
// The unit cases above use plain objects. These run real `SpanImpl` /
// `LogRecordImpl` instances through the gate into the transformer the OTLP
// exporters use, which is what proves the wrapper keeps every prototype getter
// working and that a batch sharing a resource stays ONE resource group.

/** Captures what the gate hands on, then lets the test transform it. */
class CapturingExporter<T> {
  batches: T[][] = [];
  export(items: T[], cb: (r: ExportResult) => void): void {
    this.batches.push(items);
    cb({ code: ExportResultCode.SUCCESS });
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

/** What the OTLP HTTP exporter would put on the wire, parsed back. */
function serialized<T>(serializer: { serializeRequest(items: T[]): Uint8Array | undefined }, items: T[]) {
  return JSON.parse(Buffer.from(serializer.serializeRequest(items)!).toString('utf8'));
}

function otlpAttributes(resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> }) {
  return Object.fromEntries(resource.attributes.map((a) => [a.key, a.value.stringValue]));
}

describe('stamping real SDK records through the OTLP transformer', () => {
  afterEach(resetGate);

  it('spans: one ResourceSpans with the stamped resource, span fields intact', async () => {
    const capture = new CapturingExporter<ReadableSpan>();
    const provider = new BasicTracerProvider({
      resource: RESOURCE,
      spanProcessors: [new SimpleSpanProcessor(new GatedSpanExporter(capture as unknown as SpanExporter))],
    });
    telemetryGate.setEnabled(true);
    telemetryGate.setInstanceId('prod-eu');

    const tracer = provider.getTracer('test');
    tracer.startSpan('a').end();
    tracer.startSpan('b').end();
    await provider.forceFlush();

    const spans = capture.batches.flat();
    expect(spans.map((span) => span.name)).toEqual(['a', 'b']);
    // Prototype methods and getters still work through the wrapper.
    expect(spans[0].spanContext().spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(spans[0].droppedAttributesCount).toBe(0);

    const request = serialized(JsonTraceSerializer, spans) as {
      resourceSpans: Array<{ resource: never; scopeSpans: Array<{ spans: Array<{ name: string }> }> }>;
    };
    expect(request.resourceSpans).toHaveLength(1);
    expect(otlpAttributes(request.resourceSpans[0].resource)).toEqual({
      'service.name': 'my-app-api',
      'deployment.environment': 'test',
      [ATTR_APP_INSTANCE_ID]: 'prod-eu',
    });
    expect(request.resourceSpans[0].scopeSpans[0].spans.map((span) => span.name)).toEqual(['a', 'b']);

    await provider.shutdown();
  });

  it('log records: one ResourceLogs with the stamped resource, record fields intact', async () => {
    const capture = new CapturingExporter<ReadableLogRecord>();
    const provider = new LoggerProvider({
      resource: RESOURCE,
      processors: [
        new BatchLogRecordProcessor({
          exporter: new GatedLogRecordExporter(capture as unknown as LogRecordExporter),
        }),
      ],
    });
    telemetryGate.setEnabled(true);

    const logger = provider.getLogger('test');
    logger.emit({ body: 'first', severityText: 'INFO' });
    logger.emit({ body: 'second', severityText: 'WARN' });
    await provider.forceFlush();

    const logs = capture.batches.flat();
    expect(logs.map((log) => log.body)).toEqual(['first', 'second']);
    expect(logs[1].severityText).toBe('WARN');

    const request = serialized(JsonLogsSerializer, logs) as {
      resourceLogs: Array<{ resource: never; scopeLogs: Array<{ logRecords: unknown[] }> }>;
    };
    expect(request.resourceLogs).toHaveLength(1);
    expect(otlpAttributes(request.resourceLogs[0].resource)).toEqual({
      'service.name': 'my-app-api',
      'deployment.environment': 'test',
      [ATTR_APP_INSTANCE_ID]: APP_SLUG,
    });
    expect(request.resourceLogs[0].scopeLogs[0].logRecords).toHaveLength(2);

    await provider.shutdown();
  });

  it('a closed gate still drops real records', async () => {
    const inner = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      resource: RESOURCE,
      spanProcessors: [new SimpleSpanProcessor(new GatedSpanExporter(inner))],
    });

    provider.getTracer('test').startSpan('dropped').end();
    await provider.forceFlush();

    expect(inner.getFinishedSpans()).toHaveLength(0);
    await provider.shutdown();
  });
});
