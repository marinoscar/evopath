// =============================================================================
// In-memory OpenTelemetry tracing for unit tests (issue #132)
// =============================================================================
//
// Installs, GLOBALLY, the three things `@opentelemetry/sdk-node` installs in
// the running application and that trace-context propagation depends on:
//
//   - a tracer provider whose spans land in an `InMemorySpanExporter`;
//   - an AsyncLocalStorage context manager, so `context.active()` follows
//     `await` the way it does in production;
//   - the W3C trace-context propagator (`traceparent`).
//
// Call `uninstall()` in `afterEach`/`afterAll`: the globals are process-wide,
// and a suite that leaves them registered changes what every later suite in
// the same worker sees.
// =============================================================================

import { context, propagation, trace, Tracer } from '@opentelemetry/api';
// Transitive (sdk-node / sdk-trace-node depend on it); the same context
// manager the running application gets from `NodeSDK`.
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

export interface TestTracing {
  exporter: InMemorySpanExporter;
  tracer: Tracer;
  uninstall: () => void;
}

export function installTestTracing(): TestTracing {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const contextManager = new AsyncLocalStorageContextManager().enable();

  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(contextManager);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  return {
    exporter,
    tracer: trace.getTracer('test'),
    uninstall: () => {
      trace.disable();
      context.disable();
      propagation.disable();
      exporter.reset();
    },
  };
}
