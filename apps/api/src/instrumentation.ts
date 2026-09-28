import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
} from '@opentelemetry/semantic-conventions';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
// Trivial and side-effect-free by design — see the note in that file on why it
// is safe to import here, ahead of `sdk.start()`.
import { resolveServiceName } from './common/otel/service-name';
// Same constraint: side-effect-free. Every exporter below is wrapped in a gate
// that starts CLOSED, so OTEL_ENABLED installs the SDK but nothing is exported
// until the `telemetry.enabled` system setting opens it (issue #532).
import {
  GatedLogRecordExporter,
  GatedPushMetricExporter,
  GatedSpanExporter,
} from './common/otel/telemetry-gate';

// Enable OTEL diagnostics in development
if (process.env.NODE_ENV === 'development' && process.env.OTEL_DEBUG === 'true') {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
}

const isOtelEnabled = process.env.OTEL_ENABLED === 'true';

export function initializeOtel(): NodeSDK | null {
  if (!isOtelEnabled) {
    console.log('OpenTelemetry disabled (OTEL_ENABLED !== true)');
    return null;
  }

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';
  const serviceName = resolveServiceName();

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version || '0.0.1',
    [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV || 'development',
  });

  const sdk = new NodeSDK({
    resource,
    traceExporter: new GatedSpanExporter(
      new OTLPTraceExporter({
        url: `${endpoint}/v1/traces`,
      }),
    ),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new GatedPushMetricExporter(
        new OTLPMetricExporter({
          url: `${endpoint}/v1/metrics`,
        }),
      ),
      exportIntervalMillis: 60000, // Export every 60 seconds
    }),
    // Registers the global LoggerProvider. The pino instrumentation below
    // forwards every pino record to it ("log sending"); stdout is unchanged.
    logRecordProcessors: [
      new BatchLogRecordProcessor({
        exporter: new GatedLogRecordExporter(
          new OTLPLogExporter({
            url: `${endpoint}/v1/logs`,
          }),
        ),
      }),
    ],
    instrumentations: [
      getNodeAutoInstrumentations({
        // Customize instrumentations
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingRequestHook: (request) => {
            const url = request.url || '';
            return url.includes('/api/health/live') || url.includes('/api/health/ready');
          },
        },
        '@opentelemetry/instrumentation-fs': {
          enabled: false, // Disable noisy FS instrumentation
        },
        // Log sending is the instrumentation's default (disableLogSending:
        // false); spelled out so the OTLP log pipeline above does not silently
        // depend on an upstream default. It adds an OTel destination next to
        // the logger's own stream via pino.multistream, so stdout output (and
        // pino-pretty in development) is untouched. Requires `pino` to be
        // required after `sdk.start()`, which main.ts's import order ensures.
        '@opentelemetry/instrumentation-pino': {
          disableLogSending: false,
        },
      }),
    ],
  });

  sdk.start();

  console.log(
    `OpenTelemetry initialized - exporting to ${endpoint} once the telemetry.enabled setting opens the gate`,
  );

  // Graceful shutdown
  process.on('SIGTERM', () => {
    sdk.shutdown()
      .then(() => console.log('OpenTelemetry SDK shut down'))
      .catch((err) => console.error('Error shutting down OTEL SDK', err))
      .finally(() => process.exit(0));
  });

  return sdk;
}

// Initialize immediately when this module is loaded
const sdk = initializeOtel();

export { sdk };
