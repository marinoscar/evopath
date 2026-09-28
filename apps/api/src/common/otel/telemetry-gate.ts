// =============================================================================
// The runtime telemetry gate (issue #532, epic #528)
// =============================================================================
//
// TWO SWITCHES, AND THEY ARE NOT THE SAME SWITCH
// -----------------------------------------------------------------------------
//
//   1. `OTEL_ENABLED` (environment, infra). Decides whether the OpenTelemetry
//      SDK is installed in this process AT ALL — read once by
//      `src/instrumentation.ts` before Nest exists. It is `true` when the
//      deployment ships the telemetry overlay (collector + storage backend),
//      and it cannot change without a restart, because auto-instrumentation
//      can only patch modules required AFTER `sdk.start()`.
//
//   2. `telemetry.enabled` (system setting, admin UI). Decides whether what
//      the installed SDK produces is actually EXPORTED. An administrator
//      flips it at runtime with no restart; the telemetry module calls
//      `telemetryGate.setEnabled()` on boot (once settings have loaded) and on
//      every settings refresh.
//
// The SDK keeps running either way — spans are still created, log records
// still correlated, metrics still aggregated — and the gated exporters below
// simply drop each batch while the gate is closed. Dropping is the intended
// behaviour, not a failure: a batch is acknowledged as SUCCESS so the
// processors neither retry it nor log an export error for it.
//
// The gate is read at EXPORT time, not when a span or record is created: a
// batch that was queued while closed and is flushed after the gate opens is
// sent. At worst that is one batch interval (the batch processors' scheduled
// delay, or the metric reader's 60s) on either side of a toggle.
//
// THE GATE STARTS CLOSED. Nothing leaves the process until settings have been
// read and an administrator's choice is known; a deployment that has switched
// telemetry off must not leak the first minute of every boot.
//
// THE INSTANCE IDENTIFIER IS STAMPED HERE TOO (issue #565)
// -----------------------------------------------------------------------------
//
// Every exported span, log record and metric batch carries the resource
// attribute `app.instance.id` (`instance-id.ts`), which an administrator
// changes at runtime (`telemetry.instanceId`). The SDK resource cannot carry
// it: `instrumentation.ts` hands the resource to `NodeSDK` once, before
// `sdk.start()`, and it is immutable from then on — every span and record
// holds a reference to that one object. A runtime-changeable identity must
// therefore be applied at EXPORT time, and the gate is already the one place
// every batch passes through on its way out. The telemetry module pushes the
// resolved value with `telemetryGate.setInstanceId()` at the same moments it
// pushes `setEnabled()`: on boot, every refresh interval, and after a save.
//
// The value is read per batch, like the gate itself, so a change applies to
// the next batch exported. It starts at the `APP_SLUG` default rather than
// empty, so the first batch after the gate opens is never unlabelled even if
// it races the first settings read.
//
// HOW A RECORD IS RE-LABELLED WITHOUT TOUCHING IT
// -----------------------------------------------------------------------------
//
//   - Metrics: `ResourceMetrics` is a plain object built per collection, so
//     the batch is shallow-copied with a replaced `resource`.
//
//   - Spans and log records are SDK class instances (`SpanImpl`,
//     `LogRecordImpl`), shared with every other processor, and much of what
//     the OTLP transformer reads is a prototype GETTER over an underscored
//     field (`droppedAttributesCount`, `hrTime`, `severityText`, `body`,
//     `spanContext`…). A spread would lose every getter; mutating the
//     original would leak the label into other processors. So each record is
//     presented as `Object.create(record)` with ONE own property, `resource`:
//     every getter and method still resolves through the prototype chain with
//     `this` bound to the wrapper, which falls through to the original's
//     fields. (Neither class uses `#private` fields, which a wrapper could not
//     reach — checked against sdk-trace / sdk-logs 0.221.)
//
//   - The OTLP transformer (`@opentelemetry/otlp-transformer`, `trace/
//     internal.js` and `logs/internal.js`) groups records into
//     `ResourceSpans` / `ResourceLogs` with a `Map` KEYED BY THE RESOURCE
//     OBJECT'S IDENTITY. A fresh merged resource per record would emit one
//     `ResourceSpans` per span. The merged resource is therefore cached per
//     (original resource, instance id) pair in a `WeakMap`, so every record in
//     a batch that shared a resource still shares one — and a change of id
//     simply replaces the entry.
//
//   - `resource.merge(other)` gives `other`'s attributes precedence
//     (`ResourceImpl.merge` lists the incoming attributes first and
//     `attributes` keeps the first of each key), so the stamped id wins over
//     anything a detector or `OTEL_RESOURCE_ATTRIBUTES` put there, and every
//     other attribute (`service.name`, …) is preserved.
//
//   - The batch processors settle a resource's async (detector) attributes
//     BEFORE calling `export`, so the merged copy is built from settled
//     values. A cache entry built while its source was still pending is
//     rebuilt once the source has settled.
//
// SAFE TO IMPORT BEFORE THE SDK STARTS
// -----------------------------------------------------------------------------
//
// Like `service-name.ts`, this module is imported by `instrumentation.ts`
// ahead of `sdk.start()`. It is kept trivial and side-effect-free on purpose:
// module-level state, three thin wrapper classes, and imports only from the
// OpenTelemetry SDK packages themselves and `instance-id.ts` (never `http`,
// `pg`, `pino` or any other module the auto-instrumentation needs to patch).
// There is no Nest DI here because Nest does not exist yet when this runs.
// =============================================================================

import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { resourceFromAttributes, type Resource } from '@opentelemetry/resources';
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs';
import type {
  AggregationOption,
  AggregationTemporality,
  InstrumentType,
  PushMetricExporter,
  ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';

import { ATTR_APP_INSTANCE_ID, resolveTelemetryInstanceId } from './instance-id';

let enabled = false;
let instanceId = resolveTelemetryInstanceId(null);

/**
 * Process-wide runtime export switch (starts closed, `false`) and the instance
 * identifier stamped on everything it lets through (starts at `APP_SLUG`).
 */
export const telemetryGate = {
  isEnabled(): boolean {
    return enabled;
  },
  setEnabled(next: boolean): void {
    enabled = next;
  },
  instanceId(): string {
    return instanceId;
  },
  /** Callers pass an already-resolved value (`resolveTelemetryInstanceId`). */
  setInstanceId(next: string): void {
    instanceId = next;
  },
};

/** Per source resource: the merged copy last built, and for which id. */
const stamped = new WeakMap<Resource, { id: string; merged: Resource }>();

/**
 * `resource` with `app.instance.id` set to the current instance id — the SAME
 * object for every call with the same source and id (see the header: the OTLP
 * transformer groups by resource identity).
 */
export function stampResource(resource: Resource): Resource {
  const id = instanceId;
  const hit = stamped.get(resource);

  if (hit && hit.id === id && !(hit.merged.asyncAttributesPending && !resource.asyncAttributesPending)) {
    return hit.merged;
  }

  const merged = resource.merge(resourceFromAttributes({ [ATTR_APP_INSTANCE_ID]: id }));
  stamped.set(resource, { id, merged });

  return merged;
}

/**
 * `record` presented with a stamped `resource`, without copying or mutating
 * it: an object whose prototype IS the record, so getters and methods still
 * work (see the header).
 */
function withStampedResource<T extends { resource: Resource }>(record: T): T {
  return Object.create(record, {
    resource: { value: stampResource(record.resource), enumerable: true },
  }) as T;
}

const DROPPED: ExportResult = { code: ExportResultCode.SUCCESS };

/** Forwards spans to `inner`, stamped with the instance id, only while the telemetry gate is open. */
export class GatedSpanExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    if (!telemetryGate.isEnabled()) {
      resultCallback(DROPPED);
      return;
    }
    this.inner.export(spans.map(withStampedResource), resultCallback);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush ? this.inner.forceFlush() : Promise.resolve();
  }
}

/** Forwards log records to `inner`, stamped with the instance id, only while the telemetry gate is open. */
export class GatedLogRecordExporter implements LogRecordExporter {
  constructor(private readonly inner: LogRecordExporter) {}

  export(logs: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    if (!telemetryGate.isEnabled()) {
      resultCallback(DROPPED);
      return;
    }
    this.inner.export(logs.map(withStampedResource), resultCallback);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }
}

/**
 * Forwards metrics to `inner`, stamped with the instance id, only while the
 * telemetry gate is open.
 *
 * The optional aggregation selectors are delegated so the reader keeps the
 * inner exporter's temporality (OTLP defaults to cumulative) and aggregation
 * preferences; wrapping must not change what is measured, only whether it is
 * sent.
 */
export class GatedPushMetricExporter implements PushMetricExporter {
  readonly selectAggregationTemporality?: (instrumentType: InstrumentType) => AggregationTemporality;
  readonly selectAggregation?: (instrumentType: InstrumentType) => AggregationOption;

  constructor(private readonly inner: PushMetricExporter) {
    if (inner.selectAggregationTemporality) {
      this.selectAggregationTemporality = inner.selectAggregationTemporality.bind(inner);
    }
    if (inner.selectAggregation) {
      this.selectAggregation = inner.selectAggregation.bind(inner);
    }
  }

  export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    if (!telemetryGate.isEnabled()) {
      resultCallback(DROPPED);
      return;
    }
    this.inner.export({ ...metrics, resource: stampResource(metrics.resource) }, resultCallback);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }
}
