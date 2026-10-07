// =============================================================================
// OpenTelemetry bootstrap: the FIRST import of `main.ts`
// =============================================================================
//
// Auto-instrumentation can only patch modules required AFTER `sdk.start()`,
// so `main.ts` imports this file before anything else (`import
// './instrumentation';` on its second line). The bootstrap itself lives in
// `@marinoscar/platform-api/otel-core/sdk` (marinoscar/EnterpriseAppBase#700), a Nest-free entry
// that loads no `@nestjs/*` module; this file only hands it the app's
// identity:
//
//   - OTEL_ENABLED !== 'true': logs "OpenTelemetry disabled (OTEL_ENABLED !==
//     true)", returns null, installs nothing. Every instrument and span is
//     the API's no-op.
//   - OTEL_ENABLED === 'true': OTLP/HTTP traces, metrics (every 60 s) and
//     logs to OTEL_EXPORTER_OTLP_ENDPOINT (default http://localhost:4318),
//     each behind the runtime telemetry gate, which starts CLOSED: nothing is
//     exported until the `telemetry.enabled` system setting opens it (issue
//     #532). Health probes are not traced; fs instrumentation is off; pino
//     records are forwarded as OTLP logs. SIGTERM shuts the SDK down.
//
// OTEL_DEBUG=true (with NODE_ENV=development) prints the SDK's diagnostics.
// =============================================================================

import { initializeOtel } from '@marinoscar/platform-api/otel-core/sdk';

// Binds the package's resolvers to APP_SLUG (and seeds the gate's instance
// id); touches nothing the auto-instrumentation patches.
import { resolveServiceName, resolveTelemetryInstanceId } from './common/otel/telemetry-identity';

// Initialize immediately when this module is loaded.
export const sdk = initializeOtel({
  serviceName: resolveServiceName(),
  // The instance id the gate stamps until the telemetry settings are read:
  // the app's slug, so the first exported batch is never unlabelled.
  instanceId: resolveTelemetryInstanceId(null),
});
